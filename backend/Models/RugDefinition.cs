namespace backend.Models;

/// <summary>The 9 fixed authoring roles a modular rug design assigns one explicit tileId to.</summary>
public static class RugRole
{
    public const string TL = "TL", TR = "TR", BL = "BL", BR = "BR";
    public const string N = "N", S = "S", E = "E", W = "W";
    public const string Center = "Center";
    public static readonly string[] All = [TL, TR, BL, BR, N, S, E, W, Center];
}

/// <summary>One fixed-size hand-baked layout for a "preassembled" rug design (today's baked-tile mechanism).</summary>
public class RugPreassembledSize
{
    public int Width  { get; set; }
    public int Height { get; set; }
    /// <summary>Same 2-D [row][col] tileId grid convention as TileDefinition.TileLayout.</summary>
    public List<List<string>> TileLayout { get; set; } = [[""]];
}

/// <summary>
/// A rug "design" in the rug catalog — either a modular (9-role, stretchable to any size) rug
/// or a preassembled (fixed-size, hand-baked) rug. Lives in its own catalog file
/// (rug-definitions.json) rather than as TileDefinition entries, so rug-role metadata doesn't
/// bloat the general tile schema/Tile Browser.
/// </summary>
public class RugDefinition
{
    public string Id    { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    /// <summary>"modular" | "preassembled".</summary>
    public string Mode  { get; set; } = "modular";
    /// <summary>
    /// Which TileConfigSet (vanilla/melos/…) this design's piece tileIds come from. Used to
    /// scope the editor's sprite picker and, at generation time, to skip this design entirely
    /// if that set is disabled (mirrors TileConfigSetInfo.Enabled semantics).
    /// </summary>
    public string TileSetId { get; set; } = "vanilla";
    /// <summary>Room types this rug design may appear in (empty = all). Mirrors TileDefinition.RoomTypes.</summary>
    public List<string> RoomTypes { get; set; } = [];
    /// <summary>Category tag matched against a rug slot's AllowedCategories, e.g. "Rug".</summary>
    public string Group { get; set; } = "Rug";
    public List<string> Colors    { get; set; } = [];
    public List<string> Materials { get; set; } = [];
    public string VariantGroup    { get; set; } = string.Empty;

    // ── Mode == "modular" ────────────────────────────────────────────────
    /// <summary>Exactly the 9 roles in RugRole.All → one tileId each. Populated only when Mode=="modular".</summary>
    public Dictionary<string, string> Pieces { get; set; } = new();
    /// <summary>Smallest W×H this modular design can stretch to (content constraint).</summary>
    public int MinWidth  { get; set; } = 2;
    public int MinHeight { get; set; } = 2;

    // ── Mode == "preassembled" ───────────────────────────────────────────
    /// <summary>One entry per fixed size this design was hand-baked at (mirrors today's #WxH TileDefinition variants).</summary>
    public List<RugPreassembledSize> PreassembledSizes { get; set; } = [];
}
