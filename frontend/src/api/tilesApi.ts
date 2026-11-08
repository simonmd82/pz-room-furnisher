import type { TileDefinition, TileConfigMap, TileSheetInfo, TileConfigSetInfo, TileUsageEntry } from '../types/tiles';

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

export async function getSheets(setId = 'vanilla'): Promise<{ configured: boolean; sheets: TileSheetInfo[] }> {
  return (await fetch(`${BASE}/sheets?setId=${encodeURIComponent(setId)}`)).json();
}

export function sheetImageUrl(name: string): string {
  return `${BASE}/sheet/${encodeURIComponent(name)}/image`;
}

/** No setId: merged view across every known set (for rendering/lookup). With setId: raw definitions of exactly that set (for editing it). */
export async function getTileConfig(setId?: string): Promise<TileConfigMap> {
  const url = setId ? `${BASE}/config?setId=${encodeURIComponent(setId)}` : `${BASE}/config`;
  return (await fetch(url)).json();
}

/** Every tile definition of every set, with the room-type slots that can pick it. */
export async function getTileUsage(): Promise<TileUsageEntry[]> {
  const r = await fetch(`${BASE}/usage`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function saveTileDefinition(def: TileDefinition, setId = 'vanilla'): Promise<TileDefinition> {
  const r = await fetch(`${BASE}/config/${encodeURIComponent(def.id)}?setId=${encodeURIComponent(setId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(def),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteTileDefinition(id: string, setId = 'vanilla'): Promise<void> {
  await fetch(`${BASE}/config/${encodeURIComponent(id)}?setId=${encodeURIComponent(setId)}`, { method: 'DELETE' });
}

export function exportConfigUrl(setId = 'vanilla'): string {
  return `${BASE}/config/export?setId=${encodeURIComponent(setId)}`;
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

// ── Config sets ────────────────────────────────────────────────────────

export async function getTileConfigSets(): Promise<TileConfigSetInfo[]> {
  const r = await fetch(`${BASE}/config-sets`);
  if (!r.ok) return [];
  return r.json();
}

export async function createTileConfigSet(name: string, description = ''): Promise<TileConfigSetInfo> {
  const r = await fetch(`${BASE}/config-sets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function updateTileConfigSet(
  id: string,
  changes: { name?: string; description?: string; enabled?: boolean },
): Promise<TileConfigSetInfo> {
  const r = await fetch(`${BASE}/config-sets/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteTileConfigSet(id: string): Promise<void> {
  const r = await fetch(`${BASE}/config-sets/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(await r.text());
}
