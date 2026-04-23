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

/// <summary>Globale Slot-Größen-Grenzen (max. belegte Felder pro Slot-Typ).</summary>
public class SlotSizeConfig
{
    /// <summary>max. Felder für small-Slot (inkl.). Default 1.</summary>
    public int SmallMax  { get; set; } = 1;
    /// <summary>max. Felder für medium-Slot (inkl.). Default 2.</summary>
    public int MediumMax { get; set; } = 2;
    /// <summary>max. Felder für large-Slot (inkl.). Default 4.</summary>
    public int LargeMax  { get; set; } = 4;
    // extralarge = alles darüber
}

/// <summary>Ein Slot-Eintrag in der RoomType-Konfiguration.</summary>
public class RoomTypeSlot
{
    /// <summary>small | medium | large</summary>
    public string SlotType  { get; set; } = "small";
    /// <summary>Muss dieser Slot immer befüllt werden?</summary>
    public bool   Required  { get; set; } = false;
    /// <summary>Priorität beim Ziehen optionaler Slots (niedrig = zuerst).</summary>
    public int    Priority  { get; set; } = 0;
    /// <summary>Mindestanzahl (nur relevant bei Required=true).</summary>
    public int    MinCount  { get; set; } = 1;
    /// <summary>Maximale Anzahl dieses Slot-Typs. -1 = unbegrenzt.</summary>
    public int    MaxCount  { get; set; } = -1;
    /// <summary>Erlaubte Möbelgruppen. Leer = alle passenden.</summary>
    public List<string> Groups { get; set; } = [];
}

/// <summary>Konfiguration für einen Raumtyp (z.B. "Bedroom").</summary>
public class RoomTypeConfig
{
    public string RoomType            { get; set; } = string.Empty;
    public List<RoomTypeSlot> Slots   { get; set; } = [];
}

