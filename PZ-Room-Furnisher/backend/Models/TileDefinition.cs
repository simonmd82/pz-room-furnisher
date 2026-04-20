namespace backend.Models;

using System.Text.Json;
using System.Text.Json.Serialization;

/// <summary>
/// Reads either a JSON string ("high") or JSON array (["low","high"]) into List&lt;string&gt;.
/// Allows backward-compatible loading of old tile-definitions.json files.
/// </summary>
internal class StringOrArrayConverter : JsonConverter<List<string>>
{
    public override List<string> Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.String)
            return [reader.GetString()!];
        if (reader.TokenType == JsonTokenType.StartArray)
        {
            var list = new List<string>();
            while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
                if (reader.TokenType == JsonTokenType.String)
                    list.Add(reader.GetString()!);
            return list;
        }
        reader.Skip();
        return [];
    }
    public override void Write(Utf8JsonWriter writer, List<string> value, JsonSerializerOptions options)
    {
        writer.WriteStartArray();
        foreach (var s in value) writer.WriteStringValue(s);
        writer.WriteEndArray();
    }
}

public class TileDefinition
{
    /// <summary>e.g. "furniture_seating_indoor_01_018" — the anchor/root tile (top-left cell)</summary>
    public string TileId        { get; set; } = string.Empty;
    public string Label         { get; set; } = string.Empty;
    /// <summary>N | S | E | W — facing direction of the whole piece</summary>
    public string Orientation   { get; set; } = "N";
    /// <summary>
    /// 2-D layout grid [row][col] of TileIds.
    /// Empty string = unoccupied cell.
    /// Example 1×2 sofa facing S:
    ///   [["furniture_seating_indoor_01_001"],
    ///    ["furniture_seating_indoor_01_002"]]
    /// </summary>
    public List<List<string>> TileLayout { get; set; } = [[""]];
    /// <summary>Height tags: "low", "high" — multiple allowed, e.g. ["low","high"] for a full-height mirror</summary>
    [JsonConverter(typeof(StringOrArrayConverter))]
    public List<string> Height  { get; set; } = ["high"];
    public bool BlocksPathing   { get; set; } = true;
    public bool WallMounted     { get; set; } = false;
    /// <summary>Logical group for randomiser, e.g. "seating", "storage"</summary>
    public string Group         { get; set; } = string.Empty;
    /// <summary>Furniture | Furniture2 | … | FloorFurniture</summary>
    public string Layer         { get; set; } = "Furniture";
    public bool CanStack        { get; set; } = false;
    public PlacementRules PlacementRules { get; set; } = new();
    public string Notes         { get; set; } = string.Empty;

    // ── Randomiser meta ───────────────────────────────────────────────────
    /// <summary>Colour tags, e.g. ["Brown","Wood"]</summary>
    public List<string> Colors       { get; set; } = [];
    /// <summary>Applicable room types, e.g. ["Bedroom","LivingRoom"]</summary>
    public List<string> RoomTypes    { get; set; } = [];
    /// <summary>Relative spawn weight 1–10 (default 5)</summary>
    public int Weight                { get; set; } = 5;
    /// <summary>Max number of this piece per room (0 = unlimited)</summary>
    public int MaxCount              { get; set; } = 0;
    /// <summary>Links orientation-variants of the same physical object (empty = no link)</summary>
    public string VariantGroup       { get; set; } = string.Empty;
    /// <summary>Style tags – stored but not yet consumed by the generator</summary>
    public List<string> StyleTags    { get; set; } = [];
}

public class PlacementRules
{
    public bool NearWall   { get; set; }
    public bool NearDoor   { get; set; }
    public bool NearWindow { get; set; }
    public bool CenterRoom { get; set; }
    public bool CornerOnly { get; set; }
}






