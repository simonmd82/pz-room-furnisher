export const PREDEFINED_GROUPS = [
  'Beds', 'Bedtable', 'Cabinet', 'Mirror', 'Walldecoration',
] as const;

export const HEIGHTS = ['low', 'high'] as const;

// ── Randomiser meta constants ─────────────────────────────────────────────
export const COLORS = [
  'Brown', 'Black', 'White', 'Grey', 'Red', 'Blue', 'Green',
  'Yellow', 'Metal', 'Wood', 'Beige', 'Mixed',
] as const;
export type TileColor = typeof COLORS[number];

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
  tileId: string;
  label: string;
  /** N | S | E | W | '' ('' = beliebig / keine feste Orientierung) */
  orientation: 'N' | 'S' | 'E' | 'W' | '';
  /**
   * 2-D layout grid [row][col] of tileIds.
   * Empty string = unoccupied cell.
   * Example — 1×2 sofa facing S:
   *   [["furniture_seating_indoor_01_001"],
   *    ["furniture_seating_indoor_01_002"]]
   */
  tileLayout: string[][];
  /** Height tags — multiple allowed, e.g. ["low","high"] for a full-height mirror */
  height: string[];
  blocksPathing: boolean;
  wallMounted: boolean;
  group: string;
  layer: 'Furniture' | 'Furniture2' | 'Furniture3' | 'Furniture4'
       | 'Wallfurniture' | 'Wallfurniture2' | 'Wallfurniture3' | 'Wallfurniture4'
       | 'FloorOverlay' | 'FloorFurniture';
  canStack: boolean;
  placementRules: PlacementRules;
  notes: string;
  // ── Randomiser meta ───────────────────────────
  /** Colour tags for grouping similar-looking furniture */
  colors: string[];
  /** Room types where this furniture is appropriate */
  roomTypes: string[];
  /** Relative spawn weight 1–10 (default 5) */
  weight: number;
  /** Max number of this piece per room (0 = unlimited) */
  maxCount: number;
  /** Valid orientations for randomiser placement */
  /** Links N/S/E/W variants of the same physical object (empty = no link) */
  variantGroup: string;
  /** Style tags – stored but not yet used by the generator */
  styleTags: string[];
}

export type TileConfigMap = Record<string, TileDefinition>;

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

export function defaultDefinition(tileId: string): TileDefinition {
  return {
    tileId,
    label: '',
    orientation: '',
    tileLayout: [[tileId]],   // 1×1 with the root tile pre-filled
    height: ['high'],
    blocksPathing: true,
    wallMounted: false,
    group: '',
    layer: 'Furniture',
    canStack: false,
    placementRules: {
      nearWall: false,
      nearDoor: false,
      nearWindow: false,
      centerRoom: false,
      cornerOnly: false,
    },
    notes: '',
    colors: [],
    roomTypes: [],
    weight: 5,
    variantGroup: '',
    styleTags: [],
  };
}











