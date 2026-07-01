// ── TBX Roundtrip-Metadata ────────────────────────────────────────────────────

/** A single tile element inside a tile_entry block. */
export interface TbxTileEntry {
  enum: string;
  tile: string;
  offset: string;
}

/** A single tile_entry category block (e.g. "floors", "interior_walls", …). */
export interface TbxTileEntryBlock {
  category: string;
  tiles: TbxTileEntry[];
}

/**
 * All TBX metadata not part of the abstract building/room/floor model,
 * preserved for lossless roundtrip export.
 */
export interface TbxMetadata {
  /** All root attributes of the building element except width/height. */
  rootAttributes: Record<string, string>;
  /** Ordered list of tile_entry blocks ("floors" category appears multiple times). */
  tileEntries: TbxTileEntryBlock[];
  /** Ordered list of user tile names; 1-based TBX index = position + 1. */
  userTiles: string[];
  /** Raw used_tiles index list from the original TBX (building base structure). */
  usedTiles: number[];
  /** Raw content of used_furniture. */
  usedFurnitureRaw: string;
}

// ── Building model ────────────────────────────────────────────────────────────

export interface Room {
  id: string;
  name: string;
  internalName: string;
  /** Raw color string like "255 0 0" */
  color: string;
  interiorWall: number;
  interiorWallTrim: number;
  floorTile: number;
  grimeFloor: number;
  grimeWall: number;
  ceiling: number;
  // pathCells removed – now lives on Floor.pathsByRoom
}

export type DirectionType = 'N' | 'S' | 'E' | 'W';
export type ObjectType = 'Door' | 'Window' | 'Stairs' | 'Opening' | 'InnerWall' | 'Other';
export type WallEdgeType = 'Door' | 'Window' | 'Opening' | 'InnerWall';

export interface FloorObject {
  type: ObjectType;
  /** Raw type string from TBX for round-trip export */
  originalType: string;
  x: number;
  y: number;
  dir: DirectionType;
  tile: string;
  /** Additional raw TBX attributes (e.g. FrameTile, CurtainsTile, ShuttersTile) */
  rawAttributes: Record<string, string>;
}

/**
 * Represents a door or window on the shared edge between two adjacent cells.
 * Stored bidirectionally so furniture logic can query passability from either side.
 *
 * Edge key format:
 *   "H:col,row" – horizontal edge = north wall of cell (col, row) = south wall of (col, row-1)
 *   "V:col,row" – vertical edge   = west wall of cell (col, row)  = east wall  of (col-1, row)
 */
export interface WallEdge {
  edgeKey: string;
  type: WallEdgeType;
  /** true = horizontal (top/bottom), false = vertical (left/right) */
  isHorizontal: boolean;
  edgeCol: number;
  edgeRow: number;
  /** North or west cell */
  cell1Col: number;
  cell1Row: number;
  /** South or east cell */
  cell2Col: number;
  cell2Row: number;
  /** 0 = opening/no wall tile, >0 = interior wall tile index. Always 0 for Door/Window. */
  interiorTileIndex: number;
}

export type StairWaypointType = 'Ascending' | 'Descending';

export interface StairWaypoint {
  col: number;
  row: number;
  waypointType: StairWaypointType;
}

export interface Floor {
  index: number;
  /** roomGrid[row][col] — 0 = outside, 1..N = room index (1-based into Building.rooms) */
  roomGrid: number[][];
  /** Raw TBX attributes matrix (height × width). Preserved for lossless export. */
  attributesGrid: number[][];
  /**
   * Raw TBX tile layer matrices keyed by layer name
   * (e.g. Furniture, Furniture2, FloorFurniture, WallFurniture).
   * Values are TBX user-tile indices ((height+1) × (width+1)).
   */
  tileLayers: Record<string, number[][]>;
  objects: FloorObject[];
  /** All doors, windows, openings, and inner walls as shared cell-edges */
  edges: WallEdge[];
  /** Stair entry/exit points pre-computed during parse */
  stairWaypoints: StairWaypoint[];
  /**
   * Wall-hugging traversal paths per room on this floor.
   * Key = 1-based room index.
   */
  pathsByRoom: Record<number, [number, number][]>;
}

export interface Building {
  width: number;
  height: number;
  rooms: Room[];
  floors: Floor[];
  /** TBX metadata for lossless roundtrip export. Populated by the parser. */
  tbx: TbxMetadata;
}

// ── Furnishing ────────────────────────────────────────────────────────────────

export interface PlacedFurnitureItem {
  floorIndex: number;
  col: number;
  row: number;
  tileId: string;
  layer: string;
  orient: string;
  /** Slot-ID aus dem Raumtyp-Konfigurator, z.B. "slot_bed_main_small" */
  slotId: string;
}

export interface FurnishResult {
  placements: PlacedFurnitureItem[];
  log: string[];
}


