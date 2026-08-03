import type { Floor, PlacedFurnitureItem } from '../types/building';
import type { TileConfigMap } from '../types/tiles';

interface FootprintCandidate {
  defId: string;
  dCol: number;
  dRow: number;
}

/** Maps a leaf sprite tileId -> every multi-cell def cell it appears in. Build once per tileConfig. */
export function buildReverseFootprintIndex(tileConfig: TileConfigMap | undefined): Map<string, FootprintCandidate[]> {
  const index = new Map<string, FootprintCandidate[]>();
  if (!tileConfig) return index;
  for (const def of Object.values(tileConfig)) {
    const rows = def.tileLayout;
    if (rows.length <= 1 && (rows[0]?.length ?? 1) <= 1) continue; // genuine 1x1, no reverse entry needed
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const leaf = row[c];
        if (!leaf) continue;
        const list = index.get(leaf) ?? [];
        list.push({ defId: def.id, dCol: c, dRow: r });
        index.set(leaf, list);
      }
    }
  }
  return index;
}

/**
 * Resolves every sibling placement that belongs to the same physical piece as `item`.
 * Fast path: `item.tileId` is a direct key in tileConfig => genuinely 1x1 def => [item].
 * Fallback: reconstructs candidate anchors from the reverse index and matches sibling
 * cells by (floorIndex, col, row, tileId, layer, slotId, roomIndex1Based, anchorCol, anchorRow).
 * Degrades to [item] when tileConfig/reverseIndex can't resolve a full match.
 */
export function resolveFootprintGroup(
  item: PlacedFurnitureItem,
  floorPlacements: PlacedFurnitureItem[],
  tileConfig: TileConfigMap | undefined,
  reverseIndex: Map<string, FootprintCandidate[]>,
): PlacedFurnitureItem[] {
  if (!tileConfig) return [item];
  if (tileConfig[item.tileId]) return [item]; // direct hit => bare tileId is itself a def id => genuine 1x1

  const candidates = reverseIndex.get(item.tileId) ?? [];
  let bestMatch: PlacedFurnitureItem[] | null = null;
  let bestMatchCount = 0;

  for (const cand of candidates) {
    const def = tileConfig[cand.defId];
    if (!def) continue;
    const anchorCol = item.col - cand.dCol;
    const anchorRow = item.row - cand.dRow;

    const expectedCells: { col: number; row: number; tileId: string }[] = [];
    for (let r = 0; r < def.tileLayout.length; r++) {
      const row = def.tileLayout[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const leaf = row[c];
        if (!leaf) continue;
        expectedCells.push({ col: anchorCol + c, row: anchorRow + r, tileId: leaf });
      }
    }

    const matched: PlacedFurnitureItem[] = [];
    for (const expected of expectedCells) {
      const sibling = floorPlacements.find(p =>
        p.col === expected.col &&
        p.row === expected.row &&
        p.tileId === expected.tileId &&
        p.layer === item.layer &&
        p.slotId === item.slotId &&
        p.roomIndex1Based === item.roomIndex1Based &&
        p.anchorCol === item.anchorCol &&
        p.anchorRow === item.anchorRow,
      );
      if (sibling) matched.push(sibling);
    }

    if (matched.length === expectedCells.length && matched.some(m => m.id === item.id)) {
      return matched; // full match, done
    }
    if (matched.length > bestMatchCount && matched.some(m => m.id === item.id)) {
      bestMatchCount = matched.length;
      bestMatch = matched;
    }
  }

  return bestMatch ?? [item];
}

export function computeDelta(origin: { col: number; row: number }, dropCol: number, dropRow: number): { dCol: number; dRow: number } {
  return { dCol: dropCol - origin.col, dRow: dropRow - origin.row };
}

/**
 * Validates a rigid-translation move of `group` by `delta`:
 * every resulting cell must stay in bounds, inside the same room (if the item has one),
 * and not collide with another placement on the SAME layer at that cell — pieces on
 * different layers legitimately stack (e.g. a sink placed on top of a counter, which
 * the generator itself produces as two placements on different layers sharing a cell).
 * No pathing/wall/anchor checks — those only matter at generation time.
 */
export function isGroupMoveValid(
  group: PlacedFurnitureItem[],
  delta: { dCol: number; dRow: number },
  floorPlacements: PlacedFurnitureItem[],
  floor: Floor,
): boolean {
  if (group.length === 0) return false;
  const groupIds = new Set(group.map(g => g.id));
  const groupLayer = group[0].layer;
  const otherOccupied = new Set(
    floorPlacements
      .filter(p => !groupIds.has(p.id) && p.layer === groupLayer)
      .map(p => `${p.col},${p.row}`),
  );

  const grid = floor.roomGrid;
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;

  for (const item of group) {
    const col = item.col + delta.dCol;
    const row = item.row + delta.dRow;
    if (col < 0 || row < 0 || col >= cols || row >= rows) return false;
    const roomIdx = grid[row]?.[col] ?? 0;
    if (roomIdx <= 0) return false;
    if (item.roomIndex1Based != null && roomIdx !== item.roomIndex1Based) return false;
    if (otherOccupied.has(`${col},${row}`)) return false;
  }
  return true;
}

/** Returns a NEW full (all-floors) placements array with `group` members translated by `delta`. */
export function applyGroupMove(
  allPlacements: PlacedFurnitureItem[],
  group: PlacedFurnitureItem[],
  delta: { dCol: number; dRow: number },
): PlacedFurnitureItem[] {
  const groupIds = new Set(group.map(g => g.id));
  return allPlacements.map(p =>
    groupIds.has(p.id) ? { ...p, col: p.col + delta.dCol, row: p.row + delta.dRow } : p,
  );
}
