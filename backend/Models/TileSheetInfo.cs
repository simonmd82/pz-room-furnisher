namespace backend.Models;

public class TileSheetInfo
{
    public string Name         { get; set; } = string.Empty;
    public int    SpriteWidth  { get; set; } = 128;
    public int    SpriteHeight { get; set; } = 256;
    public int    SheetWidth   { get; set; }
    public int    SheetHeight  { get; set; }
    public int    Columns      { get; set; }
    public int    Rows         { get; set; }
    public int    SpriteCount  { get; set; }
    public int    DefinedCount { get; set; }
}
