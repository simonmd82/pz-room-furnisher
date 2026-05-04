import { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
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

interface RoomEntry { floorIndex: number; roomIndex1Based: number; }

/** Collect rooms grouped by floor, sorted by floorIndex then roomIndex. */
function collectRoomsByFloor(building: Building): Map<number, RoomEntry[]> {
  const map = new Map<number, RoomEntry[]>();
  for (const floor of building.floors) {
    const seen = new Set<number>();
    for (const row of floor.roomGrid) {
      for (const idx of row) {
        if (idx <= 0 || seen.has(idx)) continue;
        seen.add(idx);
        if (!map.has(floor.index)) map.set(floor.index, []);
        map.get(floor.index)!.push({ floorIndex: floor.index, roomIndex1Based: idx });
      }
    }
  }
  for (const rooms of map.values()) rooms.sort((a, b) => a.roomIndex1Based - b.roomIndex1Based);
  return new Map([...map.entries()].sort((a, b) => a[0] - b[0]));
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
  const { t } = useTranslation();
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

  const roomsByFloor  = useMemo(() => collectRoomsByFloor(building), [building]);
  const allRoomsFlat  = useMemo(() => [...roomsByFloor.values()].flat(), [roomsByFloor]);

  const selKey = (floorIndex: number, roomIndex1Based: number) => `${floorIndex}:${roomIndex1Based}`;

  /** Unique internalNames across all rooms, sorted */
  const uniqueTypes = useMemo(() => {
    const types = new Set<string>();
    for (const e of allRoomsFlat) {
      const name = building.rooms[e.roomIndex1Based - 1]?.internalName;
      if (name) types.add(name);
    }
    return [...types].sort();
  }, [allRoomsFlat, building.rooms]);

  const toggleRoom = (key: string) => setSelected(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const toggleFloor = (floorIndex: number) => {
    const keys = (roomsByFloor.get(floorIndex) ?? []).map(e => selKey(e.floorIndex, e.roomIndex1Based));
    const allSel = keys.every(k => selected.has(k));
    setSelected(prev => {
      const next = new Set(prev);
      if (allSel) keys.forEach(k => next.delete(k));
      else keys.forEach(k => next.add(k));
      return next;
    });
  };

  const toggleByType = (typeName: string) => {
    const keys = allRoomsFlat
      .filter(e => (building.rooms[e.roomIndex1Based - 1]?.internalName ?? '') === typeName)
      .map(e => selKey(e.floorIndex, e.roomIndex1Based));
    const allSel = keys.every(k => selected.has(k));
    setSelected(prev => {
      const next = new Set(prev);
      if (allSel) keys.forEach(k => next.delete(k));
      else keys.forEach(k => next.add(k));
      return next;
    });
  };

  const toggleAll = () => {
    const allKeys = allRoomsFlat.map(e => selKey(e.floorIndex, e.roomIndex1Based));
    const allSel  = allKeys.every(k => selected.has(k));
    setSelected(allSel ? new Set() : new Set(allKeys));
  };

  const floorCheckState = (floorIndex: number): 'all' | 'some' | 'none' => {
    const keys = (roomsByFloor.get(floorIndex) ?? []).map(e => selKey(e.floorIndex, e.roomIndex1Based));
    const n = keys.filter(k => selected.has(k)).length;
    if (n === 0) return 'none';
    if (n === keys.length) return 'all';
    return 'some';
  };

  const typeIsActive = (typeName: string) => {
    const keys = allRoomsFlat
      .filter(e => (building.rooms[e.roomIndex1Based - 1]?.internalName ?? '') === typeName)
      .map(e => selKey(e.floorIndex, e.roomIndex1Based));
    return keys.length > 0 && keys.every(k => selected.has(k));
  };

  const allSel = allRoomsFlat.length > 0 && allRoomsFlat.every(e => selected.has(selKey(e.floorIndex, e.roomIndex1Based)));

  const floorLabel = (floorIndex: number) =>
    floorIndex === 0 ? t('floor.ground') : t('floor.upper', { n: floorIndex });


  const handleGenerate = async () => {
    const selections: RoomSelection[] = [];
    for (const key of selected) {
      const [f, r] = key.split(':').map(Number);
      selections.push({ floorIndex: f, roomIndex1Based: r, roomTypeOverride: overrides[key] ?? '' });
    }
    if (selections.length === 0) { setStatus({ msg: t('furnishPanel.noRoomSelected'), ok: false }); return; }

    setRunning(true); setStatus(null);
    try {
      const result = await generateFurnishing(building, selections, seed);
      setPlacements(result.placements);
      onPlacementsChanged(result.placements);
      onLogChanged?.(result.log);
      setStatus({ msg: t('furnishPanel.tilesPlaced', { tiles: result.placements.length, rooms: selections.length }), ok: true });
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
      setStatus({ msg: `✓ ${t('furnishPanel.exportOk')}`, ok: true });
    } catch (e) {
      setStatus({ msg: t('furnishPanel.exportError', { error: String(e) }), ok: false });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className={s.panel}>
      <p className={s.panelTitle}>{t('furnishPanel.title')}</p>

      {/* ── Quick-select toolbar ── */}
      <span className={s.sectionLabel}>{t('furnishPanel.selectRooms')}</span>
      <div className={s.typeToolbar}>
        <button
          className={`${s.typeBtn} ${allSel ? s.typeBtnActive : ''}`}
          onClick={toggleAll}
          title={allSel ? t('furnishPanel.deselectAll') : t('furnishPanel.selectAll')}
        >
          {t('furnishPanel.selectAll')}
        </button>
        {uniqueTypes.map(typeName => (
          <button
            key={typeName}
            className={`${s.typeBtn} ${typeIsActive(typeName) ? s.typeBtnActive : ''}`}
            onClick={() => toggleByType(typeName)}
            title={typeName}
          >
            {typeName}
          </button>
        ))}
      </div>

      {/* ── Room list grouped by floor ── */}
      <div className={s.roomList}>
        {[...roomsByFloor.entries()].map(([floorIndex, rooms]) => (
          <div key={floorIndex} className={s.floorGroup}>

            {/* Floor header */}
            <div className={s.floorHeader} onClick={() => toggleFloor(floorIndex)}>
              <FloorCheckbox state={floorCheckState(floorIndex)} />
              <span className={s.floorLabel}>{floorLabel(floorIndex)}</span>
              <span className={s.floorRoomCount}>{rooms.length}</span>
            </div>

            {/* Room rows */}
            {rooms.map(({ floorIndex: fi, roomIndex1Based }) => {
              const key         = selKey(fi, roomIndex1Based);
              const room        = building.rooms[roomIndex1Based - 1];
              const cells       = roomCellCount(building, fi, roomIndex1Based);
              const sizeKey     = classifySize(cells);
              const typeName    = overrides[key] || room?.internalName || '';
              const displayName = room?.name || `Raum ${roomIndex1Based}`;
              const hasMatch    = knownTypes.some(k => k.toLowerCase() === typeName.toLowerCase());
              const isSel       = selected.has(key);
              const colorCss    = tbxColorToCss(room?.color);

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
                    {!hasMatch && typeName && (
                      <span className={s.roomRowNoMatch} title={`Kein passender Raumtyp für „${typeName}"`}>⚠</span>
                    )}
                  </div>

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
        ))}
      </div>

      <datalist id="knownTypesList">
        {knownTypes.map(tn => <option key={tn} value={tn} />)}
      </datalist>

      {/* ── Seed ── */}
      <span className={s.sectionLabel}>{t('furnishPanel.seed')}</span>
      <div className={s.seedRow}>
        <span className={s.seedLabel}>{t('furnishPanel.seed')}</span>
        <input
          type="number"
          className={s.seedInput}
          value={seed}
          onChange={e => setSeed(+e.target.value)}
        />
        <button
          className={s.seedRandom}
          onClick={() => setSeed(Math.floor(Math.random() * 999999))}
          title={t('furnishPanel.randomSeed')}>
          🎲
        </button>
      </div>

      {/* ── Generate ── */}
      <button
        className={s.generateBtn}
        disabled={running || selected.size === 0}
        onClick={handleGenerate}>
        {running
          ? `⏳ ${t('furnishPanel.generating')}`
          : `✨ ${t('furnishPanel.generate', { count: selected.size })}`}
      </button>

      {/* ── Result summary + export ── */}
      {placements.length > 0 && (
        <>
          <div className={s.resultSummary}>
            {t('furnishPanel.tilesPlacedSummary', { count: placements.length })}
          </div>
          <button
            className={s.exportBtn}
            disabled={exporting}
            onClick={handleExport}>
            {exporting ? `⏳ ${t('furnishPanel.exporting')}` : t('furnishPanel.exportTbx')}
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

/** Floor header checkbox – supports indeterminate state */
function FloorCheckbox({ state }: { state: 'all' | 'some' | 'none' }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.indeterminate = state === 'some';
    ref.current.checked       = state === 'all';
  }, [state]);
  return (
    <input
      type="checkbox"
      ref={ref}
      className={s.floorCheck}
      onClick={e => e.stopPropagation()}
      readOnly
    />
  );
}

