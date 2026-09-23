using System.Text.Json;
using backend.Models;

namespace backend.Services;

public interface IRugCatalogService
{
    /// <summary>Every known rug design, regardless of whether its TileSetId is currently enabled.</summary>
    IReadOnlyDictionary<string, RugDefinition> GetAll();
    /// <summary>Only rug designs whose TileSetId refers to a currently-enabled TileConfigSet. Used by the generator.</summary>
    IReadOnlyDictionary<string, RugDefinition> GetAllEnabled();
    RugDefinition? Get(string id);
    void Upsert(RugDefinition def);
    void Delete(string id);
}

public class RugCatalogService : IRugCatalogService
{
    private readonly string _path;
    private readonly ITileConfigService _tileSvc;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private Dictionary<string, RugDefinition> _all = [];

    private static readonly JsonSerializerOptions Opts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public RugCatalogService(IWebHostEnvironment env, ITileConfigService tileSvc)
    {
        _path = Path.Combine(env.ContentRootPath, "Data", "rug-definitions.json");
        _tileSvc = tileSvc;
        Load();
    }

    public IReadOnlyDictionary<string, RugDefinition> GetAll() => _all;

    public IReadOnlyDictionary<string, RugDefinition> GetAllEnabled()
    {
        var enabledSetIds = _tileSvc.GetSets()
            .Where(s => s.Enabled)
            .Select(s => s.Id)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        return _all.Values
            .Where(r => enabledSetIds.Contains(r.TileSetId))
            .ToDictionary(r => r.Id);
    }

    public RugDefinition? Get(string id) => _all.GetValueOrDefault(id);

    public void Upsert(RugDefinition def)
    {
        _lock.Wait();
        try
        {
            _all[def.Id] = def;
            Save();
        }
        finally { _lock.Release(); }
    }

    public void Delete(string id)
    {
        _lock.Wait();
        try
        {
            _all.Remove(id);
            Save();
        }
        finally { _lock.Release(); }
    }

    private void Load()
    {
        try
        {
            if (File.Exists(_path))
                _all = JsonSerializer.Deserialize<Dictionary<string, RugDefinition>>(
                    File.ReadAllText(_path), Opts) ?? [];
        }
        catch { _all = []; }
    }

    private void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        File.WriteAllText(_path, JsonSerializer.Serialize(_all, Opts));
    }
}
