export interface Room {
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
}

export type DirectionType = 'N' | 'S' | 'E' | 'W';
export type ObjectType = 'Door' | 'Window' | 'Stairs' | 'Other';

export interface FloorObject {
  type: ObjectType;
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

export interface Floor {
  index: number;
  /** roomGrid[row][col] — 0 = outside, 1..N = room index (1-based into Building.rooms) */
  roomGrid: number[][];
  objects: FloorObject[];
  /** All doors and windows as shared cell-edges, ready for furniture placement queries */
  edges: WallEdge[];
}

export interface Building {
  width: number;
  height: number;
  rooms: Room[];
  floors: Floor[];
}


