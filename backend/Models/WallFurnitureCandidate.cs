namespace backend.Models;

/// <summary>
/// A distinct wall-mounted "furniture" placement found while parsing a .tbx file
/// (see TbxParserService) — e.g. a door/window/arch placed via
/// &lt;object type="furniture"&gt; instead of the normal type="door"/"window".
/// Deduplicated per building by <see cref="Signature"/> so the same multi-tile
/// design used many times only needs classifying once. Multi-tile entries (e.g.
/// a 2-wide arch, or a door tile sitting right next to a window tile) are
/// classified per individual tile, not per whole entry — <see cref="Tiles"/>.
/// </summary>
public class WallFurnitureCandidate
{
    /// <summary>Stable group identity key derived from all tile names in the block — see TbxParserService.ComputeWallFurnitureSignature.</summary>
    public string Signature { get; set; } = string.Empty;
    /// <summary>How many times this entry was placed in the building.</summary>
    public int Count { get; set; }
    /// <summary>The individual sub-tiles of this entry, each independently classifiable.</summary>
    public List<WallFurnitureTileCandidate> Tiles { get; set; } = [];
}

/// <summary>One sub-tile of a WallFurnitureCandidate, with its own classification.</summary>
public class WallFurnitureTileCandidate
{
    /// <summary>Tile name (also the classification store's lookup key), e.g. "fixtures_doors_01_112".</summary>
    public string Name { get; set; } = string.Empty;
    /// <summary>Current classification from the persisted global store, or null if never classified.</summary>
    public string? Classification { get; set; }
}
