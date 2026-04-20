namespace backend.Models;

public class Building
{
    public int Width { get; set; }
    public int Height { get; set; }
    /// <summary>Room definitions, 1-based (index 0 = "no room" / outside)</summary>
    public List<Room> Rooms { get; set; } = [];
    public List<Floor> Floors { get; set; } = [];
}
