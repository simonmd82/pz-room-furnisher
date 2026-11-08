using System.Text.Json;
using System.Text.Json.Nodes;

namespace backend.Services;

public interface ISettingsService
{
    List<string> GetKnownRoomTypes();
    void         SetKnownRoomTypes(List<string> names);
    List<string> GetKnownCategories();
    void         SetKnownCategories(List<string> categories);
    List<string> GetKnownMaterials();
    void         SetKnownMaterials(List<string> materials);
    List<string> GetKnownColors();
    void         SetKnownColors(List<string> colors);
    /// <summary>Motif themes for Picture/Poster tiles (see TileDefinition.Themes).</summary>
    List<string> GetKnownThemes();
    void         SetKnownThemes(List<string> themes);
    /// <summary>Categories whose tiles carry themes and whose slots can filter by them.</summary>
    List<string> GetThemedCategories();
    void         SetThemedCategories(List<string> categories);
    /// <summary>Colour name → colour-wheel hue in degrees (0–359); null = neutral (see ColorHarmony).</summary>
    Dictionary<string, int?> GetColorHues();
    void                     SetColorHues(Dictionary<string, int?> hues);
}

public class SettingsService : ISettingsService
{
    private readonly string _path;
    private readonly SemaphoreSlim _lock = new(1, 1);

    private static readonly List<string> DefaultRoomTypes =
    [
        "Bedroom", "Kitchen", "Bathroom", "LivingRoom", "Office",
        "Storage", "Hall", "Garage", "Bar", "Restaurant"
    ];

    private static readonly List<string> DefaultCategories =
    [
        "Beds", "Bedtable", "Cabinet", "Mirror", "Walldecoration",
        "Chair", "Sofa", "Table", "DiningChair", "Shelf",
        "Lamp", "Plant", "Decoration", "Appliance", "Storage"
    ];

    private static readonly List<string> DefaultMaterials =
    [
        "Holz", "Metall", "Plastik", "Stein"
    ];

    private static readonly List<string> DefaultColors =
    [
        "Brown", "Black", "White", "Grey", "Red", "Blue", "Green",
        "Yellow", "Metal", "Wood", "Beige", "Mixed"
    ];

    private static readonly List<string> DefaultThemes =
    [
        "Art", "Cars", "Food", "Landscape", "Movies", "Music", "Sports"
    ];

    private static readonly List<string> DefaultThemedCategories = ["Picture", "Poster"];

    /// <summary>Unlisted colours count as neutral, so only chromatic ones need a hue.</summary>
    private static readonly Dictionary<string, int?> DefaultColorHues = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Red"] = 0, ["Orange"] = 30, ["Yellow"] = 55, ["Green"] = 120, ["Blue"] = 220,
        ["Violet"] = 270, ["Purple"] = 285, ["Pink"] = 330,
        ["Beige"] = null, ["Black"] = null, ["Brown"] = null, ["Grey"] = null,
        ["Metal"] = null, ["Mixed"] = null, ["White"] = null, ["Wood"] = null,
    };

    public SettingsService(IWebHostEnvironment env)
    {
        _path = Path.Combine(env.ContentRootPath, "Data", "settings.json");
    }

    public List<string> GetKnownRoomTypes()  => ReadList("knownRoomTypes",  DefaultRoomTypes);
    public List<string> GetKnownCategories() => ReadList("knownCategories", DefaultCategories);
    public List<string> GetKnownMaterials()  => ReadList("knownMaterials",  DefaultMaterials);
    public List<string> GetKnownColors()     => ReadList("knownColors",     DefaultColors);
    public List<string> GetKnownThemes()     => ReadList("knownThemes",     DefaultThemes);
    // Not ReadList: an empty list is a valid choice here (theming off), not "use the defaults".
    public List<string> GetThemedCategories()
    {
        try
        {
            if (File.Exists(_path))
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(_path));
                if (doc.RootElement.TryGetProperty("themedCategories", out var arr) && arr.ValueKind == JsonValueKind.Array)
                    return arr.EnumerateArray().Select(e => e.GetString() ?? "").Where(s => s.Length > 0).ToList();
            }
            // Key fehlt in der Datei → Defaults persistieren
            WriteList("themedCategories", new(DefaultThemedCategories));
        }
        catch { }
        return new(DefaultThemedCategories);
    }

    public void SetKnownRoomTypes(List<string> names)       => WriteList("knownRoomTypes",  names);
    public void SetKnownCategories(List<string> categories) => WriteList("knownCategories", categories);
    public void SetKnownMaterials(List<string> materials)   => WriteList("knownMaterials",  materials);
    public void SetKnownColors(List<string> colors)         => WriteList("knownColors",     colors);
    public void SetKnownThemes(List<string> themes)         => WriteList("knownThemes",     themes);
    public void SetThemedCategories(List<string> categories) => WriteList("themedCategories", categories);

    public Dictionary<string, int?> GetColorHues()
    {
        try
        {
            if (File.Exists(_path))
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(_path));
                if (doc.RootElement.TryGetProperty("colorHues", out var obj) && obj.ValueKind == JsonValueKind.Object)
                {
                    var hues = new Dictionary<string, int?>(StringComparer.OrdinalIgnoreCase);
                    foreach (var p in obj.EnumerateObject())
                        hues[p.Name] = p.Value.ValueKind == JsonValueKind.Number ? NormalizeHue(p.Value.GetInt32()) : null;
                    return hues;
                }
            }
            // Key fehlt in der Datei → Defaults persistieren
            SetColorHues(DefaultColorHues);
        }
        catch { }
        return new(DefaultColorHues, StringComparer.OrdinalIgnoreCase);
    }

    public void SetColorHues(Dictionary<string, int?> hues) =>
        WriteNode("colorHues", JsonSerializer.SerializeToNode(
            hues.Where(kv => !string.IsNullOrWhiteSpace(kv.Key))
                .ToDictionary(kv => kv.Key, kv => kv.Value is { } h ? NormalizeHue(h) : (int?)null)));

    private static int NormalizeHue(int h) => ((h % 360) + 360) % 360;

    private List<string> ReadList(string key, List<string> defaults)
    {
        try
        {
            if (!File.Exists(_path))
            {
                WriteList(key, new(defaults));
                return new(defaults);
            }
            using var doc = JsonDocument.Parse(File.ReadAllText(_path));
            if (doc.RootElement.TryGetProperty(key, out var arr))
            {
                var list = arr.EnumerateArray()
                    .Select(e => e.GetString() ?? "")
                    .Where(s => s.Length > 0)
                    .ToList();
                return list.Count > 0 ? list : new(defaults);
            }
            // Key fehlt in der Datei → Defaults persistieren
            WriteList(key, new(defaults));
        }
        catch { }
        return new(defaults);
    }

    private void WriteList(string key, List<string> values) => WriteNode(key, JsonSerializer.SerializeToNode(values));

    private void WriteNode(string key, JsonNode? value)
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
            obj[key] = value;
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            File.WriteAllText(_path, obj.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        }
        finally { _lock.Release(); }
    }
}

