import { useState, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Floor, Room, WallEdge, Building, FloorObject, PlacedFurnitureItem, ReservedZonePlacement } from '../types/building';
import type { TileConfigMap, TileSheetInfo } from '../types/tiles';
import { parseTileId } from '../types/tiles';
import { sheetImageUrl } from '../api/tilesApi';
import { recomputeRoomPath } from '../api/buildingApi';
import { buildReverseFootprintIndex, resolveFootprintGroup, computeDelta, isGroupMoveValid, applyGroupMove } from '../utils/furnitureFootprint';
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
  /** Reserved zones (e.g. "Car" spot) for this floor */
  reservedZones?: ReservedZonePlacement[];
  /** Tile definitions – needed for sprite rendering */
  tileConfig?: TileConfigMap;
  /** Sheet metadata – needed for sprite cropping */
  sheetInfos?: TileSheetInfo[];
  /** Called with the full (all-floors) placements array after a manual drag-move. */
  onPlacementsChanged?: (updated: PlacedFurnitureItem[]) => void;
}

const DOOR_COLOR       = '#d4852a';
const WINDOW_COLOR     = '#48c8e8';
const OPENING_COLOR    = '#f0c040';
const INNER_WALL_COLOR = '#8899cc';

/** "R G B" → CSS rgba() */
function toRgb(color: string, alpha = 1): string {
  const parts = color.trim().split(/\s+/);
  if (parts.length === 3) return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`;
  return `rgba(60,60,80,${alpha})`;
}

interface SubRoomCellInfo  { isMain: boolean; }
interface SubRoomLabelInfo { size: number; isMain: boolean; }

/**
 * Extends each collinear inner wall segment (within roomCells) outward in its
 * primary direction until it hits the room boundary or a passable edge
 * (Door/Window/Opening). This treats partial dividers as full separators.
 */
function buildExtendedInnerWalls(
  allInnerWallKeys: Set<string>,
  roomCells:        Set<string>,
  passableEdgeKeys: Set<string>,
): Set<string> {
  const hByCols = new Map<number, number[]>(); // row → cols of H edges in this room
  const vByRows = new Map<number, number[]>(); // col → rows of V edges in this room

  for (const key of allInnerWallKeys) {
    if (key.startsWith('H:')) {
      const [col, row] = key.slice(2).split(',').map(Number);
      if (!roomCells.has(`${col},${row - 1}`) || !roomCells.has(`${col},${row}`)) continue;
      if (!hByCols.has(row)) hByCols.set(row, []);
      hByCols.get(row)!.push(col);
    } else {
      const [col, row] = key.slice(2).split(',').map(Number);
      if (!roomCells.has(`${col - 1},${row}`) || !roomCells.has(`${col},${row}`)) continue;
      if (!vByRows.has(col)) vByRows.set(col, []);
      vByRows.get(col)!.push(row);
    }
  }

  const extended = new Set<string>(allInnerWallKeys);

  const tryH = (col: number, row: number): boolean => {
    const k = `H:${col},${row}`;
    if (passableEdgeKeys.has(k)) return false;
    if (!roomCells.has(`${col},${row - 1}`) || !roomCells.has(`${col},${row}`)) return false;
    extended.add(k);
    return true;
  };

  const tryV = (col: number, row: number): boolean => {
    const k = `V:${col},${row}`;
    if (passableEdgeKeys.has(k)) return false;
    if (!roomCells.has(`${col - 1},${row}`) || !roomCells.has(`${col},${row}`)) return false;
    extended.add(k);
    return true;
  };

  for (const [row, cols] of hByCols) {
    const sorted = [...cols].sort((a, b) => a - b);
    let c = sorted[0] - 1;       while (tryH(c, row)) c--;
    c = sorted[sorted.length - 1] + 1; while (tryH(c, row)) c++;
  }
  for (const [col, rows] of vByRows) {
    const sorted = [...rows].sort((a, b) => a - b);
    let r = sorted[0] - 1;       while (tryV(col, r)) r--;
    r = sorted[sorted.length - 1] + 1; while (tryV(col, r)) r++;
  }

  return extended;
}

/**
 * Computes sub-room data for all rooms on the floor.
 * Always emits a size label at the centroid of every room (or every sub-room
 * component when inner walls divide a room into disconnected parts).
 * Partial inner walls are extended to the nearest room boundary so they act
 * as full dividers. Secondary sub-room cells get a white-tint overlay.
 */
function computeSubRoomData(floor: Floor): {
  subRoomCellMap:   Map<string, SubRoomCellInfo>;
  subRoomLabels:    Map<string, SubRoomLabelInfo>;
  hasSubRoomSplits: boolean;
} {
  const subRoomCellMap   = new Map<string, SubRoomCellInfo>();
  const subRoomLabels    = new Map<string, SubRoomLabelInfo>();
  let   hasSubRoomSplits = false;

  const allInnerWallKeys = new Set(
    floor.edges.filter(e => e.type === 'InnerWall').map(e => e.edgeKey)
  );

  const passableEdgeKeys = new Set(
    floor.edges
      .filter(e => e.type === 'Door' || e.type === 'Window' || e.type === 'Opening')
      .map(e => e.edgeKey)
  );

  const doorCells = new Set<string>();
  floor.edges
    .filter(e => e.type === 'Door' || e.type === 'Opening')
    .forEach(e => {
      doorCells.add(`${e.cell1Col},${e.cell1Row}`);
      doorCells.add(`${e.cell2Col},${e.cell2Row}`);
    });

  const roomIndices = new Set<number>();
  floor.roomGrid.forEach(row => row.forEach(v => { if (v > 0) roomIndices.add(v); }));

  for (const roomIdx of roomIndices) {
    const roomCells = new Set<string>();
    floor.roomGrid.forEach((row, r) =>
      row.forEach((v, c) => { if (v === roomIdx) roomCells.add(`${c},${r}`); })
    );

    const innerWallKeys = allInnerWallKeys.size > 0
      ? buildExtendedInnerWalls(allInnerWallKeys, roomCells, passableEdgeKeys)
      : allInnerWallKeys;

    const remaining = new Set(roomCells);
    const components: Set<string>[] = [];

    while (remaining.size > 0) {
      const seed = remaining.values().next().value!;
      const component = new Set<string>([seed]);
      const queue = [seed];
      while (queue.length > 0) {
        const key = queue.shift()!;
        const [c, r] = key.split(',').map(Number);
        for (const [nc, nr] of [[c, r - 1], [c, r + 1], [c - 1, r], [c + 1, r]] as [number, number][]) {
          const nk = `${nc},${nr}`;
          if (!remaining.has(nk) || component.has(nk)) continue;
          const edgeKey = nc === c
            ? `H:${c},${Math.max(r, nr)}`
            : `V:${Math.max(c, nc)},${r}`;
          if (!innerWallKeys.has(edgeKey)) { component.add(nk); queue.push(nk); }
        }
      }
      component.forEach(k => remaining.delete(k));
      components.push(component);
    }

    const hasSplit = components.length > 1;
    if (hasSplit) {
      hasSubRoomSplits = true;
      // Largest first; tie-break: most door/opening cells — matches backend ComputeMainSubRoom
      components.sort((a, b) =>
        (b.size - a.size) ||
        ([...b].filter(k => doorCells.has(k)).length - [...a].filter(k => doorCells.has(k)).length)
      );
    }

    components.forEach((comp, idx) => {
      const isMain = !hasSplit || idx === 0;
      if (!isMain) comp.forEach(k => subRoomCellMap.set(k, { isMain: false }));

      // Size label at centroid
      let sumC = 0, sumR = 0;
      comp.forEach(k => { const [c, r] = k.split(',').map(Number); sumC += c; sumR += r; });
      const avgC = sumC / comp.size;
      const avgR = sumR / comp.size;
      let bestKey = '', bestDist = Infinity;
      comp.forEach(k => {
        const [c, r] = k.split(',').map(Number);
        const d = (c - avgC) ** 2 + (r - avgR) ** 2;
        if (d < bestDist) { bestDist = d; bestKey = k; }
      });
      subRoomLabels.set(bestKey, { size: comp.size, isMain });
    });
  }

  return { subRoomCellMap, subRoomLabels, hasSubRoomSplits };
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
  const { t } = useTranslation();

  // Opening: amber gap spanning most of the cell edge
  if (edge.type === 'Opening') {
    const LONG = cellSize * 0.82;
    const THICK = 5;
    let x: number, y: number, w: number, h: number;
    if (edge.isHorizontal) {
      w = LONG; h = THICK;
      x = edge.edgeCol * cellSize + cellSize / 2 - LONG / 2;
      y = edge.edgeRow * cellSize - THICK / 2;
    } else {
      w = THICK; h = LONG;
      x = edge.edgeCol * cellSize - THICK / 2;
      y = edge.edgeRow * cellSize + cellSize / 2 - LONG / 2;
    }
    return (
      <g style={{ pointerEvents: 'auto', cursor: 'default' }}>
        <rect x={x - 1} y={y - 1} width={w + 2} height={h + 2}
          fill="none" stroke="#a08000" strokeWidth={1} rx={1} />
        <rect x={x} y={y} width={w} height={h} fill={OPENING_COLOR} rx={1} />
        <title>{t('gridRenderer.edgeLabel', {
          type: t('object.Opening'),
          c1: edge.cell1Col, r1: edge.cell1Row, c2: edge.cell2Col, r2: edge.cell2Row,
        })}</title>
      </g>
    );
  }

  // InnerWall: full-edge solid bar inside the room
  if (edge.type === 'InnerWall') {
    const THICK = 4;
    let x: number, y: number, w: number, h: number;
    if (edge.isHorizontal) {
      w = cellSize; h = THICK;
      x = edge.edgeCol * cellSize;
      y = edge.edgeRow * cellSize - THICK / 2;
    } else {
      w = THICK; h = cellSize;
      x = edge.edgeCol * cellSize - THICK / 2;
      y = edge.edgeRow * cellSize;
    }
    return (
      <g style={{ pointerEvents: 'auto', cursor: 'default' }}>
        <rect x={x} y={y} width={w} height={h} fill={INNER_WALL_COLOR} />
        <title>{t('gridRenderer.edgeLabel', {
          type: t('object.InnerWall'),
          c1: edge.cell1Col, r1: edge.cell1Row, c2: edge.cell2Col, r2: edge.cell2Row,
        })}</title>
      </g>
    );
  }

  // Door / Window: centered bar
  const isDoor = edge.type === 'Door';
  const color  = isDoor ? DOOR_COLOR : WINDOW_COLOR;
  const LONG   = cellSize * 0.62;
  const THICK  = isDoor ? 6 : 4;

  let x: number, y: number, w: number, h: number;
  if (edge.isHorizontal) {
    w = LONG;  h = THICK;
    x = edge.edgeCol * cellSize + cellSize / 2 - LONG / 2;
    y = edge.edgeRow * cellSize - THICK / 2;
  } else {
    w = THICK; h = LONG;
    x = edge.edgeCol * cellSize - THICK / 2;
    y = edge.edgeRow * cellSize + cellSize / 2 - LONG / 2;
  }

  const label = t('gridRenderer.edgeLabel', {
    type: t(isDoor ? 'object.Door' : 'object.Window'),
    c1: edge.cell1Col, r1: edge.cell1Row, c2: edge.cell2Col, r2: edge.cell2Row,
  });

  return (
    <g style={{ pointerEvents: 'auto', cursor: 'default' }}>
      <rect x={x - 1.5} y={y - 1.5} width={w + 3} height={h + 3}
        fill="none" stroke="#000" strokeWidth={1.5} rx={isDoor ? 3 : 2} />
      <rect x={x} y={y} width={w} height={h}
        fill={color} rx={isDoor ? 2 : 1} />
      <title>{label}</title>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function GridRenderer({ floor, rooms, cellSize = 40, building, floorIndex = 0, onFloorUpdated, furniturePlacements = [], reservedZones = [], tileConfig, sheetInfos, onPlacementsChanged }: Props) {
  const { t } = useTranslation();
  const grid = floor.roomGrid;

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showPaths, setShowPaths] = useState(false);
  const [recomputingRoom, setRecomputingRoom] = useState<number | null>(null);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  const [showDebug, setShowDebug] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [activeLayer, setActiveLayer] = useState<string | null>(null);
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<{ cells: { col: number; row: number }[]; valid: boolean } | null>(null);
  const dragGroupRef = useRef<PlacedFurnitureItem[] | null>(null);
  const dragOriginRef = useRef<{ col: number; row: number } | null>(null);

  // ── Furniture helpers ────────────────────────────────────────────────────────
  const sheetInfoMap = useMemo(() => {
    const m = new Map<string, TileSheetInfo>();
    for (const s of sheetInfos ?? []) m.set(s.name, s);
    return m;
  }, [sheetInfos]);

  const floorPlacements = useMemo(() =>
    furniturePlacements.filter(p => p.floorIndex === floorIndex),
  [furniturePlacements, floorIndex]);

  const placementLayers = useMemo(() => {
    const layers = new Set<string>();
    for (const p of floorPlacements) layers.add(p.layer);
    return Array.from(layers).sort();
  }, [floorPlacements]);

  const visiblePlacements = useMemo(() =>
    floorPlacements.filter(p => !hiddenLayers.has(p.layer)),
  [floorPlacements, hiddenLayers]);

  const reverseFootprintIndex = useMemo(() => buildReverseFootprintIndex(tileConfig), [tileConfig]);

  // Rooms defined in the TBX but never assigned to any cell on this floor (e.g. leftover
  // room defs from the source map) shouldn't clutter the legend.
  const usedRoomIndices = useMemo(() => {
    const s = new Set<number>();
    floor.roomGrid.forEach(row => row.forEach(v => { if (v > 0) s.add(v); }));
    return s;
  }, [floor.roomGrid]);

  const toggleLayer = useCallback((layer: string) => {
    if (layer === activeLayer) return; // can't hide the layer you're editing
    setHiddenLayers(prev => {
      const next = new Set(prev);
      if (next.has(layer)) next.delete(layer); else next.add(layer);
      return next;
    });
  }, [activeLayer]);

  const setActiveLayerHandler = useCallback((layer: string) => {
    setActiveLayer(prev => {
      const next = prev === layer ? null : layer;
      if (next) setHiddenLayers(h => { if (!h.has(next)) return h; const n = new Set(h); n.delete(next); return n; });
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

  const { subRoomCellMap, subRoomLabels, hasSubRoomSplits } = useMemo(() => computeSubRoomData(floor), [floor]);
  const hasSubRooms = hasSubRoomSplits;

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
            if (!usedRoomIndices.has(roomIdx1)) return null;
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
                    title={t('gridRenderer.regenPath')}
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
            <span className={styles.legendOpeningBar} />
            <span>{t('legend.opening')}</span>
          </div>
          <div className={styles.legendItem}>
            <span className={styles.legendInnerWallBar} />
            <span>{t('legend.innerWall')}</span>
          </div>
          {hasSubRooms && (
            <>
              <div className={styles.legendItem}>
                <span className={styles.legendMainSubRoomSwatch} />
                <span>{t('legend.mainSubRoom')}</span>
              </div>
              <div className={styles.legendItem}>
                <span className={styles.legendSecondarySubRoomSwatch} />
                <span>{t('legend.secondarySubRoom')}</span>
              </div>
            </>
          )}
          {reservedZones.length > 0 && (
            <div className={styles.legendItem}>
              <span className={styles.legendSwatch} style={{
                background: 'repeating-linear-gradient(45deg, rgba(255,180,60,0.5), rgba(255,180,60,0.5) 4px, transparent 4px, transparent 8px)',
                border: '1.5px dashed rgba(255,180,60,0.85)',
              }} />
              <span>{t('legend.reservedZone')}</span>
            </div>
          )}
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
              <span>{t('gridRenderer.pathLegend')}</span>
            </div>
          )}

          <div className={styles.legendDivider} />

          <button
            className={`${styles.pathToggleBtn} ${showPaths ? styles.pathToggleActive : ''}`}
            onClick={() => setShowPaths(v => !v)}
          >
            {showPaths ? t('gridRenderer.hidePaths', { count: pathRoomCount }) : t('gridRenderer.showPaths')}
          </button>

          {floorPlacements.length > 0 && (
            <button
              className={`${styles.pathToggleBtn} ${showDebug ? styles.pathToggleActive : ''}`}
              style={{ marginTop: 4 }}
              onClick={() => setShowDebug(v => !v)}
            >
              🐛 {showDebug ? t('gridRenderer.debugOff') : t('gridRenderer.debugOn', { count: floorPlacements.length })}
            </button>
          )}

          {placementLayers.length > 0 && (
            <>
              <div className={styles.legendDivider} />
              <button
                className={`${styles.pathToggleBtn} ${editMode ? styles.pathToggleActive : ''}`}
                onClick={() => {
                  setEditMode(v => !v);
                  setActiveLayer(null);
                  dragGroupRef.current = null;
                  dragOriginRef.current = null;
                  setDraggedItemId(null);
                  setDragPreview(null);
                }}
              >
                🖐 {editMode ? t('gridRenderer.editModeOn') : t('gridRenderer.editModeOff')}
              </button>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, marginTop: 4 }}>
                <span className={styles.layerLabel}>🛋 Layer</span>
                {!allLayersVisible && (
                  <button
                    className={styles.layerBtn}
                    style={{ fontSize: '0.66rem', padding: '1px 6px' }}
                    onClick={() => setHiddenLayers(new Set())}
                    title={t('gridRenderer.showAllLayers')}
                  >
                    {t('gridRenderer.allOn')}
                  </button>
                )}
              </div>
              {placementLayers.map(l => {
                const count   = floorPlacements.filter(p => p.layer === l).length;
                const visible = !hiddenLayers.has(l);
                const isActiveLayer = activeLayer === l;
                return (
                  <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                    <label
                      style={{
                        display: 'flex', alignItems: 'center', gap: 5, flex: 1,
                        cursor: isActiveLayer ? 'default' : 'pointer', userSelect: 'none',
                        padding: '2px 4px', borderRadius: 3,
                        background: visible ? '#1a2a1a' : '#1a1a1a',
                        border: `1px solid ${isActiveLayer ? '#c8a020' : (visible ? '#3a6a3a' : '#2a2a3a')}`,
                        fontSize: '0.73rem',
                        color: visible ? '#9f9' : '#556',
                        opacity: isActiveLayer ? 0.7 : 1,
                      }}
                      title={visible ? t('gridRenderer.hideLayer', { layer: l }) : t('gridRenderer.showLayer', { layer: l })}
                    >
                      <input
                        type="checkbox"
                        checked={visible}
                        disabled={isActiveLayer}
                        onChange={() => toggleLayer(l)}
                        style={{ accentColor: '#4a9a4a', margin: 0 }}
                      />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l}</span>
                      <span style={{ color: '#556', fontSize: '0.66rem' }}>{count}</span>
                    </label>
                    {editMode && (
                      <button
                        className={`${styles.layerBtn} ${isActiveLayer ? styles.layerBtnActive : ''}`}
                        style={{ fontSize: '0.7rem', padding: '1px 5px' }}
                        onClick={() => setActiveLayerHandler(l)}
                        title={isActiveLayer ? t('gridRenderer.clearActiveLayer', { layer: l }) : t('gridRenderer.setActiveLayer', { layer: l })}
                      >
                        ✎
                      </button>
                    )}
                  </div>
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
                const isStair            = stairCells.has(key);
                const isEntry            = stairEntry.has(key);
                const subRoomCell  = subRoomCellMap.get(key);
                const subRoomLabel = subRoomLabels.get(key);
                const cellEdges          = cellEdgeMap.get(key) ?? [];
                const isPath    = showPaths && anyPathSet.has(key);

                const edgeLines = cellEdges.map(
                  ({ edge, dir }) => `  ${t(`object.${edge.type}`)} (${t(DIR_LABEL_KEY[dir])})`,
                );
                const title = [
                  `[${colIdx},${rowIdx}] ${room ? room.name : t('cell.outside')}`,
                  isStair ? ` ${t('cell.stairs')}` : '',
                  isPath  ? t('gridRenderer.pathSuffix') : '',
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

                const previewHere = dragPreview?.cells.find(c => c.col === colIdx && c.row === rowIdx);

                return (
                  <div
                    key={key}
                    className={[
                      styles.cell,
                      room || isStair ? '' : styles.outside,
                      isSelectedRoom ? styles.cellHighlighted : '',
                      isPath ? styles.cellPath : '',
                      previewHere ? (previewHere && dragPreview?.valid ? styles.cellDropValid : styles.cellDropInvalid) : '',
                    ].join(' ')}
                    style={{ width: cellSize, height: cellSize, background: bg }}
                    title={title}
                    onDragOver={editMode ? (e) => {
                      e.preventDefault();
                      const group = dragGroupRef.current;
                      const origin = dragOriginRef.current;
                      if (!group || !origin) return;
                      const delta = computeDelta(origin, colIdx, rowIdx);
                      const valid = isGroupMoveValid(group, delta, floorPlacements, floor);
                      e.dataTransfer.dropEffect = valid ? 'move' : 'none';
                      setDragPreview(prev => {
                        if (prev && prev.valid === valid && prev.cells.length === group.length &&
                            prev.cells[0]?.col === group[0].col + delta.dCol && prev.cells[0]?.row === group[0].row + delta.dRow) {
                          return prev;
                        }
                        return { cells: group.map(g => ({ col: g.col + delta.dCol, row: g.row + delta.dRow })), valid };
                      });
                    } : undefined}
                    onDrop={editMode ? (e) => {
                      e.preventDefault();
                      const group = dragGroupRef.current;
                      const origin = dragOriginRef.current;
                      if (!group || !origin) return;
                      const delta = computeDelta(origin, colIdx, rowIdx);
                      if (isGroupMoveValid(group, delta, floorPlacements, floor)) {
                        onPlacementsChanged?.(applyGroupMove(furniturePlacements, group, delta));
                      }
                      dragGroupRef.current = null;
                      dragOriginRef.current = null;
                      setDraggedItemId(null);
                      setDragPreview(null);
                    } : undefined}
                  >
                    {isStair && <span className={styles.stairStripe} />}
                    {isEntry  && <span className={styles.stairEntry}>✕</span>}
                    {subRoomCell && !subRoomCell.isMain && <span className={styles.secondarySubRoomOverlay} />}
                    {subRoomLabel && (
                      <span className={styles.subRoomSizeLabel}>
                        {subRoomLabel.size}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* ── Reserved zone overlay (e.g. "Car" spot) ── */}
          {reservedZones.length > 0 && (
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2 }}>
              {reservedZones.map((z, i) => (
                <div
                  key={i}
                  title={z.label}
                  style={{
                    position:     'absolute',
                    left:         z.col * cellSize,
                    top:          z.row * cellSize,
                    width:        z.width * cellSize,
                    height:       z.height * cellSize,
                    border:       '2px dashed rgba(255,180,60,0.85)',
                    background:   'repeating-linear-gradient(45deg, rgba(255,180,60,0.12), rgba(255,180,60,0.12) 8px, transparent 8px, transparent 16px)',
                    display:        'flex',
                    alignItems:     'center',
                    justifyContent: 'center',
                    boxSizing:      'border-box',
                  }}
                >
                  <span style={{
                    fontSize: Math.max(9, Math.min(13, cellSize * 0.26)),
                    color: '#ffd9a0',
                    textShadow: '0 0 3px #000',
                    fontWeight: 700,
                  }}>
                    {z.label}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* ── Debug overlay ── */}
          {showDebug && visiblePlacements.length > 0 && (
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 4 }}>
              {visiblePlacements.map((p) => {
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
                    key={p.id}
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
                      // In edit mode, let drag/drop pass through to the cell (and drag hotspots) below —
                      // otherwise this box would intercept drops onto any occupied cell, blocking legitimate
                      // cross-layer stacking (e.g. dropping a sink back onto a counter).
                      pointerEvents:  editMode ? 'none' : 'auto',
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
              {visiblePlacements.map((p) => {
                const parsed = parseTileId(p.tileId);
                if (!parsed) return null;
                const sheet = sheetInfoMap.get(parsed.sheet);
                if (!sheet) return null;
                const scale   = cellSize / SPRITE_W;
                const sprH    = SPRITE_H * scale; // natural height = 2 * cellSize
                return (
                  <div
                    key={p.id}
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

          {/* ── Drag hotspots (edit mode, active layer only) ── */}
          {editMode && activeLayer && (
            <div style={{ position: 'absolute', inset: 0, zIndex: 6, pointerEvents: 'none' }}>
              {floorPlacements.filter(p => p.layer === activeLayer).map(p => (
                <div
                  key={p.id}
                  className={`${styles.dragHotspot} ${draggedItemId === p.id ? styles.dragHotspotActive : ''}`}
                  style={{ left: p.col * cellSize, top: p.row * cellSize, width: cellSize, height: cellSize }}
                  draggable
                  title={`${p.tileId} [${p.layer}]`}
                  onDragStart={(e) => {
                    const group = resolveFootprintGroup(p, floorPlacements, tileConfig, reverseFootprintIndex);
                    dragGroupRef.current = group;
                    dragOriginRef.current = { col: p.col, row: p.row };
                    setDraggedItemId(p.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', p.id);
                  }}
                  onDragEnd={() => {
                    dragGroupRef.current = null;
                    dragOriginRef.current = null;
                    setDraggedItemId(null);
                    setDragPreview(null);
                  }}
                />
              ))}
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

