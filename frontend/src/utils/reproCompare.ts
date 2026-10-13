import type { PlacedFurnitureItem } from '../types/building';

const placementKey = (p: PlacedFurnitureItem) =>
  `${p.floorIndex}:${p.col}:${p.row}:${p.tileId}:${p.layer}:${p.orient}`;

/**
 * [REPRO] log lines comparing a replay against the bundle's recorded result: placements as a
 * multiset (order-independent), plus the first diverging generator log line.
 */
export function compareReproResult(
  expected: { placements: PlacedFurnitureItem[]; log: string[] },
  actual: { placements: PlacedFurnitureItem[]; log: string[] },
  bundleVersion: string,
  localVersion: string,
): string[] {
  const lines = [`[REPRO] bundle v${bundleVersion} · local v${localVersion}`];
  if (bundleVersion !== localVersion)
    lines.push('[WARN] [REPRO] app versions differ — results may legitimately differ');

  const counts = new Map<string, number>();
  for (const p of expected.placements) counts.set(placementKey(p), (counts.get(placementKey(p)) ?? 0) + 1);
  let extra = 0;
  for (const p of actual.placements) {
    const k = placementKey(p);
    const n = counts.get(k) ?? 0;
    if (n > 0) counts.set(k, n - 1); else extra++;
  }
  const missing = [...counts.values()].reduce((a, b) => a + b, 0);

  const firstLogDiff = (() => {
    const n = Math.max(expected.log.length, actual.log.length);
    for (let i = 0; i < n; i++)
      if (expected.log[i] !== actual.log[i]) return i;
    return -1;
  })();

  if (missing === 0 && extra === 0 && firstLogDiff < 0) {
    lines.push(`[REPRO] identical — ${actual.placements.length} placements, log matches`);
  } else {
    lines.push(`[WARN] [REPRO] differs — ${missing} placements missing, ${extra} extra (of ${expected.placements.length} expected)`);
    if (firstLogDiff >= 0) {
      lines.push(`[WARN] [REPRO] first log difference at line ${firstLogDiff + 1}:`);
      lines.push(`[REPRO]   bundle: ${expected.log[firstLogDiff] ?? '(end of log)'}`);
      lines.push(`[REPRO]   replay: ${actual.log[firstLogDiff] ?? '(end of log)'}`);
    }
  }
  lines.push('[REPRO] ──────── replay log ────────');
  return lines;
}
