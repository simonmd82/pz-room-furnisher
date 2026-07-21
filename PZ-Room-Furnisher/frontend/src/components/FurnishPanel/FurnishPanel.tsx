import { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Building, PlacedFurnitureItem, ReservedZonePlacement } from '../../types/building';
import { generateFurnishing, exportTbx } from '../../api/furnishApi';
import type { RoomSelection } from '../../api/furnishApi';
import { getRoomTypes } from '../../api/roomTypesApi';
import s from './FurnishPanel.module.css';

interface Props {
  building: Building;
  fileName: string;
  placements: PlacedFurnitureItem[];
  onPlacementsChanged: (placements: PlacedFurnitureItem[]) => void;
  onReservedZonesChanged?: (zones: ReservedZonePlacement[]) => void;
  onLogChanged?: (log: string[]) => void;
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  overrides: Record<string, string>;
  onOverridesChange: (next: Record<string, string>) => void;
  seed: number;
  onSeedChange: (seed: number) => void;
  densityMin: number;
  densityMax: number;
  densityFixed: boolean;
  onDensityChange: (min: number, max: number, fixed: boolean) => void;
}

interface RoomEntry {
  floorIndex: number;
  roomIndex1Based: number;
  anchorCol: number;
  anchorRow: number;
  cellCount: number;
  instanceNo: number;
  instanceTotal: number;
}

/** Collect room instances (connected components) grouped by floor. */
function collectRoomsByFloor(building: Building): Map<number, RoomEntry[]> {
  const map = new Map<number, RoomEntry[]>();

  for (const floor of building.floors) {
    const visited = new Set<string>();
    const entries: RoomEntry[] = [];
    const indexCounts = new Map<number, number>();

    const rows = floor.roomGrid.length;
    const cols = floor.roomGrid[0]?.length ?? 0;
    const inBounds = (c: number, r: number) => r >= 0 && r < rows && c >= 0 && c < cols;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = floor.roomGrid[r]?.[c] ?? 0;
        if (idx <= 0) continue;

        const startKey = `${c},${r}`;
        if (visited.has(startKey)) continue;

        // Flood-fill one connected component for this room index.
        const queue: Array<[number, number]> = [[c, r]];
        visited.add(startKey);
        let cellCount = 0;

        while (queue.length > 0) {
          const [cc, cr] = queue.shift()!;
          cellCount++;
          const neighbors: Array<[number, number]> = [[cc + 1, cr], [cc - 1, cr], [cc, cr + 1], [cc, cr - 1]];
          for (const [nc, nr] of neighbors) {
            if (!inBounds(nc, nr)) continue;
            if ((floor.roomGrid[nr]?.[nc] ?? 0) !== idx) continue;
            const k = `${nc},${nr}`;
            if (visited.has(k)) continue;
            visited.add(k);
            queue.push([nc, nr]);
          }
        }

        indexCounts.set(idx, (indexCounts.get(idx) ?? 0) + 1);
        entries.push({
          floorIndex: floor.index,
          roomIndex1Based: idx,
          anchorCol: c,
          anchorRow: r,
          cellCount,
          instanceNo: 0,
          instanceTotal: 0,
        });
      }
    }

    const runningNo = new Map<number, number>();
    for (const entry of entries) {
      const nextNo = (runningNo.get(entry.roomIndex1Based) ?? 0) + 1;
      runningNo.set(entry.roomIndex1Based, nextNo);
      entry.instanceNo = nextNo;
      entry.instanceTotal = indexCounts.get(entry.roomIndex1Based) ?? 1;
    }

    if (entries.length > 0) map.set(floor.index, entries);
  }

  for (const rooms of map.values()) {
    rooms.sort((a, b) => {
      if (a.roomIndex1Based !== b.roomIndex1Based) return a.roomIndex1Based - b.roomIndex1Based;
      if (a.anchorRow !== b.anchorRow) return a.anchorRow - b.anchorRow;
      return a.anchorCol - b.anchorCol;
    });
  }

  return new Map([...map.entries()].sort((a, b) => a[0] - b[0]));
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

export default function FurnishPanel({
  building, fileName, placements, onPlacementsChanged, onReservedZonesChanged, onLogChanged,
  selected, onSelectedChange, overrides, onOverridesChange,
  seed, onSeedChange, densityMin, densityMax, densityFixed, onDensityChange,
}: Props) {
  const { t } = useTranslation();
  const [knownTypes, setKnownTypes]     = useState<string[]>([]);
  const [running, setRunning]           = useState(false);
  const [exporting, setExporting]       = useState(false);
  const [status, setStatus]             = useState<{ msg: string; ok: boolean } | null>(null);
  const [reservedZones, setReservedZones] = useState<ReservedZonePlacement[]>([]);
  const [openMenu, setOpenMenu]         = useState<string | null>(null);

  useEffect(() => {
    getRoomTypes().then(cfgs => setKnownTypes(Object.keys(cfgs))).catch(console.error);
  }, []);

  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [openMenu]);

  const roomsByFloor  = useMemo(() => collectRoomsByFloor(building), [building]);
  const allRoomsFlat  = useMemo(() => [...roomsByFloor.values()].flat(), [roomsByFloor]);

  const selKey = (entry: RoomEntry) => `${entry.floorIndex}:${entry.roomIndex1Based}:${entry.anchorCol}:${entry.anchorRow}`;

  /** Unique internalNames across all rooms, sorted */
  const uniqueTypes = useMemo(() => {
    const types = new Set<string>();
    for (const e of allRoomsFlat) {
      const name = building.rooms[e.roomIndex1Based - 1]?.internalName;
      if (name) types.add(name);
    }
    return [...types].sort();
  }, [allRoomsFlat, building.rooms]);

  const toggleRoom = (key: string) => {
    const next = new Set(selected);
    next.has(key) ? next.delete(key) : next.add(key);
    onSelectedChange(next);
  };

  const toggleFloor = (floorIndex: number) => {
    const keys = (roomsByFloor.get(floorIndex) ?? []).map(selKey);
    const allSel = keys.every(k => selected.has(k));
    const next = new Set(selected);
    if (allSel) keys.forEach(k => next.delete(k));
    else keys.forEach(k => next.add(k));
    onSelectedChange(next);
  };

  const toggleByType = (typeName: string) => {
    const keys = allRoomsFlat
      .filter(e => (building.rooms[e.roomIndex1Based - 1]?.internalName ?? '') === typeName)
      .map(selKey);
    const allSel = keys.every(k => selected.has(k));
    const next = new Set(selected);
    if (allSel) keys.forEach(k => next.delete(k));
    else keys.forEach(k => next.add(k));
    onSelectedChange(next);
  };

  const toggleAll = () => {
    const allKeys = allRoomsFlat.map(selKey);
    const allSel  = allKeys.every(k => selected.has(k));
    onSelectedChange(allSel ? new Set() : new Set(allKeys));
  };

  const floorCheckState = (floorIndex: number): 'all' | 'some' | 'none' => {
    const keys = (roomsByFloor.get(floorIndex) ?? []).map(selKey);
    const n = keys.filter(k => selected.has(k)).length;
    if (n === 0) return 'none';
    if (n === keys.length) return 'all';
    return 'some';
  };

  const typeIsActive = (typeName: string) => {
    const keys = allRoomsFlat
      .filter(e => (building.rooms[e.roomIndex1Based - 1]?.internalName ?? '') === typeName)
      .map(selKey);
    return keys.length > 0 && keys.every(k => selected.has(k));
  };

  const allSel = allRoomsFlat.length > 0 && allRoomsFlat.every(e => selected.has(selKey(e)));

  const floorLabel = (floorIndex: number) =>
    floorIndex === 0 ? t('floor.ground') : t('floor.upper', { n: floorIndex });


  const handleGenerate = async () => {
    const selections: RoomSelection[] = [];
    for (const key of selected) {
      const [f, r, c, rr] = key.split(':').map(Number);
      selections.push({
        floorIndex: f,
        roomIndex1Based: r,
        anchorCol: c,
        anchorRow: rr,
        roomTypeOverride: overrides[key] ?? '',
      });
    }
    if (selections.length === 0) { setStatus({ msg: t('furnishPanel.noRoomSelected'), ok: false }); return; }

    setRunning(true); setStatus(null);
    try {
      const result = await generateFurnishing(building, selections, seed, densityMin / 100, densityMax / 100, densityFixed);
      const idPlacements = result.placements.map(p => ({ ...p, id: crypto.randomUUID() }));
      const preserved = placements.filter(p =>
        !selected.has(`${p.floorIndex}:${p.roomIndex1Based}:${p.anchorCol}:${p.anchorRow}`)
      );
      const merged = [...preserved, ...idPlacements];
      onPlacementsChanged(merged);

      const selectedRoomKeys = new Set([...selected].map(k => k.split(':').slice(0, 2).join(':')));
      const preservedZones = reservedZones.filter(z => !selectedRoomKeys.has(`${z.floorIndex}:${z.roomIndex1Based}`));
      const mergedZones = [...preservedZones, ...result.reservedZones];
      setReservedZones(mergedZones);
      onReservedZonesChanged?.(mergedZones);

      onLogChanged?.(result.log);
      setStatus({ msg: t('furnishPanel.tilesPlaced', { tiles: result.placements.length, rooms: selections.length }), ok: true });
    } catch (e) {
      setStatus({ msg: t('furnishPanel.genericError', { error: String(e) }), ok: false });
    } finally {
      setRunning(false);
    }
  };

  const handleClearFurniture = (key: string) => {
    const [f, r, c, rr] = key.split(':').map(Number);
    const filtered = placements.filter(p =>
      !(p.floorIndex === f && p.roomIndex1Based === r && p.anchorCol === c && p.anchorRow === rr)
    );
    onPlacementsChanged(filtered);

    const filteredZones = reservedZones.filter(z => !(z.floorIndex === f && z.roomIndex1Based === r));
    setReservedZones(filteredZones);
    onReservedZonesChanged?.(filteredZones);

    setOpenMenu(null);
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
            {rooms.map((entry) => {
              const { roomIndex1Based, cellCount, instanceNo, instanceTotal } = entry;
              const key         = selKey(entry);
              const room        = building.rooms[roomIndex1Based - 1];
              const sizeKey     = classifySize(cellCount);
              const typeName    = overrides[key] || room?.internalName || '';
              const baseName    = room?.name || t('furnishPanel.defaultRoomName', { n: roomIndex1Based });
              const displayName = instanceTotal > 1 ? `${baseName} #${instanceNo}` : baseName;
              const hasMatch    = knownTypes.some(k => k.toLowerCase() === typeName.toLowerCase());
              const isSel       = selected.has(key);
              const colorCss    = tbxColorToCss(room?.color);
              const hasFurniture = placements.some(p =>
                p.floorIndex === entry.floorIndex &&
                p.roomIndex1Based === entry.roomIndex1Based &&
                p.anchorCol === entry.anchorCol &&
                p.anchorRow === entry.anchorRow
              );

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
                      title={t('furnishPanel.colorTitle', { color: room?.color })}
                    />
                    <span className={s.roomRowName} title={`${displayName} (${room?.internalName}) @ [${entry.anchorCol},${entry.anchorRow}]`}>
                      {displayName}
                      {room?.internalName && room.internalName !== displayName && (
                        <span className={s.roomInternalName}> · {room.internalName}</span>
                      )}
                    </span>
                    <span className={s.roomRowBadge} title={t('furnishPanel.cellsTitle', { count: cellCount })}>{SIZE_LABELS[sizeKey]}</span>
                    {!hasMatch && typeName && (
                      <span className={s.roomRowNoMatch} title={t('furnishPanel.noMatchTitle', { type: typeName })}>⚠</span>
                    )}
                    <div
                      className={s.menuAnchor}
                      onClick={e => e.stopPropagation()}
                    >
                      <button
                        className={`${s.menuBtn} ${openMenu === key || hasFurniture ? s.menuBtnVisible : ''}`}
                        aria-label={t('furnishPanel.menuLabel')}
                        title={t('furnishPanel.menuLabel')}
                        onClick={() => setOpenMenu(openMenu === key ? null : key)}
                      >⋯</button>
                      {openMenu === key && (
                        <div className={s.menuDropdown}>
                          <button
                            className={s.menuItem}
                            disabled={!hasFurniture}
                            onClick={() => handleClearFurniture(key)}
                          >
                            {t('furnishPanel.clearFurniture')}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {isSel && (
                    <input
                      className={s.overrideInput}
                      placeholder={t('furnishPanel.roomTypePlaceholder', { type: typeName || t('furnishPanel.unknown') })}
                      value={overrides[key] ?? ''}
                      list="knownTypesList"
                      onChange={e => onOverridesChange({ ...overrides, [key]: e.target.value })}
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
          onChange={e => onSeedChange(+e.target.value)}
        />
        <button
          className={s.seedRandom}
          onClick={() => onSeedChange(Math.floor(Math.random() * 999999))}
          title={t('furnishPanel.randomSeed')}>
          🎲
        </button>
      </div>

      {/* ── Density ── */}
      <span className={s.sectionLabel}>{t('furnishPanel.density')}</span>
      <div className={s.densityRow}>
        <span className={s.densityLabel}>{t('furnishPanel.densityMin')} {densityMin}%</span>
        <input
          type="range" min={0} max={100} step={5}
          value={densityMin}
          className={s.densitySlider}
          onChange={e => {
            const v = +e.target.value;
            onDensityChange(v, Math.max(v, densityMax), densityFixed);
          }}
        />
      </div>
      <div className={s.densityRow}>
        <span className={s.densityLabel}>{t('furnishPanel.densityMax')} {densityMax}%</span>
        <input
          type="range" min={0} max={100} step={5}
          value={densityMax}
          className={s.densitySlider}
          onChange={e => {
            const v = +e.target.value;
            onDensityChange(Math.min(v, densityMin), v, densityFixed);
          }}
        />
      </div>
      <p className={s.densityHint}>{t('furnishPanel.densityHint', { min: densityMin, max: densityMax })}</p>
      <label className={s.densityToggle}>
        <input
          type="checkbox"
          checked={densityFixed}
          onChange={e => onDensityChange(densityMin, densityMax, e.target.checked)}
        />
        {t('furnishPanel.densityFixed')}
      </label>

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

