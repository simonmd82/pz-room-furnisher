const BASE = '/api/settings';

async function checkResponse(r: Response, label: string): Promise<void> {
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(
      text
        ? `${label}: ${text}`
        : `${label}: Backend antwortet mit Status ${r.status} – ist das Backend gestartet?`,
    );
  }
}

export async function getRoomTypeNames(): Promise<string[]> {
  const r = await fetch(`${BASE}/room-type-names`);
  await checkResponse(r, 'getRoomTypeNames');
  return r.json();
}

export async function saveRoomTypeNames(names: string[]): Promise<string[]> {
  const r = await fetch(`${BASE}/room-type-names`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(names),
  });
  await checkResponse(r, 'saveRoomTypeNames');
  return r.json();
}

export async function getCategories(): Promise<string[]> {
  const r = await fetch(`${BASE}/categories`);
  await checkResponse(r, 'getCategories');
  return r.json();
}

export async function saveCategories(categories: string[]): Promise<string[]> {
  const r = await fetch(`${BASE}/categories`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(categories),
  });
  await checkResponse(r, 'saveCategories');
  return r.json();
}

