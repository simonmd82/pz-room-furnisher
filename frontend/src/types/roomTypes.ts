export const SIZE_KEYS = ['XS', 'S', 'M', 'L', 'XL'] as const;
export type SizeKey = typeof SIZE_KEYS[number];

/** Exakter Platzbedarf eines Slots in Zellen (Breite × Höhe). */
export interface SlotFootprint {
  width:     number;
  height:    number;
  /** Darf der Slot um 90° gedreht werden? Nur sinnvoll bei nicht-quadratischem Footprint. */
  canRotate?: boolean;
}

/** Häufig verwendete Footprints als Schnellauswahl im Editor. */
export const COMMON_FOOTPRINTS: SlotFootprint[] = [
  { width: 1, height: 1, canRotate: false },
  { width: 1, height: 2, canRotate: true },
  { width: 2, height: 1, canRotate: true },
  { width: 1, height: 3, canRotate: true },
  { width: 3, height: 1, canRotate: true },
  { width: 2, height: 2, canRotate: false },
  { width: 2, height: 3, canRotate: true },
  { width: 3, height: 2, canRotate: true },
  { width: 3, height: 3, canRotate: false },
];

export const FURNITURE_LAYERS = [
  'Furniture', 'Furniture2', 'Furniture3', 'Furniture4',
  'Wallfurniture', 'Wallfurniture2', 'Wallfurniture3', 'Wallfurniture4',
  'FloorOverlay', 'FloorFurniture',
] as const;

/** Relative Positionen eines verknüpften Slots zum Anker-Slot */
export const ANCHOR_POSITIONS = [
  'HeadLeft', 'HeadRight', 'FootLeft', 'FootRight',
  'Left', 'Right', 'Above', 'Below', 'Center',
  // Footprint-relative Positionen (unabhängig von Orientierung)
  'LongSide0', 'LongSide1', 'ShortSide0', 'ShortSide1',
  // Orientierungsabhaengige Seiten relativ zur Blickrichtung des Ankers
  'leftPerpendicular', 'rightPerpendicular',
  // Generische offene Seite: testet bevorzugte Seite, dann Fallback-Seite
  'openSidePlacement',
  // Gegenueberliegende Wand in Blickrichtung des Ankers
  'oppositeWall',
  // Orientierung-relative Seiten des Ankers
  'frontOfAnchor', 'behindAnchor', 'leftOfAnchor', 'rightOfAnchor',
  // Orientierungsabhängige Eckwand-Position (für PZ-Wandsystem)
  'perpendicularSide',
] as const;
export type AnchorPosition = typeof ANCHOR_POSITIONS[number];

/**
 * Tooltips für alle Ankerpositionen (für (i)-Anzeige im Editor).
 */
export const ANCHOR_POSITION_TOOLTIPS: Record<AnchorPosition, string> = {
  HeadLeft:          'Links neben dem Kopfende des Ankers (orient-abhängig)',
  HeadRight:         'Rechts neben dem Kopfende des Ankers (orient-abhängig)',
  FootLeft:          'Links neben dem Fußende des Ankers (orient-abhängig)',
  FootRight:         'Rechts neben dem Fußende des Ankers (orient-abhängig)',
  Left:              'Linke Seite des Ankers entlang der Längsachse',
  Right:             'Rechte Seite des Ankers entlang der Längsachse',
  Above:             'Direkt oberhalb des Ankers (orient-unabhängig)',
  Below:             'Direkt unterhalb des Ankers (orient-unabhängig)',
  Center:            'Gleiche Zelle wie der Anker (für gestapelte Layer, z.B. Wandelemente)',
  LongSide0:         'Lange Seite 0: Nordseite (horiz. Anker) oder Westseite (vert. Anker)',
  LongSide1:         'Lange Seite 1: Südseite (horiz. Anker) oder Ostseite (vert. Anker)',
  ShortSide0:        'Kurze Seite 0: Westseite (horiz. Anker) oder Nordseite (vert. Anker)',
  ShortSide1:        'Kurze Seite 1: Ostseite (horiz. Anker) oder Südseite (vert. Anker)',
  leftPerpendicular:  'Senkrecht links relativ zur Blickrichtung des Ankers.\nN→W, E→N, S→E, W→S.',
  rightPerpendicular: 'Senkrecht rechts relativ zur Blickrichtung des Ankers.\nN→E, E→S, S→W, W→N.',
  openSidePlacement:  'Offene Seite mit Fallback:\nW/E → zuerst Sued, dann Nord\nN/S → zuerst West, dann Ost.\nNimmt die erste gueltige Seite.',
  oppositeWall:      'Sucht in Blickrichtung des Ankers die gegenueberliegende Wand.\nOptional begrenzbar mit min/max Distanz.',
  frontOfAnchor:     'Direkt vor dem Anker relativ zu seiner Orientierung.',
  behindAnchor:      'Direkt hinter dem Anker relativ zu seiner Orientierung.',
  leftOfAnchor:      'Direkt links vom Anker relativ zu seiner Orientierung.',
  rightOfAnchor:     'Direkt rechts vom Anker relativ zu seiner Orientierung.',
  perpendicularSide:  'Legacy-Alias fuer leftPerpendicular (bestehende Konfigurationen).',
};

/**
 * Tooltips für alle orient-Optionen einer AnchorRule.
 */
export const ANCHOR_ORIENT_TOOLTIPS: Record<string, string> = {
  '':               'Tile-Standard: Orientierung aus der Tile-Definition.',
  match:            'Gleiche Ausrichtung wie der Anker (z.B. Nachttisch neben Bett).',
  parallelToAnchor: 'Alias für match: gleiche Ausrichtung wie der Anker. Semantisch klar für Möbel, die parallel zueinander stehen sollen (z.B. TV-Tisch parallel zum Sofa).',
  opposite:         'Entgegengesetzte Ausrichtung (N↔S, E↔W).',
  facingAnchor:     'Slot zeigt automatisch zum Anker hin (aus Position+Footprint abgeleitet).',
  openSideFacing:   'Leitet die Orientierung aus der bei openSidePlacement gewählten Seite ab:\nN→S, S→N, E→W, W→E.',
  cwPerpendicular:  'Uhrzeigersinn senkrecht: S→E, E→N, N→W, W→S.\nFür Eckwände: Dusche orient S (N-Wand) → Eckwand orient E.',
  ccwPerpendicular: 'Gegen Uhrzeigersinn senkrecht: S→W, W→N, N→E, E→S.\nAlternative Eckwand-Seite.',
  N: 'Fixe Ausrichtung Nord.', S: 'Fixe Ausrichtung Süd.',
  E: 'Fixe Ausrichtung Ost.',  W: 'Fixe Ausrichtung West.',
};

/**
 * Eine Anker-Regel: verknüpft diesen Slot mit einem anderen Slot oder einer Gruppe.
 * positions = erlaubte Positionen (OR – Generator wählt eine davon).
 * Mehrere AnchorRule-Einträge erlauben je nach Anker unterschiedliche Positionen.
 */
export interface AnchorRule {
  /** Slot-ID eines anderen Slots ODER eine slotGroupId */
  anchorTarget: string;
  /** Erlaubte Positionen (OR: Generator wählt eine). Leer = beliebig */
  positions: AnchorPosition[];
  /**
   * Versatz entlang der Ankerkante (nur für LongSide0/1, ShortSide0/1).
   * 0 = erste Zelle, 1 = zweite, -1 = letzte, -2 = vorletzte usw.
   */
  offsetAlongAnchor?: number;
  /** Mindestdistanz fuer oppositeWall (in Zellen). */
  minOppositeWallDistance?: number;
  /** Maximaldistanz fuer oppositeWall (in Zellen). */
  maxOppositeWallDistance?: number;
  /** oppositeWall: also allow spots inside the room within min..max (farthest first). */
  oppositeWallAllowInside?: boolean;
  /** oppositeWall: no colliding piece (except the anchor's own grid) between anchor and piece; lane stays clear. */
  keepSightClear?: boolean;
  /**
   * Ausrichtung des verankerten Slots relativ zum Anker.
   * "match"            = gleiche Ausrichtung wie der Anker (z.B. Nachttisch neben Bett).
   * "parallelToAnchor" = Alias für "match", semantisch klarer für parallel ausgerichtete Möbel (z.B. TV-Tisch parallel zum Sofa).
   * "opposite"         = entgegengesetzt (z.B. Stuhl zeigt vom Tisch weg).
   * "facingAnchor"     = Slot zeigt immer zum Anker hin (automatisch aus Position+Footprint).
   * "N"/"S"/"E"/"W"   = fixe Ausrichtung.
   * Leer/undefined     = tile.Orientation (bisheriges Verhalten).
   */
  orient?: 'match' | 'parallelToAnchor' | 'opposite' | 'facingAnchor' | 'openSideFacing' | 'cwPerpendicular' | 'ccwPerpendicular' | 'perpendicularCW' | 'perpendicularCCW' | 'cornerFromAnchor' | 'N' | 'S' | 'E' | 'W' | 'NW' | 'NE' | 'SW' | 'SE' | '';
}

/** Spezielle Eigenschaften, die ein Möbelstück haben muss, damit es in diesen Slot passt */
export const REQUIRED_PROPERTIES = [
  'isHigh',
  'isMedium',
  'isLow',
  'isWallMounted',
  'hasSurface',
  'hasCollision',
  'canStack',
  'isTableTop',
] as const;

export interface PlacementRules {
  nearWall:    boolean;
  nearDoor:    boolean;
  nearWindow:  boolean;
  centerRoom:  boolean;
  cornerOnly:  boolean;
  /** Excludes true room corners (cells touching two walls) — the opposite of cornerOnly. */
  avoidCorners?: boolean;
  /**
   * Darf dieser Slot auf Pfad-Zellen (Laufwegen) platziert werden?
   * false (Standard): Möbel mit hasCollision werden von Pfadzellen ferngehalten.
   * true: Pfadzellen sind erlaubt (z.B. Teppiche ohne Kollision).
   */
  allowOnPath: boolean;
  /**
   * Ausrichtung zur Wand (nur relevant wenn nearWall=true).
   * 'perpendicular': Rücken an der Wand, Vorderseite zeigt in den Raum.
   *   Die lange Achse des Möbelstücks geht in den Raum hinein (Bett, Schreibtisch, WC).
   *   → bevorzugt Tile-Variante mit fpH > fpW bei N/S-Wand (bzw. fpW > fpH bei E/W-Wand).
   * 'parallel': Längsseite entlang der Wand.
   *   Die lange Achse läuft parallel zur Wand (Sofa, Regal, Kommode).
   *   → bevorzugt Tile-Variante mit fpW > fpH bei N/S-Wand (bzw. fpH > fpW bei E/W-Wand).
   * 'any': Generator wählt passende Variante automatisch (Standard).
   */
  wallAlignment: 'perpendicular' | 'parallel' | 'any';
  /**
   * Nur in der größten zusammenhängenden Sub-Room-Fläche platzieren
   * (die durch Innenwände vom Rest abgetrennt wird und die meisten Türen hat).
   * false (Standard): gesamter Raum erlaubt.
   */
  mainSubRoom: boolean;
}

/**
 * Reservierte Pseudo-Kategorie in RoomTypeSlot.allowedCategories. Wird wie jede Kategorie
 * gewichtet; fällt der Wurf darauf, wird für diese Instanz nichts platziert (Garantie-Minimum
 * bzw. required-Instanz ausgenommen). Ersetzt Dummy-Slots in one-of-Gruppen.
 */
export const EMPTY_CATEGORY = '__empty__';

export interface SlotCount {
  min: number;
  /** -1 = unbegrenzt (nur durch freie Felder begrenzt) */
  max: number;
}

export interface RoomTypeSlot {
  /** Eindeutige ID innerhalb des Raumtyps (für Verlinkung) */
  id: string;
  /** Anzeigename, z.B. "Bett", "Nachttisch links" */
  label: string;
  /** Exakter Platzbedarf in Zellen */
  footprint: SlotFootprint;
  required: boolean;
  /** Priorität beim Ziehen optionaler Slots (0 = zuerst) */
  priority: number;
  /** Min/Max-Anzahl je Raumgröße */
  countBySize: Record<SizeKey, SlotCount>;
  /**
   * Bei mehreren Instanzen: true = alle nutzen dasselbe Tile wie die erste (bzw. dessen
   * VariantGroup). false/fehlend (Standard) = jede Instanz wählt ihr eigenes Tile.
   */
  sameTileForAllInstances?: boolean;
  /**
   * Erlaubte Möbelkategorien mit Auswahlgewichtung (Kategorie → 1–10).
   * Der Generator lost zuerst eine Kategorie und wählt daraus zufällig ein Möbel.
   * Leer = alle passenden Kategorien gleichwertig.
   * Sonderschlüssel EMPTY_CATEGORY: gewichteter "nichts platzieren"-Wurf pro Instanz.
   */
  allowedCategories: Record<string, number>;
  /** Allowed motif themes for tiles of themed categories (settings themedCategories). Empty/absent = all. */
  allowedThemes?: string[];
  /** Platzierungsregeln (an Wand, Ecke, Tür, Fenster …) */
  placementRules: PlacementRules;
  /** Erlaubter Furniture-Layer, leer = beliebig */
  requiredLayer: string;
  /** Erforderliche Eigenschaften, z.B. ["ProvidesSurface", "IsLow"] */
  requiredProperties: string[];
  /**
   * Anker-Regeln: verknüpft diesen Slot relativ zu anderen Slots oder Gruppen.
   * Jede Regel gibt einen Anker (Slot-ID oder slotGroupId) und erlaubte Positionen an.
   * Leer = freie Platzierung.
   */
  anchorRules: AnchorRule[];
  /**
   * Varianten-Gruppe: Alle Slots mit gleicher slotGroupId bilden eine Gruppe.
   * Der Generator wählt genau eine Variante daraus (one-of).
   * Leer = kein Gruppen-Modus (Slot ist unabhängig).
   */
  slotGroupId: string;
  /**
   * Wie die Gruppe behandelt wird:
   * - 'one-of': Genau eine Variante wird zufällig (nach groupWeight) ausgewählt.
   * - ''       : Kein Gruppen-Modus.
   */
  slotGroupMode: 'one-of' | '';
  /**
   * Gewichtung innerhalb der Varianten-Gruppe (1–10).
   * Höherer Wert → wird häufiger gewählt. Nur relevant wenn slotGroupId gesetzt.
   */
  groupWeight: number;
  /**
   * Farbgruppen-ID für kohärente Farbwahl.
   * Leer   = erbt colorGroupId vom Raumtyp.
   * "none" = kein Farbfilter für diesen Slot (überschreibt den Raum-Default).
   * Anderer Wert = eigene Gruppe (z.B. "accent").
   */
  colorGroupId: string;
  /**
   * Farbharmonie (Standard: an). Ohne aktive Farbsperre der eigenen Gruppe werden Farben bevorzugt,
   * die zur Referenzfarbe des Raums passen (Nachbar- oder Gegenfarbe auf dem Farbkreis, neutral immer).
   * undefined = an.
   */
  useColorHarmony?: boolean;
  /**
   * Fallback-Platzierungsregeln (geordnete Liste).
   * Wenn placementRules keine freie Zelle findet, versucht der Generator
   * diese Regeln der Reihe nach als Alternativen.
   * Nur bei required=true relevant – optionale Slots werden einfach weggelassen.
   */
  fallbackRules: PlacementRules[];
  /**
   * Wenn false: Footprint-Zellen werden NICHT in occupied eingetragen.
   * Andere Slots können dieselbe Zelle belegen (z.B. Möbel auf Teppich). Standard: true.
   */
  blocksPlacement: boolean;
  /**
   * Wenn true (und blocksPlacement:false): Zellen gehen in softOccupied.
   * Normale Slots respektieren softOccupied und landen nicht darauf.
   * Slots mit requiresSlot ignorieren softOccupied (dürfen darauf platziert werden).
   * Typischer Einsatz: Nachttisch (blocksPlacement:false, softBlocks:true). Standard: false.
   */
  softBlocks: boolean;
  /**
   * Nur relevant wenn blocksPlacement:false. Andere Slots dürfen die Footprint-Zellen
   * dieses Slots nur belegen, wenn ihr gewähltes Tile ALLE hier gelisteten Eigenschaften
   * erfüllt (gleiche Liste wie requiredProperties, z.B. "isLow", "hasCollision").
   * Leer = keine zusätzliche Einschränkung. Kombinierbar mit softBlocks.
   */
  cellRequiredProperties: string[];
  /**
   * Wenn true: Die Zelle vor der Vorderseite des platzierten Tiles (gemäß Orientierung)
   * wird zusätzlich in occupied eingetragen. Andere Slots können diese Zelle nicht belegen,
   * der Spieler kann aber weiterhin hineinlaufen.
   * Typischer Einsatz: Herd, Kühlschrank – Zelle davor soll frei bleiben. Standard: false.
   */
  blocksFrontCell: boolean;
  /** Free space all around (cells, diagonals included); 0/undefined = off. Placed after the room's other slots. */
  clearance?: number;
  /** Placed after all other slots of the room (pictures, posters). */
  placeLast?: boolean;
    /** Nur versuchen, wenn dieser Slot / diese Gruppe bereits platziert wurde. */
    requiresSlot: string;
  /** Zwingt alle passenden Tiles auf dieselbe Tile-VariantGroup. */
  tileGroupId: string;
  /** true = no match in the locked VariantGroup skips the slot instead of falling back to the unfiltered pool. */
  requireTileGroupMatch?: boolean;
  /**
   * Material-Filter für diesen Slot (AND-verknüpft mit Farbfilter).
   *   Leer   = kein Materialfilter.
   *   "none" = kein Materialfilter für diesen Slot (explizit deaktiviert).
   *   Wert   = nur Tiles deren Materials-Liste diesen Wert enthält kommen in Frage.
   */
  materialGroupId: string;
  /**
   * Non-null = this is a rug slot, resolved against the rug catalog (see rugsApi/RugDefinition)
   * instead of the normal tile-definition candidate pool. Null/undefined = ordinary slot.
   */
  rugSlot?: RugSlotConfig | null;
}

/** Sizing strategy for a rug slot. */
export interface RugSizing {
  /**
   * "fixed" (default) = target size is footprint.width/height exactly, like any other slot
   * (e.g. a dining rug anchored to the table).
   * "fill" = ignore footprint; target size is computed from room geometry at generation time
   * (e.g. a hallway runner sized to the room's long axis).
   * "matchAnchorCluster" = ignore footprint and the slot's own anchor rules; target size AND
   * position are the bounding box of requiresSlot's placed instance unioned with every other
   * placed slot that also requires that same parent (e.g. a dining table's chairs).
   */
  mode: 'fixed' | 'fill' | 'matchAnchorCluster';
  /**
   * matchAnchorCluster only: when requiresSlot names a grid (grid id or grid group name), only the
   * grid's placed pieces form the box — other slots requiring the grid don't enlarge it.
   */
  clusterGridPiecesOnly?: boolean;
  /**
   * matchAnchorCluster only: when requiresSlot names a placed grid, the rug covers the grid's full
   * frame as placed (e.g. 2×2), even if optional pieces rolled empty. Wins over clusterGridPiecesOnly.
   */
  clusterUseGridFrame?: boolean;
  /** Fill mode only: fixed short-axis width, e.g. 2 for a hallway runner. */
  fillShortAxis: number;
  /** Fill mode only: cells subtracted from each end of the long axis (door clearance etc.). */
  fillMarginEachEnd: number;
  /** Fill mode only: hard cap on the long axis so a huge room doesn't get one giant rug. */
  fillMaxLongAxis?: number | null;
}

/** Marks a RoomTypeSlot as a rug slot — see RoomTypeSlot.rugSlot. */
export interface RugSlotConfig {
  /** Optional: restrict to specific rug catalog IDs. Empty = any catalog entry matching room type + tile-set-enabled. */
  allowedRugIds: string[];
  sizing: RugSizing;
  /** "any" (default) | "modular" | "preassembled" — restrict which catalog entries are eligible. */
  modeFilter: 'any' | 'modular' | 'preassembled';
}

export function defaultRugSizing(): RugSizing {
  return { mode: 'fixed', clusterGridPiecesOnly: false, fillShortAxis: 2, fillMarginEachEnd: 1, fillMaxLongAxis: null };
}

export function defaultRugSlotConfig(): RugSlotConfig {
  return { allowedRugIds: [], sizing: defaultRugSizing(), modeFilter: 'any' };
}

/** Companion slot spawned when its parent required-pool-slot is placed (e.g. cooking hood above stove). */
export interface LayoutPoolCompanion {
  anchorPosition: AnchorPosition;
  orient?: AnchorRule['orient'];
  allowedCategories: Record<string, number>;
  /** Allowed motif themes for tiles of themed categories (settings themedCategories). Empty/absent = all. */
  allowedThemes?: string[];
  requiredProperties: string[];
  requiredLayer: string;
  label: string;
  blocksFrontCell: boolean;
  blocksPlacement: boolean;
  softBlocks: boolean;
  /** See RoomTypeSlot.cellRequiredProperties. */
  cellRequiredProperties: string[];
  /**
   * Companions sharing the same non-empty slotGroupId are alternatives: the generator picks
   * exactly one of them (weighted by groupWeight) instead of placing all of them.
   * Empty = no group mode, companion is always placed (default behaviour).
   */
  slotGroupId: string;
  /** Weight within the companion group (1–10). Only relevant when slotGroupId is set. */
  groupWeight: number;
  /** See RoomTypeSlot.tileGroupId. */
  tileGroupId?: string;
  /** See RoomTypeSlot.requireTileGroupMatch. */
  requireTileGroupMatch?: boolean;
  /** true (default) = must place; false = best-effort, never triggers the pool fallback retry. */
  required?: boolean;
}

/** A guaranteed-typed position within a pool segment (e.g. "exactly 1 stove"). */
export interface LayoutPoolRequiredSlot {
  /** Tile category for this position, e.g. "Cooking". Becomes allowedCategories: { [category]: weight }. */
  category: string;
  weight: number;
  /** How many times this type must appear in the pool. */
  count: number;
  label: string;
  requiredProperties: string[];
  /** Override pool's requiredLayer for this position only. Empty = use pool's layer. */
  requiredLayer: string;
  blocksFrontCell: boolean;
  blocksPlacement: boolean;
  softBlocks: boolean;
  /** See RoomTypeSlot.cellRequiredProperties. */
  cellRequiredProperties: string[];
  companions?: LayoutPoolCompanion[];
  /** Alternative placement rules tried if this required category can't place under the pool's rules. */
  fallbackRules?: PlacementRules[];
}

/** Min/max slot count range for a pool segment per room size. */
export interface LayoutPoolCountRange {
  min: number;
  max: number;
}

/**
 * A dynamic chain of N wall-adjacent slots within a LayoutVariant.
 * The generator expands this at runtime into RoomTypeSlot instances, chained by anchor rules.
 * Corner/structural slots remain in slotIds; pools fill the randomisable counter runs.
 */
export interface LayoutPool {
  id: string;
  label: string;
  /** Total positions in this pool segment per room size (min/max range; generator tries max first, falls back to min). */
  totalCountBySize: Record<SizeKey, LayoutPoolCountRange>;
  /** Fixed slot ID the first pool slot anchors to (e.g. a corner slot). */
  anchorTarget: string;
  /** AnchorPosition for pool slot 0 relative to anchorTarget. */
  firstAnchorPosition: AnchorPosition;
  /** Orient for pool slot 0's anchor rule. Defaults to "match". */
  firstOrient: AnchorRule['orient'];
  /** AnchorPosition for pool slot N relative to pool slot N-1. */
  chainAnchorPosition: AnchorPosition;
  /** Orient for chain slot anchor rules. Defaults to "match". */
  chainOrient: AnchorRule['orient'];
  placementRules: PlacementRules;
  requiredLayer: string;
  /** Category weights for positions not reserved by requiredSlots. */
  defaultCategories: Record<string, number>;
  /** Allowed motif themes for tiles of themed categories (settings themedCategories), for every pool position. Empty/absent = all. */
  allowedThemes?: string[];
  requiredProperties: string[];
  blocksFrontCell: boolean;
  blocksPlacement: boolean;
  softBlocks: boolean;
  /** See RoomTypeSlot.cellRequiredProperties. */
  cellRequiredProperties: string[];
  colorGroupId: string;
  /** See RoomTypeSlot.useColorHarmony; applies to every slot the pool expands to. */
  useColorHarmony?: boolean;
  materialGroupId: string;
  tileGroupId: string;
  /** Guaranteed-typed positions (e.g. 1 stove, 1 sink counter). */
  requiredSlots: LayoutPoolRequiredSlot[];
  /** Companions spawned for the pool's default (non-required-category) filler positions. */
  defaultCompanions?: LayoutPoolCompanion[];
}

  /** Alternative Layout-Variante für zusammengesetzte Möbel/Shapes. */
  export interface LayoutVariant {
    /** Eindeutige ID innerhalb des Raumtyps, z.B. "kitchen_l_shape". */
    id: string;
    /** Anzeigename für Editor/Logs. */
    label: string;
    /** Gewichtung innerhalb der Layout-Auswahl (1–10). */
    weight: number;
    /** Core-Slots, die in dieser Variante aktiv sind. Leer = alle Slots des Raumtyps. */
    slotIds: string[];
    /** Dynamic pool segments: chains of N wall-adjacent slots with randomised furniture types. */
    pools?: LayoutPool[];
    /** When true, variant is excluded from selection and fallback attempts. */
    disabled?: boolean;
  }

/**
 * Regel für eine automatisch erkannte rechteckige Sperrzone, ausgehend von einer breiten
 * Wandöffnung (z.B. Garagentor). Breite der Zone ergibt sich aus der Breite der Öffnung
 * selbst (optional gekappt via maxWidth) — nicht separat konfigurierbar.
 */
export interface ReservedZoneRule {
  id: string;
  /** Anzeigename für die Zone im UI-Overlay (z.B. "Car"). */
  label: string;
  /** Wie viele Zellen die Zone von der Öffnung nach innen ausgedehnt wird. */
  depth: number;
  /** Mindestbreite der Öffnung (Anzahl Zellen), damit diese Regel greift. */
  minOpeningWidth: number;
  /** Optionale Kappung: ist die Öffnung breiter, wird die Zone auf diese Breite zentriert zugeschnitten. */
  maxWidth?: number;
}

/** Grid-local cell coordinate (x = column, y = row; row 0 = back edge of the grid). */
export interface GridPoint {
  x: number;
  y: number;
}

export const GRID_ORIENTS = ['N', 'E', 'S', 'W'] as const;
export type GridOrient = typeof GRID_ORIENTS[number];
/** Room corner a corner piece sits in (tile-definitions orientation NW/NE/SE/SW). */
export const GRID_CORNERS = ['NW', 'NE', 'SE', 'SW'] as const;
export type GridCorner = typeof GRID_CORNERS[number];

/**
 * One piece of furniture inside a GridLayout. Position/footprint/orient are grid-local:
 * row 0 is the grid's back edge, orient "S" faces away from it (into the room).
 * Placed by the generator under slot id "{grid.id}_{cell.id}". Mirrors backend GridCell.
 */
export interface GridCell {
  id: string;
  label: string;
  x: number;
  y: number;
  footprint: SlotFootprint;
  orient: GridOrient;
  /** Exactly one per grid; always mandatory. */
  isAnchor: boolean;
  /** Required cells must fit for the grid to be placed; optional ones are dropped if blocked. */
  required: boolean;
  allowedCategories: Record<string, number>;
  /** Allowed motif themes for tiles of themed categories (settings themedCategories). Empty/absent = all. */
  allowedThemes?: string[];
  requiredLayer: string;
  requiredProperties: string[];
  colorGroupId: string;
  tileGroupId: string;
  requireTileGroupMatch: boolean;
  materialGroupId: string;
  /** Soft-block only, so a slot anchored to this piece (lamp on nightstand) can sit on top. */
  allowStacking: boolean;
  /** Back side (opposite the facing, after grid rotation) must be backed by a wall; an optional
   *  piece without one is dropped, a mandatory one rejects the spot. */
  againstWall: boolean;
  /** Piece on a cell edge (shower glass): orient names the edge; E/S become the next cell's W/N edge. */
  edgePiece: boolean;
  /** Cell in front of the piece stays free of later furniture. No effect on corner or edge pieces. */
  blocksFrontCell: boolean;
  /** Grid-local corner ('' = straight piece): the generator places the corner variant of the
   *  picked tiles and needs walls on both of its sides (rotated/mirrored with the grid). */
  cornerOrient: GridCorner | '';
  /** Shared anchor key ('' = none): slots with this AnchorTarget anchor to one of the placed
   *  pieces carrying it (across all grids), spread randomly over them. */
  anchorGroup: string;
  /** Editor-only: tile-definition ids picked for this cell, used for the sprite preview. */
  previewTileIds: string[];
}

export type GridMode = 'wall' | 'corner' | 'free';

/**
 * A fixed furniture arrangement on a small W×H grid, placed as one unit (rotated to any wall,
 * optionally mirrored) before the room's normal slots. Mirrors backend GridLayout.
 */
export interface GridLayout {
  id: string;
  label: string;
  width: number;
  height: number;
  /** wall = back edge against a wall · corner = back + left edge against walls · free = anywhere, prefers centre */
  mode: GridMode;
  allowMirror: boolean;
  required: boolean;
  priority: number;
  /** Grids sharing a non-empty slotGroupId are alternatives (one is chosen by groupWeight). */
  slotGroupId: string;
  groupWeight: number;
  /** Per room size override of groupWeight; a missing size uses groupWeight. */
  groupWeightBySize?: Partial<Record<SizeKey, number>>;
  /** Room sizes this grid is used in. Empty = all. */
  allowedSizes: SizeKey[];
  /**
   * Non-required grids only: weight of "leave this grid out" (like the __empty__ category weight).
   * Ungrouped: skipped with chance emptyWeight / (emptyWeight + weight). In a group, "none" competes
   * with the members, using the group's largest emptyWeight. 0 = always placed when possible.
   */
  emptyWeight?: number;
  allowOnPath: boolean;
  /** Pieces only in the room's main sub-room (largest area); no effect without inner walls. */
  mainSubRoom: boolean;
  /** See RoomTypeSlot.useColorHarmony; applies to all of the grid's pieces. */
  useColorHarmony?: boolean;
  cells: GridCell[];
  /** Empty grid cells that must stay walkable. */
  keepClear: GridPoint[];
  /** Places the grid opposite another grid, its front facing it. Undefined = normal mode placement. */
  oppositeAnchor?: AnchorRule;
}

export function defaultGridCell(id: string, x: number, y: number): GridCell {
  return {
    id, label: '', x, y,
    footprint: { width: 1, height: 1, canRotate: false },
    orient: 'S', isAnchor: false, required: false,
    allowedCategories: {}, requiredLayer: '', requiredProperties: [],
    colorGroupId: '', tileGroupId: '', requireTileGroupMatch: false, materialGroupId: '',
    allowStacking: false, againstWall: false, edgePiece: false, blocksFrontCell: false, cornerOrient: '', anchorGroup: '', previewTileIds: [],
  };
}

export function defaultGridLayout(id = ''): GridLayout {
  return {
    id, label: '', width: 4, height: 3, mode: 'wall', allowMirror: true,
    required: false, priority: 0, slotGroupId: '', groupWeight: 5, groupWeightBySize: {}, allowedSizes: [], emptyWeight: 0,
    allowOnPath: false, mainSubRoom: false, cells: [], keepClear: [],
  };
}

/** Fills missing fields of a grid coming from the backend / older JSON. */
export function normalizeGridLayout(g: Partial<GridLayout>): GridLayout {
  const base = defaultGridLayout();
  return {
    ...base,
    ...g,
    allowedSizes: [...(g.allowedSizes ?? [])],
    groupWeightBySize: { ...(g.groupWeightBySize ?? {}) },
    keepClear: (g.keepClear ?? []).map(p => ({ x: p.x, y: p.y })),
    cells: (g.cells ?? []).map(c => {
      const d = defaultGridCell(c.id ?? '', c.x ?? 0, c.y ?? 0);
      const fp = c.footprint ?? d.footprint;
      return {
        ...d,
        ...c,
        footprint: { width: fp.width ?? 1, height: fp.height ?? 1, canRotate: false },
        allowedCategories: { ...(c.allowedCategories ?? {}) },
        allowedThemes: [...(c.allowedThemes ?? [])],
        requiredProperties: [...(c.requiredProperties ?? [])],
        previewTileIds: [...(c.previewTileIds ?? [])],
      };
    }),
  };
}

export interface RoomTypeConfig {
  roomType:      string;
  slots:         RoomTypeSlot[];
  /** Grid layouts placed as fixed units before the slots. */
  grids?: GridLayout[];
  /** Layout-Varianten für zusammengesetzte Möbel-Setups (Küche, Sofa, Theke …). */
  layoutVariants?: LayoutVariant[];
  /** Slots, die bei aktiver Layout-Variante zusätzlich zu den Core-Slots immer aktiv sind. */
  commonSlotIds?: string[];
  /** Regeln für automatisch erkannte Sperrzonen (z.B. "Car"-Stellplatz). */
  reservedZones?: ReservedZoneRule[];
  pathStyle:     'wall' | 'center' | 'random' | 'doorOnly';
  colorGroupId:  string;
  /**
   * Erlaubte Farben pro Farbgruppen-ID.
   * key = colorGroupId, value = Liste von Farb-Tags (z.B. ["Brown", "White"]).
   * Der Generator wählt vor dem Slot-Loop zufällig eine Farbe aus der Liste.
   * Leer oder Gruppe fehlt → Farbe wird vom ersten platzierten Möbel übernommen.
   */
  colorPalettes: Record<string, string[]>;
  /** Room-level master switch for colour harmony (see RoomTypeSlot.useColorHarmony). undefined = on. */
  useColorHarmony?: boolean;
}

export type RoomTypeConfigMap = Record<string, RoomTypeConfig>;

export function defaultPlacementRules(): PlacementRules {
  return { nearWall: false, nearDoor: false, nearWindow: false, centerRoom: false, cornerOnly: false, allowOnPath: false, wallAlignment: 'any', mainSubRoom: false };
}

export function defaultCountBySize(): Record<SizeKey, SlotCount> {
  return {
    XS: { min: 0, max: 0 },
    S:  { min: 0, max: 1 },
    M:  { min: 0, max: 2 },
    L:  { min: 0, max: 3 },
    XL: { min: 0, max: 4 },
  };
}

export function defaultLayoutPoolCompanion(): LayoutPoolCompanion {
  return {
    anchorPosition: 'Center',
    orient: 'match',
    allowedCategories: {},
    requiredProperties: [],
    requiredLayer: '',
    label: '',
    blocksFrontCell: false,
    blocksPlacement: true,
    softBlocks: false,
    cellRequiredProperties: [],
    slotGroupId: '',
    groupWeight: 5,
  };
}

export function defaultLayoutPoolRequiredSlot(): LayoutPoolRequiredSlot {
  return {
    category: '',
    weight: 5,
    count: 1,
    label: '',
    requiredProperties: [],
    requiredLayer: '',
    blocksFrontCell: false,
    blocksPlacement: false,
    softBlocks: true,
    cellRequiredProperties: [],
    companions: [],
  };
}

export function defaultLayoutPool(): LayoutPool {
  return {
    id: '',
    label: '',
    totalCountBySize: { XS: { min: 0, max: 0 }, S: { min: 2, max: 2 }, M: { min: 3, max: 3 }, L: { min: 4, max: 4 }, XL: { min: 5, max: 5 } },
    anchorTarget: '',
    firstAnchorPosition: 'rightOfAnchor',
    firstOrient: 'match',
    chainAnchorPosition: 'rightOfAnchor',
    chainOrient: 'match',
    placementRules: { ...defaultPlacementRules(), nearWall: true },
    requiredLayer: 'Furniture2',
    defaultCategories: {},
    requiredProperties: [],
    blocksFrontCell: false,
    blocksPlacement: false,
    softBlocks: true,
    cellRequiredProperties: [],
    colorGroupId: '',
    materialGroupId: '',
    tileGroupId: '',
    requiredSlots: [],
  };
}

export function defaultSlot(): RoomTypeSlot {
  return {
    id: '',
    label: '',
    footprint: { width: 1, height: 1, canRotate: false },
    required: false,
    priority: 0,
    countBySize: defaultCountBySize(),
    allowedCategories: {},
    placementRules: defaultPlacementRules(),
    requiredLayer: '',
    requiredProperties: [],
    anchorRules: [],
    slotGroupId: '',
    slotGroupMode: '',
    groupWeight: 5,
    blocksPlacement: true,
    softBlocks:      false,
    cellRequiredProperties: [],
    blocksFrontCell: false,
    requiresSlot: '',
    colorGroupId: '',
    tileGroupId:  '',
    materialGroupId: '',
    fallbackRules: [],
  };
}

export function defaultReservedZone(): ReservedZoneRule {
  return { id: '', label: '', depth: 1, minOpeningWidth: 1 };
}

export function defaultRoomTypeConfig(roomType: string): RoomTypeConfig {
  return { roomType, pathStyle: 'wall', colorGroupId: '', colorPalettes: {}, slots: [], grids: [], layoutVariants: [], commonSlotIds: [], reservedZones: [] };
}


