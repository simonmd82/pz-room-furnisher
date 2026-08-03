import type { Building, Room } from '../types/building';

const API_BASE = '/api';

export async function uploadTbx(file: File): Promise<Building> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${API_BASE}/building/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  return response.json() as Promise<Building>;
}

export async function recomputePaths(
  building: Building,
  floorIndex: number,
  seed?: number,
): Promise<Room[]> {
  const res = await fetch(`${API_BASE}/building/recompute-paths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ building, floorIndex, seed: seed ?? null }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<Room[]>;
}

export async function recomputeRoomPath(
  building: Building,
  floorIndex: number,
  roomIndex1Based: number,
  seed?: number,
): Promise<[number, number][]> {
  const res = await fetch(`${API_BASE}/building/recompute-room-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ building, floorIndex, roomIndex1Based, seed: seed ?? null }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<[number, number][]>;
}

