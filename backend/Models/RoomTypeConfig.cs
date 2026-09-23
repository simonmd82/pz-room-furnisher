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
    /// Wenn true, werden Zellen ausgeschlossen, die zwei Wände berühren (echte Raumecken) —
    /// das Gegenteil von CornerOnly. Nützlich für einen Anker-Slot (z.B. eine L-förmige
    /// Theken-Reihe), der eine echte Ecke für ein daran verankertes Eckstück freihalten muss.
    /// </summary>
    public bool AvoidCorners { get; set; } = false;
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
    /// Nur relevant wenn BlocksPlacement=false. Andere Slots dürfen die Footprint-Zellen
    /// dieses Slots nur dann belegen, wenn ihr gewähltes Tile ALLE hier gelisteten
    /// Eigenschaften erfüllt (gleiche Eigenschaften wie RequiredProperties, z.B.
    /// "isLow", "hasCollision"). Leer = keine zusätzliche Einschränkung.
    /// Kombinierbar mit SoftBlocks (beide Regeln gelten dann gleichzeitig).
    /// Typischer Einsatz: Wandregal, das nur wandmontierte Deko über sich duldet.
    /// </summary>
    public List<string> CellRequiredProperties { get; set; } = [];

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
    /// Nur relevant wenn TileGroupId gesetzt. Standard (false) = bei fehlendem Match im
    /// gesperrten VariantGroup wird auf den ungefilterten Pool zurückgefallen (Slot wird
    /// trotzdem platziert, ggf. mit abweichender Farbe/Variante). true = kein Match →
    /// keine Kandidaten (Slot wird komplett übersprungen statt mit falscher Variante
    /// platziert zu werden). Für optionale Slots (Required=false) hängt eine hängende
    /// Theke lieber gar nicht als in falscher Farbe über der Bodentheke.
    /// </summary>
    public bool RequireTileGroupMatch { get; set; } = false;

    /// <summary>
    /// Material-Filter für diesen Slot (AND-verknüpft mit Farbfilter).
    ///   Leer   = kein Materialfilter.
    ///   "none" = kein Materialfilter für diesen Slot (explizit deaktiviert).
    ///   Wert   = nur Tiles deren Materials-Liste diesen Wert enthält kommen in Frage.
    /// </summary>
    public string MaterialGroupId { get; set; } = string.Empty;

    /// <summary>
    /// Non-null = this is a rug slot, resolved against the RugDefinition catalog
    /// (see IRugCatalogService) instead of the normal TileDefinition candidate pool via
    /// FilterTiles. Null (default) = ordinary slot, unchanged behavior.
    /// </summary>
    public RugSlotConfig? RugSlot { get; set; } = null;
}

/// <summary>Sizing strategy for a rug slot.</summary>
public class RugSizing
{
    /// <summary>
    /// "fixed" (default) = target size is slot.Footprint.Width/Height exactly, like any other
    /// slot today (e.g. a dining rug anchored to the table).
    /// "fill" = ignore slot.Footprint; target size is computed from room geometry at generation
    /// time (e.g. a hallway runner sized to the room's long axis). See ComputeRugFillSize.
    /// "matchAnchorCluster" = ignore slot.Footprint and the slot's own AnchorRules; target size
    /// AND position are the bounding box of slot.RequiresSlot's placed instance unioned with
    /// every other placed slot that also has RequiresSlot pointing at the same parent (e.g. a
    /// dining table's chairs) — so the rug's edge pieces land on the chairs, not just the table.
    /// See ComputeAnchorClusterBounds/PlaceSlot.
    /// </summary>
    public string Mode { get; set; } = "fixed";
    /// <summary>Fill mode only: fixed short-axis width, e.g. 2 for a hallway runner.</summary>
    public int FillShortAxis { get; set; } = 2;
    /// <summary>Fill mode only: cells subtracted from each end of the long axis (door clearance etc.).</summary>
    public int FillMarginEachEnd { get; set; } = 1;
    /// <summary>Fill mode only: hard cap on the long axis so a huge room doesn't get one giant rug.</summary>
    public int? FillMaxLongAxis { get; set; }
}

/// <summary>Marks a RoomTypeSlot as a rug slot — see RoomTypeSlot.RugSlot.</summary>
public class RugSlotConfig
{
    /// <summary>Optional: restrict to specific RugDefinition Ids. Empty = any catalog entry matching room type + tile-set-enabled.</summary>
    public List<string> AllowedRugIds { get; set; } = [];
    public RugSizing Sizing { get; set; } = new();
    /// <summary>"any" (default) | "modular" | "preassembled" — restrict which catalog entries are eligible.</summary>
    public string ModeFilter { get; set; } = "any";
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
    /// <summary>See RoomTypeSlot.CellRequiredProperties.</summary>
    public List<string> CellRequiredProperties { get; set; } = [];
    /// <summary>
    /// Varianten-Gruppe für Companions desselben Parent-Slots: Companions mit gleicher,
    /// nicht-leerer SlotGroupId sind Alternativen – der Generator wählt genau eine davon
    /// (gewichtet nach GroupWeight) statt alle zu platzieren.
    /// Leer = kein Gruppen-Modus (Companion wird wie bisher immer platziert).
    /// </summary>
    public string SlotGroupId        { get; set; } = string.Empty;
    /// <summary>Gewichtung innerhalb der Companion-Gruppe (1–10). Nur relevant wenn SlotGroupId gesetzt.</summary>
    public int GroupWeight           { get; set; } = 5;
    /// <summary>See RoomTypeSlot.TileGroupId. Lets a companion match its parent's color/variant group.</summary>
    public string TileGroupId        { get; set; } = string.Empty;
    /// <summary>See RoomTypeSlot.RequireTileGroupMatch.</summary>
    public bool RequireTileGroupMatch { get; set; } = false;
    /// <summary>
    /// true (default) = companion must place or the fallback pass retries with a smaller pool
    /// (existing behavior, e.g. Cooking Hood/Sink). false = best-effort: density-gated at
    /// expansion time and never counted toward the fallback pass's missing-required retry check,
    /// so a companion that can't fit never shrinks or cascades into skipping its siblings.
    /// </summary>
    public bool Required             { get; set; } = true;
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
    /// <summary>See RoomTypeSlot.CellRequiredProperties.</summary>
    public List<string> CellRequiredProperties { get; set; } = [];
    public List<LayoutPoolCompanion> Companions { get; set; } = [];
    /// <summary>
    /// Geordnete Liste alternativer Platzierungsregeln (wie RoomTypeSlot.FallbackRules),
    /// die versucht werden falls diese Pflicht-Kategorie (z.B. Herd, Spüle) mit ihren
    /// Standard-Regeln an keiner Kette-Position platziert werden kann. Leer = kein Fallback.
    /// </summary>
    public List<PlacementRules> FallbackRules { get; set; } = [];
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
    /// <summary>See RoomTypeSlot.CellRequiredProperties.</summary>
    public List<string> CellRequiredProperties { get; set; } = [];
    public string ColorGroupId       { get; set; } = string.Empty;
    public string MaterialGroupId    { get; set; } = string.Empty;
    public string TileGroupId        { get; set; } = string.Empty;
    public List<LayoutPoolRequiredSlot> RequiredSlots { get; set; } = [];
    /// <summary>Companions spawned for the pool's default (non-required-category) filler positions.</summary>
    public List<LayoutPoolCompanion> DefaultCompanions { get; set; } = [];
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

/// <summary>
/// Regel für eine automatisch erkannte rechteckige Sperrzone, ausgehend von einer breiten
/// Wandöffnung (z.B. Garagentor). Breite der Zone ergibt sich aus der Breite der Öffnung
/// selbst (optional gekappt via <see cref="MaxWidth"/>) — nicht separat konfigurierbar.
/// </summary>
public class ReservedZoneRule
{
    /// <summary>Eindeutige ID innerhalb des Raumtyps.</summary>
    public string Id { get; set; } = string.Empty;
    /// <summary>Anzeigename für die Zone im UI-Overlay (z.B. "Car").</summary>
    public string Label { get; set; } = string.Empty;
    /// <summary>Wie viele Zellen die Zone von der Öffnung nach innen ausgedehnt wird.</summary>
    public int Depth { get; set; } = 1;
    /// <summary>Mindestbreite der Öffnung (Anzahl Zellen), damit diese Regel greift.</summary>
    public int MinOpeningWidth { get; set; } = 1;
    /// <summary>Optionale Kappung: ist die Öffnung breiter, wird die Zone auf diese Breite
    /// zentriert zugeschnitten. Null = keine Kappung, volle Öffnungsbreite.</summary>
    public int? MaxWidth { get; set; } = null;
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
    /// Regeln für automatisch erkannte Sperrzonen (z.B. "Auto"-Stellplatz vor einem
    /// breiten Garagentor). Wird gegen die berechneten Opening-Groups des Raums geprüft;
    /// bei Treffer wird eine rechteckige Zone reserviert, die von der Möbelplatzierung
    /// komplett ausgespart bleibt.
    /// </summary>
    public List<ReservedZoneRule> ReservedZones { get; set; } = [];

    /// <summary>
    /// Pfadstil für die Laufwegberechnung in diesem Raumtyp.
    /// "wall"   : wandnaher Pfad (Standard) – A* bevorzugt wandnahe Zellen.
    /// "center" : mittig   – A* bevorzugt Zellen in der Raummitte.
    /// "random" : zufällig – hoher Jitter-Faktor, kein Richtungs-Bias.
    /// </summary>
    public string PathStyle           { get; set; } = "wall";

    /// <summary>
    /// Wenn true: nach Platzierung aller Möbel mit Kollision (und daran verankerter Deko)
    /// wird ein realer Laufweg durch den bereits möblierten Raum berechnet (Tür-zu-Tür,
    /// bei nur einer Tür bis zur am weitesten entfernten erreichbaren Zelle) und für die
    /// Platzierung der übrigen freistehenden Deko (ohne AnchorRules, ohne Kollision) als
    /// Sperrzone behandelt — außer AllowOnPath oder FloorFurniture-Layer (z.B. Teppiche,
    /// s. IsFloorFurnitureNoCollision). Verhindert, dass Pflanzen/Lampen/Wanddeko mitten
    /// im Laufweg landen. Unabhängig von PathStyle/"doorOnly", das nur die Möbel mit
    /// Kollision betrifft. Standard: false (Opt-in für stufenweisen Rollout pro Raumtyp).
    /// </summary>
    public bool UsePostPlacementPathAvoidance { get; set; } = false;

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
