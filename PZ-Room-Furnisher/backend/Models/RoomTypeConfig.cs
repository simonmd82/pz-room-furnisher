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
    /// <summary>
    /// Darf dieser Slot um 90° gedreht platziert werden?
    /// Nur relevant bei nicht-quadratischem Footprint (Width ≠ Height).
    /// </summary>
    public bool CanRotate { get; set; } = false;
}

/// <summary>Platzierungsregeln für einen Slot.</summary>
public class PlacementRules
{
    public bool NearWall    { get; set; }
    public bool NearDoor    { get; set; }
    public bool NearWindow  { get; set; }
    public bool CenterRoom  { get; set; }
    public bool CornerOnly  { get; set; }
    /// <summary>
    /// Darf dieser Slot auf Pfad-Zellen (Laufwegen) platziert werden?
    /// false (Standard): Möbel mit HasCollision=true werden von Pfad-Zellen ferngehalten.
    /// true: Pfad-Zellen sind erlaubt (z.B. Teppiche ohne Kollision).
    /// </summary>
    public bool AllowOnPath { get; set; } = false;

    /// <summary>
    /// Wenn true und der Raum durch Innenwände in Teilbereiche unterteilt ist,
    /// wird der Slot auf den Hauptbereich (größter/türnächster Teilbereich) beschränkt.
    /// Kein Effekt wenn keine Innenwände vorhanden.
    /// </summary>
    public bool MainSubRoom { get; set; } = false;

    /// <summary>
    /// Ausrichtung zur Wand (nur relevant wenn NearWall=true).
    /// "perpendicular": Rücken an Wand, Vorderseite in den Raum (Bett, Schreibtisch).
    ///   Bevorzugt Tile-Variante mit langer Achse senkrecht zur Wand.
    /// "parallel": Längsseite entlang der Wand (Sofa, Regal).
    ///   Bevorzugt Tile-Variante mit langer Achse parallel zur Wand.
    /// "any": automatisch (Standard).
    /// </summary>
    public string WallAlignment { get; set; } = "any";
}

/// <summary>Min/Max-Anzahl eines Slots für eine bestimmte Raumgröße.</summary>
public class SlotCount
{
    public int Min { get; set; } = 0;
    /// <summary>-1 = unbegrenzt</summary>
    public int Max { get; set; } = -1;
}

/// <summary>
/// Eine Anker-Regel: verknüpft einen Slot mit einem anderen Slot oder einer SlotGroupId.
/// Positions enthält die erlaubten Positionen (OR – Generator wählt eine davon).
/// </summary>
public class AnchorRule
{
    /// <summary>Slot-ID eines anderen Slots ODER eine SlotGroupId.</summary>
    public string AnchorTarget { get; set; } = string.Empty;
    /// <summary>Erlaubte relative Positionen (OR: Generator wählt eine). Leer = beliebig.</summary>
    public List<string> Positions { get; set; } = [];
    /// <summary>
    /// Versatz entlang der Ankerkante (nur für LongSide0/1 und ShortSide0/1).
    /// 0 = erste Zelle, 1 = zweite, -1 = letzte, -2 = vorletzte usw.
    /// </summary>
    public int OffsetAlongAnchor { get; set; } = 0;
    /// <summary>Mindestdistanz (in Zellen) fuer oppositeWall.</summary>
    public int? MinOppositeWallDistance { get; set; }
    /// <summary>Maximaldistanz (in Zellen) fuer oppositeWall. Null/&lt;=0 = ohne Limit.</summary>
    public int? MaxOppositeWallDistance { get; set; }
    /// <summary>
    /// Ausrichtung des verankerten Slots relativ zum Anker.
    /// "match"            = gleiche Ausrichtung wie der Anker-Slot (z.B. Nachttisch neben Bett).
    /// "parallelToAnchor" = Alias für "match"; semantisch klarer für Möbel, die parallel zum Anker stehen sollen.
    /// "opposite"         = entgegengesetzte Ausrichtung (z.B. Stuhl zeigt zum Tisch).
    /// "N"/"S"/"E"/"W" = fixe Ausrichtung.
    /// Leer / null = tile.Orientation (bisheriges Verhalten).
    /// </summary>
    public string? Orient { get; set; }
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

    /// <summary>
    /// Fallback-Platzierungsregeln (geordnete Liste).
    /// Wenn PlacementRules keine freie Zelle findet, versucht der Generator
    /// diese Regeln der Reihe nach als Alternativen.
    /// Nur bei Required=true relevant – optionale Slots werden einfach weggelassen.
    /// </summary>
    public List<PlacementRules> FallbackRules { get; set; } = [];

    /// <summary>
    /// Wenn false, werden die Footprint-Zellen nach Platzierung NICHT in occupied eingetragen.
    /// Nachfolgende Slots können dieselben Zellen belegen (z.B. Möbel auf Teppich).
    /// Standard: true.
    /// </summary>
    public bool BlocksPlacement { get; set; } = true;

    /// <summary>
    /// Wenn true und BlocksPlacement=false, werden die Footprint-Zellen in softOccupied eingetragen.
    /// Normale Slots (kein RequiresSlot) respektieren softOccupied und landen nicht auf diesen Zellen.
    /// Slots mit RequiresSlot ignorieren softOccupied – sie dürfen bewusst auf das Ankermöbel platziert werden.
    /// Typischer Einsatz: Nachttisch (blocksPlacement:false, softBlocks:true).
    /// Standard: false.
    /// </summary>
    public bool SoftBlocks { get; set; } = false;

    /// <summary>
    /// Wenn true, wird die Zelle vor der Vorderseite des platzierten Tiles
    /// (gemäß Orientierung) zusätzlich in occupied eingetragen.
    /// Andere Slots können diese Zelle dann nicht belegen, der Spieler kann
    /// aber weiterhin hineinlaufen (keine physicalOccupied-Eintragung).
    /// Typischer Einsatz: Herd, Kühlschrank – Zelle davor soll frei bleiben.
    /// Standard: false.
    /// </summary>
    public bool BlocksFrontCell { get; set; } = false;

    /// <summary>
    /// Bedingte Abhängigkeit: Dieser Slot wird nur versucht wenn der Slot mit dieser ID
    /// (oder SlotGroupId) zuvor erfolgreich platziert wurde.
    /// Nützlich für Objekte die eine Oberfläche benötigen (Lampe → Tisch, Waschbecken → Unterschrank).
    /// Leer = keine Abhängigkeit (Standard-Verhalten).
    /// </summary>
    public string RequiresSlot { get; set; } = string.Empty;

    /// <summary>
    /// Farbgruppen-ID für kohärente Farbwahl.
    ///   Leer    = erbt ColorGroupId vom Raumtyp (RoomTypeConfig.ColorGroupId).
    ///   "none"  = kein Farbfilter für diesen Slot (überschreibt den Raum-Default).
    ///   Anderer Wert = eigene Gruppe (z.B. "accent") – unabhängig vom Raum-Default.
    /// Beim ersten platzierten Slot einer Gruppe wird die Farbe aus dem Tile-Pool gezogen
    /// und für alle Folge-Slots der Gruppe als Filter verwendet. Kein Match → Fallback auf
    /// ungefilterten Pool (Slot wird nicht weggelassen).
    /// </summary>
    public string ColorGroupId { get; set; } = string.Empty;

    /// <summary>
    /// Tile-Varianten-Gruppen-ID für kohärente Modellwahl (gleicher Variantensatz).
    /// Slots mit gleicher TileGroupId erzwingen, dass alle Tiles aus derselben VariantGroup stammen.
    ///   Leer  = keine Bindung (jeder Slot wählt unabhängig).
    ///   Wert  = z.B. "dining_chairs" – der erste Slot der Gruppe friert die VariantGroup ein
    ///           (z.B. "chair_beige_01"), alle Folge-Slots filtern ihre Kandidaten auf genau
    ///           diese VariantGroup. Kein Match → ungefilterten Pool behalten.
    /// </summary>
    public string TileGroupId { get; set; } = string.Empty;

    /// <summary>
    /// Material-Filter für diesen Slot (AND-verknüpft mit Farbfilter).
    ///   Leer   = kein Materialfilter.
    ///   "none" = kein Materialfilter für diesen Slot (explizit deaktiviert).
    ///   Wert   = nur Tiles deren Materials-Liste diesen Wert enthält kommen in Frage.
    /// </summary>
    public string MaterialGroupId { get; set; } = string.Empty;
}

/// <summary>Companion slot spawned when its parent required-pool-slot is placed (e.g. cooking hood above stove).</summary>
public class LayoutPoolCompanion
{
    public string AnchorPosition     { get; set; } = string.Empty;
    public string? Orient            { get; set; }
    public Dictionary<string, int>  AllowedCategories  { get; set; } = [];
    public List<string>             RequiredProperties { get; set; } = [];
    public string RequiredLayer      { get; set; } = string.Empty;
    public string Label              { get; set; } = string.Empty;
    public bool BlocksFrontCell      { get; set; } = false;
    public bool BlocksPlacement      { get; set; } = true;
    public bool SoftBlocks           { get; set; } = false;
}

/// <summary>A guaranteed-typed position within a pool segment (e.g. "exactly 1 stove").</summary>
public class LayoutPoolRequiredSlot
{
    public string Category           { get; set; } = string.Empty;
    public int    Weight             { get; set; } = 5;
    public int    Count              { get; set; } = 1;
    public string Label              { get; set; } = string.Empty;
    public List<string> RequiredProperties { get; set; } = [];
    /// <summary>Override pool's RequiredLayer for this position. Empty = inherit pool layer.</summary>
    public string RequiredLayer      { get; set; } = string.Empty;
    public bool BlocksFrontCell      { get; set; } = false;
    public bool BlocksPlacement      { get; set; } = false;
    public bool SoftBlocks           { get; set; } = true;
    public List<LayoutPoolCompanion> Companions { get; set; } = [];
}

/// <summary>Min/max slot count for a pool segment per room size.</summary>
public class LayoutPoolCountRange
{
    public int Min { get; set; } = 0;
    public int Max { get; set; } = 0;
}

/// <summary>
/// A dynamic chain of N wall-adjacent slots within a LayoutVariant.
/// The generator expands this at runtime into RoomTypeSlot instances chained by anchor rules.
/// </summary>
public class LayoutPool
{
    public string Id                 { get; set; } = string.Empty;
    public string Label              { get; set; } = string.Empty;
    public Dictionary<string, LayoutPoolCountRange> TotalCountBySize { get; set; } = new();
    public string AnchorTarget       { get; set; } = string.Empty;
    public string FirstAnchorPosition { get; set; } = string.Empty;
    /// <summary>Orient for the first pool slot's anchor rule. Null/"" defaults to "match".</summary>
    public string? FirstOrient       { get; set; }
    public string ChainAnchorPosition { get; set; } = string.Empty;
    /// <summary>Orient for chained pool slots. Null/"" defaults to "match".</summary>
    public string? ChainOrient       { get; set; }
    public PlacementRules PlacementRules { get; set; } = new();
    public string RequiredLayer      { get; set; } = string.Empty;
    public Dictionary<string, int> DefaultCategories { get; set; } = [];
    public List<string> RequiredProperties { get; set; } = [];
    public bool BlocksFrontCell      { get; set; } = false;
    public bool BlocksPlacement      { get; set; } = false;
    public bool SoftBlocks           { get; set; } = true;
    public string ColorGroupId       { get; set; } = string.Empty;
    public string MaterialGroupId    { get; set; } = string.Empty;
    public string TileGroupId        { get; set; } = string.Empty;
    public List<LayoutPoolRequiredSlot> RequiredSlots { get; set; } = [];
}

/// <summary>
/// Alternative Layout-Variante für zusammengesetzte Möbel/Shapes.
/// Eine Variante aktiviert einen Satz von Slots gemeinsam (z.B. lineare Küche, L-Sofa, U-Theke).
/// </summary>
public class LayoutVariant
{
    /// <summary>Eindeutige ID innerhalb des Raumtyps (z.B. "kitchen_l_shape").</summary>
    public string Id { get; set; } = string.Empty;
    /// <summary>Anzeigename für Editor/Logs.</summary>
    public string Label { get; set; } = string.Empty;
    /// <summary>Gewichtung innerhalb der Layout-Auswahl (1–10).</summary>
    public int Weight { get; set; } = 5;
    /// <summary>
    /// Core-Slots, die in dieser Variante aktiv sind. Leer = alle Slots des Raumtyps.
    /// So lassen sich z.B. lineare, L- oder U-Formen als alternative Shapes definieren.
    /// </summary>
    public List<string> SlotIds { get; set; } = [];
    /// <summary>Dynamic pool segments: chains of N wall-adjacent slots with randomised furniture types.</summary>
    public List<LayoutPool> Pools { get; set; } = [];
    /// <summary>When true, variant is excluded from weighted selection and fallback attempts.</summary>
    public bool Disabled { get; set; } = false;
}

/// <summary>Konfiguration für einen Raumtyp (z.B. "Bedroom").</summary>
public class RoomTypeConfig
{
    public string RoomType            { get; set; } = string.Empty;
    public List<RoomTypeSlot> Slots   { get; set; } = [];
    /// <summary>
    /// Alternative Layout-Varianten für zusammengesetzte Möbel-Setups.
    /// Der Generator wählt pro Raum eine Variante nach Gewicht und aktiviert nur deren Slots.
    /// </summary>
    public List<LayoutVariant> LayoutVariants { get; set; } = [];

    /// <summary>
    /// Gemeinsame Slots, die bei aktiver Layout-Variante zusätzlich zu deren Core-Slots
    /// berücksichtigt werden sollen.
    /// </summary>
    public List<string> CommonSlotIds { get; set; } = [];

    /// <summary>
    /// Pfadstil für die Laufwegberechnung in diesem Raumtyp.
    /// "wall"   : wandnaher Pfad (Standard) – A* bevorzugt wandnahe Zellen.
    /// "center" : mittig   – A* bevorzugt Zellen in der Raummitte.
    /// "random" : zufällig – hoher Jitter-Faktor, kein Richtungs-Bias.
    /// </summary>
    public string PathStyle           { get; set; } = "wall";

    /// <summary>
    /// Standard-Farbgruppen-ID für alle Slots dieses Raumtyps.
    /// Slots können den Wert erben (leere ColorGroupId) oder überschreiben.
    /// Leer = kein Farbfilter als Standard (Slots müssen explizit eine Gruppe setzen).
    /// </summary>
    public string ColorGroupId        { get; set; } = string.Empty;

    /// <summary>
    /// Erlaubte Farbpaletten pro Farbgruppen-ID.
    /// key   = colorGroupId (z.B. "bedroom_main")
    /// value = Liste erlaubter Farb-Tags (z.B. ["Brown", "White", "Black"]).
    /// Der Generator wählt vor der Slot-Platzierung eine zufällige Farbe aus der Liste
    /// und filtert alle Slots dieser Gruppe auf diese Farbe.
    /// Leer oder Gruppe nicht vorhanden → Farbe wird vom ersten platzierten Slot übernommen.
    /// </summary>
    public Dictionary<string, List<string>> ColorPalettes { get; set; } = new();
}
