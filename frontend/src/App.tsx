import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FileUpload } from './components/FileUpload';
import { FloorSelector } from './components/FloorSelector';
import { GridRenderer } from './components/GridRenderer';
import { TileBrowser } from './components/TileBrowser/TileBrowser';
import { FurnitureBrowser } from './components/FurnitureBrowser/FurnitureBrowser';
import { RoomTypeEditor } from './components/RoomTypeEditor/RoomTypeEditor';
import { RugEditor } from './components/RugEditor/RugEditor';
import { TileUsage } from './components/TileUsage/TileUsage';
import { SettingsEditor } from './components/SettingsEditor/SettingsEditor';
import FurnishPanel from './components/FurnishPanel/FurnishPanel';
import { WallFurniturePanel } from './components/WallFurniturePanel/WallFurniturePanel';
import { ActiveConfigSetProvider } from './context/ActiveConfigSetContext';
import { TileSettingsClipboardProvider } from './context/TileSettingsClipboardContext';
import { ReproImport } from './components/ReproImport';
import type { Building, Floor, FurnishResult, PlacedFurnitureItem, ReservedZonePlacement } from './types/building';
import type { ReproBundle, RoomSelection } from './api/furnishApi';
import { compareReproResult } from './utils/reproCompare';
import type { TileConfigMap, TileSheetInfo } from './types/tiles';
import { getTileConfig, getSheets } from './api/tilesApi';
import { uploadTbx } from './api/buildingApi';
import './App.css';
import s from './components/FurnishPanel/FurnishPanel.module.css';

const LANGS = [
  { code: 'de', label: 'DE ' },
  { code: 'en', label: 'EN ' },
];

/** Distinct room indices (1-based) that appear in this floor's grid. */
function roomsOnFloor(floor: Floor): Set<number> {
  const result = new Set<number>();
  for (const row of floor.roomGrid)
    for (const idx of row)
      if (idx > 0) result.add(idx);
  return result;
}

/**
 * Total = SUM across all floors of (distinct rooms on that floor that have
 * at least one door or window edge).
 * Example: Floor 0 has 6 accessible rooms, Floor 1 has 2 → total = 8.
 * Falls back to all present rooms per floor when no edges exist.
 */
function countTotalAccessibleRooms(building: Building): number {
  let total = 0;
  for (const floor of building.floors) {
    const present = roomsOnFloor(floor);
    if (present.size === 0) continue;

    // No edges on this floor → count all present rooms (fallback)
    if (floor.edges.length === 0) {
      total += present.size;
      continue;
    }

    // Collect room indices touched by at least one door/window on this floor
    const accessible = new Set<number>();
    for (const edge of floor.edges) {
      for (const [col, row] of [
        [edge.cell1Col, edge.cell1Row],
        [edge.cell2Col, edge.cell2Row],
      ] as [number, number][]) {
        const idx = floor.roomGrid[row]?.[col] ?? 0;
        if (idx > 0) accessible.add(idx);
      }
    }

    // Add only rooms that are both present AND accessible on THIS floor
    for (const idx of present)
      if (accessible.has(idx)) total++;
  }
  return total;
}

/** Bestimmt die CSS-Klasse anhand des Zeilenpräfixes */
function logLineClass(line: string, styles: Record<string, string>): string {
  const t = line.trimStart();
  if (t.startsWith('[ROOM]'))   return styles.logRoom;
  if (t.startsWith('[PLACED]')) return styles.logPlaced;
  if (t.startsWith('[SLOT]'))   return styles.logSlot;
  if (t.startsWith('[GROUP]'))  return styles.logGroup;
  if (t.startsWith('[WARN]'))   return styles.logWarn;
  if (t.startsWith('[SKIP]'))   return styles.logSkip;
  return styles.logOther;
}

function App() {
  const { t, i18n } = useTranslation();
  const [building, setBuilding]         = useState<Building | null>(null);
  const [fileName, setFileName]         = useState('building');
  const [selectedFloor, setSelectedFloor] = useState(0);
  const [activeTab, setActiveTab]       = useState<'building' | 'tiles' | 'furniture' | 'roomtypes' | 'rugs' | 'tileusage' | 'settings'>('building');
  const [placements, setPlacements]     = useState<PlacedFurnitureItem[]>([]);
  const [reservedZones, setReservedZones] = useState<ReservedZonePlacement[]>([]);
  const [tileConfig, setTileConfig]     = useState<TileConfigMap | undefined>(undefined);
  const [sheetInfos, setSheetInfos]     = useState<TileSheetInfo[] | undefined>(undefined);
  const [generatorLog, setGeneratorLog] = useState<string[]>([]);
  const [logOpen, setLogOpen]           = useState(false);
  const [logCopied, setLogCopied]       = useState(false);
  const [showGeneratorLog, setShowGeneratorLog] = useState<boolean>(
    () => localStorage.getItem('pzrf.showGeneratorLog') !== 'false'
  );
  const [furnishingConfigEnabled, setFurnishingConfigEnabled] = useState<boolean>(
    () => localStorage.getItem('pzrf.furnishingConfigEnabled') === 'true'
  );
  const [selected, setSelected]         = useState<Set<string>>(new Set());
  const [overrides, setOverrides]       = useState<Record<string, string>>({});
  const [seed, setSeed]                 = useState<number>(() => Math.floor(Math.random() * 999999));
  const [densityMin, setDensityMin]     = useState(50);
  const [densityMax, setDensityMax]     = useState(100);
  const [densityFixed, setDensityFixed] = useState(false);
  const [excludedColors, setExcludedColors] = useState<string[]>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem('pzrf.excludedColors') ?? '[]');
      return Array.isArray(stored) ? stored.filter((c): c is string => typeof c === 'string') : [];
    } catch {
      return [];
    }
  });
  const [lightSwitches, setLightSwitches] = useState<boolean>(
    () => localStorage.getItem('pzrf.lightSwitches') !== 'false'
  );
  const [lastFile, setLastFile]         = useState<File | null>(null);
  const [reproToolsEnabled, setReproToolsEnabled] = useState<boolean>(
    () => localStorage.getItem('pzrf.reproToolsEnabled') === 'true'
  );
  /** Bumped on every building load so FurnishPanel remounts with fresh internal state. */
  const [loadId, setLoadId]             = useState(0);

  useEffect(() => {
    localStorage.setItem('pzrf.reproToolsEnabled', String(reproToolsEnabled));
  }, [reproToolsEnabled]);

  useEffect(() => {
    localStorage.setItem('pzrf.excludedColors', JSON.stringify(excludedColors));
  }, [excludedColors]);

  useEffect(() => {
    localStorage.setItem('pzrf.lightSwitches', String(lightSwitches));
  }, [lightSwitches]);

  useEffect(() => {
    localStorage.setItem('pzrf.showGeneratorLog', String(showGeneratorLog));
  }, [showGeneratorLog]);

  useEffect(() => {
    localStorage.setItem('pzrf.furnishingConfigEnabled', String(furnishingConfigEnabled));
    if (!furnishingConfigEnabled && (activeTab === 'tiles' || activeTab === 'furniture' || activeTab === 'roomtypes' || activeTab === 'rugs' || activeTab === 'tileusage')) {
      setActiveTab('building');
    }
  }, [furnishingConfigEnabled]);

  // Load tile config + sheet metadata once on mount (needed for furniture preview)
  useEffect(() => {
    getTileConfig().then(setTileConfig).catch(console.error);
    getSheets().then(r => setSheetInfos(r.sheets)).catch(console.error);
  }, []);

  const handleBuildingLoaded = (b: Building, name: string, file: File) => {
    setBuilding(b);
    setFileName(name);
    setLastFile(file);
    setSelectedFloor(0);
    setPlacements([]);
    setReservedZones([]);
    setGeneratorLog([]);
    setLogOpen(false);
    setSelected(new Set());
    setOverrides({});
    setLoadId(n => n + 1);
  };

  /** A repro bundle was replayed: restore its building, selection and settings, show the replay. */
  const handleReproReplayed = (bundle: ReproBundle, result: FurnishResult, localVersion: string) => {
    const req = bundle.request;
    const sels = req.roomSelections;
    const key = (r: RoomSelection) => `${r.floorIndex}:${r.roomIndex1Based}:${r.anchorCol}:${r.anchorRow}`;
    setBuilding(req.building);
    setFileName(bundle.fileName || 'building');
    setLastFile(null); // no .tbx to re-parse; the bundle's building is authoritative
    setSelectedFloor(sels[0]?.floorIndex ?? req.building.floors[0]?.index ?? 0);
    setPlacements(result.placements.map(p => ({ ...p, id: crypto.randomUUID() })));
    setReservedZones(result.reservedZones);
    setSelected(new Set(sels.map(key)));
    setOverrides(Object.fromEntries(sels.filter(r => r.roomTypeOverride).map(r => [key(r), r.roomTypeOverride])));
    if (req.seed != null) setSeed(req.seed);
    setDensityMin(Math.round(req.densityMin * 100));
    setDensityMax(Math.round(req.densityMax * 100));
    setDensityFixed(req.densityFixed);
    setExcludedColors(req.excludedColors ?? []);
    setLightSwitches(req.lightSwitches ?? false);
    setGeneratorLog([...compareReproResult(bundle.expected, result, bundle.appVersion, localVersion), ...result.log]);
    setLogOpen(true);
    setLoadId(n => n + 1);
  };

  /**
   * Wall-furniture classifications are resolved into WallEdges at parse time
   * (backend), so saving a new classification doesn't retroactively touch the
   * already-parsed building — silently re-parse the same file to pick it up.
   * placements/selected/overrides are keyed by floor/room/anchor coordinates
   * that don't change across a re-parse of the identical file, so they stay valid.
   */
  const handleWallFurnitureClassified = async () => {
    if (!lastFile) return;
    try {
      const refreshed = await uploadTbx(lastFile);
      setBuilding(refreshed);
    } catch (e) {
      console.error('Failed to re-parse building after wall-furniture classification:', e);
    }
  };

  /** Called by GridRenderer after a single room's path was regenerated. */
  const handleFloorUpdated = (updatedFloor: Floor) => {
    if (!building) return;
    setBuilding({
      ...building,
      floors: building.floors.map(f => f.index === updatedFloor.index ? updatedFloor : f),
    });
  };

  const floor = building?.floors.find((f) => f.index === selectedFloor) ?? null;

  const accessibleCount = useMemo(
    () => building ? countTotalAccessibleRooms(building) : 0,
    [building],
  );

  const floorRoomCount = useMemo(
    () => floor ? roomsOnFloor(floor).size : 0,
    [floor],
  );

  const handleCopyLog = async () => {
    try {
      await navigator.clipboard.writeText(generatorLog.join('\n'));
      setLogCopied(true);
      setTimeout(() => setLogCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy log:', e);
    }
  };

  /** Sheet-Metadaten neu laden – z.B. nach Setzen des Tiles-Pfads nach App-Start. */
  const reloadSheets = () => {
    getSheets().then(r => { if (r.configured) setSheetInfos(r.sheets); }).catch(console.error);
  };

  /** Tab wechseln - beim Zurueckwechseln zum Building-Tab sheetInfos nachladen */
  const handleTabChange = (tab: typeof activeTab) => {
    setActiveTab(tab);
    if (tab === 'building') reloadSheets();
  };

  return (
    <ActiveConfigSetProvider>
    <TileSettingsClipboardProvider>
    <div className="app">
      <header className="app-header">
        <div className="app-header-top">
          <div>
            <h1>{t('app.title')}</h1>
            <p className="app-subtitle">{t('app.subtitle')}</p>
          </div>
          <div className="lang-switcher">
            {LANGS.map(l => (
              <button
                key={l.code}
                className={`lang-btn ${i18n.language === l.code ? 'lang-btn-active' : ''}`}
                onClick={() => i18n.changeLanguage(l.code)}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
        <div className="tab-bar">
          <button
            className={`tab-btn ${activeTab === 'building' ? 'tab-active' : ''}`}
            onClick={() => handleTabChange('building')}
          >
            🏠 {t('tabs.building')}
          </button>
          {furnishingConfigEnabled && (
            <>
              <button
                className={`tab-btn ${activeTab === 'tiles' ? 'tab-active' : ''}`}
                onClick={() => handleTabChange('tiles')}
              >
                🖼 {t('tabs.tiles')}
              </button>
              <button
                className={`tab-btn ${activeTab === 'furniture' ? 'tab-active' : ''}`}
                onClick={() => handleTabChange('furniture')}
              >
                📋 {t('tabs.furniture')}
              </button>
              <button
                className={`tab-btn ${activeTab === 'roomtypes' ? 'tab-active' : ''}`}
                onClick={() => handleTabChange('roomtypes')}
              >
                🏠 {t('tabs.roomTypes')}
              </button>
              <button
                className={`tab-btn ${activeTab === 'rugs' ? 'tab-active' : ''}`}
                onClick={() => handleTabChange('rugs')}
              >
                🧵 {t('tabs.rugs')}
              </button>
              <button
                className={`tab-btn ${activeTab === 'tileusage' ? 'tab-active' : ''}`}
                onClick={() => handleTabChange('tileusage')}
              >
                🔍 {t('tabs.tileUsage')}
              </button>
            </>
          )}
          <button
            className={`tab-btn ${activeTab === 'settings' ? 'tab-active' : ''}`}
            onClick={() => handleTabChange('settings')}
          >
            ⚙ {t('tabs.settings')}
          </button>
        </div>
      </header>

      {activeTab === 'tiles' ? (
        <div className="tab-full"><TileBrowser /></div>
      ) : activeTab === 'furniture' ? (
        <div className="tab-full"><FurnitureBrowser /></div>
      ) : activeTab === 'roomtypes' ? (
        <div className="tab-full"><RoomTypeEditor /></div>
      ) : activeTab === 'rugs' ? (
        <div className="tab-full"><RugEditor /></div>
      ) : activeTab === 'tileusage' ? (
        <div className="tab-full"><TileUsage /></div>
      ) : activeTab === 'settings' ? (
        <div className="tab-full"><SettingsEditor showGeneratorLog={showGeneratorLog} onShowGeneratorLogChange={setShowGeneratorLog} furnishingConfigEnabled={furnishingConfigEnabled} onFurnishingConfigEnabledChange={setFurnishingConfigEnabled} reproToolsEnabled={reproToolsEnabled} onReproToolsEnabledChange={setReproToolsEnabled} /></div>
      ) : (
      <main className="app-main">
        <section className="upload-section">
          <FileUpload onBuildingLoaded={handleBuildingLoaded} />
          {furnishingConfigEnabled && reproToolsEnabled && <ReproImport onReplayed={handleReproReplayed} />}
        </section>

        {building && (
          <>
            <section className="info-section">
              <div className="info-bar">
                <span> {t('app.dimensions', { width: building.width, height: building.height })}</span>
                <span> {t('app.floors', { count: building.floors.length })}</span>
                <span title={t('app.roomsTotalHint')}>
                  ️ {t('app.roomsTotal', { count: accessibleCount })}
                </span>
                {floor && (
                  <span className="info-bar-secondary">
                    {t('app.roomsFloor', { count: floorRoomCount })}
                  </span>
                )}
              </div>
            </section>

            <WallFurniturePanel
              candidates={building.wallFurnitureCandidates}
              onClassified={handleWallFurnitureClassified}
            />

            <section className="floor-section">
              <FurnishPanel
                key={loadId}
                building={building}
                fileName={fileName}
                placements={placements}
                onPlacementsChanged={newPlacements => {
                  setPlacements(newPlacements);
                  // Falls sheetInfos noch leer (Tiles-Pfad nach App-Start gesetzt), nachladen
                  if (!sheetInfos || sheetInfos.length === 0) reloadSheets();
                }}
                onReservedZonesChanged={setReservedZones}
                onLogChanged={log => { setGeneratorLog(log); setLogOpen(true); }}
                selected={selected}
                onSelectedChange={setSelected}
                overrides={overrides}
                onOverridesChange={setOverrides}
                seed={seed}
                onSeedChange={setSeed}
                densityMin={densityMin}
                densityMax={densityMax}
                densityFixed={densityFixed}
                onDensityChange={(min, max, fixed) => {
                  setDensityMin(min);
                  setDensityMax(max);
                  setDensityFixed(fixed);
                }}
                lightSwitches={lightSwitches}
                onLightSwitchesChange={setLightSwitches}
                excludedColors={excludedColors}
                onExcludedColorsChange={setExcludedColors}
                initialReservedZones={reservedZones}
              />

              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
                <FloorSelector
                  floors={building.floors}
                  selected={selectedFloor}
                  onSelect={setSelectedFloor}
                />
                {floor
                  ? <GridRenderer
                      floor={floor}
                      rooms={building.rooms}
                      building={building}
                      floorIndex={selectedFloor}
                      onFloorUpdated={handleFloorUpdated}
                      furniturePlacements={placements}
                      onPlacementsChanged={setPlacements}
                      reservedZones={reservedZones.filter(z => z.floorIndex === selectedFloor)}
                      tileConfig={tileConfig}
                      sheetInfos={sheetInfos}
                    />
                  : <p className="no-floor">{t('floor.noGrid')}</p>
                }
              </div>

              {/* Log-Panel rechts neben Grid */}
              {furnishingConfigEnabled && showGeneratorLog && generatorLog.length > 0 && (
                <div className="log-panel">
                  <div className="log-panel-header">
                    <button className={s.logToggle} onClick={() => setLogOpen(v => !v)}>
                      {logOpen ? '▼' : '▶'} {t('generatorLog.toggle', { count: generatorLog.length })}
                    </button>
                    <button className={s.logCopyBtn} onClick={handleCopyLog} title={t('generatorLog.copy')}>
                      {logCopied ? t('generatorLog.copied') : t('generatorLog.copy')}
                    </button>
                  </div>
                  {logOpen && (
                    <div className={s.logBox} style={{ flex: 1, maxHeight: 'none', overflow: 'auto' }}>
                      {generatorLog.map((line, i) => (
                        <div key={i} className={`${s.logLine} ${logLineClass(line, s as Record<string, string>)}`}>
                          {line}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

            </section>

          </>
        )}
      </main>
      )}
    </div>
    </TileSettingsClipboardProvider>
    </ActiveConfigSetProvider>
  );
}

export default App;

