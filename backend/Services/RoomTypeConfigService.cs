using System.Text.Json;
using backend.Models;

namespace backend.Services;

public interface IRoomTypeConfigService
{
    IReadOnlyDictionary<string, RoomTypeConfig> GetAll();
    void Upsert(RoomTypeConfig cfg);
    void Delete(string roomType);
    bool HasDefault();
    void RestoreDefault();
    bool HasSnapshot();
    void SaveSnapshot();
    void RestoreSnapshot();
}

public class RoomTypeConfigService : IRoomTypeConfigService
{
    private readonly string _roomTypesPath;
    private readonly string _defaultsPath;
    private readonly string _snapshotPath;
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
        _defaultsPath  = Path.Combine(dataDir, "Defaults",   "room-types.default.json");
        _snapshotPath  = Path.Combine(dataDir, "Snapshots",  "room-types.snapshot.json");
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

    public bool HasDefault() => File.Exists(_defaultsPath);

    public void RestoreDefault()
    {
        if (!File.Exists(_defaultsPath))
            throw new FileNotFoundException("No bundled defaults file found.", _defaultsPath);
        _lock.Wait();
        try
        {
            _configs = JsonSerializer.Deserialize<Dictionary<string, RoomTypeConfig>>(
                File.ReadAllText(_defaultsPath), Opts) ?? [];
            SaveRoomTypes();
        }
        finally { _lock.Release(); }
    }

    public bool HasSnapshot() => File.Exists(_snapshotPath);

    public void SaveSnapshot()
    {
        _lock.Wait();
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_snapshotPath)!);
            File.WriteAllText(_snapshotPath, JsonSerializer.Serialize(_configs, Opts));
        }
        finally { _lock.Release(); }
    }

    public void RestoreSnapshot()
    {
        if (!File.Exists(_snapshotPath))
            throw new FileNotFoundException("No snapshot file found.", _snapshotPath);
        _lock.Wait();
        try
        {
            _configs = JsonSerializer.Deserialize<Dictionary<string, RoomTypeConfig>>(
                File.ReadAllText(_snapshotPath), Opts) ?? [];
            SaveRoomTypes();
        }
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
