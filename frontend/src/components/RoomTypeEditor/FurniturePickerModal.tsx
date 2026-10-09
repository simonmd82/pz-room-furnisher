import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RoomTypeSlot } from '../../types/roomTypes';
import { REQUIRED_PROPERTIES, FURNITURE_LAYERS } from '../../types/roomTypes';
import type { TileDefinition } from '../../types/tiles';
import { layoutCols, layoutRows } from '../../types/tiles';
import { getCachedTileCatalog, loadTileCatalog, spriteStyle as sheetSpriteStyle } from '../../utils/tileCatalog';
import s from './FurniturePickerModal.module.css';

const THUMB_ZOOM = 0.35;
const DEFAULT_WEIGHT = 5;

/** One card = one physical object: all definitions sharing a variantGroup (N/S/E/W variants). */
interface PickerEntry {
  key: string;
  defs: TileDefinition[];
  label: string;
}

type Warning = 'layerConflict' | 'footprintConflict';

/**
 * Derives the slot patch from the selected furniture.
 * - requiredProperties: flags true on ALL selected pieces (replaces existing)
 * - requiredLayer:      shared layer; untouched if pieces disagree
 * - allowedCategories:  existing kept, each new group added with default weight
 * - footprint:          shared W×H (rotations count as equal); untouched if pieces disagree
 */
export function computeSlotPatch(defs: TileDefinition[], slot: RoomTypeSlot): { patch: Partial<RoomTypeSlot>; warnings: Warning[] } {
  const patch: Partial<RoomTypeSlot> = {};
  const warnings: Warning[] = [];
  if (defs.length === 0) return { patch, warnings };

  patch.requiredProperties = REQUIRED_PROPERTIES.filter(p => defs.every(d => d[p]));

  const layers = new Set(defs.map(d => d.layer).filter(Boolean));
  if (layers.size === 1) patch.requiredLayer = [...layers][0];
  else if (layers.size > 1) warnings.push('layerConflict');

  const cats = { ...slot.allowedCategories };
  let catsChanged = false;
  for (const d of defs) {
    if (d.group && cats[d.group] === undefined) { cats[d.group] = DEFAULT_WEIGHT; catsChanged = true; }
  }
  if (catsChanged) patch.allowedCategories = cats;

  const shapes = new Set(defs.map(d => {
    const w = layoutCols(d), h = layoutRows(d);
    return `${Math.min(w, h)}x${Math.max(w, h)}`;
  }));
  if (shapes.size === 1) {
    // Keep the slot's current orientation if it already has this shape, else take the first piece's.
    const w = layoutCols(defs[0]), h = layoutRows(defs[0]);
    const sameAsSlot = (slot.footprint.width === h && slot.footprint.height === w);
    patch.footprint = {
      width:  sameAsSlot ? h : w,
      height: sameAsSlot ? w : h,
      canRotate: w !== h,
    };
  } else {
    warnings.push('footprintConflict');
  }
  return { patch, warnings };
}

interface Props {
  slot: RoomTypeSlot;
  /** defs = every tile definition of the selected pieces (all orientation variants). */
  onApply: (patch: Partial<RoomTypeSlot>, pieceCount: number, defs: TileDefinition[]) => void;
  onClose: () => void;
}

export function FurniturePickerModal({ slot, onApply, onClose }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState(getCachedTileCatalog);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [layerFilter, setLayerFilter] = useState('');
  const [fitFootprint, setFitFootprint] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    if (data) return;
    loadTileCatalog().then(setData).catch(e => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const entries = useMemo<PickerEntry[]>(() => {
    if (!data) return [];
    const map = new Map<string, TileDefinition[]>();
    for (const d of data.defs) {
      const key = d.variantGroup ? `vg:${d.variantGroup}` : `id:${d.id}`;
      const list = map.get(key);
      if (list) list.push(d); else map.set(key, [d]);
    }
    return [...map.entries()]
      .map(([key, defs]) => ({ key, defs, label: defs[0].label || defs[0].variantGroup || defs[0].tileId }))
      .sort((a, b) => (a.defs[0].group || '~').localeCompare(b.defs[0].group || '~') || a.label.localeCompare(b.label));
  }, [data]);

  const groups = useMemo(
    () => [...new Set(entries.flatMap(e => e.defs.map(d => d.group)).filter(Boolean))].sort(),
    [entries]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fw = slot.footprint.width, fh = slot.footprint.height;
    return entries.filter(e => e.defs.some(d =>
      (!q || [d.label, d.tileId, d.group, d.variantGroup].some(v => v?.toLowerCase().includes(q)))
      && (!groupFilter || d.group === groupFilter)
      && (!layerFilter || d.layer === layerFilter)
      && (!fitFootprint || (() => {
        const w = layoutCols(d), h = layoutRows(d);
        return (w === fw && h === fh) || (w === fh && h === fw);
      })())));
  }, [entries, search, groupFilter, layerFilter, fitFootprint, slot.footprint]);

  const selectedDefs = useMemo(
    () => entries.filter(e => selected.has(e.key)).flatMap(e => e.defs),
    [entries, selected]);

  const { patch, warnings } = useMemo(() => computeSlotPatch(selectedDefs, slot), [selectedDefs, slot]);

  const toggle = (key: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const spriteStyle = (tileId: string) => data ? sheetSpriteStyle(tileId, data.sheetCols, THUMB_ZOOM) : null;

  const newCats = patch.allowedCategories
    ? Object.keys(patch.allowedCategories).filter(c => slot.allowedCategories[c] === undefined)
    : [];

  return (
    <div className={s.overlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={s.modal} role="dialog" aria-modal="true">
        <div className={s.header}>
          <span className={s.title}>{t('roomTypeEditor.furniturePicker.title', { slot: slot.label || slot.id || '?' })}</span>
          <button className={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={s.filters}>
          <input ref={searchRef} className={s.search}
            placeholder={t('roomTypeEditor.furniturePicker.searchPlaceholder')}
            value={search} onChange={e => setSearch(e.target.value)} />
          <select className={s.select} value={groupFilter} onChange={e => setGroupFilter(e.target.value)}>
            <option value="">{t('roomTypeEditor.furniturePicker.allCategories')}</option>
            {groups.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <select className={s.select} value={layerFilter} onChange={e => setLayerFilter(e.target.value)}>
            <option value="">{t('roomTypeEditor.furniturePicker.allLayers')}</option>
            {FURNITURE_LAYERS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <label className={s.checkLabel}>
            <input type="checkbox" checked={fitFootprint} onChange={e => setFitFootprint(e.target.checked)} />
            {t('roomTypeEditor.furniturePicker.fitFootprint', { w: slot.footprint.width, h: slot.footprint.height })}
          </label>
        </div>

        <div className={s.grid}>
          {error && <div className={s.empty}>{error}</div>}
          {!data && !error && <div className={s.empty}>{t('roomTypeEditor.furniturePicker.loading')}</div>}
          {data && visible.length === 0 && <div className={s.empty}>{t('roomTypeEditor.furniturePicker.noResults')}</div>}
          {visible.map(e => {
            const d = e.defs[0];
            const css = spriteStyle(d.tileId);
            const flags = REQUIRED_PROPERTIES.filter(p => e.defs.every(x => x[p]));
            return (
              <div key={e.key}
                className={`${s.card} ${selected.has(e.key) ? s.cardSelected : ''}`}
                onClick={() => toggle(e.key)}
                title={e.defs.map(x => x.tileId).join('\n')}>
                <div className={s.thumb}>{css ? <div style={css} /> : <span className={s.noThumb}>?</span>}</div>
                <div className={s.cardBody}>
                  <div className={s.cardLabel}>{e.label}</div>
                  <div className={s.cardMeta}>
                    {d.group || '—'} · {d.layer || '—'} · {layoutCols(d)}×{layoutRows(d)}
                    {e.defs.length > 1 && <> · {t('roomTypeEditor.furniturePicker.variants', { count: e.defs.length })}</>}
                  </div>
                  <div className={s.flags}>
                    {flags.map(p => <span key={p} className={s.flag}>{t(`tileBrowser.properties.${p}`)}</span>)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className={s.footer}>
          <div className={s.preview}>
            {selectedDefs.length === 0
              ? <span className={s.muted}>{t('roomTypeEditor.furniturePicker.selectHint')}</span>
              : <>
                <span>{t('roomTypeEditor.furniturePicker.selectedCount', { count: selected.size })}</span>
                <span>
                  <b>{t('roomTypeEditor.slotCard.requiredPropertiesLabel')}:</b>{' '}
                  {patch.requiredProperties?.length
                    ? patch.requiredProperties.map(p => t(`tileBrowser.properties.${p}`)).join(', ')
                    : '—'}
                </span>
                {patch.requiredLayer && <span><b>Layer:</b> {patch.requiredLayer}</span>}
                {patch.footprint && <span><b>B×H:</b> {patch.footprint.width}×{patch.footprint.height}{patch.footprint.canRotate ? ' ⟲' : ''}</span>}
                {newCats.length > 0 && <span><b>+</b> {newCats.join(', ')}</span>}
                {warnings.map(w => <span key={w} className={s.warning}>⚠ {t(`roomTypeEditor.furniturePicker.${w}`)}</span>)}
              </>}
          </div>
          <div className={s.actions}>
            {selected.size > 0 && (
              <button className={s.secondaryBtn} onClick={() => setSelected(new Set())}>
                {t('roomTypeEditor.furniturePicker.clearSelection')}
              </button>
            )}
            <button className={s.secondaryBtn} onClick={onClose}>{t('roomTypeEditor.furniturePicker.cancel')}</button>
            <button className={s.applyBtn} disabled={selectedDefs.length === 0}
              onClick={() => onApply(patch, selected.size, selectedDefs)}>
              {t('roomTypeEditor.furniturePicker.apply')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
