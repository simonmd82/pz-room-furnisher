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
  /**
   * Ausrichtung des verankerten Slots relativ zum Anker.
   * "match"            = gleiche Ausrichtung wie der Anker (z.B. Nachttisch neben Bett).
   * "parallelToAnchor" = Alias für "match", semantisch klarer für parallel ausgerichtete Möbel (z.B. TV-Tisch parallel zum Sofa).
   * "opposite"         = entgegengesetzt (z.B. Stuhl zeigt vom Tisch weg).
   * "facingAnchor"     = Slot zeigt immer zum Anker hin (automatisch aus Position+Footprint).
   * "N"/"S"/"E"/"W"   = fixe Ausrichtung.
   * Leer/undefined     = tile.Orientation (bisheriges Verhalten).
   */
  orient?: 'match' | 'parallelToAnchor' | 'opposite' | 'facingAnchor' | 'openSideFacing' | 'cwPerpendicular' | 'ccwPerpendicular' | 'N' | 'S' | 'E' | 'W' | '';
}

/** Spezielle Eigenschaften, die ein Möbelstück haben muss, damit es in diesen Slot passt */
export const REQUIRED_PROPERTIES = [
  'isHigh',
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
}

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
   * Erlaubte Möbelkategorien mit Auswahlgewichtung (Kategorie → 1–10).
   * Der Generator lost zuerst eine Kategorie und wählt daraus zufällig ein Möbel.
   * Leer = alle passenden Kategorien gleichwertig.
   */
  allowedCategories: Record<string, number>;
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
    /** Nur versuchen, wenn dieser Slot / diese Gruppe bereits platziert wurde. */
    requiresSlot: string;
  /** Zwingt alle passenden Tiles auf dieselbe Tile-VariantGroup. */
  tileGroupId: string;
  /**
   * Material-Filter für diesen Slot (AND-verknüpft mit Farbfilter).
   *   Leer   = kein Materialfilter.
   *   "none" = kein Materialfilter für diesen Slot (explizit deaktiviert).
   *   Wert   = nur Tiles deren Materials-Liste diesen Wert enthält kommen in Frage.
   */
  materialGroupId: string;
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
  }

export interface RoomTypeConfig {
  roomType:      string;
  slots:         RoomTypeSlot[];
  /** Layout-Varianten für zusammengesetzte Möbel-Setups (Küche, Sofa, Theke …). */
  layoutVariants?: LayoutVariant[];
  /** Slots, die bei aktiver Layout-Variante zusätzlich zu den Core-Slots immer aktiv sind. */
  commonSlotIds?: string[];
  pathStyle:     'wall' | 'center' | 'random' | 'doorOnly';
  colorGroupId:  string;
  /**
   * Erlaubte Farben pro Farbgruppen-ID.
   * key = colorGroupId, value = Liste von Farb-Tags (z.B. ["Brown", "White"]).
   * Der Generator wählt vor dem Slot-Loop zufällig eine Farbe aus der Liste.
   * Leer oder Gruppe fehlt → Farbe wird vom ersten platzierten Möbel übernommen.
   */
  colorPalettes: Record<string, string[]>;
}

export type RoomTypeConfigMap = Record<string, RoomTypeConfig>;

export function defaultPlacementRules(): PlacementRules {
  return { nearWall: false, nearDoor: false, nearWindow: false, centerRoom: false, cornerOnly: false, allowOnPath: false, wallAlignment: 'any' };
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
    requiresSlot: '',
    colorGroupId: '',
    tileGroupId:  '',
    materialGroupId: '',
    fallbackRules: [],
  };
}

export function defaultRoomTypeConfig(roomType: string): RoomTypeConfig {
  return { roomType, pathStyle: 'wall', colorGroupId: '', colorPalettes: {}, slots: [], layoutVariants: [], commonSlotIds: [] };
}


