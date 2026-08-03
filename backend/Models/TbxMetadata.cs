namespace backend.Models;

/// <summary>
/// Zusätzliche TBX-Roundtrip-Daten, die nicht direkt Teil des abstrakten
/// Building-/Room-/Floor-Modells sind, beim Export aber möglichst unverändert
/// wieder ausgegeben werden sollen.
/// </summary>
public class TbxMetadata
{
    /// <summary>
    /// Alle Root-Attribute des Building-Elements außer width/height, z.B.
    /// version, ExteriorWall, Door, Window, RoofCap, ...
    /// </summary>
    public Dictionary<string, string> RootAttributes { get; set; } = [];

    /// <summary>
    /// Geordnete Liste aller tile_entry-Blöcke. Eine Liste statt Dictionary,
    /// weil Kategorien wie "floors" mehrfach vorkommen und die Reihenfolge im
    /// Original erhalten bleiben soll.
    /// </summary>
    public List<TbxTileEntryBlock> TileEntries { get; set; } = [];

    /// <summary>
    /// Geordnete Liste aller Möbel-/User-Tiles. Der TBX-interne Index ist 1-basiert
    /// und ergibt sich aus der Position in dieser Liste.
    /// </summary>
    public List<string> UserTiles { get; set; } = [];

    /// <summary>
    /// Originale used_tiles-Werte der TBX. Gehören zur Basistile-Struktur des
    /// Gebäudes und sind von den Möbel-Layern getrennt.
    /// </summary>
    public List<int> UsedTiles { get; set; } = [];

    /// <summary>
    /// Raw content of used_furniture. Currently preserved as-is until its exact
    /// semantics are implemented.
    /// </summary>
    public string UsedFurnitureRaw { get; set; } = string.Empty;
}

/// <summary>
/// Ein einzelner tile_entry-Block inkl. aller enthaltenen Tiles.
/// </summary>
public class TbxTileEntryBlock
{
    public string Category { get; set; } = string.Empty;
    public List<TbxTileEntry> Tiles { get; set; } = [];
}

/// <summary>
/// Ein einzelnes tile-Element innerhalb eines tile_entry-Blocks.
/// </summary>
public class TbxTileEntry
{
    public string Enum { get; set; } = string.Empty;
    public string Tile { get; set; } = string.Empty;
    /// <summary>Optionales raw offset-Attribut, z.B. "-1,-1".</summary>
    public string Offset { get; set; } = string.Empty;
}
