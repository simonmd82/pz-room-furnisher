using System.Text.Json;
using backend.Models;

namespace backend.Services;

public interface ITileConfigService
{
    IReadOnlyDictionary<string, TileDefinition> GetAll();
    TileDefinition? Get(string tileId);
    void Upsert(TileDefinition def);
    void Delete(string tileId);
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

    public TileDefinition? Get(string tileId) =>
        _defs.GetValueOrDefault(tileId);

    public void Upsert(TileDefinition def)
    {
        _lock.Wait();
        try
        {
            _defs[def.TileId] = def;
            Save();
        }
        finally { _lock.Release(); }
    }

    public void Delete(string tileId)
    {
        _lock.Wait();
        try
        {
            _defs.Remove(tileId);
            Save();
        }
        finally { _lock.Release(); }
    }

    public string ExportJson() => JsonSerializer.Serialize(_defs, Opts);

    public void ImportJson(string json)
    {
        var imported = JsonSerializer.Deserialize<Dictionary<string, TileDefinition>>(json, Opts) ?? [];
        foreach (var (k, v) in imported) _defs[k] = v;
        Save();
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath)) return;
            _defs = JsonSerializer.Deserialize<Dictionary<string, TileDefinition>>(
                File.ReadAllText(_filePath), Opts) ?? [];
        }
        catch { _defs = []; }
    }

    private void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_filePath)!);
        File.WriteAllText(_filePath, JsonSerializer.Serialize(_defs, Opts));
    }
}


