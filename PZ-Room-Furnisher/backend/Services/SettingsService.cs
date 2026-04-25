using System.Text.Json;
using System.Text.Json.Nodes;

namespace backend.Services;

public interface ISettingsService
{
    List<string> GetKnownRoomTypes();
    void         SetKnownRoomTypes(List<string> names);
    List<string> GetKnownCategories();
    void         SetKnownCategories(List<string> categories);
}

public class SettingsService : ISettingsService
{
    private readonly string _path;
    private readonly SemaphoreSlim _lock = new(1, 1);

    private static readonly List<string> DefaultRoomTypes =
    [
        "Bedroom", "Kitchen", "Bathroom", "LivingRoom", "Office",
        "Storage", "Hallway", "Garage", "Bar", "Restaurant"
    ];

    private static readonly List<string> DefaultCategories =
    [
        "Beds", "Bedtable", "Cabinet", "Mirror", "Walldecoration",
        "Chair", "Sofa", "Table", "DiningChair", "Shelf",
        "Lamp", "Plant", "Decoration", "Appliance", "Storage"
    ];

    public SettingsService(IWebHostEnvironment env)
    {
        _path = Path.Combine(env.ContentRootPath, "Data", "settings.json");
    }

    public List<string> GetKnownRoomTypes()  => ReadList("knownRoomTypes",  DefaultRoomTypes);
    public List<string> GetKnownCategories() => ReadList("knownCategories", DefaultCategories);

    public void SetKnownRoomTypes(List<string> names)       => WriteList("knownRoomTypes",  names);
    public void SetKnownCategories(List<string> categories) => WriteList("knownCategories", categories);

    private List<string> ReadList(string key, List<string> defaults)
    {
        try
        {
            if (!File.Exists(_path)) return new(defaults);
            using var doc = JsonDocument.Parse(File.ReadAllText(_path));
            if (doc.RootElement.TryGetProperty(key, out var arr))
            {
                var list = arr.EnumerateArray()
                    .Select(e => e.GetString() ?? "")
                    .Where(s => s.Length > 0)
                    .ToList();
                return list.Count > 0 ? list : new(defaults);
            }
        }
        catch { }
        return new(defaults);
    }

    private void WriteList(string key, List<string> values)
    {
        _lock.Wait();
        try
        {
            JsonObject obj = [];
            try
            {
                if (File.Exists(_path))
                    obj = JsonNode.Parse(File.ReadAllText(_path))?.AsObject() ?? [];
            }
            catch { }
            obj[key] = JsonSerializer.SerializeToNode(values);
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            File.WriteAllText(_path, obj.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        }
        finally { _lock.Release(); }
    }
}
