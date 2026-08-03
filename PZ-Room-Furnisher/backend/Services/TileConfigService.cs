using System.Text.Json;
using System.Text.RegularExpressions;
using backend.Models;

namespace backend.Services;

public interface ITileConfigService
{
    /// <summary>Merged view of every known set (regardless of enabled), vanilla-wins-then-load-order on id collisions. Used for rendering/lookup.</summary>
    IReadOnlyDictionary<string, TileDefinition> GetAll();
    /// <summary>Merged view of only the currently-enabled sets. Used by the generator.</summary>
    IReadOnlyDictionary<string, TileDefinition> GetAllEnabled();
    /// <summary>Raw definitions belonging to exactly one set (for editing that set in the Tile Browser).</summary>
    IReadOnlyDictionary<string, TileDefinition> GetAllForSet(string setId);
    TileDefinition? Get(string id);
    void Upsert(TileDefinition def, string setId = "vanilla");
    void Delete(string id, string setId = "vanilla");
    string ExportJson(string setId = "vanilla");
    void ImportJson(string json, string setId = "vanilla");

    IReadOnlyList<TileConfigSetInfo> GetSets();
    TileConfigSetInfo CreateSet(string name, string description);
    TileConfigSetInfo SetSetMeta(string setId, string? name, string? description, bool? enabled);
    void DeleteSet(string setId);
}

public class TileConfigService : ITileConfigService
{
    private readonly string _dataDir;
    private readonly string _manifestPath;
    private readonly SemaphoreSlim _lock = new(1, 1);

    private List<TileConfigSetInfo> _sets = [];
    private readonly Dictionary<string, Dictionary<string, TileDefinition>> _setDefs = [];
    private Dictionary<string, TileDefinition> _mergedAll = [];
    private Dictionary<string, TileDefinition> _mergedEnabled = [];

    private const string VanillaId = "vanilla";

    private static readonly JsonSerializerOptions Opts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public TileConfigService(IWebHostEnvironment env)
    {
        _dataDir = Path.Combine(env.ContentRootPath, "Data");
        _manifestPath = Path.Combine(_dataDir, "tile-config-sets.json");
        LoadAll();
    }

    public IReadOnlyDictionary<string, TileDefinition> GetAll() => _mergedAll;
    public IReadOnlyDictionary<string, TileDefinition> GetAllEnabled() => _mergedEnabled;

    public IReadOnlyDictionary<string, TileDefinition> GetAllForSet(string setId) =>
        _setDefs.TryGetValue(setId, out var defs) ? defs : new Dictionary<string, TileDefinition>();

    public TileDefinition? Get(string id) => _mergedAll.GetValueOrDefault(id);

    public IReadOnlyList<TileConfigSetInfo> GetSets() => _sets;

    public void Upsert(TileDefinition def, string setId = "vanilla")
    {
        if (string.IsNullOrEmpty(def.Id))
            def.Id = def.ComputeOwnId();

        _lock.Wait();
        try
        {
            if (!_setDefs.TryGetValue(setId, out var defs))
                throw new ArgumentException($"Unknown tile config set '{setId}'.");

            defs[def.Id] = def;
            SaveSetFile(setId);
            RebuildMerged();
        }
        finally { _lock.Release(); }
    }

    public void Delete(string id, string setId = "vanilla")
    {
        _lock.Wait();
        try
        {
            if (_setDefs.TryGetValue(setId, out var defs))
            {
                defs.Remove(id);
                SaveSetFile(setId);
                RebuildMerged();
            }
        }
        finally { _lock.Release(); }
    }

    public string ExportJson(string setId = "vanilla") =>
        JsonSerializer.Serialize(GetAllForSet(setId), Opts);

    public void ImportJson(string json, string setId = "vanilla")
    {
        var imported = JsonSerializer.Deserialize<Dictionary<string, TileDefinition>>(json, Opts) ?? [];

        _lock.Wait();
        try
        {
            if (!_setDefs.TryGetValue(setId, out var defs))
                throw new ArgumentException($"Unknown tile config set '{setId}'.");

            foreach (var def in imported.Values)
            {
                if (string.IsNullOrEmpty(def.Id))
                    def.Id = def.ComputeOwnId();
                defs[def.Id] = def;
            }
            SaveSetFile(setId);
            RebuildMerged();
        }
        finally { _lock.Release(); }
    }

    public TileConfigSetInfo CreateSet(string name, string description)
    {
        _lock.Wait();
        try
        {
            var id = MakeUniqueId(name);
            var info = new TileConfigSetInfo
            {
                Id = id,
                Name = string.IsNullOrWhiteSpace(name) ? id : name,
                Description = description ?? string.Empty,
                Enabled = true,
                File = Path.Combine("TileConfigSets", $"{id}.json"),
            };

            _sets.Add(info);
            _setDefs[id] = [];
            SaveSetFile(id);
            SaveManifest();
            RebuildMerged();
            return info;
        }
        finally { _lock.Release(); }
    }

    public TileConfigSetInfo SetSetMeta(string setId, string? name, string? description, bool? enabled)
    {
        _lock.Wait();
        try
        {
            var info = _sets.FirstOrDefault(s => s.Id == setId)
                ?? throw new ArgumentException($"Unknown tile config set '{setId}'.");

            if (name is not null) info.Name = name;
            if (description is not null) info.Description = description;
            if (enabled is not null) info.Enabled = enabled.Value;

            SaveManifest();
            RebuildMerged();
            return info;
        }
        finally { _lock.Release(); }
    }

    public void DeleteSet(string setId)
    {
        if (setId == VanillaId)
            throw new InvalidOperationException("The vanilla config set cannot be deleted.");

        _lock.Wait();
        try
        {
            var info = _sets.FirstOrDefault(s => s.Id == setId);
            if (info is null) return;

            _sets.Remove(info);
            _setDefs.Remove(setId);

            var path = Path.Combine(_dataDir, info.File);
            if (File.Exists(path)) File.Delete(path);

            SaveManifest();
            RebuildMerged();
        }
        finally { _lock.Release(); }
    }

    // ── Loading ──────────────────────────────────────────────────────────

    private void LoadAll()
    {
        LoadManifest();
        foreach (var set in _sets)
            _setDefs[set.Id] = LoadSetFile(set.File);
        RebuildMerged();
    }

    private void LoadManifest()
    {
        try
        {
            if (File.Exists(_manifestPath))
            {
                _sets = JsonSerializer.Deserialize<List<TileConfigSetInfo>>(
                    File.ReadAllText(_manifestPath), Opts) ?? [];
                if (_sets.Any(s => s.Id == VanillaId)) return;
            }
        }
        catch { _sets = []; }

        // First run (or corrupt/missing manifest without a vanilla entry): seed it,
        // pointing at the pre-existing tile-definitions.json so no data migration is needed.
        _sets.Insert(0, new TileConfigSetInfo
        {
            Id = VanillaId,
            Name = "Vanilla",
            Description = "Built-in base game furniture",
            Enabled = true,
            File = "tile-definitions.json",
        });
        SaveManifest();
    }

    private Dictionary<string, TileDefinition> LoadSetFile(string relativeFile)
    {
        var path = Path.Combine(_dataDir, relativeFile);
        var result = new Dictionary<string, TileDefinition>();
        try
        {
            if (!File.Exists(path)) return result;
            var raw = JsonSerializer.Deserialize<Dictionary<string, TileDefinition>>(
                File.ReadAllText(path), Opts) ?? [];

            // Self-healing migration: re-key by each entry's own computed Id rather than
            // trusting the raw JSON key, so legacy entries (saved before Id existed) get
            // a correct, collision-proof key derived from their own TileId + TileLayout shape.
            foreach (var def in raw.Values)
            {
                if (string.IsNullOrEmpty(def.Id))
                    def.Id = def.ComputeOwnId();
                result[def.Id] = def;
            }
        }
        catch { /* leave empty */ }
        return result;
    }

    private void RebuildMerged()
    {
        // Vanilla wins first, then remaining sets in manifest order.
        var ordered = _sets.OrderBy(s => s.Id == VanillaId ? 0 : 1).ToList();

        var all = new Dictionary<string, TileDefinition>();
        var enabled = new Dictionary<string, TileDefinition>();
        foreach (var set in ordered)
        {
            if (!_setDefs.TryGetValue(set.Id, out var defs)) continue;
            foreach (var (id, def) in defs)
            {
                all.TryAdd(id, def);
                if (set.Enabled) enabled.TryAdd(id, def);
            }
        }
        _mergedAll = all;
        _mergedEnabled = enabled;
    }

    // ── Saving ───────────────────────────────────────────────────────────

    private void SaveManifest()
    {
        Directory.CreateDirectory(_dataDir);
        File.WriteAllText(_manifestPath, JsonSerializer.Serialize(_sets, Opts));
    }

    private void SaveSetFile(string setId)
    {
        var info = _sets.FirstOrDefault(s => s.Id == setId);
        if (info is null) return;
        var path = Path.Combine(_dataDir, info.File);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(_setDefs[setId], Opts));
    }

    // ── Id generation ────────────────────────────────────────────────────

    private string MakeUniqueId(string name)
    {
        var slug = Regex.Replace((name ?? string.Empty).Trim().ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-');
        if (string.IsNullOrEmpty(slug)) slug = "set";

        var candidate = slug;
        var n = 2;
        while (_sets.Any(s => s.Id == candidate))
            candidate = $"{slug}-{n++}";
        return candidate;
    }
}
