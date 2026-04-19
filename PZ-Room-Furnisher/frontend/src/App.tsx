import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FileUpload } from './components/FileUpload';
import { FloorSelector } from './components/FloorSelector';
import { GridRenderer } from './components/GridRenderer';
import type { Building, Floor } from './types/building';
import './App.css';

const LANGS = [
  { code: 'de', label: 'DE 🇩🇪' },
  { code: 'en', label: 'EN 🇬🇧' },
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

function App() {
  const { t, i18n } = useTranslation();
  const [building, setBuilding] = useState<Building | null>(null);
  const [selectedFloor, setSelectedFloor] = useState(0);

  const handleBuildingLoaded = (b: Building) => {
    setBuilding(b);
    setSelectedFloor(0);
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

  return (
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
      </header>

      <main className="app-main">
        <section className="upload-section">
          <FileUpload onBuildingLoaded={handleBuildingLoaded} />
        </section>

        {building && (
          <>
            <section className="info-section">
              <div className="info-bar">
                <span>📐 {t('app.dimensions', { width: building.width, height: building.height })}</span>
                <span>🏢 {t('app.floors', { count: building.floors.length })}</span>
                <span title={t('app.roomsTotalHint')}>
                  🏷️ {t('app.roomsTotal', { count: accessibleCount })}
                </span>
                {floor && (
                  <span className="info-bar-secondary">
                    {t('app.roomsFloor', { count: floorRoomCount })}
                  </span>
                )}
              </div>
            </section>

            <section className="floor-section">
              <FloorSelector
                floors={building.floors}
                selected={selectedFloor}
                onSelect={setSelectedFloor}
              />
              {floor
                ? <GridRenderer floor={floor} rooms={building.rooms} cellSize={40} />
                : <p className="no-floor">{t('floor.noGrid')}</p>
              }
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default App;



