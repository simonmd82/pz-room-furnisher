using System.Text.Json;
using backend.Models;

namespace backend.Services;

public interface IRoomTypeConfigService
{
    IReadOnlyDictionary<string, RoomTypeConfig> GetAll();
    SlotSizeConfig GetSlotSizes();
    void Upsert(RoomTypeConfig cfg);
    void Delete(string roomType);
    void SaveSlotSizes(SlotSizeConfig sizes);
}

public class RoomTypeConfigService : IRoomTypeConfigService
{
    private readonly string _roomTypesPath;
    private readonly string _slotSizesPath;
    private Dictionary<string, RoomTypeConfig> _configs = [];
    private SlotSizeConfig _slotSizes = new();
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
        _slotSizesPath = Path.Combine(dataDir, "slot-sizes.json");
        Load();
    }

    public IReadOnlyDictionary<string, RoomTypeConfig> GetAll() => _configs;
    public SlotSizeConfig GetSlotSizes() => _slotSizes;

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

    public void SaveSlotSizes(SlotSizeConfig sizes)
    {
        _lock.Wait();
        try { _slotSizes = sizes; SaveSlotSizesFile(); }
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

        try
        {
            if (File.Exists(_slotSizesPath))
                _slotSizes = JsonSerializer.Deserialize<SlotSizeConfig>(
                    File.ReadAllText(_slotSizesPath), Opts) ?? new();
        }
        catch { _slotSizes = new(); }
    }

    private void SaveRoomTypes()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_roomTypesPath)!);
        File.WriteAllText(_roomTypesPath, JsonSerializer.Serialize(_configs, Opts));
    }

    private void SaveSlotSizesFile()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_slotSizesPath)!);
        File.WriteAllText(_slotSizesPath, JsonSerializer.Serialize(_slotSizes, Opts));
    }
}
