import type { CSSProperties } from 'react';
import type { TileDefinition } from '../types/tiles';
import { parseTileId } from '../types/tiles';
import { getTileConfig, getSheets, sheetImageUrl } from '../api/tilesApi';

export const SPRITE_W = 128;
export const SPRITE_H = 256;

export interface TileCatalog {
  defs: TileDefinition[];
  byId: Map<string, TileDefinition>;
  sheetCols: Record<string, number>;
}

/** Loaded once per page session and shared by the furniture picker and the grid editor. */
let cache: TileCatalog | null = null;
let pending: Promise<TileCatalog> | null = null;

export const getCachedTileCatalog = (): TileCatalog | null => cache;

export function loadTileCatalog(): Promise<TileCatalog> {
  if (cache) return Promise.resolve(cache);
  pending ??= Promise.all([getTileConfig(), getSheets().catch(() => ({ configured: false, sheets: [] }))])
    .then(([cfg, sh]) => {
      const sheetCols: Record<string, number> = {};
      sh.sheets.forEach(x => { sheetCols[x.name] = x.columns; });
      const defs = Object.values(cfg);
      cache = { defs, byId: new Map(defs.map(d => [d.id, d])), sheetCols };
      return cache;
    })
    .finally(() => { pending = null; });
  return pending;
}

/** Background-image crop of one sprite from its sheet, scaled by zoom. Null if the id can't be parsed. */
export function spriteStyle(tileId: string, sheetCols: Record<string, number>, zoom: number): CSSProperties | null {
  const p = parseTileId(tileId);
  if (!p) return null;
  const cols = sheetCols[p.sheet] ?? 8;
  const col  = p.index % cols;
  const row  = Math.floor(p.index / cols);
  return {
    width:  Math.round(SPRITE_W * zoom),
    height: Math.round(SPRITE_H * zoom),
    backgroundImage:    `url(${sheetImageUrl(p.sheet)})`,
    backgroundRepeat:   'no-repeat',
    backgroundSize:     `${Math.round(SPRITE_W * cols * zoom)}px auto`,
    backgroundPosition: `${-Math.round(col * SPRITE_W * zoom)}px ${-Math.round(row * SPRITE_H * zoom)}px`,
    imageRendering:     'pixelated',
  };
}

/** A tile's facing in this tool's canonical convention (see backend CanonicalOrient). */
export function facingOf(d: TileDefinition): string {
  if (d.useFacingOrientation !== false) return d.orientation;
  return ({ N: 'S', S: 'N', E: 'W', W: 'E' } as Record<string, string>)[d.orientation] ?? d.orientation;
}
