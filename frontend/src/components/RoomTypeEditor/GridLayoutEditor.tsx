import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnchorRule, GridCell, GridCorner, GridLayout, GridMode, GridOrient, GridPoint, RoomTypeSlot } from '../../types/roomTypes';
import { defaultGridCell, defaultGridLayout, defaultSlot, EMPTY_CATEGORY, FURNITURE_LAYERS, GRID_CORNERS, GRID_ORIENTS, SIZE_KEYS } from '../../types/roomTypes';
import type { TileDefinition } from '../../types/tiles';
import { layoutCols, layoutRows } from '../../types/tiles';
import {
  canOverlap, cellRect, CORNER_ARROW, GRID_WARNING_KINDS, nextCellId, ORIENT_ARROW, pieceArrow, rectContains, rectsOverlap,
  rotateOrientCw, transformedGridSize, transformGridCorner, transformGridOrient, transformGridRect, validateGrid,
} from '../../utils/gridLayoutMath';
import type { GridIssue, GridRect } from '../../utils/gridLayoutMath';
import type { TileCatalog } from '../../utils/tileCatalog';
import { facingOf, getCachedTileCatalog, loadTileCatalog, SPRITE_W, spriteStyle } from '../../utils/tileCatalog';
import { FurniturePickerModal } from './FurniturePickerModal';
import { ThemeSelector } from './ThemeSelector';
import rs from './RoomTypeEditor.module.css';
import s from './GridLayoutEditor.module.css';

const CELL = 52;
const MINI_CELL = 11;
const MAX_GRID = 10;
const DEFAULT_WEIGHT = 5;
const EMPTY_CHIP_STYLE: CSSProperties = { borderStyle: 'dashed', fontStyle: 'italic' };

interface Props {
  grids: GridLayout[];
  onChange: (grids: GridLayout[]) => void;
  availGroups: string[];
  /** Ids of the room type's slots — a grid id must not clash with them. */
  slotIds: string[];
  /** Copied grid, shared across room types (state lives in the room-type editor). */
  clipboard: { grid: GridLayout; fromRoom: string } | null;
  /** Current room type, to label a clipboard copied from another one. */
  roomType: string;
  onCopy: (grid: GridLayout) => void;
  onClearClipboard: () => void;
}

/** `${base}_copy`, `${base}_copy2`, … — the first one not in `taken`. */
function uniqueGridId(base: string, taken: Set<string>): string {
  const stem = `${base || 'grid'}_copy`;
  if (!taken.has(stem)) return stem;
  let n = 2;
  while (taken.has(`${stem}${n}`)) n++;
  return `${stem}${n}`;
}

/** "Grid layouts" section of the room-type editor: a list of collapsible grid cards. */
export function GridLayoutEditor({ grids, onChange, availGroups, slotIds, clipboard, roomType, onCopy, onClearClipboard }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [catalog, setCatalog] = useState<TileCatalog | null>(getCachedTileCatalog);

  useEffect(() => {
    if (catalog || grids.length === 0) return;
    loadTileCatalog().then(setCatalog).catch(console.error);
  }, [catalog, grids.length]);

  const updateGrid = (idx: number, next: GridLayout) => onChange(grids.map((g, i) => i === idx ? next : g));

  const addGrid = () => {
    const ids = new Set(grids.map(g => g.id));
    let n = grids.length + 1;
    while (ids.has(`grid_${n}`)) n++;
    onChange([...grids, defaultGridLayout(`grid_${n}`)]);
    setExpanded(new Set([grids.length]));
  };

  const removeGrid = (idx: number) => {
    const g = grids[idx];
    if (!window.confirm(t('roomTypeEditor.grids.removeConfirm', { id: g.id || `#${idx + 1}` }))) return;
    onChange(grids.filter((_, i) => i !== idx));
    setExpanded(new Set());
  };

  /** Deep copy with a free id; cell ids stay (they are only unique within their grid).
   *  A paste keeps the original id/label when the id is still free in this room type. */
  const cloneWithFreeId = (g: GridLayout, keepIfFree: boolean): GridLayout => {
    const copy = structuredClone(g);
    const taken = new Set([...slotIds, ...grids.map(x => x.id)]);
    if (keepIfFree && g.id && !taken.has(g.id)) return copy;
    copy.id = uniqueGridId(g.id, taken);
    if (copy.label) copy.label = t('roomTypeEditor.grids.copyLabel', { label: copy.label });
    return copy;
  };

  const duplicateGrid = (idx: number) => {
    const next = [...grids];
    next.splice(idx + 1, 0, cloneWithFreeId(grids[idx], false));
    onChange(next);
    // Indices after idx shift by one; the duplicate opens.
    setExpanded(prev => {
      const n = new Set<number>();
      prev.forEach(i => n.add(i <= idx ? i : i + 1));
      n.add(idx + 1);
      return n;
    });
  };

  const pasteGrid = () => {
    if (!clipboard) return;
    onChange([...grids, cloneWithFreeId(clipboard.grid, true)]);
    setExpanded(new Set([grids.length]));
  };

  return (
    <>
      <div className={rs.slotsHeader} style={{ marginTop: 12 }}>
        <span className={rs.slotsLabel}>{t('roomTypeEditor.grids.header', { count: grids.length })}</span>
        <button className={rs.addSlotBtn} onClick={addGrid}>{t('roomTypeEditor.grids.addGrid')}</button>
      </div>
      {clipboard && (
        <div className={rs.pasteBar}>
          <span className={rs.pasteBarIcon}>📋</span>
          <span className={rs.pasteBarText}>
            {t('roomTypeEditor.pasteBar.clipboard')}{' '}
            <strong>▦ {clipboard.grid.id || clipboard.grid.label || t('roomTypeEditor.pasteBar.noName')}</strong>
            {clipboard.fromRoom !== roomType && (
              <span className={rs.pasteBarFrom}>{t('roomTypeEditor.pasteBar.from', { room: clipboard.fromRoom })}</span>
            )}
          </span>
          <button className={rs.pasteSlotBtn} onClick={pasteGrid}
            title={t('roomTypeEditor.grids.pasteTitle', { name: clipboard.grid.id || t('roomTypeEditor.pasteBar.insertTitleFallback') })}>
            {t('roomTypeEditor.pasteBar.insert')}
          </button>
          <button className={rs.pasteBarClearBtn} title={t('roomTypeEditor.pasteBar.clearTitle')}
            onClick={onClearClipboard}>✕</button>
        </div>
      )}
      {grids.length === 0 && (
        <div className={rs.hint} style={{ padding: '10px 12px' }}>{t('roomTypeEditor.grids.noGrids')}</div>
      )}
      {grids.map((grid, idx) => {
        const otherIds = new Set([...slotIds, ...grids.filter((_, i) => i !== idx).map(g => g.id)]);
        const anchorTargets = [...new Set(grids.filter((_, i) => i !== idx).flatMap(g => [
          g.id, g.slotGroupId, ...g.cells.map(c => c.anchorGroup?.trim() ?? ''),
        ]))].filter(id => id && id !== grid.id && id !== grid.slotGroupId);
        return (
          <GridCard key={idx}
            grid={grid}
            index={idx}
            expanded={expanded.has(idx)}
            onToggle={() => setExpanded(prev => { const n = new Set(prev); if (n.has(idx)) n.delete(idx); else n.add(idx); return n; })}
            onChange={next => updateGrid(idx, next)}
            onRemove={() => removeGrid(idx)}
            onDuplicate={() => duplicateGrid(idx)}
            onCopy={() => onCopy(grid)}
            otherIds={otherIds}
            anchorTargets={anchorTargets}
            availGroups={availGroups}
            catalog={catalog} />
        );
      })}
    </>
  );
}

/** Issues for every grid, for blocking the room-type save. */
export function gridSaveErrors(grids: GridLayout[], slotIds: string[]): { gridId: string; issues: GridIssue[] }[] {
  return grids
    .map((g, i) => {
      const others = new Set([...slotIds, ...grids.filter((_, j) => j !== i).map(o => o.id)]);
      return { gridId: g.id || `#${i + 1}`, issues: validateGrid(g, others).filter(x => !GRID_WARNING_KINDS.has(x.kind)) };
    })
    .filter(e => e.issues.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────

interface CardProps {
  grid: GridLayout;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onChange: (g: GridLayout) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onCopy: () => void;
  otherIds: Set<string>;
  /** Grid ids, grid groups and cell anchor groups this grid can be placed opposite. */
  anchorTargets: string[];
  availGroups: string[];
  catalog: TileCatalog | null;
}

type PickerTarget = { kind: 'new'; x: number; y: number } | { kind: 'repick'; cellId: string };
type Tool = 'place' | 'keepClear';

function GridCard({ grid, index, expanded, onToggle, onChange, onRemove, onDuplicate, onCopy, otherIds, anchorTargets, availGroups, catalog }: CardProps) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('place');
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [drag, setDrag] = useState<{ cellId: string; offX: number; offY: number } | null>(null);
  const [dropHover, setDropHover] = useState<GridPoint | null>(null);
  const [flashBad, setFlashBad] = useState(false);

  const issues = useMemo(() => validateGrid(grid, otherIds), [grid, otherIds]);
  const errors = issues.filter(i => !GRID_WARNING_KINDS.has(i.kind));
  const selected = grid.cells.find(c => c.id === selectedId) ?? null;

  const setCells = (cells: GridCell[]) => onChange({ ...grid, cells });
  const updateCell = (id: string, patch: Partial<GridCell>) =>
    setCells(grid.cells.map(c => c.id === id ? { ...c, ...patch } : c));

  /** True if rect fits inside the grid and overlaps no other piece (except a stacking host,
   *  see canOverlap) / keep-clear cell. `ignoreId` = the piece being moved (new pieces don't stack). */
  const fits = (r: GridRect, ignoreId?: string) => {
    const self = grid.cells.find(c => c.id === ignoreId) ?? defaultGridCell('', r.x, r.y);
    return r.x >= 0 && r.y >= 0 && r.x + r.w <= grid.width && r.y + r.h <= grid.height
      && !grid.cells.some(c => c.id !== ignoreId && rectsOverlap(r, cellRect(c)) && !canOverlap(self, c))
      && !grid.keepClear.some(p => rectContains(r, p));
  };

  /** Topmost piece at p: a piece standing on/in a stacking host wins over the host. */
  const pieceAt = (p: GridPoint) => {
    const hits = grid.cells.filter(c => rectContains(cellRect(c), p));
    return hits.find(c => !c.allowStacking) ?? hits[0];
  };

  /** Click on a piece: a selected stacking host adds a new piece on that cell; a selected piece
   *  standing on a host selects the host below (click-through); otherwise select the piece. */
  const onPieceClick = (c: GridCell, p: GridPoint) => {
    if (c.id !== selectedId) { setSelectedId(c.id); return; }
    if (c.allowStacking) { addOnHost(p); return; }
    const host = grid.cells.find(h => h.id !== c.id && h.allowStacking && rectContains(cellRect(h), p));
    if (host) setSelectedId(host.id);
  };

  /** Click on an already selected stacking host: add a new piece on that cell. */
  const addOnHost = (p: GridPoint) => {
    if (grid.keepClear.some(k => k.x === p.x && k.y === p.y) || pieceAt(p)?.allowStacking === false) { flash(); return; }
    setPicker({ kind: 'new', x: p.x, y: p.y });
  };

  const flash = () => { setFlashBad(true); window.setTimeout(() => setFlashBad(false), 450); };

  // ── Size change ──
  const resize = (width: number, height: number) => {
    width = Math.max(1, Math.min(MAX_GRID, width || 1));
    height = Math.max(1, Math.min(MAX_GRID, height || 1));
    const inside = (r: GridRect) => r.x + r.w <= width && r.y + r.h <= height;
    const dropped = grid.cells.filter(c => !inside(cellRect(c)));
    if (dropped.length > 0
      && !window.confirm(t('roomTypeEditor.grids.shrinkConfirm', { count: dropped.length, ids: dropped.map(c => c.id).join(', ') })))
      return;
    onChange({
      ...grid, width, height,
      cells: grid.cells.filter(c => inside(cellRect(c))),
      keepClear: grid.keepClear.filter(p => p.x < width && p.y < height),
    });
  };

  // ── Canvas interactions ──
  const onCellClick = (p: GridPoint) => {
    const piece = pieceAt(p);
    if (piece) { setSelectedId(piece.id); return; }
    if (tool === 'keepClear') {
      const has = grid.keepClear.some(k => k.x === p.x && k.y === p.y);
      onChange({ ...grid, keepClear: has ? grid.keepClear.filter(k => k.x !== p.x || k.y !== p.y) : [...grid.keepClear, p] });
      return;
    }
    if (grid.keepClear.some(k => k.x === p.x && k.y === p.y)) { flash(); return; }
    setPicker({ kind: 'new', x: p.x, y: p.y });
  };

  const onDrop = (p: GridPoint) => {
    if (!drag) return;
    const cell = grid.cells.find(c => c.id === drag.cellId);
    setDrag(null); setDropHover(null);
    if (!cell) return;
    const r = { x: p.x - drag.offX, y: p.y - drag.offY, w: cell.footprint.width, h: cell.footprint.height };
    if (!fits(r, cell.id)) { flash(); return; }
    updateCell(cell.id, { x: r.x, y: r.y });
  };

  const dragPreview: GridRect | null = (() => {
    if (!drag || !dropHover) return null;
    const cell = grid.cells.find(c => c.id === drag.cellId);
    return cell ? { x: dropHover.x - drag.offX, y: dropHover.y - drag.offY, w: cell.footprint.width, h: cell.footprint.height } : null;
  })();
  const dragPreviewOk = dragPreview ? fits(dragPreview, drag!.cellId) : true;

  // ── Piece edits ──
  const rotatePiece = (c: GridCell) => {
    const orient = rotateOrientCw(c.orient);
    const cornerOrient = transformGridCorner(c.cornerOrient, 1, false);
    const footprint = { ...c.footprint, width: c.footprint.height, height: c.footprint.width };
    // Pivot around the top-left; nudge back inside the grid if the swap pushes it out.
    const x = Math.max(0, Math.min(c.x, grid.width - footprint.width));
    const y = Math.max(0, Math.min(c.y, grid.height - footprint.height));
    if (!fits({ x, y, w: footprint.width, h: footprint.height }, c.id)) { flash(); return; }
    updateCell(c.id, { orient, cornerOrient, footprint, x, y });
  };

  const setAnchor = (id: string) =>
    setCells(grid.cells.map(c => ({ ...c, isAnchor: c.id === id, required: c.id === id ? true : c.required })));

  const deletePiece = (id: string) => {
    setCells(grid.cells.filter(c => c.id !== id));
    setSelectedId(null);
  };

  const renameCell = (oldId: string, id: string) => {
    updateCell(oldId, { id });
    setSelectedId(id);
  };

  // ── Picker ──
  const pickerSlot: RoomTypeSlot | null = (() => {
    if (!picker) return null;
    const base = defaultSlot();
    if (picker.kind === 'new') return { ...base, label: t('roomTypeEditor.grids.newPiece') };
    const c = grid.cells.find(x => x.id === picker.cellId);
    return c ? { ...base, id: c.id, label: c.label || c.id, footprint: { ...c.footprint, canRotate: true } } : null;
  })();

  const applyPick = (patch: Partial<RoomTypeSlot>, _count: number, defs: TileDefinition[]) => {
    if (!picker) return;
    const target = picker;
    setPicker(null);
    const prev = target.kind === 'repick' ? grid.cells.find(c => c.id === target.cellId) : undefined;
    const orient: GridOrient = prev?.orient ?? 'S';
    // A card holding only corner variants (no straight piece) makes this a corner piece; a mixed
    // card (straight + corner counters of one set) keeps the cell's current corner setting.
    const cornerDefs = defs.filter(isCornerDef);
    const cornerOrient: GridCorner | '' = defs.length > 0 && cornerDefs.length === defs.length
      ? (cornerDefs.find(d => facingOf(d) === prev?.cornerOrient) ?? cornerDefs[0]).orientation as GridCorner
      : prev?.cornerOrient ?? '';
    // Footprint from the picked variant that actually faces `orient` (or sits in the corner),
    // so the canvas shape matches what the generator will place; fall back to the picker's
    // shared footprint.
    const facing = defs.find(d => facingOf(d) === (cornerOrient || orient));
    const fp = facing
      ? { width: layoutCols(facing), height: layoutRows(facing), canRotate: false }
      : patch.footprint ? { width: patch.footprint.width, height: patch.footprint.height, canRotate: false } : null;
    const furniture: Partial<GridCell> = {
      allowedCategories: patch.allowedCategories ?? {},
      requiredLayer: patch.requiredLayer ?? '',
      requiredProperties: patch.requiredProperties ?? [],
      previewTileIds: defs.map(d => d.id),
      cornerOrient,
    };

    if (target.kind === 'repick') {
      const c = grid.cells.find(x => x.id === target.cellId);
      if (!c) return;
      const footprint = fp ?? c.footprint;
      updateCell(c.id, { ...furniture, footprint, label: c.label || defs[0]?.label || '' });
      return;
    }

    const footprint = fp ?? { width: 1, height: 1, canRotate: false };
    // Keep the clicked cell inside the piece; shift up/left if it would overflow the grid.
    let x = Math.max(0, Math.min(target.x, grid.width - footprint.width));
    let y = Math.max(0, Math.min(target.y, grid.height - footprint.height));
    if (!fits({ x, y, w: footprint.width, h: footprint.height })) {
      const spot = findFreeSpot(footprint.width, footprint.height);
      if (!spot) { flash(); return; }
      ({ x, y } = spot);
    }
    const id = nextCellId(grid);
    const cell: GridCell = {
      ...defaultGridCell(id, x, y),
      ...furniture,
      label: defs[0]?.label ?? '',
      footprint,
      orient,
      isAnchor: !grid.cells.some(c => c.isAnchor),
    };
    if (cell.isAnchor) cell.required = true;
    setCells([...grid.cells, cell]);
    setSelectedId(id);
  };

  const findFreeSpot = (w: number, h: number): GridPoint | null => {
    for (let y = 0; y + h <= grid.height; y++)
      for (let x = 0; x + w <= grid.width; x++)
        if (fits({ x, y, w, h })) return { x, y };
    return null;
  };

  const anchorCell = grid.cells.find(c => c.isAnchor);
  const opposite = grid.oppositeAnchor;
  const updateOpposite = (patch: Partial<AnchorRule>) => {
    if (opposite) onChange({ ...grid, oppositeAnchor: { ...opposite, ...patch } });
  };
  const setOppositeTarget = (anchorTarget: string) => {
    if (!anchorTarget) {
      const { oppositeAnchor: _, ...rest } = grid;
      onChange(rest);
      return;
    }
    onChange({ ...grid, oppositeAnchor: { positions: ['oppositeWall'], minOppositeWallDistance: 1, ...opposite, anchorTarget } });
  };

  return (
    <div className={`${rs.slotCard} ${grid.required ? rs.slotCardRequired : ''}`}
      style={grid.enabled === false ? { opacity: 0.5 } : undefined}>
      <div className={s.cardHeader} onClick={onToggle}>
        <input type="checkbox" checked={grid.enabled !== false}
          title={t('roomTypeEditor.grids.enabledTitle')}
          onClick={e => e.stopPropagation()}
          onChange={e => onChange({ ...grid, enabled: e.target.checked })} />
        <span className={s.collapseIcon}>{expanded ? '▾' : '▸'}</span>
        <span className={s.gridBadge}>▦ {grid.width}×{grid.height}</span>
        <span className={s.gridId}>{grid.id || t('roomTypeEditor.grids.noId')}</span>
        {grid.label && <span className={s.gridLabel}>{grid.label}</span>}
        <span className={s.headerMeta}>
          {t(`roomTypeEditor.grids.mode.${grid.mode}`)} · {t('roomTypeEditor.grids.pieceCount', { count: grid.cells.length })}
          {anchorCell && <> · ★ {anchorCell.label || anchorCell.id}</>}
        </span>
        {errors.length > 0 && <span className={s.errorBadge} title={issues.map(i => issueText(t, i)).join('\n')}>⚠ {errors.length}</span>}
        <button className={rs.duplicateSlotBtn} onClick={e => { e.stopPropagation(); onDuplicate(); }}
          title={t('roomTypeEditor.grids.duplicateGrid')}>⎘</button>
        <button className={rs.copySlotBtn} onClick={e => { e.stopPropagation(); onCopy(); }}
          title={t('roomTypeEditor.grids.copyGrid')}>📋</button>
        <button className={rs.removeSlotBtn} onClick={e => { e.stopPropagation(); onRemove(); }}
          title={t('roomTypeEditor.grids.removeGrid')}>✕</button>
      </div>

      {expanded && (
        <div className={s.cardBody}>
          {/* ── Settings ── */}
          <div className={rs.slotRow}>
            <label className={s.field}>
              <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.idLabel')}</span>
              <input className={rs.slotSizeInput} style={{ width: 130 }} value={grid.id}
                onChange={e => onChange({ ...grid, id: e.target.value.replace(/\s+/g, '_') })} />
            </label>
            <label className={s.field}>
              <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.labelLabel')}</span>
              <input className={rs.slotSizeInput} style={{ width: 150 }} value={grid.label}
                onChange={e => onChange({ ...grid, label: e.target.value })} />
            </label>
            <label className={s.field}>
              <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.sizeLabel')}</span>
              <input type="number" min={1} max={MAX_GRID} className={rs.slotNumInput} value={grid.width}
                onChange={e => resize(+e.target.value, grid.height)} />
              <span className={rs.slotHint}>×</span>
              <input type="number" min={1} max={MAX_GRID} className={rs.slotNumInput} value={grid.height}
                onChange={e => resize(grid.width, +e.target.value)} />
            </label>
            <label className={s.field} title={t(`roomTypeEditor.grids.modeHint.${grid.mode}`)}>
              <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.modeLabel')}</span>
              <select className={rs.slotSelect} value={grid.mode} onChange={e => onChange({ ...grid, mode: e.target.value as GridMode })}>
                {(['wall', 'corner', 'free'] as const).map(m => <option key={m} value={m}>{t(`roomTypeEditor.grids.mode.${m}`)}</option>)}
              </select>
            </label>
          </div>
          <div className={rs.slotRow}>
            <label className={rs.slotCheck} title={t('roomTypeEditor.grids.mirrorHint')}>
              <input type="checkbox" checked={grid.allowMirror} onChange={e => onChange({ ...grid, allowMirror: e.target.checked })} />
              {t('roomTypeEditor.grids.mirrorLabel')}
            </label>
            <label className={rs.slotCheck} title={t('roomTypeEditor.grids.requiredHint')}>
              <input type="checkbox" checked={grid.required} onChange={e => onChange({ ...grid, required: e.target.checked })} />
              {t('roomTypeEditor.grids.requiredLabel')}
            </label>
            <label className={rs.slotCheck} title={t('roomTypeEditor.grids.allowOnPathHint')}>
              <input type="checkbox" checked={grid.allowOnPath} onChange={e => onChange({ ...grid, allowOnPath: e.target.checked })} />
              {t('roomTypeEditor.grids.allowOnPathLabel')}
            </label>
            <label className={rs.slotCheck} title={t('roomTypeEditor.grids.mainSubRoomHint')}>
              <input type="checkbox" checked={!!grid.mainSubRoom} onChange={e => onChange({ ...grid, mainSubRoom: e.target.checked })} />
              {t('roomTypeEditor.grids.mainSubRoomLabel')}
            </label>
            <label className={rs.slotCheck} title={t('roomTypeEditor.colorHarmony.title')}>
              <input type="checkbox" checked={grid.useColorHarmony !== false} onChange={e => onChange({ ...grid, useColorHarmony: e.target.checked })} />
              {t('roomTypeEditor.colorHarmony.label')}
            </label>
            <label className={s.field}>
              <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.priorityLabel')}</span>
              <input type="number" className={rs.slotNumInput} value={grid.priority}
                onChange={e => onChange({ ...grid, priority: +e.target.value || 0 })} />
            </label>
            <label className={s.field} title={t('roomTypeEditor.grids.emptyWeightHint')}>
              <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.emptyWeightLabel')}</span>
              <input type="number" min={0} max={99} className={rs.slotNumInput} value={grid.emptyWeight ?? 0}
                disabled={grid.required}
                onChange={e => onChange({ ...grid, emptyWeight: Math.max(0, Math.min(99, +e.target.value || 0)) })} />
            </label>
            <label className={s.field} title={t('roomTypeEditor.grids.groupHint')}>
              <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.groupLabel')}</span>
              <input className={rs.slotSizeInput} style={{ width: 110 }} value={grid.slotGroupId}
                onChange={e => onChange({ ...grid, slotGroupId: e.target.value })} />
              {grid.slotGroupId && (
                <input type="number" min={1} max={10} className={rs.slotNumInput} value={grid.groupWeight}
                  title={t('roomTypeEditor.grids.weightLabel')}
                  onChange={e => onChange({ ...grid, groupWeight: Math.max(1, Math.min(10, +e.target.value || 1)) })} />
              )}
            </label>
          </div>
          <div className={rs.slotRow} style={{ flexWrap: 'wrap' }} title={t('roomTypeEditor.grids.oppositeAnchorHint')}>
            <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.oppositeAnchorLabel')}</span>
            <select className={rs.slotSelect} value={opposite?.anchorTarget ?? ''} onChange={e => setOppositeTarget(e.target.value)}>
              <option value="">{t('roomTypeEditor.grids.oppositeAnchorNone')}</option>
              {[...new Set([...anchorTargets, ...(opposite ? [opposite.anchorTarget] : [])])].map(id => <option key={id} value={id}>{id}</option>)}
            </select>
            {opposite && (<>
              <span className={rs.slotHint} title={t('roomTypeEditor.slotCard.distanceTitle')}>{t('roomTypeEditor.slotCard.distanceLabel')}</span>
              <input type="number" min={1} className={rs.slotSizeInput} style={{ width: 64 }}
                value={opposite.minOppositeWallDistance ?? 1}
                title={t('roomTypeEditor.slotCard.distanceMinTitle')}
                onChange={e => updateOpposite({ minOppositeWallDistance: Math.max(1, parseInt(e.target.value) || 1) })} />
              <span className={rs.slotHint}>{t('roomTypeEditor.slotCard.distanceTo')}</span>
              <input type="number" min={1} className={rs.slotSizeInput} style={{ width: 64 }} placeholder="∞"
                value={opposite.maxOppositeWallDistance ?? ''}
                title={t('roomTypeEditor.slotCard.distanceMaxTitle')}
                onChange={e => {
                  const raw = e.target.value.trim();
                  updateOpposite({ maxOppositeWallDistance: raw === '' ? undefined : Math.max(1, parseInt(raw) || 1) });
                }} />
              <label className={rs.slotCheck} title={t('roomTypeEditor.slotCard.allowInsideTitle')}>
                <input type="checkbox" checked={opposite.oppositeWallAllowInside ?? false}
                  onChange={e => updateOpposite({ oppositeWallAllowInside: e.target.checked || undefined })} />
                {t('roomTypeEditor.slotCard.allowInsideLabel')}
              </label>
              <label className={rs.slotCheck} title={t('roomTypeEditor.slotCard.keepSightClearTitle')}>
                <input type="checkbox" checked={opposite.keepSightClear ?? false}
                  onChange={e => updateOpposite({ keepSightClear: e.target.checked || undefined })} />
                {t('roomTypeEditor.slotCard.keepSightClearLabel')}
              </label>
            </>)}
          </div>
          <div className={rs.slotRow}>
            <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.sizesLabel')}</span>
            <div className={rs.chipGroup} style={{ gap: 4 }}>
              {SIZE_KEYS.map(k => {
                const on = grid.allowedSizes.includes(k);
                return (
                  <span key={k} className={`${rs.chip} ${on ? rs.chipActive : ''}`}
                    onClick={() => {
                      // Toggling a size off also drops its per-size weight.
                      const { [k]: _, ...restWeights } = grid.groupWeightBySize ?? {};
                      onChange({ ...grid,
                        allowedSizes: on ? grid.allowedSizes.filter(x => x !== k) : [...grid.allowedSizes, k],
                        groupWeightBySize: on ? restWeights : grid.groupWeightBySize });
                    }}>
                    {k}
                  </span>
                );
              })}
            </div>
            <span className={rs.slotHint}>{grid.allowedSizes.length === 0 ? t('roomTypeEditor.grids.allSizes') : ''}</span>
          </div>
          {grid.slotGroupId && (
            <div className={rs.slotRow} title={t('roomTypeEditor.grids.sizeWeightHint')}>
              <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.sizeWeightLabel')}</span>
              {SIZE_KEYS.filter(k => grid.allowedSizes.length === 0 || grid.allowedSizes.includes(k)).map(k => (
                <label key={k} className={s.field} style={{ gap: 3 }}>
                  <span className={rs.slotHint}>{k}</span>
                  <input type="number" min={1} max={10} className={rs.slotNumInput}
                    value={grid.groupWeightBySize?.[k] ?? ''} placeholder={String(grid.groupWeight)}
                    onChange={e => {
                      const { [k]: _, ...rest } = grid.groupWeightBySize ?? {};
                      onChange({ ...grid, groupWeightBySize: e.target.value === ''
                        ? rest
                        : { ...rest, [k]: Math.max(1, Math.min(10, +e.target.value || 1)) } });
                    }} />
                </label>
              ))}
            </div>
          )}

          {/* ── Canvas + inspector ── */}
          <div className={s.workArea}>
            <div className={s.canvasColumn}>
              <div className={s.toolbar}>
                <button className={`${s.toolBtn} ${tool === 'place' ? s.toolBtnActive : ''}`} onClick={() => setTool('place')}
                  title={t('roomTypeEditor.grids.toolPlaceHint')}>＋ {t('roomTypeEditor.grids.toolPlace')}</button>
                <button className={`${s.toolBtn} ${tool === 'keepClear' ? s.toolBtnActive : ''}`} onClick={() => setTool('keepClear')}
                  title={t('roomTypeEditor.grids.toolKeepClearHint')}>▨ {t('roomTypeEditor.grids.toolKeepClear')}</button>
              </div>

              <div className={s.canvasFrame}>
                <div className={s.wallLabel}>{t('roomTypeEditor.grids.backWall')}</div>
                <div className={`${s.canvas} ${flashBad ? s.canvasFlash : ''}`}
                  style={{ width: grid.width * CELL, height: grid.height * CELL }}
                  onDragLeave={e => { if (e.currentTarget === e.target) setDropHover(null); }}>
                  {grid.mode !== 'free' && <div className={s.wallTop} />}
                  {grid.mode === 'corner' && <div className={s.wallLeft} />}

                  {Array.from({ length: grid.height }, (_, y) => Array.from({ length: grid.width }, (_, x) => {
                    const keep = grid.keepClear.some(k => k.x === x && k.y === y);
                    return (
                      <div key={`${x},${y}`}
                        className={`${s.cell} ${keep ? s.cellKeepClear : ''} ${tool === 'keepClear' ? s.cellToolKeep : ''}`}
                        style={{ left: x * CELL, top: y * CELL, width: CELL, height: CELL }}
                        onClick={() => onCellClick({ x, y })}
                        onDragOver={e => { if (drag) { e.preventDefault(); setDropHover({ x, y }); } }}
                        onDrop={e => { e.preventDefault(); onDrop({ x, y }); }}
                        title={keep ? t('roomTypeEditor.grids.keepClearCell') : tool === 'place' ? t('roomTypeEditor.grids.clickToPlace') : ''} />
                    );
                  }))}

                  {[...grid.cells].sort((a, b) => Number(b.allowStacking) - Number(a.allowStacking) || a.y - b.y).map(c => (
                    <Piece key={c.id} cell={c} catalog={catalog}
                      selected={c.id === selectedId}
                      dragging={drag?.cellId === c.id}
                      onSelect={p => onPieceClick(c, p)}
                      onDragStart={(offX, offY) => { setSelectedId(c.id); setDrag({ cellId: c.id, offX, offY }); }}
                      onDragEnd={() => { setDrag(null); setDropHover(null); }}
                      onDropOnto={p => onDrop(p)}
                      onDragOverCell={p => drag && setDropHover(p)} />
                  ))}

                  {dragPreview && (
                    <div className={`${s.dropPreview} ${dragPreviewOk ? '' : s.dropPreviewBad}`}
                      style={{ left: dragPreview.x * CELL, top: dragPreview.y * CELL, width: dragPreview.w * CELL, height: dragPreview.h * CELL }} />
                  )}
                </div>
                <div className={s.frontLabel}>{t('roomTypeEditor.grids.roomSide')}</div>
              </div>

              <div className={s.legend}>
                <span><span className={`${s.legendSwatch} ${s.swAnchor}`} /> {t('roomTypeEditor.grids.legendAnchor')}</span>
                <span><span className={`${s.legendSwatch} ${s.swRequired}`} /> {t('roomTypeEditor.grids.legendRequired')}</span>
                <span><span className={`${s.legendSwatch} ${s.swOptional}`} /> {t('roomTypeEditor.grids.legendOptional')}</span>
                <span><span className={`${s.legendSwatch} ${s.swKeep}`} /> {t('roomTypeEditor.grids.legendKeepClear')}</span>
              </div>
            </div>

            <div className={s.inspector}>
              {!selected && <div className={rs.slotHint}>{t('roomTypeEditor.grids.selectHint')}</div>}
              {selected && (
                <PieceInspector key={selected.id}
                  cell={selected}
                  takenIds={new Set(grid.cells.filter(c => c.id !== selected.id).map(c => c.id))}
                  availGroups={availGroups}
                  onChange={patch => updateCell(selected.id, patch)}
                  onRename={id => renameCell(selected.id, id)}
                  onRotate={() => rotatePiece(selected)}
                  onSetAnchor={() => setAnchor(selected.id)}
                  onRepick={() => setPicker({ kind: 'repick', cellId: selected.id })}
                  onDelete={() => deletePiece(selected.id)}
                  onResize={(w, h) => {
                    const r = { x: selected.x, y: selected.y, w, h };
                    if (!fits(r, selected.id)) { flash(); return; }
                    updateCell(selected.id, { footprint: { ...selected.footprint, width: w, height: h } });
                  }} />
              )}
            </div>
          </div>

          {/* ── Rotation preview ── */}
          <RotationPreview grid={grid} />

          {/* ── Validation ── */}
          {issues.length > 0 && (
            <div className={s.issues}>
              {issues.map((i, k) => (
                <div key={k} className={GRID_WARNING_KINDS.has(i.kind) ? s.issueWarn : s.issueError}>
                  {GRID_WARNING_KINDS.has(i.kind) ? '⚠' : '✖'} {issueText(t, i)}
                </div>
              ))}
            </div>
          )}
          <div className={rs.slotHint} style={{ marginTop: 4 }}>
            {t('roomTypeEditor.grids.anchorKeysHint', { grid: grid.id || `grid_${index + 1}` })}
          </div>
        </div>
      )}

      {picker && pickerSlot && (
        <FurniturePickerModal slot={pickerSlot} onApply={applyPick} onClose={() => setPicker(null)} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function issueText(t: (k: string, o?: Record<string, unknown>) => string, i: GridIssue): string {
  switch (i.kind) {
    case 'anchorCount':       return t('roomTypeEditor.grids.issues.anchorCount', { count: i.count });
    case 'outOfBounds':       return t('roomTypeEditor.grids.issues.outOfBounds', { id: i.cellId });
    case 'overlap':           return t('roomTypeEditor.grids.issues.overlap', { a: i.a, b: i.b });
    case 'duplicateId':       return t('roomTypeEditor.grids.issues.duplicateId', { id: i.cellId });
    case 'noId':              return t('roomTypeEditor.grids.issues.noId');
    case 'idClash':           return t('roomTypeEditor.grids.issues.idClash', { id: i.id });
    case 'keepClearOccupied': return t('roomTypeEditor.grids.issues.keepClearOccupied', { x: i.x, y: i.y });
    case 'noCategories':      return t('roomTypeEditor.grids.issues.noCategories', { id: i.cellId });
    case 'noBackWallPiece':   return t('roomTypeEditor.grids.issues.noBackWallPiece');
  }
}

/** Corner variant: orientation NW/NE/SE/SW = the room corner it sits in (both conventions). */
const isCornerDef = (d: TileDefinition) => (GRID_CORNERS as readonly string[]).includes(d.orientation);

/** Preview tile definition for a cell: the picked variant facing the cell's orient (or, for a
 *  corner piece, sitting in its corner) with a matching shape. */
function previewDef(cell: GridCell, catalog: TileCatalog | null, orient: GridOrient = cell.orient,
  corner: GridCorner | '' = cell.cornerOrient, w = cell.footprint.width, h = cell.footprint.height): TileDefinition | null {
  if (!catalog || cell.previewTileIds.length === 0) return null;
  const defs = cell.previewTileIds.map(id => catalog.byId.get(id)).filter((d): d is TileDefinition => !!d);
  const shaped = defs.filter(d => layoutCols(d) === w && layoutRows(d) === h);
  if (corner) return shaped.find(d => d.orientation === corner) ?? null;
  return shaped.find(d => facingOf(d) === orient) ?? shaped.find(d => !isCornerDef(d)) ?? null;
}

interface PieceProps {
  cell: GridCell;
  catalog: TileCatalog | null;
  selected: boolean;
  dragging: boolean;
  /** Called with the clicked grid cell. */
  onSelect: (p: GridPoint) => void;
  onDragStart: (offX: number, offY: number) => void;
  onDragEnd: () => void;
  onDropOnto: (p: GridPoint) => void;
  onDragOverCell: (p: GridPoint) => void;
}

function Piece({ cell, catalog, selected, dragging, onSelect, onDragStart, onDragEnd, onDropOnto, onDragOverCell }: PieceProps) {
  const def = previewDef(cell, catalog);
  const zoom = CELL / SPRITE_W;
  const kind = cell.isAnchor ? s.pieceAnchor : cell.required ? s.pieceRequired : s.pieceOptional;
  const cats = Object.keys(cell.allowedCategories).filter(c => c !== EMPTY_CATEGORY);

  /** Grid cell under the pointer, from an event on the piece. */
  const cellFromEvent = (e: React.DragEvent | React.MouseEvent): GridPoint => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return {
      x: cell.x + Math.max(0, Math.min(cell.footprint.width - 1, Math.floor((e.clientX - rect.left) / CELL))),
      y: cell.y + Math.max(0, Math.min(cell.footprint.height - 1, Math.floor((e.clientY - rect.top) / CELL))),
    };
  };

  return (
    <div className={`${s.piece} ${kind} ${selected ? s.pieceSelected : ''} ${dragging ? s.pieceDragging : ''}`}
      style={{ left: cell.x * CELL, top: cell.y * CELL, width: cell.footprint.width * CELL, height: cell.footprint.height * CELL,
        // Stacking hosts stay below pieces placed on / inside them.
        zIndex: (cell.allowStacking ? 10 : 30) + cell.y }}
      draggable
      onClick={e => { e.stopPropagation(); onSelect(cellFromEvent(e)); }}
      onDragStart={e => {
        const p = cellFromEvent(e);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', cell.id);
        onDragStart(p.x - cell.x, p.y - cell.y);
      }}
      onDragEnd={onDragEnd}
      onDragOver={e => { e.preventDefault(); onDragOverCell(cellFromEvent(e)); }}
      onDrop={e => { e.preventDefault(); onDropOnto(cellFromEvent(e)); }}
      title={`${cell.id}${cell.label ? ` – ${cell.label}` : ''}\n${cats.join(', ')}`}>
      {def
        ? def.tileLayout.map((row, r) => row.map((tid, c) => {
            if (!tid || !catalog) return null;
            const css = spriteStyle(tid, catalog.sheetCols, zoom);
            return css && (
              <div key={`${r},${c}`} className={s.sprite}
                style={{ ...css, left: c * CELL, top: (r - 1) * CELL } as CSSProperties} />
            );
          }))
        : <span className={s.pieceText}>{cell.label || cats[0] || cell.id}</span>}
      <span className={s.orientBadge}>{pieceArrow(cell.orient, cell.cornerOrient)}</span>
      {cell.isAnchor && <span className={s.anchorBadge}>★</span>}
      {cell.cornerOrient
        ? cornerWallFacings(cell.cornerOrient).map(f => <span key={f} className={s.wallMark} style={WALL_MARK_STYLE[f]} />)
        : cell.againstWall && <span className={s.wallMark} style={WALL_MARK_STYLE[cell.orient]} />}
    </div>
  );
}

/** A corner piece's two walls, as the facings whose back side they are (NW → walls N, W → facings S, E). */
const BACK_TO_FACING: Record<string, GridOrient> = { N: 'S', S: 'N', E: 'W', W: 'E' };
const cornerWallFacings = (c: GridCorner): GridOrient[] => [BACK_TO_FACING[c[0]], BACK_TO_FACING[c[1]]];

/** "Against wall" marker: a wall bar on the piece's back side (opposite its facing). */
const WALL_MARK_STYLE: Record<GridOrient, CSSProperties> = {
  S: { top: 0, left: 0, right: 0, height: 4 },
  N: { bottom: 0, left: 0, right: 0, height: 4 },
  E: { left: 0, top: 0, bottom: 0, width: 4 },
  W: { right: 0, top: 0, bottom: 0, width: 4 },
};

interface InspectorProps {
  cell: GridCell;
  takenIds: Set<string>;
  availGroups: string[];
  onChange: (patch: Partial<GridCell>) => void;
  onRename: (id: string) => void;
  onRotate: () => void;
  onSetAnchor: () => void;
  onRepick: () => void;
  onDelete: () => void;
  onResize: (w: number, h: number) => void;
}

function PieceInspector({ cell, takenIds, availGroups, onChange, onRename, onRotate, onSetAnchor, onRepick, onDelete, onResize }: InspectorProps) {
  const { t } = useTranslation();
  const [idDraft, setIdDraft] = useState(cell.id);
  const idTaken = idDraft !== cell.id && takenIds.has(idDraft);
  const [showAllCats, setShowAllCats] = useState(false);
  const [catFilter, setCatFilter] = useState('');
  const filterText = catFilter.trim().toLowerCase();
  const addableCats = availGroups.filter(g => cell.allowedCategories[g] === undefined
    && (!filterText || g.toLowerCase().includes(filterText)));
  const emptyLabel = t('roomTypeEditor.slotCard.emptyCategory');
  const showEmptyChip = cell.allowedCategories[EMPTY_CATEGORY] === undefined
    && (!filterText || emptyLabel.toLowerCase().includes(filterText) || 'empty'.includes(filterText));

  const commitId = () => {
    const id = idDraft.trim().replace(/\s+/g, '_');
    if (!id || takenIds.has(id)) { setIdDraft(cell.id); return; }
    if (id !== cell.id) onRename(id);
  };

  const toggleCat = (cat: string) => {
    const next = { ...cell.allowedCategories };
    if (next[cat] !== undefined) delete next[cat]; else next[cat] = DEFAULT_WEIGHT;
    onChange({ allowedCategories: next });
  };

  return (
    <div className={s.inspectorBody}>
      <div className={s.inspectorTitle}>
        {cell.isAnchor && <span className={s.anchorStar}>★</span>}
        {cell.label || cell.id}
      </div>

      <label className={s.field}>
        <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.cellIdLabel')}</span>
        <input className={rs.slotSizeInput} style={{ width: 90, borderColor: idTaken ? '#a44' : undefined }}
          value={idDraft} onChange={e => setIdDraft(e.target.value)} onBlur={commitId}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      </label>
      <label className={s.field}>
        <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.labelLabel')}</span>
        <input className={rs.slotSizeInput} style={{ width: 140 }} value={cell.label}
          onChange={e => onChange({ label: e.target.value })} />
      </label>

      <div className={s.field}>
        <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.facingLabel')}</span>
        <div className={s.orientButtons}>
          {GRID_ORIENTS.map(o => (
            <button key={o} className={`${s.orientBtn} ${cell.orient === o ? s.orientBtnActive : ''}`}
              title={t(`roomTypeEditor.grids.facing.${o}`)}
              onClick={() => onChange({ orient: o })}>{ORIENT_ARROW[o]}</button>
          ))}
          <button className={s.orientBtn} title={t('roomTypeEditor.grids.rotateHint')} onClick={onRotate}>⟳</button>
        </div>
      </div>

      <div className={s.field} title={t('roomTypeEditor.grids.cornerHint')}>
        <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.cornerLabel')}</span>
        <div className={s.orientButtons}>
          <button className={`${s.orientBtn} ${!cell.cornerOrient ? s.orientBtnActive : ''}`}
            title={t('roomTypeEditor.grids.cornerNone')}
            onClick={() => onChange({ cornerOrient: '' })}>–</button>
          {GRID_CORNERS.map(c => (
            <button key={c} className={`${s.orientBtn} ${cell.cornerOrient === c ? s.orientBtnActive : ''}`}
              title={t(`roomTypeEditor.grids.corner.${c}`)}
              onClick={() => onChange({ cornerOrient: c })}>{CORNER_ARROW[c]}</button>
          ))}
        </div>
      </div>

      <div className={s.field}>
        <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.footprintLabel')}</span>
        <input type="number" min={1} max={MAX_GRID} className={rs.slotNumInput} value={cell.footprint.width}
          onChange={e => onResize(Math.max(1, +e.target.value || 1), cell.footprint.height)} />
        <span className={rs.slotHint}>×</span>
        <input type="number" min={1} max={MAX_GRID} className={rs.slotNumInput} value={cell.footprint.height}
          onChange={e => onResize(cell.footprint.width, Math.max(1, +e.target.value || 1))} />
      </div>

      <div className={rs.slotRow} style={{ gap: 8 }}>
        <label className={rs.slotCheck} title={t('roomTypeEditor.grids.anchorHint')}>
          <input type="radio" checked={cell.isAnchor} onChange={onSetAnchor} />
          ★ {t('roomTypeEditor.grids.anchorLabel')}
        </label>
        <label className={rs.slotCheck} title={t('roomTypeEditor.grids.cellRequiredHint')}>
          <input type="checkbox" checked={cell.required || cell.isAnchor} disabled={cell.isAnchor}
            onChange={e => onChange({ required: e.target.checked })} />
          {t('roomTypeEditor.grids.cellRequiredLabel')}
        </label>
        <label className={rs.slotCheck} title={t('roomTypeEditor.grids.allowStackingHint', { key: cell.id })}>
          <input type="checkbox" checked={cell.allowStacking} onChange={e => onChange({ allowStacking: e.target.checked })} />
          {t('roomTypeEditor.grids.allowStackingLabel')}
        </label>
        <label className={rs.slotCheck} title={t('roomTypeEditor.grids.againstWallHint')}>
          <input type="checkbox" checked={cell.againstWall} onChange={e => onChange({ againstWall: e.target.checked })} />
          {t('roomTypeEditor.grids.againstWallLabel')}
        </label>
        <label className={rs.slotCheck} title={t('roomTypeEditor.grids.edgePieceHint')}>
          <input type="checkbox" checked={cell.edgePiece} onChange={e => onChange({ edgePiece: e.target.checked })} />
          {t('roomTypeEditor.grids.edgePieceLabel')}
        </label>
        <label className={rs.slotCheck} title={t('roomTypeEditor.slotCard.blocksFrontCellTitle')}>
          <input type="checkbox" checked={cell.blocksFrontCell} onChange={e => onChange({ blocksFrontCell: e.target.checked })} />
          {t('roomTypeEditor.slotCard.blocksFrontCell')}
        </label>
      </div>

      <div className={s.field} style={{ alignItems: 'flex-start', flexDirection: 'column' }}>
        <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.categoriesLabel')}</span>
        {Object.entries(cell.allowedCategories).map(([cat, w]) => (
          <div key={cat} className={rs.slotRow} style={{ gap: 6 }}>
            <span className={`${rs.chip} ${rs.chipActive}`} onClick={() => toggleCat(cat)}
              title={cat === EMPTY_CATEGORY ? t('roomTypeEditor.grids.emptyCategoryHint') : undefined}
              style={cat === EMPTY_CATEGORY ? EMPTY_CHIP_STYLE : undefined}>
              {cat === EMPTY_CATEGORY ? t('roomTypeEditor.slotCard.emptyCategory') : cat} ✕
            </span>
            <input type="number" min={1} max={10} className={rs.slotNumInput} value={w}
              onChange={e => onChange({ allowedCategories: { ...cell.allowedCategories, [cat]: Math.max(1, Math.min(10, +e.target.value || 1)) } })} />
          </div>
        ))}
        <span className={s.linkBtn} onClick={() => setShowAllCats(v => !v)}>
          {showAllCats ? t('roomTypeEditor.grids.hideCategories') : t('roomTypeEditor.grids.addCategory')}
        </span>
        {showAllCats && (
          <>
            <input className={`${rs.slotSizeInput} ${s.catFilter}`} autoFocus value={catFilter}
              placeholder={t('roomTypeEditor.grids.filterCategories')}
              onChange={e => setCatFilter(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') setCatFilter('');
                // Enter adds the only remaining match.
                if (e.key === 'Enter' && addableCats.length === 1) { toggleCat(addableCats[0]); setCatFilter(''); }
              }} />
            <div className={rs.chipGroup} style={{ gap: 3, maxHeight: 140, overflowY: 'auto' }}>
              {showEmptyChip && (
                <span className={rs.chip} style={EMPTY_CHIP_STYLE} title={t('roomTypeEditor.grids.emptyCategoryHint')}
                  onClick={() => toggleCat(EMPTY_CATEGORY)}>
                  {t('roomTypeEditor.slotCard.emptyCategory')}
                </span>
              )}
              {addableCats.map(g => (
                <span key={g} className={rs.chip} onClick={() => toggleCat(g)}>{g}</span>
              ))}
              {addableCats.length === 0 && !showEmptyChip && (
                <span className={rs.slotHint}>{t('roomTypeEditor.grids.noCategoryMatch')}</span>
              )}
            </div>
          </>
        )}
        <ThemeSelector categories={Object.keys(cell.allowedCategories)} value={cell.allowedThemes}
          onChange={allowedThemes => onChange({ allowedThemes })} />
      </div>

      <label className={s.field}>
        <span className={rs.slotGroupLabel}>Layer</span>
        <select className={rs.slotSelect} value={cell.requiredLayer} onChange={e => onChange({ requiredLayer: e.target.value })}>
          <option value="">{t('roomTypeEditor.grids.anyLayer')}</option>
          {FURNITURE_LAYERS.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      </label>

      <label className={s.field} title={t('roomTypeEditor.grids.colorGroupHint')}>
        <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.colorGroupLabel')}</span>
        <input className={rs.slotSizeInput} style={{ width: 100 }} value={cell.colorGroupId}
          onChange={e => onChange({ colorGroupId: e.target.value })} />
      </label>
      <label className={s.field}>
        <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.tileGroupLabel')}</span>
        <input className={rs.slotSizeInput} style={{ width: 100 }} value={cell.tileGroupId}
          onChange={e => onChange({ tileGroupId: e.target.value })} />
        {cell.tileGroupId && (
          <label className={rs.slotCheck} title={t('roomTypeEditor.grids.strictMatchHint')}>
            <input type="checkbox" checked={cell.requireTileGroupMatch}
              onChange={e => onChange({ requireTileGroupMatch: e.target.checked })} />
            {t('roomTypeEditor.grids.strictMatch')}
          </label>
        )}
      </label>
      <label className={s.field}>
        <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.materialLabel')}</span>
        <input className={rs.slotSizeInput} style={{ width: 100 }} value={cell.materialGroupId}
          onChange={e => onChange({ materialGroupId: e.target.value })} />
      </label>
      <label className={s.field} title={t('roomTypeEditor.grids.anchorGroupHint')}>
        <span className={rs.slotGroupLabel}>{t('roomTypeEditor.grids.anchorGroupLabel')}</span>
        <input className={rs.slotSizeInput} style={{ width: 100 }} value={cell.anchorGroup}
          placeholder="counters"
          onChange={e => onChange({ anchorGroup: e.target.value.trim() })} />
      </label>

      <div className={rs.slotRow} style={{ gap: 6, marginTop: 4 }}>
        <button className={rs.addSlotBtn} onClick={onRepick}>🪑 {t('roomTypeEditor.grids.repick')}</button>
        <button className={rs.removeSlotBtn} style={{ marginLeft: 0 }} onClick={onDelete}>{t('roomTypeEditor.grids.deletePiece')}</button>
      </div>
    </div>
  );
}

/** Mini renders of the grid as the generator would try it: back edge on each wall, ± mirrored. */
function RotationPreview({ grid }: { grid: GridLayout }) {
  const { t } = useTranslation();
  const variants = [false, ...(grid.allowMirror ? [true] : [])].flatMap(mirror => [0, 1, 2, 3].map(rot => ({ rot, mirror })));
  const wallSides: Record<number, CSSProperties> = {
    0: { top: -3, left: 0, right: 0, height: 3 },
    1: { right: -3, top: 0, bottom: 0, width: 3 },
    2: { bottom: -3, left: 0, right: 0, height: 3 },
    3: { left: -3, top: 0, bottom: 0, width: 3 },
  };

  return (
    <div className={s.previewStrip}>
      <div className={rs.slotGroupLabel} style={{ width: '100%' }}>{t('roomTypeEditor.grids.previewTitle')}</div>
      {variants.map(({ rot, mirror }) => {
        const { w, h } = transformedGridSize(grid, rot);
        // Side edge (corner mode): local W edge, E when mirrored, rotated with the grid.
        const sideDir = transformGridOrient(mirror ? 'E' : 'W', rot, false);
        const sideIdx = { N: 0, E: 1, S: 2, W: 3 }[sideDir];
        return (
          <div key={`${rot}-${mirror}`} className={s.previewItem}>
            <div className={s.previewGrid} style={{ width: w * MINI_CELL, height: h * MINI_CELL }}>
              {grid.mode !== 'free' && <div className={s.previewWall} style={wallSides[rot]} />}
              {grid.mode === 'corner' && <div className={s.previewWall} style={wallSides[sideIdx]} />}
              {grid.keepClear.map(p => {
                const r = transformGridRect({ x: p.x, y: p.y, w: 1, h: 1 }, grid.width, grid.height, rot, mirror);
                return <div key={`k${p.x},${p.y}`} className={s.previewKeep}
                  style={{ left: r.x * MINI_CELL, top: r.y * MINI_CELL, width: MINI_CELL, height: MINI_CELL }} />;
              })}
              {grid.cells.map(c => {
                const r = transformGridRect(cellRect(c), grid.width, grid.height, rot, mirror);
                const o = transformGridOrient(c.orient, rot, mirror);
                const corner = transformGridCorner(c.cornerOrient, rot, mirror);
                const kind = c.isAnchor ? s.swAnchor : c.required ? s.swRequired : s.swOptional;
                return (
                  <div key={c.id} className={`${s.previewPiece} ${kind}`}
                    style={{ left: r.x * MINI_CELL, top: r.y * MINI_CELL, width: r.w * MINI_CELL, height: r.h * MINI_CELL }}
                    title={`${c.id} → ${corner || o}`}>
                    <span className={s.previewArrow}>{pieceArrow(o, corner)}</span>
                  </div>
                );
              })}
            </div>
            <div className={s.previewCaption}>
              {t('roomTypeEditor.grids.previewWall', { dir: ['N', 'E', 'S', 'W'][rot] })}{mirror ? ' ⇋' : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}
