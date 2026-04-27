namespace backend.Models;

public enum FloorObjectType
{
    Door,
    Window,
    Stairs,
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
}
