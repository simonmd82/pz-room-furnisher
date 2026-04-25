namespace backend.Models;

/// <summary>Klassifiziert einen Raum nach Anzahl begehbarer Felder.</summary>
public static class RoomSize
{
    public const string XS = "XS";
    public const string S  = "S";
    public const string M  = "M";
    public const string L  = "L";
    public const string XL = "XL";

    public static string Classify(int fieldCount) => fieldCount switch
    {
        <= 4  => XS,
        <= 12 => S,
        <= 25 => M,
        <= 50 => L,
        _     => XL,
    };
}

/// <summary>Exakter Platzbedarf eines Slots in Zellen (Breite × Höhe).</summary>
public class SlotFootprint
{
    /// <summary>Anzahl Zellen horizontal (Spalten).</summary>
    public int Width  { get; set; } = 1;
    /// <summary>Anzahl Zellen vertikal (Zeilen).</summary>
    public int Height { get; set; } = 1;
}

/// <summary>Platzierungsregeln für einen Slot.</summary>
public class PlacementRules
{
    public bool NearWall   { get; set; }
    public bool NearDoor   { get; set; }
    public bool NearWindow { get; set; }
    public bool CenterRoom { get; set; }
    public bool CornerOnly { get; set; }
}

/// <summary>Min/Max-Anzahl eines Slots für eine bestimmte Raumgröße.</summary>
public class SlotCount
{
    public int Min { get; set; } = 0;
    /// <summary>-1 = unbegrenzt</summary>
    public int Max { get; set; } = -1;
}

/// <summary>Ein Slot-Eintrag in der RoomType-Konfiguration (Ansatz A: verknüpfte Einzel-Slots).</summary>
public class RoomTypeSlot
{
    /// <summary>Eindeutige ID innerhalb des Raumtyps (für Verlinkung über AnchorSlotId).</summary>
    public string Id             { get; set; } = string.Empty;
    /// <summary>Anzeigename, z.B. "Bett", "Nachttisch links".</summary>
    public string Label          { get; set; } = string.Empty;
    /// <summary>Exakter Platzbedarf des Slots in Zellen.</summary>
    public SlotFootprint Footprint { get; set; } = new();
    /// <summary>Muss dieser Slot immer befüllt werden?</summary>
    public bool   Required       { get; set; } = false;
    /// <summary>Priorität beim Ziehen optionaler Slots (niedrig = zuerst).</summary>
    public int    Priority       { get; set; } = 0;
    /// <summary>Min/Max-Anzahl je Raumgröße (XS/S/M/L/XL).</summary>
    public Dictionary<string, SlotCount> CountBySize { get; set; } = new()
    {
        { "XS", new() { Min = 0, Max = 0 } },
        { "S",  new() { Min = 0, Max = 1 } },
        { "M",  new() { Min = 0, Max = 2 } },
        { "L",  new() { Min = 0, Max = 3 } },
        { "XL", new() { Min = 0, Max = 4 } },
    };
    /// <summary>
    /// Erlaubte Möbelkategorien mit Auswahlgewichtung (Kategorie → Gewicht 1–10).
    /// Der Generator lost zuerst eine Kategorie (nach Gewichtung) und wählt dann
    /// ein passendes Möbelstück aus dieser Kategorie zufällig aus.
    /// Leer = alle passenden Kategorien gleichwertig.
    /// </summary>
    public Dictionary<string, int> AllowedCategories { get; set; } = [];
    /// <summary>Platzierungsregeln für diesen Slot (an Wand, Ecke, Fenster …).</summary>
    public PlacementRules PlacementRules { get; set; } = new();
    /// <summary>
    /// Erlaubter Furniture-Layer (leer = beliebig).
    /// z.B. "Furniture", "FloorFurniture", "Wallfurniture".
    /// </summary>
    public string RequiredLayer  { get; set; } = string.Empty;
    /// <summary>
    /// Erforderliche Möbeleigenschaften, z.B. ["ProvidesSurface", "IsLow"].
    /// Nur Möbel, die alle genannten Eigenschaften erfüllen, kommen in Frage.
    /// </summary>
    public List<string> RequiredProperties { get; set; } = [];
    /// <summary>
    /// Anker-Regeln: verknüpft diesen Slot relativ zu anderen Slots oder Gruppen.
    /// Jede Regel gibt einen Anker (Slot-ID oder SlotGroupId) und erlaubte Positionen an.
    /// Leer = freie Platzierung.
    /// </summary>
    public List<AnchorRule> AnchorRules { get; set; } = [];

    /// <summary>
    /// Varianten-Gruppe: Alle Slots mit gleicher SlotGroupId bilden eine Gruppe.
    /// Der Generator wählt genau eine Variante daraus aus.
    /// Leer = kein Gruppen-Modus (Slot ist unabhängig).
    /// </summary>
    public string SlotGroupId   { get; set; } = string.Empty;
    /// <summary>
    /// Verarbeitungsmodus der Gruppe.
    /// "one-of" = genau eine Variante wird zufällig (nach GroupWeight) gewählt.
    /// Leer = kein Gruppen-Modus.
    /// </summary>
    public string SlotGroupMode { get; set; } = string.Empty;
    /// <summary>
    /// Gewichtung innerhalb der Varianten-Gruppe (1–10).
    /// Höherer Wert → wird häufiger gewählt.
    /// </summary>
    public int GroupWeight { get; set; } = 5;
}

/// <summary>Konfiguration für einen Raumtyp (z.B. "Bedroom").</summary>
public class RoomTypeConfig
{
    public string RoomType            { get; set; } = string.Empty;
    public List<RoomTypeSlot> Slots   { get; set; } = [];
}

