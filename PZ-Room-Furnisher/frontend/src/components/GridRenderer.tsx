import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { Floor, Room, WallEdge } from '../types/building';
import styles from './GridRenderer.module.css';

interface Props {
  floor: Floor;
  rooms: Room[];
  cellSize?: number;
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

function buildStairCells(floor: Floor): StairInfo {
  const cells = new Set<string>();
  const entry = new Set<string>();
  for (const obj of floor.objects) {
    if (obj.type !== 'Stairs') continue;
    for (let i = 0; i < STAIR_SPAN; i++) {
      const cx = obj.dir === 'W' ? obj.x + i : obj.x;
      const cy = obj.dir === 'N' ? obj.y + i : obj.y;
      cells.add(`${cx},${cy}`);
      if (i === STAIR_SPAN - 1) entry.add(`${cx},${cy}`);
    }
  }
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
export function GridRenderer({ floor, rooms, cellSize = 40 }: Props) {
  const { t } = useTranslation();
  const grid = floor.roomGrid;

  // 1-based room indices that are currently highlighted (matches roomGrid values)
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const handleLegendClick = useCallback((roomIdx1Based: number, ctrlKey: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (ctrlKey) {
        // Toggle this room while keeping others
        if (next.has(roomIdx1Based)) next.delete(roomIdx1Based);
        else next.add(roomIdx1Based);
      } else {
        // Single click: select only this room, or deselect if already the only one
        if (next.size === 1 && next.has(roomIdx1Based)) next.clear();
        else { next.clear(); next.add(roomIdx1Based); }
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  if (!grid || grid.length === 0) {
    return <p className={styles.empty}>{t('floor.noGrid')}</p>;
  }

  const stairInfo   = buildStairCells(floor);
  const stairCells  = stairInfo.cells;
  const stairEntry  = stairInfo.entry;
  const cellEdgeMap = buildCellEdgeMap(floor.edges);
  const cols        = grid[0]?.length ?? 1;
  const rows        = grid.length;
  const svgW        = cols * cellSize;
  const svgH        = rows * cellSize;
  const hasSelection = selected.size > 0;

  return (
    <div className={styles.wrapper}>

      {/* ── Legend ── */}
      <div className={styles.legendWrapper}>
        <div className={styles.legend}>
          {/* Clickable room entries */}
          {rooms.map((room, idx) => {
            const roomIdx1 = idx + 1;
            const isSelected = selected.has(roomIdx1);
            return (
              <div
                key={idx}
                className={`${styles.legendItem} ${styles.legendItemClickable} ${isSelected ? styles.legendItemSelected : ''} ${hasSelection && !isSelected ? styles.legendItemDimmed : ''}`}
                onClick={e => handleLegendClick(roomIdx1, e.ctrlKey)}
                title={t('legend.selectHint', { name: room.name })}
              >
                <span className={styles.legendSwatch} style={{ background: toRgb(room.color) }} />
                <span>{room.name}</span>
              </div>
            );
          })}

          {/* Divider */}
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
        </div>

        {/* Clear-selection button */}
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

                const edgeLines = cellEdges.map(
                  ({ edge, dir }) =>
                    `  ${t(`object.${edge.type}`)} (${t(DIR_LABEL_KEY[dir])})`,
                );
                const title = [
                  `[${colIdx},${rowIdx}] ${room ? room.name : t('cell.outside')}`,
                  isStair ? `🪜 ${t('cell.stairs')}` : '',
                  ...edgeLines,
                ].filter(Boolean).join('\n');

                // Determine highlight state
                const isSelectedRoom = room !== null && selected.has(roomIdx);
                const isDimmed       = hasSelection && !isSelectedRoom && !isStair;

                let alpha: number;
                if (isSelectedRoom)     alpha = 0.95;
                else if (isStair)       alpha = 0.5;
                else if (isDimmed)      alpha = 0.18;
                else                    alpha = 0.72;

                let bg: string;
                if (isStair)    bg = room ? toRgb(room.color, alpha) : `rgba(40,32,0,${isStair ? 0.6 : 0.18})`;
                else if (room)  bg = toRgb(room.color, alpha);
                else            bg = 'transparent';

                return (
                  <div
                    key={key}
                    className={[
                      styles.cell,
                      room || isStair ? '' : styles.outside,
                      isSelectedRoom ? styles.cellHighlighted : '',
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

          {/* SVG overlay – doors and windows exactly on the grid lines */}
          <svg
            width={svgW}
            height={svgH}
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}
          >
            {floor.edges.map(edge => (
              <EdgeMarker key={edge.edgeKey} edge={edge} cellSize={cellSize} />
            ))}
          </svg>

        </div>
      </div>
    </div>
  );
}








