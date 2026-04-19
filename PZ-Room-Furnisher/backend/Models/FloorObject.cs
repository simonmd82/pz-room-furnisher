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
    public int X { get; set; }
    public int Y { get; set; }
    public Direction Dir { get; set; }
    public string Tile { get; set; } = string.Empty;
}

