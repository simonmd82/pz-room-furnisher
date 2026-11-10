import { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Building, PlacedFurnitureItem, ReservedZonePlacement } from '../../types/building';
import { generateFurnishingStream, exportTbx, exportReproBundle, getAppVersion } from '../../api/furnishApi';
import type { RoomSelection, FurnishRequestSnapshot, ReproExpected } from '../../api/furnishApi';
import { getColorNames } from '../../api/settingsApi';
import { getRoomTypes } from '../../api/roomTypesApi';
import type { RoomTypeConfigMap } from '../../types/roomTypes';
import { getColors, getTilesPath, getTileConfigSets, updateTileConfigSet } from '../../api/tilesApi';
import { issueUrl } from '../../utils/reportLinks';
import type { TileConfigSetInfo } from '../../types/tiles';
import { Spinner } from '../Spinner/Spinner';
import { FurnishProgressDialog } from './FurnishProgressDialog';
import type { FurnishProgress } from './FurnishProgressDialog';
import s from './FurnishPanel.module.css';

/** How many recent generator log lines the progress dialog shows. */
const PROGRESS_LOG_LINES = 40;

/** openMenu value of the colour dropdown; room menus use their selection key. */
const COLOR_MENU = 'excludeColors';

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
  /** Colour tags that must not appear in the furnishing. */
  excludedColors: string[];
  onExcludedColorsChange: (colors: string[]) => void;
  /** Place light switches next to doors. */
  lightSwitches: boolean;
  onLightSwitchesChange: (on: boolean) => void;
  /** Reserved zones already on the grid when the panel mounts (e.g. from a replayed repro bundle). */
  initialReservedZones?: ReservedZonePlacement[];
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
  seed, onSeedChange, densityMin, densityMax, densityFixed, onDensityChange, excludedColors, onExcludedColorsChange,
  lightSwitches, onLightSwitchesChange,
  initialReservedZones,
}: Props) {
  const { t } = useTranslation();
  const [roomTypes, setRoomTypes]       = useState<RoomTypeConfigMap>({});
  const [running, setRunning]           = useState(false);
  const [progress, setProgress]         = useState<FurnishProgress | null>(null);
  const abortRef                        = useRef<AbortController | null>(null);
  const [exporting, setExporting]       = useState(false);
  const [status, setStatus]             = useState<{ msg: string; ok: boolean } | null>(null);
  const [reservedZones, setReservedZones] = useState<ReservedZonePlacement[]>(() => initialReservedZones ?? []);
  const [openMenu, setOpenMenu]         = useState<string | null>(null);
  const [configSets, setConfigSets]     = useState<TileConfigSetInfo[]>([]);
  const [collapsedFloors, setCollapsedFloors] = useState<Set<number>>(new Set());
  /** Last fully completed run: the request exactly as sent + only what that run produced. */
  const [lastRun, setLastRun] = useState<{ request: FurnishRequestSnapshot; expected: ReproExpected } | null>(null);
  const [exportingRepro, setExportingRepro] = useState(false);
  const [knownColors, setKnownColors] = useState<string[]>([]);
  const [appVersion, setAppVersion]   = useState('');
  /** The tiles folder from the Settings tab is valid; null until the check has finished.
   *  (The BuildingFurniture.txt path is developer-only and not needed for furnishing.) */
  const [pathsReady, setPathsReady]   = useState<boolean | null>(null);

  useEffect(() => {
    getTilesPath()
      .then(tiles => setPathsReady(tiles.isValid))
      .catch(() => setPathsReady(false));
    getRoomTypes().then(setRoomTypes).catch(console.error);
    getTileConfigSets().then(setConfigSets).catch(console.error);
    getAppVersion().then(setAppVersion).catch(console.error);
    // Tile tags plus the colour registry: some colours exist only on rugs, some only on tiles.
    Promise.all([getColors(), getColorNames().catch(() => [] as string[])]).then(([tags, names]) => {
      // Shades are listed under their base colour; the backend excludes them together.
      const byLower = new Map([...names, ...tags].map(c => c.replace(/ (Light|Dark)$/i, '')).map(c => [c.toLowerCase(), c]));
      const colors = [...byLower.values()].sort((a, b) => a.localeCompare(b));
      setKnownColors(colors);
      // An empty list means the request failed or no tiles exist; keep the stored selection then.
      if (colors.length === 0) return;
      const stillKnown = excludedColors.filter(c => colors.includes(c));
      if (stillKnown.length !== excludedColors.length) onExcludedColorsChange(stillKnown);
    }).catch(console.error);
  }, []);

  const toggleConfigSet = async (id: string, enabled: boolean) => {
    setConfigSets(prev => prev.map(set => set.id === id ? { ...set, enabled } : set));
    try {
      await updateTileConfigSet(id, { enabled });
    } catch {
      setConfigSets(prev => prev.map(set => set.id === id ? { ...set, enabled: !enabled } : set));
    }
  };

  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [openMenu]);

  const roomsByFloor  = useMemo(() => collectRoomsByFloor(building), [building]);
  const allRoomsFlat  = useMemo(() => [...roomsByFloor.values()].flat(), [roomsByFloor]);

  const selKey = (entry: RoomEntry) => `${entry.floorIndex}:${entry.roomIndex1Based}:${entry.anchorCol}:${entry.anchorRow}`;

  const knownTypes = useMemo(() => Object.keys(roomTypes), [roomTypes]);

  /** Room type the generator will use for this room: the override, else the room's InternalName. */
  const effectiveType = (entry: RoomEntry) =>
    overrides[selKey(entry)] || building.rooms[entry.roomIndex1Based - 1]?.internalName || '';

  /** Matching room-type config (case-insensitive, like the backend), or undefined. */
  const configFor = (typeName: string) => {
    const k = knownTypes.find(k => k.toLowerCase() === typeName.toLowerCase());
    return k ? roomTypes[k] : undefined;
  };

  /** A config that can actually place something — at least one slot or grid layout. */
  const configHasFurniture = (cfg: RoomTypeConfigMap[string]) =>
    cfg.slots.length > 0 || (cfg.grids?.length ?? 0) > 0;

  /**
   * Bulk selectors (all / floor / type) only pick rooms with a working room definition;
   * individual checkboxes can still select any room.
   */
  const isEligible = (entry: RoomEntry) => {
    const cfg = configFor(effectiveType(entry));
    return cfg !== undefined && configHasFurniture(cfg);
  };

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

  /**
   * Shared bulk toggle over a group of rooms: if every eligible room of the group is already
   * selected, the whole group is deselected (eligible or not); otherwise its eligible rooms
   * are added.
   */
  const toggleGroup = (entries: RoomEntry[]) => {
    const eligibleKeys = entries.filter(isEligible).map(selKey);
    const allSel = eligibleKeys.length > 0 && eligibleKeys.every(k => selected.has(k));
    const next = new Set(selected);
    if (allSel) entries.forEach(e => next.delete(selKey(e)));
    else eligibleKeys.forEach(k => next.add(k));
    onSelectedChange(next);
  };

  const roomsOfType = (typeName: string) =>
    allRoomsFlat.filter(e => (building.rooms[e.roomIndex1Based - 1]?.internalName ?? '') === typeName);

  const toggleFloor  = (floorIndex: number) => toggleGroup(roomsByFloor.get(floorIndex) ?? []);
  const toggleByType = (typeName: string)   => toggleGroup(roomsOfType(typeName));
  const toggleAll    = ()                   => toggleGroup(allRoomsFlat);

  /** 'all' = every eligible room selected. */
  const groupCheckState = (entries: RoomEntry[]): 'all' | 'some' | 'none' => {
    const n = entries.filter(e => selected.has(selKey(e))).length;
    if (n === 0) return 'none';
    const eligible = entries.filter(isEligible);
    if (eligible.length > 0 && eligible.every(e => selected.has(selKey(e)))) return 'all';
    return 'some';
  };

  const floorCheckState = (floorIndex: number) => groupCheckState(roomsByFloor.get(floorIndex) ?? []);
  const typeIsActive    = (typeName: string) => groupCheckState(roomsOfType(typeName)) === 'all';
  const allSel          = groupCheckState(allRoomsFlat) === 'all';

  const floorLabel = (floorIndex: number) =>
    floorIndex === 0 ? t('floor.ground') : t('floor.upper', { n: floorIndex });

  const toggleFloorCollapse = (floorIndex: number) => {
    setCollapsedFloors(prev => {
      const next = new Set(prev);
      next.has(floorIndex) ? next.delete(floorIndex) : next.add(floorIndex);
      return next;
    });
  };


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

    // Each finished room replaces only its own furniture, so the grid fills in room by room
    // and a stopped run keeps every room completed so far (unprocessed rooms stay untouched).
    let livePlacements = placements;
    let liveZones      = reservedZones;
    const clearedZoneRooms = new Set<string>(); // zones are keyed per room index, not per instance
    const fullLog: string[] = [];
    let roomsDone = 0, tilesPlaced = 0;
    const request: FurnishRequestSnapshot = {
      building, roomSelections: selections, seed,
      densityMin: densityMin / 100, densityMax: densityMax / 100, densityFixed,
      excludedColors: [...excludedColors],
      lightSwitches,
    };
    const runPlacements: PlacedFurnitureItem[] = [];
    const runZones: ReservedZonePlacement[] = [];

    const abort = new AbortController();
    abortRef.current = abort;
    setRunning(true); setStatus(null);
    setProgress({ total: selections.length, done: 0, furnished: 0, skipped: 0, tiles: 0, current: null, logTail: [], stopping: false });

    try {
      await generateFurnishingStream(building, selections, ev => {
        switch (ev.type) {
          case 'room':
            setProgress(p => p && { ...p, current: { floorIndex: ev.floorIndex, roomName: ev.roomName, roomType: ev.roomType } });
            break;
          case 'roomDone': {
            const key = `${ev.floorIndex}:${ev.roomIndex1Based}:${ev.anchorCol}:${ev.anchorRow}`;
            livePlacements = [
              ...livePlacements.filter(p => `${p.floorIndex}:${p.roomIndex1Based}:${p.anchorCol}:${p.anchorRow}` !== key),
              ...ev.placements.map(p => ({ ...p, id: crypto.randomUUID() })),
            ];
            onPlacementsChanged(livePlacements);

            const roomKey = `${ev.floorIndex}:${ev.roomIndex1Based}`;
            if (!clearedZoneRooms.has(roomKey)) {
              clearedZoneRooms.add(roomKey);
              liveZones = liveZones.filter(z => `${z.floorIndex}:${z.roomIndex1Based}` !== roomKey);
            }
            liveZones = [...liveZones, ...ev.reservedZones];
            setReservedZones(liveZones);
            onReservedZonesChanged?.(liveZones);

            fullLog.push(...ev.log);
            runPlacements.push(...ev.placements);
            runZones.push(...ev.reservedZones);
            roomsDone++;
            tilesPlaced += ev.placements.length;
            setProgress(p => p && {
              ...p,
              done:      p.done + 1,
              furnished: p.furnished + (ev.skipped ? 0 : 1),
              skipped:   p.skipped + (ev.skipped ? 1 : 0),
              tiles:     p.tiles + ev.placements.length,
              logTail:   [...p.logTail, ...ev.log].slice(-PROGRESS_LOG_LINES),
            });
            break;
          }
          case 'error':
            throw new Error(ev.message);
        }
      }, abort.signal, request.seed ?? undefined, request.densityMin, request.densityMax, request.densityFixed, excludedColors, lightSwitches);

      setLastRun({ request, expected: { placements: runPlacements, reservedZones: runZones, log: fullLog } });
      setStatus({ msg: t('furnishPanel.tilesPlaced', { tiles: tilesPlaced, rooms: selections.length }), ok: true });
    } catch (e) {
      if (abort.signal.aborted)
        setStatus({ msg: t('furnishPanel.progress.stoppedStatus', { done: roomsDone, total: selections.length, tiles: tilesPlaced }), ok: true });
      else
        setStatus({ msg: t('furnishPanel.genericError', { error: String(e) }), ok: false });
    } finally {
      onLogChanged?.(fullLog);
      abortRef.current = null;
      setProgress(null);
      setRunning(false);
    }
  };

  const handleStop = () => {
    setProgress(p => p && { ...p, stopping: true });
    abortRef.current?.abort();
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

  const handleClearAllFurniture = () => {
    if (placements.length === 0 && reservedZones.length === 0) return;
    if (!window.confirm(t('furnishPanel.clearAllConfirm'))) return;
    onPlacementsChanged([]);
    setReservedZones([]);
    onReservedZonesChanged?.([]);
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

  const handleExportRepro = async (successMsg = t('furnishPanel.reproExportOk')) => {
    if (!lastRun) return;
    setExportingRepro(true);
    try {
      await exportReproBundle(lastRun.request, fileName, lastRun.expected);
      setStatus({ msg: `✓ ${successMsg}`, ok: true });
    } catch (e) {
      setStatus({ msg: t('furnishPanel.exportError', { error: String(e) }), ok: false });
    } finally {
      setExportingRepro(false);
    }
  };

  const handleReportProblem = () => {
    if (!lastRun) return;
    // Open before any await: browsers block popups that aren't directly tied to the click.
    window.open(issueUrl('bad-result.yml', { version: appVersion, seed: lastRun.request.seed ?? '' }), '_blank', 'noopener');
    void handleExportRepro(t('furnishPanel.reportExportOk'));
  };

  const toggleExcludedColor = (color: string) =>
    onExcludedColorsChange(excludedColors.includes(color)
      ? excludedColors.filter(c => c !== color)
      : [...excludedColors, color]);

  return (
    <div className={s.panel}>
    <div className={s.scrollArea}>
      <p className={s.panelTitle}>{t('furnishPanel.title')}</p>

      {/* ── Quick-select toolbar ── */}
      <div className={s.sectionLabelRow}>
        <span className={s.sectionLabel}>{t('furnishPanel.selectRooms')}</span>
        <button
          className={s.clearAllBtn}
          onClick={handleClearAllFurniture}
          disabled={placements.length === 0 && reservedZones.length === 0}
          title={t('furnishPanel.clearAllFurniture')}
        >
          🗑
        </button>
      </div>
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

      {/* ── Room list grouped by floor (collapsible tree) ── */}
      <div className={s.roomList}>
        {[...roomsByFloor.entries()].map(([floorIndex, rooms]) => {
          const collapsed = collapsedFloors.has(floorIndex);
          return (
          <div key={floorIndex} className={s.floorGroup}>

            {/* Floor header */}
            <div className={s.floorHeader}>
              <button
                className={s.floorChevron}
                onClick={() => toggleFloorCollapse(floorIndex)}
                aria-label={t('furnishPanel.toggleFloor')}
                title={t('furnishPanel.toggleFloor')}
              >
                {collapsed ? '▸' : '▾'}
              </button>
              <div className={s.floorHeaderMain} onClick={() => toggleFloor(floorIndex)}>
                <FloorCheckbox state={floorCheckState(floorIndex)} />
                <span className={s.floorLabel}>{floorLabel(floorIndex)}</span>
                <span className={s.floorRoomCount} title={t('furnishPanel.eligibleCountTitle')}>
                  {(() => {
                    const eligible = rooms.filter(isEligible).length;
                    return eligible === rooms.length ? rooms.length : `${eligible}/${rooms.length}`;
                  })()}
                </span>
              </div>
            </div>

            {/* Room rows */}
            {!collapsed && (
            <div className={s.floorRooms}>
            {rooms.map((entry) => {
              const { roomIndex1Based, cellCount, instanceNo, instanceTotal } = entry;
              const key         = selKey(entry);
              const room        = building.rooms[roomIndex1Based - 1];
              const sizeKey     = classifySize(cellCount);
              const typeName    = overrides[key] || room?.internalName || '';
              const baseName    = room?.name || t('furnishPanel.defaultRoomName', { n: roomIndex1Based });
              const displayName = instanceTotal > 1 ? `${baseName} #${instanceNo}` : baseName;
              const matchedCfg  = configFor(typeName);
              const hasMatch    = matchedCfg !== undefined;
              const isEmptyType = matchedCfg !== undefined && !configHasFurniture(matchedCfg);
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
                    {isEmptyType && (
                      <span className={s.roomRowNoMatch} title={t('furnishPanel.emptyTypeTitle', { type: typeName })}>⚠</span>
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
            )}
          </div>
          );
        })}
      </div>

      <datalist id="knownTypesList">
        {knownTypes.map(tn => <option key={tn} value={tn} />)}
      </datalist>
    </div>

    <div className={s.stickyFooter}>
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

      {/* ── Excluded colours ── */}
      {knownColors.length > 0 && (
        <>
          <span className={s.sectionLabel}>{t('furnishPanel.excludeColors')}</span>
          <div className={s.colorSelect} onClick={e => e.stopPropagation()}>
            <button
              type="button"
              className={s.colorSelectBtn}
              aria-haspopup="true"
              aria-expanded={openMenu === COLOR_MENU}
              title={excludedColors.join(', ')}
              onClick={() => setOpenMenu(openMenu === COLOR_MENU ? null : COLOR_MENU)}>
              <span className={s.colorSelectValue}>
                {excludedColors.length > 0 ? excludedColors.join(', ') : t('furnishPanel.excludeColorsNone')}
              </span>
              <span aria-hidden="true">▾</span>
            </button>
            {openMenu === COLOR_MENU && (
              <div className={s.colorSelectMenu}>
                <p className={s.configSetsHint}>{t('furnishPanel.excludeColorsHint')}</p>
                {excludedColors.length > 0 && (
                  <button type="button" className={s.colorSelectClear} onClick={() => onExcludedColorsChange([])}>
                    {t('furnishPanel.excludeColorsClear')}
                  </button>
                )}
                {knownColors.map(color => (
                  <label key={color} className={s.colorSelectOption}>
                    <input
                      type="checkbox"
                      checked={excludedColors.includes(color)}
                      onChange={() => toggleExcludedColor(color)}
                    />
                    {color}
                  </label>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <label className={s.densityToggle}>
        <input
          type="checkbox"
          checked={lightSwitches}
          onChange={e => onLightSwitchesChange(e.target.checked)}
        />
        {t('furnishPanel.lightSwitches')}
      </label>

      {/* ── Config sets ── */}
      {configSets.length > 0 && (
        <>
          <span className={s.sectionLabel}>{t('furnishPanel.configSets.title')}</span>
          <p className={s.configSetsHint}>{t('furnishPanel.configSets.description')}</p>
          <div className={s.configSetsList}>
            {configSets.map(set => (
              <label key={set.id} className={s.configSetRow}>
                <input
                  type="checkbox"
                  checked={set.enabled}
                  onChange={e => toggleConfigSet(set.id, e.target.checked)}
                />
                <span className={s.configSetName}>{set.name}</span>
                {set.description && <span className={s.configSetDesc}>{set.description}</span>}
              </label>
            ))}
          </div>
        </>
      )}

      {/* ── Generate ── */}
      {pathsReady === false && (
        <div className={`${s.status} ${s.statusError}`}>{t('furnishPanel.pathsMissing')}</div>
      )}
      <button
        className={s.generateBtn}
        disabled={running || selected.size === 0 || !pathsReady}
        onClick={handleGenerate}>
        {running
          ? <><Spinner /> {t('furnishPanel.generating')}</>
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
            {exporting ? <><Spinner /> {t('furnishPanel.exporting')}</> : t('furnishPanel.exportTbx')}
          </button>
        </>
      )}
      {lastRun && (
        <>
          <button
            className={s.exportBtn}
            disabled={exportingRepro || running}
            onClick={handleReportProblem}
            title={t('furnishPanel.reportProblemHint')}>
            {t('furnishPanel.reportProblem')}
          </button>
          <button
            className={s.exportBtn}
            disabled={exportingRepro || running}
            onClick={() => handleExportRepro()}
            title={t('furnishPanel.exportReproHint')}>
            {exportingRepro ? <><Spinner /> {t('furnishPanel.exporting')}</> : t('furnishPanel.exportRepro')}
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

    {progress && <FurnishProgressDialog progress={progress} onStop={handleStop} />}
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

