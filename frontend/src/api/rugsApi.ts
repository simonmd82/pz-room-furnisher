import type { RugDefinition, RugCatalogMap } from '../types/rugs';

const BASE = '/api/rugs';

export async function getRugCatalog(): Promise<RugCatalogMap> {
  const r = await fetch(BASE);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function saveRugDefinition(def: RugDefinition): Promise<RugDefinition> {
  const r = await fetch(`${BASE}/${encodeURIComponent(def.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(def),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteRugDefinition(id: string): Promise<void> {
  const r = await fetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(await r.text());
}
