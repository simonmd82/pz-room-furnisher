import type { Building } from '../types/building';

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

