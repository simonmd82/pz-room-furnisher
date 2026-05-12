namespace backend.Models;

using System.Text.Json.Serialization;

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
    /// </summary>
    public List<List<string>> TileLayout { get; set; } = [[""]];
    /// <summary>Logical group for randomiser, e.g. "seating", "storage"</summary>
    public string Group         { get; set; } = string.Empty;
    /// <summary>Furniture | Furniture2 | … | FloorFurniture</summary>
    public string Layer         { get; set; } = "Furniture";
    public string Notes         { get; set; } = string.Empty;

    // ── Unified properties ────────────────────────────────────────────────
    public bool IsHigh          { get; set; } = true;
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

    // ── Randomiser meta ───────────────────────────────────────────────────
    /// <summary>Colour tags, e.g. ["Brown","Wood"]</summary>
    public List<string> Colors       { get; set; } = [];
    /// <summary>Applicable room types, e.g. ["Bedroom","LivingRoom"]</summary>
    public List<string> RoomTypes    { get; set; } = [];
    /// <summary>Links orientation-variants of the same physical object (empty = no link)</summary>
    public string VariantGroup       { get; set; } = string.Empty;
    /// <summary>Style tags – stored but not yet consumed by the generator</summary>
    public List<string> StyleTags    { get; set; } = [];
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
}




