import type { Building, FurnishResult, PlacedFurnitureItem } from '../types/building';

const API_BASE = '/api';

export interface RoomSelection {
  floorIndex: number;
  roomIndex1Based: number;
  anchorCol?: number;
  anchorRow?: number;
  roomTypeOverride: string;
}

export async function generateFurnishing(
  building: Building,
  roomSelections: RoomSelection[],
  seed?: number,
  densityMin = 0,
  densityMax = 1,
  densityPerRoom = false,
): Promise<FurnishResult> {
  const res = await fetch(`${API_BASE}/furnish/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ building, roomSelections, seed: seed ?? null, densityMin, densityMax, densityPerRoom }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<FurnishResult>;
}

export async function exportTbx(
  building: Building,
  placements: PlacedFurnitureItem[],
  originalFileName: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/furnish/export-tbx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ building, placements, originalFileName }),
  });
  if (!res.ok) throw new Error(await res.text());

  // Trigger browser download
  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  const cd   = res.headers.get('content-disposition') ?? '';
  const match = cd.match(/filename="?([^"]+)"?/);
  a.download = match?.[1] ?? 'building_furnished.tbx';
  a.click();
  URL.revokeObjectURL(url);
}


