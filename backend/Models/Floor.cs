namespace backend.Models;

public enum StairWaypointType
{
    Ascending,   // Aufgang – dieses Stockwerk, letztes Treppenfeld (i = 4)
    Descending   // Abgang  – Stockwerk darüber, erstes Treppenfeld (i = 0)
}

/// <summary>
/// The single traversable cell of a staircase on a given floor.
/// Ascending = bottom-floor entry (last span cell, i=4).
/// Descending = upper-floor entry (first span cell, i=0).
/// </summary>
public class StairWaypoint
{
    public int Col { get; set; }
    public int Row { get; set; }
    public StairWaypointType WaypointType { get; set; }
}

public class Floor
{
    public int Index { get; set; }
    /// <summary>RoomGrid[row][col] — 0 = no room, 1..N = 1-based room index</summary>
    public int[][] RoomGrid { get; set; } = [];
    /// <summary>Raw TBX-Attributmatrix je Zelle. 0 = kein besonderes Attribut.</summary>
    public int[][] AttributesGrid { get; set; } = [];
    /// <summary>
    /// Raw TBX layer matrices, keyed by layer name (e.g. Furniture, Furniture2,
    /// FloorFurniture, WallFurniture). Values are TBX user-tile indices.
    /// </summary>
    public Dictionary<string, int[][]> TileLayers { get; set; } = [];
    public List<FloorObject> Objects { get; set; } = [];
    /// <summary>All doors and windows as shared cell-edges.</summary>
    public List<WallEdge> Edges { get; set; } = [];
    /// <summary>
    /// Stair entry/exit points pre-computed during TBX parse.
    /// Each staircase contributes one Ascending waypoint on its own floor
    /// and one Descending waypoint on the floor above.
    /// </summary>
    public List<StairWaypoint> StairWaypoints { get; set; } = [];
    /// <summary>Wall-hugging traversal paths per room. Key = 1-based room index.</summary>
    public Dictionary<int, List<int[]>> PathsByRoom { get; set; } = [];
}
