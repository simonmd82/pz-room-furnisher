import { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Floor, Room, WallEdge, Building, FloorObject, PlacedFurnitureItem } from '../types/building';
import type { TileConfigMap, TileSheetInfo } from '../types/tiles';
import { parseTileId } from '../types/tiles';
import { sheetImageUrl } from '../api/tilesApi';
import { recomputeRoomPath } from '../api/buildingApi';
import styles from './GridRenderer.module.css';

const SPRITE_W = 128;
const SPRITE_H = 256;

interface Props {
  floor: Floor;
  rooms: Room[];
  cellSize?: number;
  building?: Building;
  floorIndex?: number;
  onFloorUpdated?: (floor: Floor) => void;
  /** Placed furniture for this floor */
  furniturePlacements?: PlacedFurnitureItem[];
  /** Tile definitions – needed for sprite rendering */
  tileConfig?: TileConfigMap;
  /** Sheet metadata – needed for sprite cropping */
  sheetInfos?: TileSheetInfo[];
}

const DOOR_COLOR   = '#d4852a';
const WINDOW_COLOR = '#48c8e8';

/** "R G B" → CSS rgba() */
function toRgb(color: string, alpha = 1): string {
  const parts = color.trim().split(/\s+/);
  if (parts.length === 3) return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`;
  return `rgba(60,60,80,${alpha})`;
}

// ---------------------------------------------------------------------------
// Stairs: span 5 cells from start, along X (dir=W) or Y (dir=N).
// The LAST cell is the entry point and gets marked with an X.
// ---------------------------------------------------------------------------
const STAIR_SPAN = 5;

interface StairInfo {
  cells: Set<string>;
  entry: Set<string>;
}

/**
 * Build stair cell sets for the given floor.
 * - cells: full stair span (visual striping) – from own + lower floor objects
 * - entry: only the X-marked waypoint cells from floor.stairWaypoints
 */
function buildStairCells(floor: Floor, allFloors?: Floor[]): StairInfo {
  const cells = new Set<string>();
  const entry = new Set<string>();

  const addSpan = (obj: FloorObject) => {
    for (let i = 0; i < STAIR_SPAN; i++) {
      const cx = obj.dir === 'W' ? obj.x + i : obj.x;
      const cy = obj.dir === 'N' ? obj.y + i : obj.y;
      cells.add(`${cx},${cy}`);
    }
  };

  for (const obj of floor.objects)
    if (obj.type === 'Stairs') addSpan(obj);

  const lowerFloor = allFloors?.find(f => f.index === floor.index - 1);
  if (lowerFloor)
    for (const obj of lowerFloor.objects)
      if (obj.type === 'Stairs') addSpan(obj);

  // X markers come directly from pre-computed stairWaypoints (single source of truth)
  for (const sw of floor.stairWaypoints ?? [])
    entry.add(`${sw.col},${sw.row}`);

  return { cells, entry };
}

// ---------------------------------------------------------------------------
// Cell-edge lookup: for each cell, which WallEdges touch it and from which dir?
// ---------------------------------------------------------------------------
interface CellEdgeInfo {
  edge: WallEdge;
  /** Direction of this edge from the perspective of THIS cell */
  dir: 'N' | 'S' | 'W' | 'E';
}

function buildCellEdgeMap(edges: WallEdge[]): Map<string, CellEdgeInfo[]> {
  const map = new Map<string, CellEdgeInfo[]>();

  const add = (col: number, row: number, info: CellEdgeInfo) => {
    const k = `${col},${row}`;
    map.set(k, [...(map.get(k) ?? []), info]);
  };

  for (const edge of edges) {
    if (edge.isHorizontal) {
      // H(edgeCol, edgeRow): north wall of cell2 (edgeCol, edgeRow),
      //                      south wall of cell1 (edgeCol, edgeRow-1)
      add(edge.cell2Col, edge.cell2Row, { edge, dir: 'N' });
      add(edge.cell1Col, edge.cell1Row, { edge, dir: 'S' });
    } else {
      // V(edgeCol, edgeRow): west wall of cell2 (edgeCol, edgeRow),
      //                      east wall of cell1 (edgeCol-1, edgeRow)
      add(edge.cell2Col, edge.cell2Row, { edge, dir: 'W' });
      add(edge.cell1Col, edge.cell1Row, { edge, dir: 'E' });
    }
  }

  return map;
}

const DIR_LABEL_KEY: Record<string, string> = { N: 'direction.N', S: 'direction.S', W: 'direction.W', E: 'direction.E' };

// ---------------------------------------------------------------------------
// SVG edge marker for a single WallEdge
// ---------------------------------------------------------------------------
function EdgeMarker({ edge, cellSize }: { edge: WallEdge; cellSize: number }) {
  const isDoor  = edge.type === 'Door';
  const color   = isDoor ? DOOR_COLOR : WINDOW_COLOR;
  const LONG    = cellSize * 0.62;
  const THICK   = isDoor ? 6 : 4;

  let x: number, y: number, w: number, h: number;

  if (edge.isHorizontal) {
    // Horizontal edge → horizontal bar centred on the grid line y = edgeRow * cellSize
    w = LONG;  h = THICK;
    x = edge.edgeCol * cellSize + cellSize / 2 - LONG / 2;
    y = edge.edgeRow * cellSize - THICK / 2;
  } else {
    // Vertical edge → vertical bar centred on the grid line x = edgeCol * cellSize
    w = THICK; h = LONG;
    x = edge.edgeCol * cellSize - THICK / 2;
    y = edge.edgeRow * cellSize + cellSize / 2 - LONG / 2;
  }

  const label = `${isDoor ? 'Tür' : 'Fenster'} [${edge.cell1Col},${edge.cell1Row}] ↔ [${edge.cell2Col},${edge.cell2Row}]`;

  return (
    <g style={{ pointerEvents: 'auto', cursor: 'default' }}>
      {/* black outline rect slightly larger */}
      <rect x={x - 1.5} y={y - 1.5} width={w + 3} height={h + 3}
        fill="none" stroke="#000" strokeWidth={1.5} rx={isDoor ? 3 : 2} />
      {/* coloured fill rect */}
      <rect x={x} y={y} width={w} height={h}
        fill={color} rx={isDoor ? 2 : 1} />
      <title>{label}</title>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function GridRenderer({ floor, rooms, cellSize = 40, building, floorIndex = 0, onFloorUpdated, furniturePlacements = [], tileConfig, sheetInfos }: Props) {
  const { t } = useTranslation();
  void tileConfig;
  const grid = floor.roomGrid;

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showPaths, setShowPaths] = useState(false);
  const [recomputingRoom, setRecomputingRoom] = useState<number | null>(null);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  const [showDebug, setShowDebug] = useState(false);

  // ── Furniture helpers ────────────────────────────────────────────────────────
  const sheetInfoMap = useMemo(() => {
    const m = new Map<string, TileSheetInfo>();
    for (const s of sheetInfos ?? []) m.set(s.name, s);
    return m;
  }, [sheetInfos]);

  const placementLayers = useMemo(() => {
    const layers = new Set<string>();
    for (const p of furniturePlacements) layers.add(p.layer);
    return Array.from(layers).sort();
  }, [furniturePlacements]);

  const visiblePlacements = useMemo(() =>
    furniturePlacements.filter(p => !hiddenLayers.has(p.layer)),
  [furniturePlacements, hiddenLayers]);

  const toggleLayer = useCallback((layer: string) => {
    setHiddenLayers(prev => {
      const next = new Set(prev);
      if (next.has(layer)) next.delete(layer); else next.add(layer);
      return next;
    });
  }, []);

  const allLayersVisible = hiddenLayers.size === 0;

  const handleLegendClick = useCallback((roomIdx1Based: number, ctrlKey: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (ctrlKey) {
        if (next.has(roomIdx1Based)) next.delete(roomIdx1Based);
        else next.add(roomIdx1Based);
      } else {
        if (next.size === 1 && next.has(roomIdx1Based)) next.clear();
        else { next.clear(); next.add(roomIdx1Based); }
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const handleRegenPath = useCallback(async (roomIdx1Based: number) => {
    if (!building) return;
    setRecomputingRoom(roomIdx1Based);
    try {
      const newCells = await recomputeRoomPath(building, floorIndex, roomIdx1Based, Math.floor(Math.random() * 2147483647));
      const updatedFloor: Floor = {
        ...floor,
        pathsByRoom: { ...floor.pathsByRoom, [roomIdx1Based]: newCells },
      };
      onFloorUpdated?.(updatedFloor);
    } catch (e) {
      console.error('Path recompute error:', e);
    } finally {
      setRecomputingRoom(null);
    }
  }, [building, floor, floorIndex, onFloorUpdated]);

  if (!grid || grid.length === 0) {
    return <p className={styles.empty}>{t('floor.noGrid')}</p>;
  }

  const stairInfo   = buildStairCells(floor, building?.floors);
  const stairCells  = stairInfo.cells;
  const stairEntry  = stairInfo.entry;
  const cellEdgeMap = buildCellEdgeMap(floor.edges);
  const cols        = grid[0]?.length ?? 1;
  const rows        = grid.length;
  const svgW        = cols * cellSize;
  const svgH        = rows * cellSize;
  const hasSelection = selected.size > 0;

  // Build per-room path sets from floor.pathsByRoom
  const pathSets: Map<number, Set<string>> = new Map();
  Object.entries(floor.pathsByRoom ?? {}).forEach(([riStr, cells]) => {
    const ri = Number(riStr);
    if (cells && cells.length > 0)
      pathSets.set(ri, new Set(cells.map(([c, r]) => `${c},${r}`)));
  });
  const pathRoomCount = pathSets.size;

  // Combined set for quick cell lookup
  const anyPathSet = new Set<string>();
  if (showPaths) {
    for (const s of pathSets.values()) s.forEach(k => anyPathSet.add(k));
  }

  return (
    <div className={styles.wrapper}>

      {/* ── Legend ── */}
      <div className={styles.legendWrapper}>
        <div className={styles.legend}>
          {/* Clickable room entries */}
          {rooms.map((room, idx) => {
            const roomIdx1 = idx + 1;
            const isSelected = selected.has(roomIdx1);
            const hasPath = (floor.pathsByRoom?.[roomIdx1]?.length ?? 0) > 0;
            const isRegen  = recomputingRoom === roomIdx1;
            return (
              <div
                key={idx}
                className={`${styles.legendItem} ${styles.legendItemClickable} ${isSelected ? styles.legendItemSelected : ''} ${hasSelection && !isSelected ? styles.legendItemDimmed : ''}`}
                onClick={e => handleLegendClick(roomIdx1, e.ctrlKey)}
                title={t('legend.selectHint', { name: room.name })}
              >
                <span className={styles.legendSwatch} style={{ background: toRgb(room.color) }} />
                <span>{room.name}</span>
                {building && hasPath && (
                  <button
                    className={styles.regenBtn}
                    disabled={isRegen}
                    title="Weg neu generieren"
                    onClick={e => { e.stopPropagation(); void handleRegenPath(roomIdx1); }}
                  >
                    {isRegen ? '⏳' : '🔄'}
                  </button>
                )}
              </div>
            );
          })}

          <div className={styles.legendDivider} />

          {/* Non-clickable symbols */}
          <div className={styles.legendItem}>
            <span className={styles.legendDoorBar} />
            <span>{t('legend.door')}</span>
          </div>
          <div className={styles.legendItem}>
            <span className={styles.legendWindowBar} />
            <span>{t('legend.window')}</span>
          </div>
          <div className={styles.legendItem}>
            <span className={`${styles.legendSwatch} ${styles.stairSwatch}`} />
            <span>{t('legend.stairs')}</span>
          </div>
          <div className={styles.legendItem}>
            <span className={styles.legendEntryX}>✕</span>
            <span>{t('legend.stairEntry')}</span>
          </div>

          {showPaths && (
            <div className={styles.legendItem}>
              <span className={styles.legendPathDot} />
              <span>Weg (Tür→Tür)</span>
            </div>
          )}

          <div className={styles.legendDivider} />

          <button
            className={`${styles.pathToggleBtn} ${showPaths ? styles.pathToggleActive : ''}`}
            onClick={() => setShowPaths(v => !v)}
          >
            {showPaths ? `🛤 Wege verbergen (${pathRoomCount})` : '🛤 Wege zeigen'}
          </button>

          {furniturePlacements.length > 0 && (
            <button
              className={`${styles.pathToggleBtn} ${showDebug ? styles.pathToggleActive : ''}`}
              style={{ marginTop: 4 }}
              onClick={() => setShowDebug(v => !v)}
            >
              🐛 {showDebug ? `Debug aus` : `Debug (${furniturePlacements.length})`}
            </button>
          )}

          {placementLayers.length > 0 && (
            <>
              <div className={styles.legendDivider} />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                <span className={styles.layerLabel}>🛋 Layer</span>
                {!allLayersVisible && (
                  <button
                    className={styles.layerBtn}
                    style={{ fontSize: '0.66rem', padding: '1px 6px' }}
                    onClick={() => setHiddenLayers(new Set())}
                    title="Alle Layer einblenden"
                  >
                    alle an
                  </button>
                )}
              </div>
              {placementLayers.map(l => {
                const count   = furniturePlacements.filter(p => p.layer === l).length;
                const visible = !hiddenLayers.has(l);
                return (
                  <label
                    key={l}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5,
                      cursor: 'pointer', userSelect: 'none',
                      padding: '2px 4px', borderRadius: 3,
                      background: visible ? '#1a2a1a' : '#1a1a1a',
                      border: `1px solid ${visible ? '#3a6a3a' : '#2a2a3a'}`,
                      fontSize: '0.73rem',
                      color: visible ? '#9f9' : '#556',
                      marginTop: 2,
                    }}
                    title={visible ? `${l} ausblenden` : `${l} einblenden`}
                  >
                    <input
                      type="checkbox"
                      checked={visible}
                      onChange={() => toggleLayer(l)}
                      style={{ accentColor: '#4a9a4a', margin: 0 }}
                    />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l}</span>
                    <span style={{ color: '#556', fontSize: '0.66rem' }}>{count}</span>
                  </label>
                );
              })}
            </>
          )}
        </div>

        {hasSelection && (
          <button className={styles.clearBtn} onClick={clearSelection}>
            {t('legend.clearSelection', { count: selected.size })}
          </button>
        )}
      </div>

      {/* ── Scrollable grid + SVG overlay ── */}
      <div className={styles.scrollArea}>
        <div style={{ position: 'relative', width: svgW, height: svgH }}>

          {/* CSS grid layer */}
          <div
            className={styles.grid}
            style={{ gridTemplateColumns: `repeat(${cols}, ${cellSize}px)` }}
          >
            {grid.map((row, rowIdx) =>
              row.map((roomIdx, colIdx) => {
                const room      = roomIdx > 0 ? rooms[roomIdx - 1] : null;
                const key       = `${colIdx},${rowIdx}`;
                const isStair   = stairCells.has(key);
                const isEntry   = stairEntry.has(key);
                const cellEdges = cellEdgeMap.get(key) ?? [];
                const isPath    = showPaths && anyPathSet.has(key);

                const edgeLines = cellEdges.map(
                  ({ edge, dir }) => `  ${t(`object.${edge.type}`)} (${t(DIR_LABEL_KEY[dir])})`,
                );
                const title = [
                  `[${colIdx},${rowIdx}] ${room ? room.name : t('cell.outside')}`,
                  isStair ? ` ${t('cell.stairs')}` : '',
                  isPath  ? ' [Weg]' : '',
                  ...edgeLines,
                ].filter(Boolean).join('\n');

                // Determine highlight state
                const isSelectedRoom = room !== null && selected.has(roomIdx);
                const isDimmed       = hasSelection && !isSelectedRoom && !isStair;

                let alpha: number;
                if (isSelectedRoom)  alpha = 0.95;
                else if (isStair)    alpha = 0.5;
                else if (isDimmed)   alpha = 0.18;
                else                 alpha = 0.72;

                let bg: string;
                if (isStair)   bg = room ? toRgb(room.color, alpha) : `rgba(40,32,0,${isStair ? 0.6 : 0.18})`;
                else if (room) bg = toRgb(room.color, alpha);
                else           bg = 'transparent';

                return (
                  <div
                    key={key}
                    className={[
                      styles.cell,
                      room || isStair ? '' : styles.outside,
                      isSelectedRoom ? styles.cellHighlighted : '',
                      isPath ? styles.cellPath : '',
                    ].join(' ')}
                    style={{ width: cellSize, height: cellSize, background: bg }}
                    title={title}
                  >
                    {isStair && <span className={styles.stairStripe} />}
                    {isEntry  && <span className={styles.stairEntry}>✕</span>}
                  </div>
                );
              })
            )}
          </div>

          {/* ── Debug overlay ── */}
          {showDebug && visiblePlacements.length > 0 && (
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 4 }}>
              {visiblePlacements.map((p, i) => {
                const orientArrow: Record<string, string> = { N: '↑', S: '↓', E: '→', W: '←' };
                const layerColor: Record<string, string> = {
                  Furniture:      'rgba(80,200,120,0.65)',
                  Furniture2:     'rgba(60,180,100,0.65)',
                  Furniture3:     'rgba(40,160,80,0.65)',
                  Furniture4:     'rgba(20,140,60,0.65)',
                  Wallfurniture:  'rgba(100,160,255,0.65)',
                  Wallfurniture2: 'rgba(80,140,220,0.65)',
                  Wallfurniture3: 'rgba(60,120,190,0.65)',
                  Wallfurniture4: 'rgba(40,100,160,0.65)',
                  FloorOverlay:   'rgba(255,200,80,0.60)',
                  FloorFurniture: 'rgba(220,170,60,0.60)',
                };
                const bg = layerColor[p.layer] ?? 'rgba(180,100,255,0.65)';
                const arrow = orientArrow[p.orient] ?? p.orient;
                const shortId = p.tileId.split('_').pop()?.slice(-4) ?? p.tileId.slice(-4);
                const fontSize = Math.max(7, Math.min(11, cellSize * 0.22));
                return (
                  <div
                    key={i}
                    title={`Slot: ${p.slotId || '—'}\n${p.tileId}\nLayer: ${p.layer}\nOrient: ${p.orient}\n[${p.col}, ${p.row}]`}
                    style={{
                      position:       'absolute',
                      left:           p.col * cellSize + 1,
                      top:            p.row * cellSize + 1,
                      width:          cellSize - 2,
                      height:         cellSize - 2,
                      background:     bg,
                      border:         '1.5px solid rgba(255,255,255,0.4)',
                      borderRadius:   3,
                      display:        'flex',
                      flexDirection:  'column',
                      alignItems:     'center',
                      justifyContent: 'center',
                      overflow:       'hidden',
                      pointerEvents:  'auto',
                    }}
                  >
                    <span style={{ fontSize: fontSize + 3, lineHeight: 1, color: '#fff', fontWeight: 700, textShadow: '0 0 4px #000' }}>
                      {arrow}
                    </span>
                    <span style={{ fontSize, lineHeight: 1.15, color: '#ffe', textShadow: '0 0 2px #000', marginTop: 1, textAlign: 'center' }}>
                      {shortId}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Furniture sprite overlay ── */}
          {!showDebug && visiblePlacements.length > 0 && (
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 3 }}>
              {visiblePlacements.map((p, i) => {
                const parsed = parseTileId(p.tileId);
                if (!parsed) return null;
                const sheet = sheetInfoMap.get(parsed.sheet);
                if (!sheet) return null;
                const scale   = cellSize / SPRITE_W;
                const sprH    = SPRITE_H * scale; // natural height = 2 * cellSize
                return (
                  <div
                    key={i}
                    className={styles.furnitureSprite}
                    style={{
                      left:               p.col * cellSize,
                      // bottom-align to cell bottom (sprite grows upward – PZ convention)
                      top:                (p.row + 1) * cellSize - sprH,
                      width:              cellSize,
                      height:             sprH,
                      backgroundImage:    `url(${sheetImageUrl(parsed.sheet)})`,
                      backgroundRepeat:   'no-repeat',
                      backgroundSize:     `${sheet.sheetWidth  * scale}px ${sheet.sheetHeight * scale}px`,
                      backgroundPosition: `${-(parsed.index % sheet.columns) * SPRITE_W * scale}px `
                                        + `${-Math.floor(parsed.index / sheet.columns) * SPRITE_H * scale}px`,
                    }}
                    title={`${p.tileId} [${p.layer}]`}
                  />
                );
              })}
            </div>
          )}

          {/* SVG overlay – doors/windows + path dots */}
          <svg
            width={svgW}
            height={svgH}
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}
          >
            {/* Path dots */}
            {showPaths && Array.from(pathSets.entries()).map(([roomIdx1, pset]) => {
              const room = rooms[roomIdx1 - 1];
              if (!room) return null;
              const color = toRgb(room.color, 0.85);
              return Array.from(pset).map(key => {
                const [c, r] = key.split(',').map(Number);
                const cx = c * cellSize + cellSize / 2;
                const cy = r * cellSize + cellSize / 2;
                const radius = Math.max(2, cellSize * 0.13);
                return (
                  <g key={key}>
                    <circle cx={cx} cy={cy} r={radius + 1.5} fill="rgba(0,0,0,0.55)" />
                    <circle cx={cx} cy={cy} r={radius} fill={color} />
                  </g>
                );
              });
            })}

            {/* Doors & windows */}
            {floor.edges.map(edge => (
              <EdgeMarker key={edge.edgeKey} edge={edge} cellSize={cellSize} />
            ))}
          </svg>

        </div>
      </div>
    </div>
  );
}

