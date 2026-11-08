import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TileUsageEntry, TileUsageRef } from '../../types/tiles';
import { layoutCols, layoutRows } from '../../types/tiles';
import { REQUIRED_PROPERTIES } from '../../types/roomTypes';
import { getTileUsage } from '../../api/tilesApi';
import { loadTileCatalog, spriteStyle } from '../../utils/tileCatalog';
import s from './TileUsage.module.css';

type UsageFilter = 'all' | 'unused' | 'via' | 'used';
type SortKey = 'id' | 'group' | 'layer' | 'set' | 'usage';

const THUMB_ZOOM = 0.25;
const PAGE = 300;

/** 'used' = matched directly by at least one slot, 'via' = only as a VariantGroup sibling. */
function usageState(e: TileUsageEntry): Exclude<UsageFilter, 'all'> {
  if (e.usage.length === 0) return 'unused';
  return e.usage.some(u => !u.viaVariantGroup) ? 'used' : 'via';
}

const roomTypesOf = (usage: TileUsageRef[]) => [...new Set(usage.map(u => u.roomType))].sort();

/**
 * Every tile definition with the room-type slots that can pick it (computed by the backend with
 * the generator's own slot filter), to find dead tile config.
 */
export function TileUsage() {
  const { t } = useTranslation();
  const [entries, setEntries]     = useState<TileUsageEntry[] | null>(null);
  const [error, setError]         = useState<string | null>(null);
  const [sheetCols, setSheetCols] = useState<Record<string, number>>({});

  const [search, setSearch]           = useState('');
  const [usageFilter, setUsageFilter] = useState<UsageFilter>('unused');
  const [groupFilter, setGroupFilter] = useState('');
  const [layerFilter, setLayerFilter] = useState('');
  const [roomFilter, setRoomFilter]   = useState('');
  const [setFilter, setSetFilter]     = useState('');
  const [sortKey, setSortKey]         = useState<SortKey>('group');
  const [sortDesc, setSortDesc]       = useState(false);
  const [expanded, setExpanded]       = useState<Set<string>>(new Set());
  const [limit, setLimit]             = useState(PAGE);

  const reload = () => {
    setError(null);
    setEntries(null);
    getTileUsage().then(setEntries).catch(e => setError(String(e)));
  };

  useEffect(() => {
    reload();
    loadTileCatalog().then(c => setSheetCols(c.sheetCols)).catch(() => {});
  }, []);

  useEffect(() => setLimit(PAGE), [search, usageFilter, groupFilter, layerFilter, roomFilter, setFilter]);

  const options = useMemo(() => {
    const groups = new Set<string>(), layers = new Set<string>(), rooms = new Set<string>(), sets = new Set<string>();
    for (const e of entries ?? []) {
      groups.add(e.tile.group);
      layers.add(e.tile.layer);
      sets.add(e.setId);
      e.usage.forEach(u => rooms.add(u.roomType));
    }
    const sorted = (x: Set<string>) => [...x].sort((a, b) => a.localeCompare(b));
    return { groups: sorted(groups), layers: sorted(layers), rooms: sorted(rooms), sets: sorted(sets) };
  }, [entries]);

  const counts = useMemo(() => {
    const c = { all: 0, unused: 0, via: 0, used: 0 };
    for (const e of entries ?? []) { c.all++; c[usageState(e)]++; }
    return c;
  }, [entries]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (entries ?? []).filter(e =>
      (usageFilter === 'all' || usageState(e) === usageFilter)
      && (!groupFilter || e.tile.group === groupFilter)
      && (!layerFilter || e.tile.layer === layerFilter)
      && (!setFilter || e.setId === setFilter)
      && (!roomFilter || e.usage.some(u => u.roomType === roomFilter))
      && (!q || e.tile.id.toLowerCase().includes(q)
             || e.tile.label.toLowerCase().includes(q)
             || (e.tile.variantGroup ?? '').toLowerCase().includes(q)));
    const key = (e: TileUsageEntry): string | number => {
      switch (sortKey) {
        case 'id':    return e.tile.id;
        case 'group': return `${e.tile.group}\u0000${e.tile.id}`;
        case 'layer': return `${e.tile.layer}\u0000${e.tile.id}`;
        case 'set':   return `${e.setId}\u0000${e.tile.id}`;
        case 'usage': return e.usage.length;
      }
    };
    list.sort((a, b) => {
      const ka = key(a), kb = key(b);
      const r = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb));
      return sortDesc ? -r : r;
    });
    return list;
  }, [entries, search, usageFilter, groupFilter, layerFilter, roomFilter, setFilter, sortKey, sortDesc]);

  const sortBy = (k: SortKey) => {
    if (k === sortKey) setSortDesc(d => !d);
    else { setSortKey(k); setSortDesc(false); }
  };
  const sortMark = (k: SortKey) => sortKey === k ? (sortDesc ? ' ▼' : ' ▲') : '';

  const toggleExpanded = (id: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const rowKey = (e: TileUsageEntry) => `${e.setId}/${e.tile.id}`;

  return (
    <div className={s.root}>
      <div className={s.filters}>
        <div className={s.usageTabs}>
          {(['unused', 'via', 'used', 'all'] as const).map(f => (
            <button key={f}
              className={`${s.usageTab} ${usageFilter === f ? s.usageTabActive : ''}`}
              title={t(`tileUsage.filter.${f}Hint`)}
              onClick={() => setUsageFilter(f)}>
              {t(`tileUsage.filter.${f}`)} ({counts[f]})
            </button>
          ))}
        </div>
        <input className={s.search} placeholder={t('tileUsage.searchPlaceholder')}
          value={search} onChange={e => setSearch(e.target.value)} />
        <select className={s.select} value={groupFilter} onChange={e => setGroupFilter(e.target.value)}>
          <option value="">{t('tileUsage.allGroups')}</option>
          {options.groups.map(g => <option key={g} value={g}>{g || t('tileUsage.none')}</option>)}
        </select>
        <select className={s.select} value={layerFilter} onChange={e => setLayerFilter(e.target.value)}>
          <option value="">{t('tileUsage.allLayers')}</option>
          {options.layers.map(l => <option key={l} value={l}>{l || t('tileUsage.none')}</option>)}
        </select>
        <select className={s.select} value={roomFilter} onChange={e => setRoomFilter(e.target.value)}>
          <option value="">{t('tileUsage.allRoomTypes')}</option>
          {options.rooms.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <select className={s.select} value={setFilter} onChange={e => setSetFilter(e.target.value)}>
          <option value="">{t('tileUsage.allSets')}</option>
          {options.sets.map(x => <option key={x} value={x}>{x}</option>)}
        </select>
        <button className={s.reloadBtn} onClick={reload}>⟳ {t('tileUsage.reload')}</button>
        <span className={s.count}>{t('tileUsage.resultCount', { count: visible.length })}</span>
      </div>

      <div className={s.tableWrap}>
        {error && <div className={s.empty}>{error}</div>}
        {!entries && !error && <div className={s.empty}>{t('tileUsage.loading')}</div>}
        {entries && visible.length === 0 && <div className={s.empty}>{t('tileUsage.noResults')}</div>}
        {entries && visible.length > 0 && (
          <table className={s.table}>
            <thead>
              <tr>
                <th />
                <th className={s.sortable} onClick={() => sortBy('id')}>{t('tileUsage.col.id')}{sortMark('id')}</th>
                <th className={s.sortable} onClick={() => sortBy('group')}>{t('tileUsage.col.group')}{sortMark('group')}</th>
                <th className={s.sortable} onClick={() => sortBy('layer')}>{t('tileUsage.col.layer')}{sortMark('layer')}</th>
                <th>{t('tileUsage.col.shape')}</th>
                <th>{t('tileUsage.col.properties')}</th>
                <th>{t('tileUsage.col.roomTypes')}</th>
                <th>{t('tileUsage.col.variantGroup')}</th>
                <th className={s.sortable} onClick={() => sortBy('set')}>{t('tileUsage.col.set')}{sortMark('set')}</th>
                <th className={s.sortable} onClick={() => sortBy('usage')}>{t('tileUsage.col.usage')}{sortMark('usage')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.slice(0, limit).map(e => {
                const d = e.tile;
                const key = rowKey(e);
                const css = spriteStyle(d.tileId, sheetCols, THUMB_ZOOM);
                const state = usageState(e);
                const isOpen = expanded.has(key);
                return (
                  <tr key={key} className={state === 'unused' ? s.rowUnused : undefined}>
                    <td><div className={s.thumb}>{css ? <div style={css} /> : <span className={s.muted}>?</span>}</div></td>
                    <td>
                      <div className={s.mono}>{d.id}</div>
                      {d.label && <div className={s.muted}>{d.label}</div>}
                    </td>
                    <td>{d.group || <span className={s.warn}>{t('tileUsage.none')}</span>}</td>
                    <td>{d.layer || <span className={s.warn}>{t('tileUsage.none')}</span>}</td>
                    <td className={s.nowrap}>{layoutCols(d)}×{layoutRows(d)}{d.orientation && <> · {d.orientation}</>}</td>
                    <td>
                      <div className={s.chips}>
                        {REQUIRED_PROPERTIES.filter(p => d[p]).map(p =>
                          <span key={p} className={s.chip}>{t(`tileBrowser.properties.${p}`)}</span>)}
                      </div>
                    </td>
                    <td>{d.roomTypes.length ? d.roomTypes.join(', ') : <span className={s.muted}>{t('tileUsage.anyRoom')}</span>}</td>
                    <td className={s.mono}>{d.variantGroup || <span className={s.muted}>—</span>}</td>
                    <td>
                      {e.setId}
                      {!e.setEnabled && <span className={s.muted}> ({t('tileUsage.setDisabled')})</span>}
                    </td>
                    <td className={s.usageCell}>
                      {state === 'unused'
                        ? <span className={s.badgeUnused}>{t('tileUsage.unused')}</span>
                        : <>
                          <button className={s.usageToggle} onClick={() => toggleExpanded(key)}>
                            {isOpen ? '▾' : '▸'} {roomTypesOf(e.usage).join(', ')}
                            <span className={s.muted}> ({e.usage.length})</span>
                            {state === 'via' && <span className={s.badgeVia}>{t('tileUsage.viaOnly')}</span>}
                          </button>
                          {isOpen && (
                            <ul className={s.refList}>
                              {e.usage.map(u => (
                                <li key={`${u.roomType}/${u.sourceId}`} className={u.viaVariantGroup ? s.refVia : undefined}>
                                  <b>{u.roomType}</b> › {u.label || u.sourceId}
                                  <span className={s.muted}> [{t(`tileUsage.source.${u.source}`)}{u.viaVariantGroup && ` · ${t('tileUsage.viaVariantGroup')}`}]</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {visible.length > limit && (
          <button className={s.moreBtn} onClick={() => setLimit(l => l + PAGE)}>
            {t('tileUsage.showMore', { shown: limit, total: visible.length })}
          </button>
        )}
      </div>
    </div>
  );
}
