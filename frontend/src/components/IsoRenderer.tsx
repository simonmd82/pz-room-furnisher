import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Room } from '../types/building';
import type { TileSheetInfo } from '../types/tiles';
import { parseTileId } from '../types/tiles';
import type { IsoSprite } from '../utils/isoScene';
import { getSheetImage, isSheetFailed } from '../utils/sheetImageCache';
import styles from './GridRenderer.module.css';

// Geometry, in multiples of cellSize (= half a diamond's width). PZ 2x tiles are 128×256
// with the floor diamond (128×64) at the very bottom, so a sprite is 2 cells wide, 4 tall,
// and the diamond's top vertex sits 3 cells below the sprite's top edge.
/** Room above row 0 for full-height sprites (diamond top → sprite top). */
export const ISO_HEADROOM_CELLS = 3;
/** Cutaway stub height above the floor, in 2x sprite px. */
const CUT_H = 28;

/** Content size of the ISO scene for a grid of cols×rows cells (+1 for the S/E outline walls). */
export function isoContentSize(cols: number, rows: number, cellSize: number) {
  const span = cols + rows + 2;
  return { w: span * cellSize, h: span * cellSize / 2 + ISO_HEADROOM_CELLS * cellSize };
}

function toRgb(color: string, alpha = 1): string {
  const parts = color.trim().split(/\s+/);
  if (parts.length === 3) return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`;
  return `rgba(60,60,80,${alpha})`;
}

interface Props {
  sprites: IsoSprite[];
  sheetInfoMap: Map<string, TileSheetInfo>;
  cellSize: number;
  cols: number;
  rows: number;
  rooms: Room[];
  roomGrid: number[][];
  /** Open stairwell cells ("col,row"), painted black. */
  stairwell: Set<string>;
  scrollEl: HTMLDivElement | null;
  hiddenLayers: Set<string>;
  selectedRooms: Set<number>;
  cutaway: boolean;
}

export function IsoRenderer({
  sprites, sheetInfoMap, cellSize, cols, rows, rooms, roomGrid, stairwell, scrollEl,
  hiddenLayers, selectedRooms, cutaway,
}: Props) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ col: number; row: number; x: number; y: number } | null>(null);
  const [view, setView] = useState({ left: 0, top: 0, w: 0, h: 0 });

  const { w: contentW, h: contentH } = isoContentSize(cols, rows, cellSize);
  const originX = (rows + 1) * cellSize;
  const originY = ISO_HEADROOM_CELLS * cellSize;

  // Track the visible window of the scroll container; the canvas only ever covers that.
  useEffect(() => {
    if (!scrollEl) return;
    const update = () => setView({
      left: scrollEl.scrollLeft, top: scrollEl.scrollTop,
      w: scrollEl.clientWidth, h: scrollEl.clientHeight,
    });
    update();
    scrollEl.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(scrollEl);
    return () => { scrollEl.removeEventListener('scroll', update); ro.disconnect(); };
  }, [scrollEl]);

  // Canvas box clamped to the content, so it never extends the scrollable area.
  const canvasW = Math.max(0, Math.min(view.w, contentW));
  const canvasH = Math.max(0, Math.min(view.h, contentH));
  const canvasLeft = Math.max(0, Math.min(view.left, contentW - canvasW));
  const canvasTop  = Math.max(0, Math.min(view.top, contentH - canvasH));

  const missingTiles = useMemo(() => {
    let n = 0;
    for (const s of sprites) {
      const p = parseTileId(s.tile);
      if (!p || !sheetInfoMap.has(p.sheet)) n++;
    }
    return n;
  }, [sprites, sheetInfoMap]);

  const [loadTick, setLoadTick] = useState(0);
  const onSheetLoaded = useCallback(() => setLoadTick(n => n + 1), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasW === 0 || canvasH === 0) return;
    const raf = requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.round(canvasW * dpr), ph = Math.round(canvasH * dpr);
      if (canvas.width !== pw) canvas.width = pw;
      if (canvas.height !== ph) canvas.height = ph;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvasW, canvasH);
      // Content coords → canvas coords.
      ctx.translate(-canvasLeft, -canvasTop);
      const s = cellSize / 64;  // 2x sprite px → screen px
      ctx.imageSmoothingEnabled = s < 1;

      const hw = cellSize, hh = cellSize / 2;
      const top = (c: number, r: number) => ({ x: (c - r) * hw + originX, y: (c + r) * hh + originY });
      const diamond = (x: number, y: number) => {
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.lineTo(x + hw, y + hh); ctx.lineTo(x, y + 2 * hh); ctx.lineTo(x - hw, y + hh);
        ctx.closePath();
      };
      const viewL = canvasLeft - 2 * hw, viewR = canvasLeft + canvasW + 2 * hw;
      const viewT = canvasTop - 4 * cellSize, viewB = canvasTop + canvasH + cellSize;

      // Room-coloured base: shows the layout even where floor sprites are missing.
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const ri = roomGrid[r]?.[c] ?? 0;
          if (ri <= 0) continue;
          const p = top(c, r);
          if (p.x < viewL || p.x > viewR || p.y < viewT || p.y > viewB) continue;
          if (stairwell.has(`${c},${r}`)) {
            ctx.fillStyle = '#000';
            diamond(p.x, p.y);
            ctx.fill();
            continue;
          }
          // Skipped for dimmed rooms: under their half-transparent sprites it would tint the floor.
          if (selectedRooms.size > 0 && !selectedRooms.has(ri)) continue;
          ctx.fillStyle = toRgb(rooms[ri - 1]?.color ?? '', 0.55);
          diamond(p.x, p.y);
          ctx.fill();
        }

      for (const sp of sprites) {
        if (hiddenLayers.has(sp.layer)) continue;
        const p = top(sp.col, sp.row);
        if (p.x < viewL || p.x > viewR || p.y < viewT || p.y > viewB) continue;
        const parsed = parseTileId(sp.tile);
        if (!parsed) continue;
        const sheet = sheetInfoMap.get(parsed.sheet);
        if (!sheet || isSheetFailed(parsed.sheet)) continue;
        const img = getSheetImage(parsed.sheet, onSheetLoaded);
        if (!img) continue;

        const sw = sheet.spriteWidth || 128, sh = sheet.spriteHeight || 256;
        const sx = (parsed.index % sheet.columns) * sw;
        const sy = Math.floor(parsed.index / sheet.columns) * sh;
        const dx = p.x - hw, dy = p.y - ISO_HEADROOM_CELLS * cellSize;
        const dim = selectedRooms.size > 0 && !selectedRooms.has(sp.roomIdx);
        ctx.globalAlpha = dim ? 0.3 : 1;

        if (cutaway && sp.trimmable) {
          // Clip to the cell's diamond extruded upward by CUT_H, so the stub's top edge
          // runs parallel to the wall base instead of horizontally across the sprite.
          const H = CUT_H * s, pad = 3 * s;
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(p.x, p.y - H - pad);
          ctx.lineTo(p.x + hw + pad, p.y + hh - H);
          ctx.lineTo(p.x + hw + pad, p.y + 2 * hh + pad);
          ctx.lineTo(p.x - hw - pad, p.y + 2 * hh + pad);
          ctx.lineTo(p.x - hw - pad, p.y + hh - H);
          ctx.closePath();
          ctx.clip();
          ctx.drawImage(img, sx, sy, sw, sh, dx, dy, 2 * hw, 4 * cellSize);
          ctx.restore();
        } else {
          ctx.drawImage(img, sx, sy, sw, sh, dx, dy, 2 * hw, 4 * cellSize);
        }
      }
      ctx.globalAlpha = 1;

      if (hover) {
        const p = top(hover.col, hover.row);
        diamond(p.x, p.y);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [sprites, sheetInfoMap, cellSize, cols, rows, rooms, roomGrid, stairwell, hiddenLayers, selectedRooms, cutaway,
      canvasW, canvasH, canvasLeft, canvasTop, originX, originY, hover, loadTick, onSheetLoaded]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const el = contentRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const u = (x - originX) / cellSize;           // = c - r
    const v = (y - originY) / (cellSize / 2);     // = c + r
    const col = Math.floor((u + v) / 2), row = Math.floor((v - u) / 2);
    if (col < 0 || row < 0 || col > cols || row > rows) { setHover(null); return; }
    setHover(prev => prev && prev.col === col && prev.row === row && prev.x === x && prev.y === y
      ? prev : { col, row, x, y });
  }, [originX, originY, cellSize, cols, rows]);

  const hoverLines = useMemo(() => {
    if (!hover) return null;
    const ri = roomGrid[hover.row]?.[hover.col] ?? 0;
    const room = ri > 0 ? rooms[ri - 1] : null;
    const lines = [`[${hover.col},${hover.row}] ${room ? room.name : t('cell.outside')}`];
    for (const sp of sprites)
      if (sp.col === hover.col && sp.row === hover.row && !hiddenLayers.has(sp.layer))
        lines.push(`${sp.layer}: ${sp.tile}`);
    return lines;
  }, [hover, sprites, roomGrid, rooms, hiddenLayers, t]);

  return (
    <div
      ref={contentRef}
      className={styles.isoContent}
      style={{ width: contentW, height: contentH }}
      onMouseMove={onMouseMove}
      onMouseLeave={() => setHover(null)}
    >
      <canvas
        ref={canvasRef}
        className={styles.isoCanvas}
        style={{ left: canvasLeft, top: canvasTop, width: canvasW, height: canvasH }}
      />
      {hover && hoverLines && (
        <div
          className={styles.isoTooltip}
          style={{
            left: Math.min(hover.x + 14, canvasLeft + canvasW - 260),
            top: hover.y + 14,
          }}
        >
          {hoverLines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
      {missingTiles > 0 && (
        <div className={styles.isoNotice} style={{ left: canvasLeft + 8, top: canvasTop + canvasH - 30 }}>
          {t('gridRenderer.isoMissingTiles', { count: missingTiles })}
        </div>
      )}
    </div>
  );
}
