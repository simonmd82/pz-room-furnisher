import type { RoomTypeConfig, RoomTypeConfigMap, SlotSizeConfig } from '../types/roomTypes';

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

export async function getSlotSizes(): Promise<SlotSizeConfig> {
  const r = await fetch(`${BASE}/slot-sizes`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function saveSlotSizes(cfg: SlotSizeConfig): Promise<SlotSizeConfig> {
  const r = await fetch(`${BASE}/slot-sizes`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
