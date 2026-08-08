using System.Text.Json;
using System.Text.Json.Nodes;

namespace backend.Services;

public interface IWallFurnitureClassificationService
{
    Dictionary<string, string> GetAll();
    void Set(string signature, string classification);
}

/// <summary>
/// Global, persisted store mapping an individual wall-furniture tile name (e.g.
/// "fixtures_doors_01_112") to a user-chosen classification
/// ("WindowHigh" | "WindowHighLow" | "Door" | "Ignore"). Keyed per tile rather
/// than per whole multi-tile entry so adjacent sub-tiles within the same entry
/// (e.g. a door tile placed right next to a window tile) can be classified
/// independently. Ships/commits normally (unlike the machine-local
/// tiles/BuildingFurniture.txt paths) since it describes tileset content, not a
/// local file path.
/// </summary>
public class WallFurnitureClassificationService : IWallFurnitureClassificationService
{
    private readonly string _path;
    private readonly SemaphoreSlim _lock = new(1, 1);

    public WallFurnitureClassificationService(IWebHostEnvironment env)
    {
        _path = Path.Combine(env.ContentRootPath, "Data", "wall-furniture-classifications.json");
    }

    public Dictionary<string, string> GetAll()
    {
        try
        {
            if (!File.Exists(_path)) return [];
            using var doc = JsonDocument.Parse(File.ReadAllText(_path));
            var result = new Dictionary<string, string>();
            foreach (var prop in doc.RootElement.EnumerateObject())
            {
                var value = prop.Value.GetString();
                if (!string.IsNullOrEmpty(value))
                    result[prop.Name] = value;
            }
            return result;
        }
        catch { return []; }
    }

    public void Set(string signature, string classification)
    {
        if (string.IsNullOrWhiteSpace(signature)) return;

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

            obj[signature] = classification;

            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            File.WriteAllText(_path, obj.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        }
        finally { _lock.Release(); }
    }
}
