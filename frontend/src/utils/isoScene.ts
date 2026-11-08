import type { Building, Floor, FloorObject, PlacedFurnitureItem } from '../types/building';

/**
 * One sprite of the isometric scene, positioned on a TBX cell. Tiles are drawn the way
 * BuildingEd/PZ do: every sprite belongs to exactly one cell and its art already contains
 * the offset to the cell's W/N edge (walls) or centre (furniture).
 */
export interface IsoSprite {
  col: number;
  row: number;
  /** Full tile name, e.g. "walls_exterior_house_02_000". */
  tile: string;
  /** Layer name — TBX/placement layer, or a structural one (Floor, Walls, WallTrim, Doors, Windows, Stairs). */
  layer: string;
  /** Paint order within one cell (lower first). Ranks below FLAT_RANK_LIMIT are flat and drawn in a first pass. */
  rank: number;
  /** Wall-height piece that the cutaway mode trims down to a stub. */
  trimmable: boolean;
  /** 1-based room the sprite belongs to (0 = none), for selection dimming. */
  roomIdx: number;
  /** Where it came from — shown in the hover tooltip. */
  source: 'structure' | 'tbx' | 'generated';
}

/** Sprites with rank below this lie flat on the floor and never occlude anything. */
export const FLAT_RANK_LIMIT = 10;

const LAYER_RANK: Record<string, number> = {
  floor: 0, flooroverlay: 2, floorfurniture: 4,
  walls: 10, walltrim: 11, walltrim2: 12, walloverlay: 13, walloverlay2: 14,
  doors: 20, windows: 20, frames: 21, curtains: 22, stairs: 30,
  furniture: 40, furniture2: 41, furniture3: 42, furniture4: 43,
  wallfurniture: 50, wallfurniture2: 51, wallfurniture3: 52, wallfurniture4: 53,
};

export function layerRank(layer: string): number {
  const l = layer.toLowerCase();
  if (l in LAYER_RANK) return LAYER_RANK[l];
  if (l.startsWith('roof')) return 60;
  return 45;
}

/** Layers that stand as tall as a wall and get trimmed in cutaway mode. */
function isWallHeightLayer(layer: string): boolean {
  const l = layer.toLowerCase();
  return l === 'walls' || l.startsWith('walltrim') || l.startsWith('walloverlay') || l.startsWith('roof');
}

type WallDir = 'West' | 'North';
type Opening = 'Door' | 'Window' | null;

export function buildIsoScene(
  building: Building,
  floor: Floor,
  /** Placements are matched against this (it is the index the generator stamps on them). */
  floorIndex: number,
  placements: PlacedFurnitureItem[],
): IsoSprite[] {
  const tbx = building.tbx;
  const grid = floor.roomGrid;
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const sprites: IsoSprite[] = [];

  /** Tile name for a 1-based tile_entry index + enum, or null for none/empty. */
  const entryTile = (index: number | string | undefined, enumName: string): string | null => {
    const i = typeof index === 'string' ? parseInt(index, 10) : index;
    if (!i || i < 1 || i > tbx.tileEntries.length) return null;
    const t = tbx.tileEntries[i - 1].tiles.find(e => e.enum === enumName)?.tile;
    return t ? t : null;
  };
  const roomAt = (c: number, r: number): number =>
    r >= 0 && r < rows && c >= 0 && c < cols ? grid[r][c] ?? 0 : 0;
  const rootIdx = (name: string) => parseInt(tbx.rootAttributes[name] ?? '0', 10) || 0;

  const push = (col: number, row: number, tile: string | null, layer: string,
                roomIdx: number, source: IsoSprite['source'], trimmable = false, rank = layerRank(layer)) => {
    if (!tile) return;
    sprites.push({ col, row, tile, layer, rank, trimmable, roomIdx, source });
  };

  // ── Floors ────────────────────────────────────────────────────────────────
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const ri = roomAt(c, r);
      if (ri > 0) push(c, r, entryTile(building.rooms[ri - 1]?.floorTile, 'Floor'), 'Floor', ri, 'structure');
    }

  // ── Walls ─────────────────────────────────────────────────────────────────
  // A wall sits on the W / N edge of a cell. The camera looks at the inner face of the
  // north/west walls and the outer face of south/east walls, so (as in BuildingEd) the
  // set used is the room on the cell's own side; an outside cell gets the exterior set.
  interface WallSpec { wall: number; trim: number; room: number }
  const wallW = new Map<string, WallSpec>();
  const wallN = new Map<string, WallSpec>();
  const key = (c: number, r: number) => `${c},${r}`;

  const defaultSpec = (c: number, r: number, otherRoom: number): WallSpec => {
    const ri = roomAt(c, r);
    if (ri > 0) {
      const room = building.rooms[ri - 1];
      return { wall: room?.interiorWall ?? 0, trim: room?.interiorWallTrim ?? 0, room: ri };
    }
    return { wall: rootIdx('ExteriorWall'), trim: rootIdx('ExteriorWallTrim'), room: otherRoom };
  };

  for (let r = 0; r <= rows; r++)
    for (let c = 0; c <= cols; c++) {
      const here = roomAt(c, r);
      const west = roomAt(c - 1, r);
      const north = roomAt(c, r - 1);
      if (here !== west) wallW.set(key(c, r), defaultSpec(c, r, west));
      if (here !== north) wallN.set(key(c, r), defaultSpec(c, r, north));
    }

  // Explicit wall objects override (or, with tile 0, remove) the wall on their edges.
  for (const obj of floor.objects) {
    if (obj.originalType.toLowerCase() !== 'wall') continue;
    const length = parseInt(obj.rawAttributes.length ?? '1', 10) || 1;
    for (let i = 0; i < length; i++) {
      const vertical = obj.dir === 'N'; // dir N: west face, extends south; dir W: north face, extends east
      const c = vertical ? obj.x : obj.x + i;
      const r = vertical ? obj.y + i : obj.y;
      const inside = roomAt(c, r) > 0;
      const wall = parseInt(inside ? obj.rawAttributes.InteriorTile ?? '0' : obj.tile, 10) || 0;
      const trim = parseInt(obj.rawAttributes[inside ? 'InteriorTrim' : 'ExteriorTrim'] ?? '0', 10) || 0;
      const room = roomAt(c, r) || (vertical ? roomAt(c - 1, r) : roomAt(c, r - 1));
      (vertical ? wallW : wallN).set(key(c, r), { wall, trim, room });
    }
  }

  // Doors/windows cut a hole into the wall they sit on.
  const openingW = new Map<string, Opening>();
  const openingN = new Map<string, Opening>();
  for (const obj of floor.objects) {
    if (obj.type !== 'Door' && obj.type !== 'Window') continue;
    const target = obj.dir === 'W' ? openingW : obj.dir === 'N' ? openingN : null;
    target?.set(key(obj.x, obj.y), obj.type);
  }

  const wallTile = (spec: WallSpec, dir: WallDir | 'NorthWest' | 'SouthEast', opening: Opening, trim: boolean) => {
    const idx = trim ? spec.trim : spec.wall;
    if (opening && (dir === 'West' || dir === 'North'))
      return entryTile(idx, `${dir}${opening}`) ?? entryTile(idx, dir);
    return entryTile(idx, dir);
  };

  for (let r = 0; r <= rows; r++)
    for (let c = 0; c <= cols; c++) {
      const k = key(c, r);
      const w = wallW.get(k);
      const n = wallN.get(k);
      const hasW = !!w && w.wall > 0;
      const hasN = !!n && n.wall > 0;
      const oW = openingW.get(k) ?? null;
      const oN = openingN.get(k) ?? null;

      // One NorthWest corner piece replaces separate W + N pieces of the same set.
      if (hasW && hasN && !oW && !oN && w!.wall === n!.wall) {
        push(c, r, wallTile(w!, 'NorthWest', null, false), 'Walls', w!.room, 'structure', true);
        push(c, r, wallTile(w!, 'NorthWest', null, true), 'WallTrim', w!.room, 'structure', true);
      } else {
        if (hasW) {
          push(c, r, wallTile(w!, 'West', oW, false), 'Walls', w!.room, 'structure', true);
          push(c, r, wallTile(w!, 'West', oW, true), 'WallTrim', w!.room, 'structure', true);
        }
        if (hasN) {
          push(c, r, wallTile(n!, 'North', oN, false), 'Walls', n!.room, 'structure', true);
          push(c, r, wallTile(n!, 'North', oN, true), 'WallTrim', n!.room, 'structure', true);
        }
      }

      // SouthEast pillar closes the gap where a W wall ends above and an N wall ends to the left.
      if (!hasW && !hasN) {
        const above = wallW.get(key(c, r - 1));
        const left = wallN.get(key(c - 1, r));
        if (above && above.wall > 0 && left && left.wall > 0)
          push(c, r, wallTile(above, 'SouthEast', null, false), 'Walls', above.room, 'structure', true);
      }
    }

  // ── Doors / windows ───────────────────────────────────────────────────────
  for (const obj of floor.objects) {
    if (obj.type !== 'Door' && obj.type !== 'Window') continue;
    const dir: WallDir | null = obj.dir === 'W' ? 'West' : obj.dir === 'N' ? 'North' : null;
    if (!dir) continue;
    const ri = roomAt(obj.x, obj.y) || (dir === 'West' ? roomAt(obj.x - 1, obj.y) : roomAt(obj.x, obj.y - 1));
    if (obj.type === 'Door') {
      const frame = parseInt(obj.rawAttributes.FrameTile ?? '0', 10) || rootIdx('DoorFrame');
      push(obj.x, obj.y, entryTile(frame, dir), 'Frames', ri, 'structure', true);
      push(obj.x, obj.y, entryTile(obj.tile, dir), 'Doors', ri, 'structure', true);
    } else {
      push(obj.x, obj.y, entryTile(obj.tile, dir), 'Windows', ri, 'structure', true);
      push(obj.x, obj.y, entryTile(obj.rawAttributes.CurtainsTile, dir), 'Curtains', ri, 'structure', true);
      push(obj.x, obj.y, entryTile(obj.rawAttributes.ShuttersTile, dir), 'Curtains', ri, 'structure', true);
    }
  }

  // ── Stairs: 3 tiles at span offsets 1..3, top (…3) nearest the object origin ──
  for (const obj of floor.objects) {
    if (obj.type !== 'Stairs') continue;
    const base = obj.dir === 'W' ? 'West' : 'North';
    for (let i = 1; i <= 3; i++) {
      const c = obj.dir === 'W' ? obj.x + i : obj.x;
      const r = obj.dir === 'W' ? obj.y : obj.y + i;
      push(c, r, entryTile(obj.tile, `${base}${4 - i}`), 'Stairs', roomAt(c, r), 'structure');
    }
  }

  // ── TBX-authored content ──────────────────────────────────────────────────
  addTileLayers(floor, tbx.userTiles, roomAt, push);
  addFurnitureObjects(floor.objects, tbx.furnitureBlocks ?? [], roomAt, push);

  // ── Generated placements ──────────────────────────────────────────────────
  for (const p of placements) {
    if (p.floorIndex !== floorIndex) continue;
    push(p.col, p.row, p.tileId, p.layer, p.roomIndex1Based ?? roomAt(p.col, p.row), 'generated',
      isWallHeightLayer(p.layer));
  }

  return sortIsoSprites(sprites);
}

type PushFn = (col: number, row: number, tile: string | null, layer: string,
               roomIdx: number, source: IsoSprite['source'], trimmable?: boolean) => void;

function addTileLayers(floor: Floor, userTiles: string[], roomAt: (c: number, r: number) => number, push: PushFn) {
  for (const [layer, layerGrid] of Object.entries(floor.tileLayers ?? {}))
    layerGrid.forEach((line, r) => line.forEach((v, c) => {
      if (v > 0) push(c, r, userTiles[v - 1] ?? null, layer, roomAt(c, r), 'tbx', isWallHeightLayer(layer));
    }));
}

function addFurnitureObjects(
  objects: FloorObject[],
  blocks: NonNullable<Building['tbx']['furnitureBlocks']>,
  roomAt: (c: number, r: number) => number,
  push: PushFn,
) {
  for (const obj of objects) {
    if (obj.originalType.toLowerCase() !== 'furniture') continue;
    const block = blocks[parseInt(obj.rawAttributes.FurnitureTiles ?? '-1', 10)];
    if (!block) continue;
    const orient = obj.rawAttributes.orient ?? 'N';
    const entry = block.entries.find(e => e.orient === orient) ?? block.entries[0];
    if (!entry) continue;
    const isWall = block.layer.toLowerCase() === 'walls';
    const layer = block.layer || 'Furniture';
    for (const t of entry.tiles) {
      const c = obj.x + t.x;
      const r = obj.y + t.y;
      push(c, r, t.name || null, layer, roomAt(c, r), 'tbx', isWall || isWallHeightLayer(layer));
    }
  }
}

/** Flat sprites first, then PZ painter order: back-to-front by diagonal, then column, then rank. */
export function sortIsoSprites(sprites: IsoSprite[]): IsoSprite[] {
  return sprites.sort((a, b) => {
    const fa = a.rank < FLAT_RANK_LIMIT ? 0 : 1;
    const fb = b.rank < FLAT_RANK_LIMIT ? 0 : 1;
    return (fa - fb)
      || ((a.col + a.row) - (b.col + b.row))
      || (a.col - b.col)
      || (a.rank - b.rank);
  });
}
