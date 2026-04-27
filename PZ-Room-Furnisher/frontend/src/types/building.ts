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
export type ObjectType = 'Door' | 'Window' | 'Stairs' | 'Other';

export interface FloorObject {
  type: ObjectType;
  /** Raw type string from TBX for round-trip export */
  originalType: string;
  x: number;
  y: number;
  dir: DirectionType;
  tile: string;
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
  type: 'Door' | 'Window';
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
  objects: FloorObject[];
  /** All doors and windows as shared cell-edges */
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


