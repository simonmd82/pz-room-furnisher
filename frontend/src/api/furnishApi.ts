import type { Building, FurnishResult, PlacedFurnitureItem, ReservedZonePlacement } from '../types/building';

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
  densityFixed = false,
): Promise<FurnishResult> {
  const res = await fetch(`${API_BASE}/furnish/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ building, roomSelections, seed: seed ?? null, densityMin, densityMax, densityFixed }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<FurnishResult>;
}

/** Identifies the room selection an event belongs to (mirrors RoomSelection's key fields). */
interface StreamRoomRef {
  index: number;
  total: number;
  floorIndex: number;
  roomIndex1Based: number;
  anchorCol: number | null;
  anchorRow: number | null;
}

export type FurnishStreamEvent =
  | { type: 'start'; total: number }
  | (StreamRoomRef & { type: 'room'; roomName: string; roomType: string | null })
  | (StreamRoomRef & {
      type: 'roomDone';
      placements: PlacedFurnitureItem[];
      reservedZones: ReservedZonePlacement[];
      log: string[];
      skipped: boolean;
    })
  | { type: 'done' }
  | { type: 'error'; message: string };

/**
 * Streaming variant of generateFurnishing: the backend reports every room as it starts and
 * finishes (NDJSON). Aborting `signal` stops generation after the current room; the promise
 * then rejects with an AbortError, and every roomDone already delivered stays valid.
 */
export async function generateFurnishingStream(
  building: Building,
  roomSelections: RoomSelection[],
  onEvent: (ev: FurnishStreamEvent) => void,
  signal: AbortSignal,
  seed?: number,
  densityMin = 0,
  densityMax = 1,
  densityFixed = false,
): Promise<void> {
  const res = await fetch(`${API_BASE}/furnish/generate-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ building, roomSelections, seed: seed ?? null, densityMin, densityMax, densityFixed }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(await res.text());

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered  = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as FurnishStreamEvent);
    }
  }
  if (buffered.trim()) onEvent(JSON.parse(buffered) as FurnishStreamEvent);
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
  await downloadResponse(res, 'building_furnished.tbx');
}

/** Trigger a browser download of a file response, using its Content-Disposition name. */
async function downloadResponse(res: Response, fallbackName: string): Promise<void> {
  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  const cd   = res.headers.get('content-disposition') ?? '';
  const match = cd.match(/filename="?([^";]+)"?/);
  a.download = match?.[1] ?? fallbackName;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Repro bundles ────────────────────────────────────────────────────────────

/** Exactly what one furnish run sent to the generator. */
export interface FurnishRequestSnapshot {
  building: Building;
  roomSelections: RoomSelection[];
  seed: number | null;
  densityMin: number;
  densityMax: number;
  densityFixed: boolean;
}

export interface ReproExpected {
  placements: PlacedFurnitureItem[];
  reservedZones: ReservedZonePlacement[];
  log: string[];
}

/**
 * A run bundled with the room-type/tile/rug config it ran against (see backend ReproBundle).
 * Config fields are only passed back to the backend on replay, so they stay untyped here.
 */
export interface ReproBundle {
  formatVersion: number;
  appVersion: string;
  createdUtc: string;
  fileName: string;
  request: FurnishRequestSnapshot;
  expected: ReproExpected;
  [config: string]: unknown;
}

export async function exportReproBundle(
  request: FurnishRequestSnapshot,
  fileName: string,
  expected: ReproExpected,
): Promise<void> {
  const res = await fetch(`${API_BASE}/furnish/repro-export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request, fileName, expected }),
  });
  if (!res.ok) throw new Error(await res.text());
  await downloadResponse(res, 'building.pzrf-repro.json');
}

/** Re-run a bundle against its own bundled config (local config files are not used). */
export async function replayReproBundle(bundle: ReproBundle): Promise<{ result: FurnishResult; appVersion: string }> {
  const res = await fetch(`${API_BASE}/furnish/repro-replay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bundle),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ result: FurnishResult; appVersion: string }>;
}


