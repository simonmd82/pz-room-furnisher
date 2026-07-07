import type { TileDefinition, TileConfigMap, TileSheetInfo } from '../types/tiles';

const BASE = '/api/tiles';

export async function getTilesPath(): Promise<{ path: string; isValid: boolean }> {
  return (await fetch(`${BASE}/path`)).json();
}

export async function setTilesPath(path: string): Promise<{ path: string; isValid: boolean }> {
  const r = await fetch(`${BASE}/path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export interface BrowseEntry {
  name: string;
  fullPath: string;
  isDrive: boolean;
}
export interface BrowseResult {
  current: string | null;
  parent:  string | null;
  entries: BrowseEntry[];
}

export async function browseDirectory(path?: string): Promise<BrowseResult> {
  const url = path ? `${BASE}/browse?path=${encodeURIComponent(path)}` : `${BASE}/browse`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getSheets(): Promise<{ configured: boolean; sheets: TileSheetInfo[] }> {
  return (await fetch(`${BASE}/sheets`)).json();
}

export function sheetImageUrl(name: string): string {
  return `${BASE}/sheet/${encodeURIComponent(name)}/image`;
}

export async function getTileConfig(): Promise<TileConfigMap> {
  return (await fetch(`${BASE}/config`)).json();
}

export async function saveTileDefinition(def: TileDefinition): Promise<TileDefinition> {
  const r = await fetch(`${BASE}/config/${encodeURIComponent(def.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(def),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteTileDefinition(id: string): Promise<void> {
  await fetch(`${BASE}/config/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function exportConfigUrl(): string {
  return `${BASE}/config/export`;
}

/** Returns distinct non-empty group names from all saved tile definitions. */
export async function getGroups(): Promise<string[]> {
  const r = await fetch(`${BASE}/groups`);
  if (!r.ok) return [];
  return r.json();
}

/** Returns distinct non-empty color tags from all saved tile definitions. */
export async function getColors(): Promise<string[]> {
  const r = await fetch(`${BASE}/colors`);
  if (!r.ok) return [];
  return r.json();
}
