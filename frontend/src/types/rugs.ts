/**
 * Mirrors backend/Models/RugDefinition.cs — keep both in sync.
 */

export const RUG_ROLES = ['TL', 'TR', 'BL', 'BR', 'N', 'S', 'E', 'W', 'Center'] as const;
export type RugRole = typeof RUG_ROLES[number];

/** Spatial layout of the 9-role grid, for a 3×3 UI (TL/N/TR — W/Center/E — BL/S/BR). */
export const RUG_ROLE_GRID: (RugRole | null)[][] = [
  ['TL', 'N', 'TR'],
  ['W', 'Center', 'E'],
  ['BL', 'S', 'BR'],
];

export interface RugPreassembledSize {
  width: number;
  height: number;
  /** Same 2-D [row][col] tileId grid convention as TileDefinition.tileLayout. */
  tileLayout: string[][];
}

export interface RugDefinition {
  id: string;
  label: string;
  /** "modular" | "preassembled" */
  mode: 'modular' | 'preassembled';
  /** Which TileConfigSet (vanilla/melos/…) this design's piece tileIds come from. */
  tileSetId: string;
  /** Room types this rug design may appear in (empty = all). */
  roomTypes: string[];
  group: string;
  colors: string[];
  materials: string[];
  variantGroup: string;
  // ── mode === 'modular' ──────────────────────────────────────────────
  /** Exactly the 9 roles in RUG_ROLES → one tileId each (missing role = unassigned). */
  pieces: Partial<Record<RugRole, string>>;
  minWidth: number;
  minHeight: number;
  // ── mode === 'preassembled' ─────────────────────────────────────────
  preassembledSizes: RugPreassembledSize[];
}

export type RugCatalogMap = Record<string, RugDefinition>;

export function defaultRugDefinition(id: string): RugDefinition {
  return {
    id,
    label: '',
    mode: 'modular',
    tileSetId: 'vanilla',
    roomTypes: [],
    group: 'Rug',
    colors: [],
    materials: [],
    variantGroup: '',
    pieces: {},
    minWidth: 2,
    minHeight: 2,
    preassembledSizes: [],
  };
}
