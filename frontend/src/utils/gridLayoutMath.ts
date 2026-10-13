import type { GridCell, GridLayout, GridOrient, GridPoint } from '../types/roomTypes';
import { EMPTY_CATEGORY, GRID_ORIENTS } from '../types/roomTypes';

/**
 * TS port of the grid transform in backend/Services/FurnishingGeneratorService.Grid.cs
 * (TransformGridRect / TransformGridOrient) — keep both in sync.
 *
 * rot = clockwise quarter turns: 0 = back edge (row 0) against the N wall, 1 = E, 2 = S, 3 = W.
 * mirror flips left↔right BEFORE rotating.
 */
export interface GridRect { x: number; y: number; w: number; h: number }

export function transformGridRect(r: GridRect, gridW: number, gridH: number, rot: number, mirror: boolean): GridRect {
  const x = mirror ? gridW - r.x - r.w : r.x;
  switch (rot & 3) {
    case 1:  return { x: gridH - r.y - r.h, y: x, w: r.h, h: r.w };
    case 2:  return { x: gridW - x - r.w, y: gridH - r.y - r.h, w: r.w, h: r.h };
    case 3:  return { x: r.y, y: gridW - x - r.w, w: r.h, h: r.w };
    default: return { x, y: r.y, w: r.w, h: r.h };
  }
}

export function transformGridOrient(o: GridOrient, rot: number, mirror: boolean): GridOrient {
  let idx = GRID_ORIENTS.indexOf(o);
  if (idx < 0) return o;
  if (mirror && (idx === 1 || idx === 3)) idx = 4 - idx; // E ↔ W
  return GRID_ORIENTS[(idx + rot) & 3];
}

/** Grid dimensions after rotation. */
export function transformedGridSize(g: GridLayout, rot: number): { w: number; h: number } {
  return rot % 2 === 0 ? { w: g.width, h: g.height } : { w: g.height, h: g.width };
}

export const cellRect = (c: GridCell): GridRect => ({ x: c.x, y: c.y, w: c.footprint.width, h: c.footprint.height });

export function rectContains(r: GridRect, p: GridPoint): boolean {
  return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
}

export function rectsOverlap(a: GridRect, b: GridRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Turn a facing 90° clockwise. */
export const rotateOrientCw = (o: GridOrient): GridOrient => GRID_ORIENTS[(GRID_ORIENTS.indexOf(o) + 1) & 3];

export const ORIENT_ARROW: Record<GridOrient, string> = { N: '↑', E: '→', S: '↓', W: '←' };

export type GridIssue =
  | { kind: 'anchorCount'; count: number }
  | { kind: 'outOfBounds'; cellId: string }
  | { kind: 'overlap'; a: string; b: string }
  | { kind: 'duplicateId'; cellId: string }
  | { kind: 'noId' }
  | { kind: 'idClash'; id: string }
  | { kind: 'keepClearOccupied'; x: number; y: number }
  | { kind: 'noCategories'; cellId: string }
  | { kind: 'noBackWallPiece' };

/** Errors block saving; 'noBackWallPiece' and 'noCategories' are warnings. */
export const GRID_WARNING_KINDS = new Set<GridIssue['kind']>(['noBackWallPiece', 'noCategories']);

export function validateGrid(g: GridLayout, otherIds: Set<string>): GridIssue[] {
  const issues: GridIssue[] = [];
  if (!g.id.trim()) issues.push({ kind: 'noId' });
  else if (otherIds.has(g.id)) issues.push({ kind: 'idClash', id: g.id });

  const anchors = g.cells.filter(c => c.isAnchor).length;
  if (anchors !== 1) issues.push({ kind: 'anchorCount', count: anchors });

  const seen = new Set<string>();
  g.cells.forEach((c, i) => {
    if (seen.has(c.id)) issues.push({ kind: 'duplicateId', cellId: c.id });
    seen.add(c.id);
    const r = cellRect(c);
    if (r.x < 0 || r.y < 0 || r.x + r.w > g.width || r.y + r.h > g.height) issues.push({ kind: 'outOfBounds', cellId: c.id });
    for (let j = i + 1; j < g.cells.length; j++)
      if (rectsOverlap(r, cellRect(g.cells[j]))) issues.push({ kind: 'overlap', a: c.id, b: g.cells[j].id });
    if (!Object.keys(c.allowedCategories).some(k => k !== EMPTY_CATEGORY)) issues.push({ kind: 'noCategories', cellId: c.id });
  });

  for (const p of g.keepClear)
    if (g.cells.some(c => rectContains(cellRect(c), p))) issues.push({ kind: 'keepClearOccupied', x: p.x, y: p.y });

  if (g.mode !== 'free' && g.cells.length > 0 && !g.cells.some(c => (c.isAnchor || c.required) && c.y === 0))
    issues.push({ kind: 'noBackWallPiece' });

  return issues;
}

/** Next free "cN" id within the grid. */
export function nextCellId(g: GridLayout): string {
  const ids = new Set(g.cells.map(c => c.id));
  let n = g.cells.length + 1;
  while (ids.has(`c${n}`)) n++;
  return `c${n}`;
}
