namespace backend.Models;

public class Room
{
    /// <summary>Short unique id assigned on parse, used for path recomputation.</summary>
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string InternalName { get; set; } = string.Empty;
    /// <summary>Raw color string from TBX, e.g. "255 0 0"</summary>
    public string Color { get; set; } = string.Empty;
    public int InteriorWall { get; set; }
    public int InteriorWallTrim { get; set; }
    public int FloorTile { get; set; }
    public int GrimeFloor { get; set; }
    public int GrimeWall { get; set; }
    public int Ceiling { get; set; }
}
