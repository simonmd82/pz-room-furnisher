export const SIZE_KEYS = ['XS', 'S', 'M', 'L', 'XL'] as const;
export type SizeKey = typeof SIZE_KEYS[number];

/** Exakter Platzbedarf eines Slots in Zellen (Breite × Höhe). */
export interface SlotFootprint {
  width:     number;
  height:    number;
  /** Darf der Slot um 90° gedreht werden? Nur sinnvoll bei nicht-quadratischem Footprint. */
  canRotate: boolean;
}

/** Häufig verwendete Footprints als Schnellauswahl im Editor. */
export const COMMON_FOOTPRINTS: SlotFootprint[] = [
  { width: 1, height: 1 },
  { width: 1, height: 2 },
  { width: 2, height: 1 },
  { width: 1, height: 3 },
  { width: 3, height: 1 },
  { width: 2, height: 2 },
  { width: 2, height: 3 },
  { width: 3, height: 2 },
  { width: 3, height: 3 },
];

export const FURNITURE_LAYERS = [
  'Furniture', 'Furniture2', 'Furniture3', 'Furniture4',
  'Wallfurniture', 'Wallfurniture2', 'Wallfurniture3', 'Wallfurniture4',
  'FloorOverlay', 'FloorFurniture',
] as const;
export type FurnitureLayer = typeof FURNITURE_LAYERS[number];

/** Relative Positionen eines verknüpften Slots zum Anker-Slot */
export const ANCHOR_POSITIONS = [
  'HeadLeft', 'HeadRight', 'FootLeft', 'FootRight',
  'Left', 'Right', 'Above', 'Below', 'Center',
] as const;
export type AnchorPosition = typeof ANCHOR_POSITIONS[number];

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
export type RequiredProperty = typeof REQUIRED_PROPERTIES[number];

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
   * Fallback-Platzierungsregeln (geordnete Liste).
   * Wenn placementRules keine freie Zelle findet, versucht der Generator
   * diese Regeln der Reihe nach als Alternativen.
   * Nur bei required=true relevant – optionale Slots werden einfach weggelassen.
   */
  fallbackRules: PlacementRules[];
}

export interface RoomTypeConfig {
  roomType: string;
  slots:    RoomTypeSlot[];
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
    fallbackRules: [],
  };
}

export function defaultRoomTypeConfig(roomType: string): RoomTypeConfig {
  return { roomType, slots: [] };
}


