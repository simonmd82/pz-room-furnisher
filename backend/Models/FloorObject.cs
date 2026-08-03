namespace backend.Models;

public enum FloorObjectType
{
    Door,
    Window,
    Stairs,
    Opening,    // type="wall" InteriorTile=0: gap in auto-generated room-boundary wall
    InnerWall,  // type="wall" InteriorTile>0: free-standing wall within a room
    Other
}

public enum Direction
{
    N,
    S,
    E,
    W
}

public class FloorObject
{
    public FloorObjectType Type { get; set; }
    /// <summary>Raw type string from TBX for lossless round-trip export (e.g. "door", "furniture").</summary>
    public string OriginalType { get; set; } = string.Empty;
    public int X { get; set; }
    public int Y { get; set; }
    public Direction Dir { get; set; }
    public string Tile { get; set; } = string.Empty;
    /// <summary>
    /// Zusätzliche rohe XML-Attribute des TBX-Objekts (z.B. FrameTile,
    /// CurtainsTile, ShuttersTile), damit spätere Exporte verlustarm bleiben.
    /// Bekannte Kernfelder (type/x/y/dir/Tile) werden hier nicht doppelt geführt.
    /// </summary>
    public Dictionary<string, string> RawAttributes { get; set; } = [];
}
