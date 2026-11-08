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

export async function getThemes(): Promise<string[]> {
  const r = await fetch(`${BASE}/themes`);
  await checkResponse(r, 'getThemes');
  return r.json();
}

export async function saveThemes(themes: string[]): Promise<string[]> {
  const r = await fetch(`${BASE}/themes`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(themes),
  });
  await checkResponse(r, 'saveThemes');
  return r.json();
}

export async function getThemedCategories(): Promise<string[]> {
  const r = await fetch(`${BASE}/themed-categories`);
  await checkResponse(r, 'getThemedCategories');
  return r.json();
}

export async function saveThemedCategories(categories: string[]): Promise<string[]> {
  const r = await fetch(`${BASE}/themed-categories`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(categories),
  });
  await checkResponse(r, 'saveThemedCategories');
  return r.json();
}

export async function getMaterials(): Promise<string[]> {
  const r = await fetch(`${BASE}/materials`);
  await checkResponse(r, 'getMaterials');
  return r.json();
}

export async function saveMaterials(materials: string[]): Promise<string[]> {
  const r = await fetch(`${BASE}/materials`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(materials),
  });
  await checkResponse(r, 'saveMaterials');
  return r.json();
}

export async function getColorNames(): Promise<string[]> {
  const r = await fetch(`${BASE}/colors`);
  await checkResponse(r, 'getColorNames');
  return r.json();
}

export async function saveColorNames(colors: string[]): Promise<string[]> {
  const r = await fetch(`${BASE}/colors`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(colors),
  });
  await checkResponse(r, 'saveColorNames');
  return r.json();
}

/** Colour → hue in degrees (0–359) for colour harmony; null = neutral. Missing colours are neutral. */
export type ColorHues = Record<string, number | null>;

export async function getColorHues(): Promise<ColorHues> {
  const r = await fetch(`${BASE}/color-hues`);
  await checkResponse(r, 'getColorHues');
  return r.json();
}

export async function saveColorHues(hues: ColorHues): Promise<ColorHues> {
  const r = await fetch(`${BASE}/color-hues`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(hues),
  });
  await checkResponse(r, 'saveColorHues');
  return r.json();
}
