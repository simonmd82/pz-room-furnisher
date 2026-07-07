using System.Text.Json;
using backend.Models;

namespace backend.Services;

public interface ITileConfigService
{
    IReadOnlyDictionary<string, TileDefinition> GetAll();
    TileDefinition? Get(string id);
    void Upsert(TileDefinition def);
    void Delete(string id);
    string ExportJson();
    void ImportJson(string json);
}

public class TileConfigService : ITileConfigService
{
    private readonly string _filePath;
    private Dictionary<string, TileDefinition> _defs = [];
    private readonly SemaphoreSlim _lock = new(1, 1);

    private static readonly JsonSerializerOptions Opts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public TileConfigService(IWebHostEnvironment env)
    {
        _filePath = Path.Combine(env.ContentRootPath, "Data", "tile-definitions.json");
        Load();
    }

    public IReadOnlyDictionary<string, TileDefinition> GetAll() => _defs;

    public TileDefinition? Get(string id) =>
        _defs.GetValueOrDefault(id);

    public void Upsert(TileDefinition def)
    {
        if (string.IsNullOrEmpty(def.Id))
            def.Id = def.ComputeOwnId();

        _lock.Wait();
        try
        {
            _defs[def.Id] = def;
            Save();
        }
        finally { _lock.Release(); }
    }

    public void Delete(string id)
    {
        _lock.Wait();
        try
        {
            _defs.Remove(id);
            Save();
        }
        finally { _lock.Release(); }
    }

    public string ExportJson() => JsonSerializer.Serialize(_defs, Opts);

    public void ImportJson(string json)
    {
        var imported = JsonSerializer.Deserialize<Dictionary<string, TileDefinition>>(json, Opts) ?? [];
        foreach (var def in imported.Values)
        {
            if (string.IsNullOrEmpty(def.Id))
                def.Id = def.ComputeOwnId();
            _defs[def.Id] = def;
        }
        Save();
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath)) return;
            var raw = JsonSerializer.Deserialize<Dictionary<string, TileDefinition>>(
                File.ReadAllText(_filePath), Opts) ?? [];

            // Self-healing migration: re-key by each entry's own computed Id rather than
            // trusting the raw JSON key, so legacy entries (saved before Id existed) get
            // a correct, collision-proof key derived from their own TileId + TileLayout shape.
            _defs = new Dictionary<string, TileDefinition>();
            foreach (var def in raw.Values)
            {
                if (string.IsNullOrEmpty(def.Id))
                    def.Id = def.ComputeOwnId();
                _defs[def.Id] = def;
            }
        }
        catch { _defs = []; }
    }

    private void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_filePath)!);
        File.WriteAllText(_filePath, JsonSerializer.Serialize(_defs, Opts));
    }
}


