import type { WallFurnitureClassification } from '../types/building';

const BASE = '/api/wallfurniture';

export async function getWallFurnitureClassifications(): Promise<Record<string, WallFurnitureClassification>> {
  const r = await fetch(`${BASE}/classifications`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function setWallFurnitureClassification(
  tileName: string,
  classification: WallFurnitureClassification,
): Promise<Record<string, WallFurnitureClassification>> {
  const r = await fetch(`${BASE}/classifications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tileName, classification }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
