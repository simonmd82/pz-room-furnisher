import { useState, useEffect, useMemo } from 'react';
import type { Building, PlacedFurnitureItem } from '../../types/building';
import { generateFurnishing, exportTbx } from '../../api/furnishApi';
import type { RoomSelection } from '../../api/furnishApi';
import { getRoomTypes } from '../../api/roomTypesApi';
import s from './FurnishPanel.module.css';

interface Props {
  building: Building;
  fileName: string;
  onPlacementsChanged: (placements: PlacedFurnitureItem[]) => void;
  onLogChanged?: (log: string[]) => void;
}

/** Collect all (floorIndex, roomIndex1Based) pairs that appear in the building. */
function collectRooms(building: Building): { floorIndex: number; roomIndex1Based: number }[] {
  const seen = new Set<string>();
  const result: { floorIndex: number; roomIndex1Based: number }[] = [];
  for (const floor of building.floors) {
    for (const row of floor.roomGrid) {
      for (const idx of row) {
        if (idx <= 0) continue;
        const key = `${floor.index}:${idx}`;
        if (!seen.has(key)) { seen.add(key); result.push({ floorIndex: floor.index, roomIndex1Based: idx }); }
      }
    }
  }
  return result.sort((a, b) => a.floorIndex - b.floorIndex || a.roomIndex1Based - b.roomIndex1Based);
}

/** Count cells of a room on a floor */
function roomCellCount(building: Building, floorIndex: number, roomIndex1Based: number): number {
  const floor = building.floors.find(f => f.index === floorIndex);
  if (!floor) return 0;
  let n = 0;
  for (const row of floor.roomGrid) for (const idx of row) if (idx === roomIndex1Based) n++;
  return n;
}

const SIZE_LABELS: Record<string, string> = {
  XS: 'XS ≤4', S: 'S ≤12', M: 'M ≤25', L: 'L ≤50', XL: 'XL 50+',
};
function classifySize(cells: number) {
  if (cells <= 4)  return 'XS';
  if (cells <= 12) return 'S';
  if (cells <= 25) return 'M';
  if (cells <= 50) return 'L';
  return 'XL';
}

/** Convert "R G B" TBX color string to CSS rgb(). */
function tbxColorToCss(color: string | undefined): string {
  if (!color) return '#888';
  const parts = color.trim().split(/\s+/);
  if (parts.length === 3) return `rgb(${parts[0]},${parts[1]},${parts[2]})`;
  return '#888';
}

export default function FurnishPanel({ building, fileName, onPlacementsChanged, onLogChanged }: Props) {
  const [knownTypes, setKnownTypes]     = useState<string[]>([]);
  const [selected, setSelected]         = useState<Set<string>>(new Set());
  const [overrides, setOverrides]       = useState<Record<string, string>>({});
  const [seed, setSeed]                 = useState<number>(() => Math.floor(Math.random() * 999999));
  const [running, setRunning]           = useState(false);
  const [exporting, setExporting]       = useState(false);
  const [status, setStatus]             = useState<{ msg: string; ok: boolean } | null>(null);
  const [placements, setPlacements]     = useState<PlacedFurnitureItem[]>([]);

  useEffect(() => {
    getRoomTypes().then(cfgs => setKnownTypes(Object.keys(cfgs))).catch(console.error);
  }, []);

  const allRooms = useMemo(() => collectRooms(building), [building]);

  const toggleRoom = (key: string) => setSelected(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const selKey = (floorIndex: number, roomIndex1Based: number) => `${floorIndex}:${roomIndex1Based}`;

  const handleGenerate = async () => {
    const selections: RoomSelection[] = [];
    for (const key of selected) {
      const [f, r] = key.split(':').map(Number);
      selections.push({ floorIndex: f, roomIndex1Based: r, roomTypeOverride: overrides[key] ?? '' });
    }
    if (selections.length === 0) { setStatus({ msg: 'Bitte mindestens einen Raum auswählen.', ok: false }); return; }

    setRunning(true); setStatus(null);
    try {
      const result = await generateFurnishing(building, selections, seed);
      setPlacements(result.placements);
      onPlacementsChanged(result.placements);
      onLogChanged?.(result.log);
      setStatus({ msg: `✓ ${result.placements.length} Tiles platziert in ${selections.length} Räumen.`, ok: true });
    } catch (e) {
      setStatus({ msg: `Fehler: ${String(e)}`, ok: false });
    } finally {
      setRunning(false);
    }
  };

  const handleExport = async () => {
    if (placements.length === 0) return;
    setExporting(true);
    try {
      await exportTbx(building, placements, fileName);
      setStatus({ msg: '✓ TBX heruntergeladen.', ok: true });
    } catch (e) {
      setStatus({ msg: `Export-Fehler: ${String(e)}`, ok: false });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className={s.panel}>
      <p className={s.panelTitle}>🛋 Möblierung generieren</p>

      {/* ── Room selection ── */}
      <span className={s.sectionLabel}>Räume auswählen</span>
      <div className={s.roomList}>
        {allRooms.map(({ floorIndex, roomIndex1Based }) => {
          const key          = selKey(floorIndex, roomIndex1Based);
          const room         = building.rooms[roomIndex1Based - 1];
          const cells        = roomCellCount(building, floorIndex, roomIndex1Based);
          const sizeKey      = classifySize(cells);
          const typeName     = overrides[key] || room?.internalName || '';
          const displayName  = room?.name || `Raum ${roomIndex1Based}`;
          const hasMatch     = knownTypes.some(k => k.toLowerCase() === typeName.toLowerCase());
          const isSel        = selected.has(key);
          const colorCss     = tbxColorToCss(room?.color);

          return (
            <div key={key}>
              <div
                className={`${s.roomRow} ${isSel ? s.roomRowSelected : ''}`}
                onClick={() => toggleRoom(key)}>
                <input
                  type="checkbox"
                  className={s.roomRowCheck}
                  checked={isSel}
                  onChange={() => toggleRoom(key)}
                  onClick={e => e.stopPropagation()}
                />
                {/* Color swatch */}
                <span
                  className={s.roomColorSwatch}
                  style={{ background: colorCss }}
                  title={`Farbe: ${room?.color}`}
                />
                <span className={s.roomRowName} title={`${displayName} (${room?.internalName})`}>
                  {displayName}
                  {room?.internalName && room.internalName !== displayName && (
                    <span className={s.roomInternalName}> · {room.internalName}</span>
                  )}
                </span>
                <span className={s.roomRowBadge} title={`${cells} Zellen`}>{SIZE_LABELS[sizeKey]}</span>
                {building.floors.length > 1 && (
                  <span className={s.roomRowBadge}>E{floorIndex}</span>
                )}
                {!hasMatch && typeName && (
                  <span className={s.roomRowNoMatch} title={`Kein passender Raumtyp für „${typeName}"`}>⚠</span>
                )}
              </div>

              {/* Override input when selected */}
              {isSel && (
                <input
                  className={s.overrideInput}
                  placeholder={`Raumtyp: ${typeName || 'unbekannt'}`}
                  value={overrides[key] ?? ''}
                  list="knownTypesList"
                  onChange={e => setOverrides(prev => ({ ...prev, [key]: e.target.value }))}
                />
              )}
            </div>
          );
        })}
      </div>

      <datalist id="knownTypesList">
        {knownTypes.map(t => <option key={t} value={t} />)}
      </datalist>

      {/* ── Seed ── */}
      <span className={s.sectionLabel}>Seed</span>
      <div className={s.seedRow}>
        <span className={s.seedLabel}>Seed</span>
        <input
          type="number"
          className={s.seedInput}
          value={seed}
          onChange={e => setSeed(+e.target.value)}
        />
        <button
          className={s.seedRandom}
          onClick={() => setSeed(Math.floor(Math.random() * 999999))}
          title="Zufälligen Seed würfeln">
          🎲
        </button>
      </div>

      {/* ── Generate ── */}
      <button
        className={s.generateBtn}
        disabled={running || selected.size === 0}
        onClick={handleGenerate}>
        {running ? '⏳ Generiert…' : `✨ ${selected.size} Raum${selected.size !== 1 ? 'räume' : ''} möblieren`}
      </button>

      {/* ── Result summary + export ── */}
      {placements.length > 0 && (
        <>
          <div className={s.resultSummary}>
            {placements.length} Tiles platziert
          </div>
          <button
            className={s.exportBtn}
            disabled={exporting}
            onClick={handleExport}>
            {exporting ? '⏳ Exportiert…' : '💾 Möblierte TBX exportieren'}
          </button>
        </>
      )}

      {/* ── Status ── */}
      {status && (
        <div className={`${s.status} ${status.ok ? s.statusOk : s.statusError}`}>
          {status.msg}
        </div>
      )}
    </div>
  );
}

