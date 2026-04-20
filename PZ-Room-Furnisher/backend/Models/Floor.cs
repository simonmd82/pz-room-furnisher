namespace backend.Models;

public class Floor
{
    public int Index { get; set; }
    /// <summary>
    /// RoomGrid[row][col] — 0 = no room, 1..N = index into Building.Rooms (1-based)
    /// </summary>
    public int[][] RoomGrid { get; set; } = [];
    public List<FloorObject> Objects { get; set; } = [];

    /// <summary>
    /// All doors and windows expressed as shared edges between two cells.
    /// Used by the furniture-placement system to query passability from either side.
    /// </summary>
    public List<WallEdge> Edges { get; set; } = [];
}

