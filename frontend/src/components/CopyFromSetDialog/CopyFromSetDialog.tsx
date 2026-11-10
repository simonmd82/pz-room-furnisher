import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TileDefinition } from '../../types/tiles';
import { layoutCols, layoutRows } from '../../types/tiles';
import { getSheets, getTileConfig } from '../../api/tilesApi';
import { spriteStyle, facingOf } from '../../utils/tileCatalog';
import { useActiveConfigSet } from '../../context/ActiveConfigSetContext';
import {
  useTileSettingsClipboard, CROSS_SET_DEFAULT_OMIT, type CopyableField,
} from '../../context/TileSettingsClipboardContext';
import s from './CopyFromSetDialog.module.css';

const THUMB_ZOOM = 0.35;
const FACING_ORDER = ['N', 'E', 'S', 'W'];
/** Fields the user can choose to leave out; everything else in COPYABLE_FIELDS is always copied. */
const TOGGLEABLE_FIELDS: readonly CopyableField[] = ['variantGroup', 'colors', 'notes', 'orientation'];

/** One card = one physical object: all definitions sharing a variantGroup + shape (N/E/S/W variants). */
interface Entry {
  key: string;
  defs: TileDefinition[];
  label: string;
}

interface Props {
  /** Set currently being edited — cross-set copies leave out sprite-specific fields by default. */
  currentSetId: string;
  onClose: () => void;
  /** Called after copying, with the number of copied definitions. */
  onCopied: (count: number) => void;
}

/**
 * Picks tile definitions from any tile set and puts their settings on the shared clipboard,
 * so a new set can reuse e.g. vanilla bed/counter settings without switching the active set.
 * Pasting itself stays with the existing Paste button.
 */
export function CopyFromSetDialog({ currentSetId, onClose, onCopied }: Props) {
  const { t } = useTranslation();
  const { sets } = useActiveConfigSet();
  const { copy } = useTileSettingsClipboard();

  const [setId, setSetId] = useState(() =>
    currentSetId !== 'vanilla' ? 'vanilla' : (sets.find(x => x.id !== currentSetId)?.id ?? currentSetId));
  const [defs, setDefs] = useState<TileDefinition[] | null>(null);
  const [sheetCols, setSheetCols] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [roomFilter, setRoomFilter] = useState('');
  /** Selected def ids in click order — multi-copies paste positionally. */
  const [selected, setSelected] = useState<string[]>([]);
  const [omit, setOmit] = useState<Set<CopyableField>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Load the chosen set; reset selection and the field defaults (cross-set vs. same set).
  useEffect(() => {
    let cancelled = false;
    setDefs(null);
    setError(null);
    setSelected([]);
    setOmit(new Set(setId === currentSetId ? [] : CROSS_SET_DEFAULT_OMIT));
    Promise.all([getTileConfig(setId), getSheets(setId).catch(() => ({ configured: false, sheets: [] }))])
      .then(([cfg, sh]) => {
        if (cancelled) return;
        const cols: Record<string, number> = {};
        sh.sheets.forEach(x => { cols[x.name] = x.columns; });
        setSheetCols(cols);
        setDefs(Object.values(cfg));
      })
      .catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [setId, currentSetId]);

  const entries = useMemo<Entry[]>(() => {
    if (!defs) return [];
    const map = new Map<string, TileDefinition[]>();
    for (const d of defs) {
      const shape = [layoutCols(d), layoutRows(d)].sort((a, b) => a - b).join('x');
      const key = d.variantGroup ? `vg:${d.variantGroup}:${shape}` : `id:${d.id}`;
      const list = map.get(key);
      if (list) list.push(d); else map.set(key, [d]);
    }
    const facingRank = (d: TileDefinition) => {
      const i = FACING_ORDER.indexOf(facingOf(d));
      return i < 0 ? FACING_ORDER.length : i;
    };
    return [...map.entries()]
      .map(([key, list]) => ({
        key,
        defs: [...list].sort((a, b) => facingRank(a) - facingRank(b) || a.tileId.localeCompare(b.tileId)),
        label: list[0].label || list[0].variantGroup || list[0].tileId,
      }))
      .sort((a, b) => (a.defs[0].group || '~').localeCompare(b.defs[0].group || '~') || a.label.localeCompare(b.label));
  }, [defs]);

  const groups = useMemo(
    () => [...new Set(entries.flatMap(e => e.defs.map(d => d.group)).filter(Boolean))].sort(),
    [entries]);
  const roomTypes = useMemo(
    () => [...new Set(entries.flatMap(e => e.defs.flatMap(d => d.roomTypes ?? [])))].sort(),
    [entries]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter(e => e.defs.some(d =>
      (!q || [d.label, d.tileId, d.group, d.variantGroup].some(v => v?.toLowerCase().includes(q)))
      && (!groupFilter || d.group === groupFilter)
      && (!roomFilter || (d.roomTypes ?? []).includes(roomFilter))));
  }, [entries, search, groupFilter, roomFilter]);

  const byId = useMemo(() => new Map((defs ?? []).map(d => [d.id, d])), [defs]);

  const toggleDef = (id: string) => setSelected(prev =>
    prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  /** Card click: select all its variants in N/E/S/W order, or deselect them if all are selected. */
  const toggleEntry = (e: Entry) => setSelected(prev => {
    const ids = e.defs.map(d => d.id);
    return ids.every(id => prev.includes(id))
      ? prev.filter(x => !ids.includes(x))
      : [...prev, ...ids.filter(id => !prev.includes(id))];
  });

  const toggleOmit = (f: CopyableField) => setOmit(prev => {
    const next = new Set(prev);
    if (next.has(f)) next.delete(f); else next.add(f);
    return next;
  });

  const doCopy = () => {
    const picked = selected.map(id => byId.get(id)).filter((d): d is TileDefinition => !!d);
    if (picked.length === 0) return;
    copy(picked, { omit, sourceSetId: setId });
    onCopied(picked.length);
    onClose();
  };

  const setName = (id: string) => sets.find(x => x.id === id)?.name ?? id;

  return (
    <div className={s.overlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={s.modal} role="dialog" aria-modal="true" aria-labelledby="copy-from-set-title">
        <div className={s.header}>
          <span id="copy-from-set-title" className={s.title}>{t('common.copyFromSet.title')}</span>
          <button className={s.closeBtn} onClick={onClose} aria-label={t('common.copyFromSet.cancel')}>✕</button>
        </div>

        <div className={s.filters}>
          <label className={s.inline}>
            {t('common.copyFromSet.set')}
            <select className={s.select} value={setId} onChange={e => setSetId(e.target.value)}>
              {sets.map(x => (
                <option key={x.id} value={x.id}>
                  {x.name}{x.id === currentSetId ? ` (${t('common.copyFromSet.current')})` : ''}
                </option>
              ))}
            </select>
          </label>
          <input ref={searchRef} className={s.search}
            placeholder={t('common.copyFromSet.search')}
            value={search} onChange={e => setSearch(e.target.value)} />
          <select className={s.select} value={groupFilter} onChange={e => setGroupFilter(e.target.value)}>
            <option value="">{t('common.copyFromSet.allCategories')}</option>
            {groups.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <select className={s.select} value={roomFilter} onChange={e => setRoomFilter(e.target.value)}>
            <option value="">{t('common.copyFromSet.allRoomTypes')}</option>
            {roomTypes.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>

        <div className={s.grid}>
          {error && <div className={s.empty}>{error}</div>}
          {!error && !defs && <div className={s.empty}>{t('common.copyFromSet.loading')}</div>}
          {defs && visible.length === 0 && <div className={s.empty}>{t('common.copyFromSet.none')}</div>}
          {visible.map(e => {
            const allSel = e.defs.every(d => selected.includes(d.id));
            return (
              <div key={e.key} className={`${s.card} ${allSel ? s.cardSelected : ''}`}>
                <div className={s.cardHead} onClick={() => toggleEntry(e)} title={t('common.copyFromSet.selectAll')}>
                  <span className={s.cardLabel}>{e.label}</span>
                  <span className={s.cardMeta}>{[e.defs[0].group, e.defs[0].layer].filter(Boolean).join(' · ')}</span>
                </div>
                <div className={s.thumbs}>
                  {e.defs.map(d => {
                    const idx = selected.indexOf(d.id);
                    const st = spriteStyle(d.tileId, sheetCols, THUMB_ZOOM);
                    return (
                      <button
                        key={d.id}
                        type="button"
                        className={`${s.thumbBtn} ${idx >= 0 ? s.thumbSelected : ''}`}
                        onClick={() => toggleDef(d.id)}
                        title={d.tileId}
                      >
                        <span className={s.thumb}>{st ? <span style={st} /> : <span className={s.noThumb}>?</span>}</span>
                        <span className={s.facing}>{facingOf(d)}</span>
                        {idx >= 0 && <span className={s.order}>{idx + 1}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className={s.footer}>
          <div className={s.fields}>
            <span className={s.muted}>{t('common.copyFromSet.fields')}</span>
            {TOGGLEABLE_FIELDS.map(f => (
              <label key={f} className={s.checkLabel}>
                <input type="checkbox" checked={!omit.has(f)} onChange={() => toggleOmit(f)} />
                {t(`common.copyFromSet.field.${f}`)}
              </label>
            ))}
          </div>
          <span className={s.muted}>
            {selected.length > 1
              ? t('common.copyFromSet.orderHint', { count: selected.length })
              : setId !== currentSetId ? t('common.copyFromSet.fromSet', { set: setName(setId) }) : ''}
          </span>
          <div className={s.actions}>
            <button className={s.secondaryBtn} onClick={onClose}>{t('common.copyFromSet.cancel')}</button>
            <button className={s.applyBtn} disabled={selected.length === 0} onClick={doCopy}>
              {t('common.copyFromSet.copy', { count: selected.length })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
