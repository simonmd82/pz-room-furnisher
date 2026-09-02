import type { BfGroupSummary, BfGroupDetail } from '../types/bf';

const BASE = '/api/bfurniture';

export async function getBfPath(): Promise<{ path: string; isValid: boolean }> {
  return (await fetch(`${BASE}/path`)).json();
}

export async function setBfPath(path: string): Promise<{ path: string; isValid: boolean }> {
  const r = await fetch(`${BASE}/path`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ path }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getBfGroups(setId: string): Promise<{ configured: boolean; groups: BfGroupSummary[] }> {
  const r = await fetch(`${BASE}/groups?setId=${encodeURIComponent(setId)}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getBfGroupDetail(index: number): Promise<BfGroupDetail> {
  const r = await fetch(`${BASE}/groups/${index}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
