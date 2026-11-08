import { sheetImageUrl } from '../api/tilesApi';

/** Shared across renderers: each sheet PNG is fetched once per session. */
const images = new Map<string, HTMLImageElement>();
/** Callbacks waiting for a sheet that is still loading (a Set, so redraw loops don't pile up duplicates). */
const waiting = new Map<string, Set<() => void>>();
const failed = new Set<string>();

/**
 * Returns the sheet image if it is already decoded, otherwise starts loading it (once)
 * and returns null; `onLoad` fires when that load finishes so the caller can redraw.
 */
export function getSheetImage(sheet: string, onLoad: () => void): HTMLImageElement | null {
  if (failed.has(sheet)) return null;
  const existing = images.get(sheet);
  if (existing?.complete && existing.naturalWidth > 0) return existing;

  let cbs = waiting.get(sheet);
  if (!cbs) waiting.set(sheet, cbs = new Set());
  cbs.add(onLoad);
  if (existing) return null;

  const img = new Image();
  const settle = (ok: boolean) => {
    if (!ok) { failed.add(sheet); images.delete(sheet); }
    const pending = waiting.get(sheet);
    waiting.delete(sheet);
    pending?.forEach(cb => cb());
  };
  img.addEventListener('load', () => settle(true), { once: true });
  img.addEventListener('error', () => settle(false), { once: true });
  img.src = sheetImageUrl(sheet);
  images.set(sheet, img);
  return null;
}

export function isSheetFailed(sheet: string): boolean {
  return failed.has(sheet);
}
