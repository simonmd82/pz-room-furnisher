namespace backend.Models;

public class Building
{
    public int Width { get; set; }
    public int Height { get; set; }
    /// <summary>Room definitions, 1-based (index 0 = "no room" / outside)</summary>
    public List<Room> Rooms { get; set; } = [];
    public List<Floor> Floors { get; set; } = [];
    /// <summary>
    /// Originale TBX-Struktur für verlustarmen Roundtrip-Import/-Export.
    /// Parser und Exporter können damit Root-Metadaten, Tile-Listen und andere
    /// nicht-geometrische TBX-Daten erhalten, ohne das eigentliche Building-Modell
    /// zu überladen.
    /// </summary>
    public global::backend.Models.TbxMetadata Tbx { get; set; } = new();
    /// <summary>
    /// Distinct wall-mounted door/window/arch pieces placed via the generic
    /// &lt;object type="furniture"&gt; mechanism (see TbxParserService), for the
    /// frontend's classification review panel.
    /// </summary>
    public List<WallFurnitureCandidate> WallFurnitureCandidates { get; set; } = [];
}
