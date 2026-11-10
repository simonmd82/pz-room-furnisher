namespace backend.Models;

using System.Text.Json.Serialization;

public class TileDefinition
{
    /// <summary>
    /// Storage/identity key. Equal to TileId for 1×1 pieces; for multi-cell pieces
    /// suffixed with the footprint shape ("{TileId}#{cols}x{rows}") so two different
    /// footprints that happen to share the same starting sprite (TileId) don't collide.
    /// See <see cref="ComputeId"/>.
    /// </summary>
    public string Id            { get; set; } = string.Empty;
    /// <summary>e.g. "furniture_seating_indoor_01_018" — the anchor/root tile (top-left cell)</summary>
    public string TileId        { get; set; } = string.Empty;
    public string Label         { get; set; } = string.Empty;
    /// <summary>N | S | E | W — facing direction of the whole piece</summary>
    public string Orientation   { get; set; } = "N";
    /// <summary>
    /// 2-D layout grid [row][col] of TileIds.
    /// Empty string = unoccupied cell.
    /// </summary>
    public List<List<string>> TileLayout { get; set; } = [[""]];
    /// <summary>Logical group for randomiser, e.g. "seating", "storage"</summary>
    public string Group         { get; set; } = string.Empty;
    /// <summary>Furniture | Furniture2 | … | FloorFurniture</summary>
    public string Layer         { get; set; } = "Furniture";
    public string Notes         { get; set; } = string.Empty;

    // ── Unified properties ────────────────────────────────────────────────
    public bool IsHigh          { get; set; } = true;
    public bool IsMedium        { get; set; } = false;
    public bool IsLow           { get; set; } = false;
    public bool IsWallMounted   { get; set; } = false;
    public bool HasSurface      { get; set; } = false;
    public bool HasCollision    { get; set; } = true;
    public bool CanStack        { get; set; } = false;
    /// <summary>True if this tile is a table-top surface (on top of another object).</summary>
    public bool IsTableTop      { get; set; } = false;
    /// <summary>
    /// True if this tile is a loot container (Schrank, Truhe, etc.).
    /// Der Generator prüft dann, ob jede Footprint-Zelle von mindestens einer
    /// freien Nachbarzelle aus erreichbar bleibt (Moore-Nachbarschaft, Reichweite 1).
    /// </summary>
    public bool IsLootContainer { get; set; } = false;
    /// <summary>
    /// True if this wall piece hangs high enough to sit above a window (e.g. kitchen hanging
    /// counters). Skips the window check only — IsHigh still counts for the one-high-piece-per-cell
    /// rule, light switches and doors/openings.
    /// </summary>
    public bool AllowAboveWindow { get; set; } = false;

    // ── Randomiser meta ───────────────────────────────────────────────────
    /// <summary>Colour tags, e.g. ["Brown","Wood"]</summary>
    public List<string> Colors       { get; set; } = [];
    /// <summary>Material tags, e.g. ["Holz","Metall"]</summary>
    public List<string> Materials    { get; set; } = [];
    /// <summary>Applicable room types, e.g. ["Bedroom","LivingRoom"]</summary>
    public List<string> RoomTypes    { get; set; } = [];
    /// <summary>Links orientation-variants of the same physical object (empty = no link)</summary>
    public string VariantGroup       { get; set; } = string.Empty;
    /// <summary>Style tags – stored but not yet consumed by the generator</summary>
    public List<string> StyleTags    { get; set; } = [];
    /// <summary>
    /// Motif themes, e.g. ["Cars","Music"]. Only meaningful for themed categories
    /// (settings "themedCategories", e.g. Picture/Poster); slots with AllowedThemes filter on it.
    /// </summary>
    public List<string> Themes       { get; set; } = [];
    /// <summary>
    /// Erlaubte Orientierungen für dieses Tile (z.B. ["E","S"] für Bilder/Poster).
    /// Leer = alle 4 Richtungen erlaubt.
    /// </summary>
    public List<string> AllowedOrients { get; set; } = [];
    /// <summary>
    /// Optionale fensterkritische Kante (N|E|S|W). Wenn gesetzt, darf nur diese
    /// Kante keine Fensterzellen berühren.
    /// </summary>
    public string WindowBlockedEdge { get; set; } = string.Empty;
    /// <summary>
    /// true (default) = Orientation/AllowedOrients are authored as the direction the piece
    /// faces (this tool's historical convention). false = authored directly in Project
    /// Zomboid's own editor convention instead (the wall side the piece sits against, e.g.
    /// a cabinet against the west wall is "W" even though it faces east) — lets new tiles be
    /// copied straight from the PZ editor without manually inverting N/S/E/W by hand.
    /// Existing tiles keep this true so their already-authored values keep working unchanged.
    /// </summary>
    public bool UseFacingOrientation { get; set; } = true;

    /// <summary>
    /// Computes the identity key for a piece from its root tile id and footprint shape.
    /// 1×1 pieces key by the bare tileId (unchanged from historical behavior); multi-cell
    /// pieces get a shape suffix so two different footprints sharing the same starting
    /// sprite (e.g. a 1×2 and a 1×3 desk both starting on the same tile) don't collide.
    /// Mirrored in frontend/src/types/tiles.ts (computeTileDefId) — keep both in sync.
    /// </summary>
    public static string ComputeId(string tileId, int cols, int rows) =>
        (cols <= 1 && rows <= 1) ? tileId : $"{tileId}#{cols}x{rows}";

    /// <summary>Computes this instance's identity key from its own TileId + TileLayout shape.</summary>
    public string ComputeOwnId()
    {
        int cols = TileLayout.Count > 0 ? (TileLayout[0]?.Count ?? 1) : 1;
        int rows = TileLayout.Count;
        return ComputeId(TileId, cols, rows);
    }
}
