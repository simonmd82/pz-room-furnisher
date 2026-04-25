using System.Text.Json;
using backend.Models;

namespace backend.Services;

public interface IRoomTypeConfigService
{
    IReadOnlyDictionary<string, RoomTypeConfig> GetAll();
    void Upsert(RoomTypeConfig cfg);
    void Delete(string roomType);
}

public class RoomTypeConfigService : IRoomTypeConfigService
{
    private readonly string _roomTypesPath;
    private Dictionary<string, RoomTypeConfig> _configs = [];
    private readonly SemaphoreSlim _lock = new(1, 1);

    private static readonly JsonSerializerOptions Opts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public RoomTypeConfigService(IWebHostEnvironment env)
    {
        var dataDir = Path.Combine(env.ContentRootPath, "Data");
        _roomTypesPath = Path.Combine(dataDir, "room-types.json");
        Load();
    }

    public IReadOnlyDictionary<string, RoomTypeConfig> GetAll() => _configs;

    public void Upsert(RoomTypeConfig cfg)
    {
        _lock.Wait();
        try { _configs[cfg.RoomType] = cfg; SaveRoomTypes(); }
        finally { _lock.Release(); }
    }

    public void Delete(string roomType)
    {
        _lock.Wait();
        try { _configs.Remove(roomType); SaveRoomTypes(); }
        finally { _lock.Release(); }
    }

    private void Load()
    {
        try
        {
            if (File.Exists(_roomTypesPath))
                _configs = JsonSerializer.Deserialize<Dictionary<string, RoomTypeConfig>>(
                    File.ReadAllText(_roomTypesPath), Opts) ?? [];
        }
        catch { _configs = []; }
    }

    private void SaveRoomTypes()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_roomTypesPath)!);
        File.WriteAllText(_roomTypesPath, JsonSerializer.Serialize(_configs, Opts));
    }
}
