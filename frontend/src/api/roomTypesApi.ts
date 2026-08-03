import type { RoomTypeConfig, RoomTypeConfigMap } from '../types/roomTypes';

const BASE = '/api/roomtypes';

export async function getRoomTypes(): Promise<RoomTypeConfigMap> {
  const r = await fetch(BASE);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function saveRoomType(cfg: RoomTypeConfig): Promise<RoomTypeConfig> {
  const r = await fetch(`${BASE}/${encodeURIComponent(cfg.roomType)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteRoomType(roomType: string): Promise<void> {
  await fetch(`${BASE}/${encodeURIComponent(roomType)}`, { method: 'DELETE' });
}

export interface RoomTypesStatus {
  hasDefault:  boolean;
  hasSnapshot: boolean;
}

export async function getRoomTypesStatus(): Promise<RoomTypesStatus> {
  const r = await fetch(`${BASE}/default-status`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function restoreRoomTypesDefault(): Promise<void> {
  const r = await fetch(`${BASE}/restore-default`, { method: 'POST' });
  if (!r.ok) throw new Error(await r.text());
}

export async function saveRoomTypesSnapshot(): Promise<void> {
  const r = await fetch(`${BASE}/save-snapshot`, { method: 'POST' });
  if (!r.ok) throw new Error(await r.text());
}

export async function restoreRoomTypesSnapshot(): Promise<void> {
  const r = await fetch(`${BASE}/restore-snapshot`, { method: 'POST' });
  if (!r.ok) throw new Error(await r.text());
}
