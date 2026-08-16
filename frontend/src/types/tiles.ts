export const PREDEFINED_GROUPS = [
  'Beds', 'Bedtable', 'Cabinet', 'Mirror', 'Walldecoration',
] as const;

// ── Randomiser meta constants ─────────────────────────────────────────────
export const COLORS = [
  'Brown', 'Black', 'White', 'Grey', 'Red', 'Blue', 'Green',
  'Yellow', 'Metal', 'Wood', 'Beige', 'Mixed',
] as const;
export type TileColor = typeof COLORS[number];

// Shade modifiers combinable with a base color, e.g. "Brown" + "Light" => "Brown Light"
export const SHADES = ['Light', 'Dark'] as const;
export type ShadeTag = typeof SHADES[number];
export const shadeColor = (color: string, shade: string): string => `${color} ${shade}`;

export const ROOM_TYPES = [
  'Bedroom', 'Kitchen', 'Bathroom', 'LivingRoom', 'Office',
  'Storage', 'Hallway', 'Garage', 'Bar', 'Restaurant',
] as const;
export type RoomType = typeof ROOM_TYPES[number];

export const STYLE_TAGS = [
  'Modern', 'Rustic', 'Industrial', 'Vintage', 'Luxury', 'Simple',
] as const;
export type StyleTag = typeof STYLE_TAGS[number];

export interface TileSheetInfo {
  name: string;
  spriteWidth: number;
  spriteHeight: number;
  sheetWidth: number;
  sheetHeight: number;
  columns: number;
  rows: number;
  spriteCount: number;
  definedCount: number;
}

export interface PlacementRules {
  nearWall: boolean;
  nearDoor: boolean;
  nearWindow: boolean;
  centerRoom: boolean;
  cornerOnly: boolean;
}

export interface TileDefinition {
  /**
   * Storage/identity key. Equal to tileId for 1x1 pieces; for multi-cell pieces
   * suffixed with the footprint shape ("{tileId}#{cols}x{rows}") so two different
   * footprints that happen to share the same starting sprite (tileId) don't collide.
   * See computeTileDefId. Mirrored in backend/Models/TileDefinition.cs (ComputeId).
   */
  id: string;
  tileId: string;
  label: string;
  /** N | S | E | W | NW | NE | SW | SE | '' ('' = beliebig / keine feste Orientierung) */
  orientation: 'N' | 'S' | 'E' | 'W' | 'NW' | 'NE' | 'SW' | 'SE' | '';
  /**
   * 2-D layout grid [row][col] of tileIds.
   * Empty string = unoccupied cell.
   * Example — 1×2 sofa facing S:
   *   [["furniture_seating_indoor_01_001"],
   *    ["furniture_seating_indoor_01_002"]]
   */
  tileLayout: string[][];
  group: string;
  layer: 'Furniture' | 'Furniture2' | 'Furniture3' | 'Furniture4'
       | 'Wallfurniture' | 'Wallfurniture2' | 'Wallfurniture3' | 'Wallfurniture4'
       | 'FloorOverlay' | 'FloorFurniture';
  notes: string;
  // ── Unified boolean properties ────────────────────────────────────────
  isHigh:        boolean;
  isMedium:      boolean;
  isLow:         boolean;
  isWallMounted: boolean;
  hasSurface:    boolean;
  hasCollision:  boolean;
  canStack:      boolean;
  isTableTop:    boolean;
  isLootContainer: boolean;
  // ── Randomiser meta ───────────────────────────────────────────────────
  /** Colour tags for grouping similar-looking furniture */
  colors: string[];
  /** Material tags, e.g. ["Holz","Metall"] */
  materials: string[];
  /** Room types where this furniture is appropriate */
  roomTypes: string[];
  /** Links N/S/E/W variants of the same physical object (empty = no link) */
  variantGroup: string;
  /** Erlaubte Orientierungen für NearWall-Placement (leer = alle) */
  allowedOrients: string[];
  /** Optionale fensterkritische Kante (N/E/S/W), leer = keine Sonderregel */
  windowBlockedEdge: '' | 'N' | 'E' | 'S' | 'W';
  /** Style tags – stored but not yet used by the generator */
  styleTags: string[];
}

export type TileConfigMap = Record<string, TileDefinition>;

/** Metadata for one furniture tile-definition set (vanilla or a mod pack). */
export interface TileConfigSetInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  file: string;
}

// ── Unified tile properties (used in all 3 tabs) ──────────────────────────
export const TILE_PROPERTIES = [
  'isHigh',
  'isMedium',
  'isLow',
  'isWallMounted',
  'hasSurface',
  'hasCollision',
  'canStack',
  'isTableTop',
  'isLootContainer',
] as const;
export type TileProperty = typeof TILE_PROPERTIES[number];

/** Number of columns in the layout grid. */
export function layoutCols(def: TileDefinition): number {
  return def.tileLayout[0]?.length ?? 1;
}

/** Number of rows in the layout grid. */
export function layoutRows(def: TileDefinition): number {
  return def.tileLayout.length;
}

/**
 * Parse a canonical tileId (e.g. "furniture_seating_indoor_01_002")
 * into sheet name + sprite index.
 */
export function parseTileId(tileId: string): { sheet: string; index: number } | null {
  const m = tileId.match(/^(.+)_(\d{3})$/);
  if (!m) return null;
  return { sheet: m[1], index: parseInt(m[2], 10) };
}

/** Builds a canonical tile ID from sheet name + zero-padded index, e.g. "furniture_seating_indoor_01_018" */
export function makeTileId(sheetName: string, index: number): string {
  return `${sheetName}_${String(index).padStart(3, '0')}`;
}

/**
 * Computes the identity key for a piece from its root tile id and footprint shape.
 * Mirrors backend/Models/TileDefinition.cs (ComputeId) — keep both in sync.
 */
export function computeTileDefId(tileId: string, tileLayout: string[][]): string {
  const cols = tileLayout[0]?.length ?? 1;
  const rows = tileLayout.length;
  return (cols <= 1 && rows <= 1) ? tileId : `${tileId}#${cols}x${rows}`;
}

export function defaultDefinition(tileId: string): TileDefinition {
  return {
    id: tileId,
    tileId,
    label: '',
    orientation: '',
    tileLayout: [[tileId]],
    group: '',
    layer: 'Furniture',
    notes: '',
    isHigh:        true,
    isMedium:      false,
    isLow:         false,
    isWallMounted: false,
    hasSurface:    false,
    hasCollision:  true,
    canStack:      false,
    isTableTop:    false,
    isLootContainer: false,
    colors: [],
    materials: [],
    roomTypes: [],
    variantGroup: '',
    allowedOrients: [],
    windowBlockedEdge: '',
    styleTags: [],
  };
}



