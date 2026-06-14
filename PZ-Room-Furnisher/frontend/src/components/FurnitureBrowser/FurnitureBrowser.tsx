import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getBfPath, setBfPath, getBfGroups, getBfGroupDetail } from '../../api/bfApi';
import { getTileConfig, saveTileDefinition, sheetImageUrl, getSheets } from '../../api/tilesApi';
import { getRoomTypeNames, getCategories, getMaterials } from '../../api/settingsApi';
import type { BfGroupSummary, BfGroupDetail, BfEntryDto } from '../../types/bf';
import type { TileDefinition, TileConfigMap } from '../../types/tiles';
import { defaultDefinition, parseTileId, layoutCols, layoutRows, COLORS, STYLE_TAGS, TILE_PROPERTIES } from '../../types/tiles';
import { DirPicker } from '../TileBrowser/DirPicker';
import s from './FurnitureBrowser.module.css';

// Checkbox mit indeterminate-Support – muss AUSSERHALB der Hauptkomponente definiert sein
function IndeterminateCheckbox({ checked, indeterminate, onChange }: {
  checked: boolean; indeterminate: boolean; onChange: (v: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />;
}

const SPRITE_W   = 128;
const SPRITE_H   = 256;
const ENTRY_ZOOM = 0.22; // tiny previews in entry list
const CONF_ZOOM  = 0.30; // config panel previews

export function FurnitureBrowser() {
  const { t } = useTranslation();

  // ── path ─────────────────────────────────────────────────────────────
  const [pathInput, setPathInput] = useState('');
  const [pathOk, setPathOk]       = useState(false);
  const [pathErr, setPathErr]     = useState('');
  const [backendOk, setBackendOk] = useState(true);
  const [showPicker, setShowPicker] = useState(false);

  // ── groups ────────────────────────────────────────────────────────────
  const [loading, setLoading]       = useState(false);
  const [groups, setGroups]         = useState<BfGroupSummary[]>([]);
  const [groupFilter, setGroupFilter] = useState('');
  const [selGroup, setSelGroup]     = useState<BfGroupSummary | null>(null);

  // ── detail (lazy) ─────────────────────────────────────────────────────
  const [detail, setDetail]         = useState<BfGroupDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // ── multi-select & pending state ──────────────────────────────────────
  /** Ausgewählte Karten als "pieceIdx-entryIdx" */
  const [selKeys, setSelKeys]   = useState<string[]>([]);
  /** Alle geöffneten/geänderten Defs – bleibt beim Gruppenwechsel erhalten */
  const [viewDefs, setViewDefs] = useState<Record<string, TileDefinition>>({});
  /** rootTileIds mit ungespeicherten Änderungen */
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());

  // ── tile config (for "already imported" indicator) ────────────────────
  const [config, setConfig] = useState<TileConfigMap>({});
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'ok' | 'err'>('idle');
  /** sheet name → column count, loaded once for correct sprite positioning */
  const [sheetCols, setSheetCols] = useState<Record<string, number>>({});

  // ── room types (from settings) ────────────────────────────────────────────
  const [roomTypeList, setRoomTypeList] = useState<string[]>([]);

  // ── known categories (from settings) ──────────────────────────────────────
  const [knownCategories, setKnownCategories] = useState<string[]>([]);

  // ── known materials (from settings) ───────────────────────────────────────
  const [materialList, setMaterialList] = useState<string[]>([]);

  // ── collapsible sections ──────────────────────────────────────────────────
  const [notesOpen, setNotesOpen]     = useState(false);
  const [spritesOpen, setSpritesOpen] = useState(false);

  // ── group selector ────────────────────────────────────────────────────
  const [extraGroups, setExtraGroups] = useState<string[]>([]);
  const [groupInput, setGroupInput]   = useState('');

  const allGroups = useMemo(() => {
    const fromConfig = Object.values(config).map(d => d.group).filter(Boolean);
    const combined = [...knownCategories, ...fromConfig, ...extraGroups];
    const seen = new Set<string>();
    return combined.filter(g => { const l = g.toLowerCase(); if (seen.has(l)) return false; seen.add(l); return true; });
  }, [config, extraGroups, knownCategories]);

  const handleAddGroup = () => {
    const trimmed = groupInput.trim();
    if (!trimmed) return;
    const existing = allGroups.find(g => g.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      applyField('group', existing);
    } else {
      setExtraGroups(prev => [...prev, trimmed]);
      applyField('group', trimmed);
    }
    setGroupInput('');
  };

  // ── key → entry map ────────────────────────────────────────────────────
  const keyToEntry = useMemo(() => {
    const map: Record<string, { entry: BfEntryDto; layer?: string }> = {};
    detail?.pieces.forEach((piece, pi) =>
      piece.entries.forEach((entry, ei) => {
        map[`${pi}-${ei}`] = { entry, layer: piece.layer ?? undefined };
      })
    );
    return map;
  }, [detail]);

  const selRootIds = useMemo(() =>
    selKeys.map(k => keyToEntry[k]?.entry.rootTileId).filter((id): id is string => !!id),
    [selKeys, keyToEntry]);

  const selDefs = useMemo(() =>
    selRootIds.map(id => viewDefs[id]).filter((d): d is TileDefinition => !!d),
    [selRootIds, viewDefs]);

  // ── init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    getBfPath()
      .then(r => { setPathInput(r.path); setPathOk(r.isValid); setBackendOk(true); })
      .catch(() => setBackendOk(false));
    getTileConfig().then(setConfig).catch(() => {});
    getRoomTypeNames().then(setRoomTypeList).catch(console.error);
    getCategories().then(setKnownCategories).catch(console.error);
    getMaterials().then(setMaterialList).catch(console.error);
    getSheets().then(r => {
      if (r.configured) {
        const map: Record<string, number> = {};
        r.sheets.forEach(sh => { map[sh.name] = sh.columns; });
        setSheetCols(map);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!pathOk) { setGroups([]); return; }
    setLoading(true);
    getBfGroups()
      .then(r => setGroups(r.configured ? r.groups : []))
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, [pathOk]);

  // ── path ─────────────────────────────────────────────────────────────
  const applyPath = async (p: string) => {
    setPathErr('');
    try {
      const r = await setBfPath(p);
      setPathInput(r.path);
      setPathOk(r.isValid);
    } catch (e) {
      setPathOk(false);
      setPathErr(e instanceof Error ? e.message : t('furnitureBrowser.pathError'));
    }
  };

  // ── group select ──────────────────────────────────────────────────────
  const handleGroupSelect = async (g: BfGroupSummary) => {
    setSelGroup(g);
    setDetail(null);
    setSelKeys([]);
    setDetailLoading(true);
    try {
      setDetail(await getBfGroupDetail(g.index));
    } finally {
      setDetailLoading(false);
    }
  };

  // ── entry click (Ctrl = multi-select) ─────────────────────────────────
  const handleEntryClick = (
    pi: number, ei: number, entry: BfEntryDto, groupLabel: string,
    layer?: string, evt?: React.MouseEvent
  ) => {
    const key = `${pi}-${ei}`;
    const id  = entry.rootTileId;

    setViewDefs(prev => {
      if (prev[id]) return prev;
      const existing = config[id];
      let def: TileDefinition;
      if (existing) {
        def = { ...existing };
      } else {
        def = defaultDefinition(id);
        def.orientation = entry.orient as TileDefinition['orientation'];
        def.tileLayout  = entry.tileLayout;
        def.group       = groupLabel;
        if (layer) def.layer = layer as TileDefinition['layer'];
      }
      return { ...prev, [id]: def };
    });

    if (evt?.ctrlKey || evt?.metaKey) {
      setSelKeys(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
    } else {
      setSelKeys([key]);
    }
    setSaveState('idle');
  };

  // ── field helpers ──────────────────────────────────────────────────────
  const applyField = <K extends keyof TileDefinition>(field: K, value: TileDefinition[K]) => {
    setViewDefs(prev => {
      const next = { ...prev };
      selRootIds.forEach(id => { if (next[id]) next[id] = { ...next[id], [field]: value }; });
      return next;
    });
    setDirtyIds(prev => new Set([...prev, ...selRootIds]));
    setSaveState('idle');
  };

  const toggleArrayField = (field: keyof TileDefinition, val: string) => {
    const allHave = selDefs.every(d => (d[field] as string[]).includes(val));
    setViewDefs(prev => {
      const next = { ...prev };
      selDefs.forEach(def => {
        const cur     = def[field] as string[];
        const updated = allHave ? cur.filter(x => x !== val) : cur.includes(val) ? cur : [...cur, val];
        next[def.tileId] = { ...next[def.tileId], [field]: updated };
      });
      return next;
    });
    setDirtyIds(prev => new Set([...prev, ...selRootIds]));
    setSaveState('idle');
  };

  // ── mixed-value helpers ────────────────────────────────────────────────
  function sv<T>(getter: (d: TileDefinition) => T): T | undefined {
    if (!selDefs.length) return undefined;
    const vals = selDefs.map(d => JSON.stringify(getter(d)));
    return vals.every(v => v === vals[0]) ? getter(selDefs[0]) : undefined;
  }
  const isMixed = (getter: (d: TileDefinition) => unknown): boolean => {
    if (selDefs.length < 2) return false;
    const vals = selDefs.map(d => JSON.stringify(getter(d)));
    return !vals.every(v => v === vals[0]);
  };
  const arrState = (getter: (d: TileDefinition) => string[], val: string): 'all' | 'some' | 'none' => {
    if (!selDefs.length) return 'none';
    const has = selDefs.map(d => getter(d).includes(val));
    return has.every(Boolean) ? 'all' : has.some(Boolean) ? 'some' : 'none';
  };
  const mixStyle = (mixed: boolean): React.CSSProperties =>
    mixed ? { borderColor: '#aa6600', color: '#bb8833' } : {};

  // ── save ALL dirty (sequenziell – verhindert gleichzeitige Datei-Schreibzugriffe) ──
  const handleSave = async () => {
    if (dirtyIds.size === 0) return;
    setSaveState('saving');
    try {
      const toSave = [...dirtyIds].map(id => viewDefs[id]).filter((d): d is TileDefinition => !!d);
      const saved: TileDefinition[] = [];
      for (const def of toSave) {
        saved.push(await saveTileDefinition(def));
      }
      setConfig(prev => {
        const next = { ...prev };
        saved.forEach(def => { next[def.tileId] = def; });
        return next;
      });
      setDirtyIds(new Set());
      setSaveState('ok');
    } catch { setSaveState('err'); }
  };

  // ── helpers ───────────────────────────────────────────────────────────
  const filtered = groups.filter(g =>
    g.label.toLowerCase().includes(groupFilter.toLowerCase()));

  /** Build CSS for a single sprite using actual sheet column count */
  const spriteStyle = (tileId: string, zoom: number): React.CSSProperties | null => {
    const p = parseTileId(tileId);
    if (!p) return null;
    const cols = sheetCols[p.sheet] ?? 8;
    const col  = p.index % cols;
    const row  = Math.floor(p.index / cols);
    return {
      width:  '100%',
      height: '100%',
      backgroundImage:    `url(${sheetImageUrl(p.sheet)})`,
      backgroundRepeat:   'no-repeat',
      backgroundSize:     `${Math.round(SPRITE_W * cols * zoom)}px auto`,
      backgroundPosition: `${-Math.round(col * SPRITE_W * zoom)}px ${-Math.round(row * SPRITE_H * zoom)}px`,
      imageRendering:     'pixelated',
    };
  };

  return (
    <div className={s.layout}>
      {showPicker && (
        <DirPicker
          onSelect={p => { setShowPicker(false); applyPath(p); }}
          onClose={() => setShowPicker(false)}
        />
      )}

      {/* ── Path bar ── */}
      <div className={s.pathBar}>
        {!backendOk ? (
          <span className={s.statusErr} style={{ flex: 1 }}>
            {t('furnitureBrowser.backendUnreachable')}
          </span>
        ) : (
          <>
            <span className={s.pathLabel}>BuildingFurniture.txt:</span>
            <input
              className={s.pathInput}
              value={pathInput}
              onChange={e => setPathInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && applyPath(pathInput)}
              placeholder={t('furnitureBrowser.pathPlaceholder')}
            />
            <button className={s.browseBtn} onClick={() => setShowPicker(true)} title={t('furnitureBrowser.browseFile')}>📁</button>
            <button className={s.setBtn} onClick={() => applyPath(pathInput)}>{t('furnitureBrowser.load')}</button>
            {pathOk && <span className={s.statusOk}>{t('furnitureBrowser.groupsLoaded', { count: groups.length })}</span>}
            {pathErr && <span className={s.statusErr}>✗ {pathErr}</span>}
          </>
        )}
      </div>

      {/* ── Group list ── */}
      <div className={s.groupPanel}>
        <div className={s.panelHeader}>
          <input
            className={s.searchInput}
            placeholder={t('furnitureBrowser.searchGroup')}
            value={groupFilter}
            onChange={e => setGroupFilter(e.target.value)}
          />
        </div>
        <div className={s.groupList}>
          {loading && <p className={s.hint}>{t('furnitureBrowser.loadingGroups')}</p>}
          {!loading && !pathOk && (
            <p className={s.hint}>{t('furnitureBrowser.setPathHint')}</p>
          )}
          {!loading && pathOk && filtered.length === 0 && (
            <p className={s.hint}>{t('furnitureBrowser.noGroups')}</p>
          )}
          {filtered.map(g => (
            <div
              key={g.index}
              className={`${s.groupItem} ${selGroup?.index === g.index ? s.groupItemActive : ''}`}
              onClick={() => handleGroupSelect(g)}
            >
              <span className={s.groupName}>{g.label}</span>
              <span className={s.groupBadge}>{g.pieceCount}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Pieces list ── */}
      <div className={s.piecePanel}>
        <div className={s.panelHeader}>
          <span className={s.panelTitle}>
            {selGroup ? selGroup.label : t('furnitureBrowser.selectGroup')}
          </span>
          <div className={s.pieceSubHeader}>
            {selKeys.length > 0 && <span className={s.selCount}>{t('furnitureBrowser.selectedCount', { count: selKeys.length })}</span>}
            {dirtyIds.size > 0 && <span className={s.dirtyBadge}>{t('furnitureBrowser.unsavedCount', { count: dirtyIds.size })}</span>}
            <span className={s.ctrlHint}>{t('furnitureBrowser.ctrlClickHint')}</span>
          </div>
        </div>
        <div className={s.pieceList}>
          {detailLoading && <p className={s.hint}>{t('furnitureBrowser.loading')}</p>}
          {!selGroup && !detailLoading && (
            <p className={s.hint}>{t('furnitureBrowser.selectGroupHint')}</p>
          )}
          {detail && detail.pieces.map((piece, pi) => (
            <div key={pi} className={s.pieceBlock}>
              {piece.layer && <div className={s.pieceLayer}>{piece.layer}</div>}
              <div className={s.entryList}>
                {piece.entries.map((entry, ei) => {
                  const key      = `${pi}-${ei}`;
                  const isActive = selKeys.includes(key);
                  const isDirty  = dirtyIds.has(entry.rootTileId);
                  const imported = !isDirty && !!config[entry.rootTileId];
                  const cols = entry.tileLayout[0]?.length ?? 1;
                  const rows = entry.tileLayout.length;
                  return (
                    <div
                      key={ei}
                      className={[s.entryCard, isActive ? s.entryCardActive : '', isDirty ? s.entryCardDirty : ''].filter(Boolean).join(' ')}
                      onClick={evt => handleEntryClick(pi, ei, entry, detail.label, piece.layer ?? undefined, evt)}
                    >
                      {/* Mini layout preview – tooltip = full tileId */}
                      <div
                        className={s.miniLayout}
                        style={{ gridTemplateColumns: `repeat(${cols}, ${Math.round(SPRITE_W * ENTRY_ZOOM)}px)` }}
                      >
                        {entry.tileLayout.flatMap((row, ri) =>
                          row.map((cellId, ci) => {
                            const cw = Math.round(SPRITE_W * ENTRY_ZOOM);
                            const ch = Math.round(SPRITE_H * ENTRY_ZOOM);
                            return (
                              <div
                                key={`${ri}-${ci}`}
                                className={`${s.miniCell} ${!cellId ? s.miniCellEmpty : ''}`}
                                style={{ width: cw, height: ch }}
                                title={cellId || t('furnitureBrowser.emptyCell', { row: ri, col: ci })}
                              >
                                {cellId && spriteStyle(cellId, ENTRY_ZOOM) ? (
                                  <div style={spriteStyle(cellId, ENTRY_ZOOM)!} />
                                ) : (
                                  <span style={{ fontSize: '0.45rem', color: '#446' }}>—</span>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>

                      <div className={s.entryMeta}>
                        <span className={s.entryOrient} title={t('furnitureBrowser.txtOrient', { orient: entry.orient })}>
                          {viewDefs[entry.rootTileId]?.orientation || entry.orient}
                        </span>
                        <span className={s.entryDims}>{cols}×{rows}</span>
                        <span className={s.entryRoot} title={entry.rootTileId}>
                           {entry.rootTileId.split('_').slice(-2).join('_')}
                        </span>
                        {isDirty  && <span className={s.dirtyDot}>✎</span>}
                        {imported && <span className={s.importedBadge}>✓</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Config / Edit panel ── */}
      <div className={s.configPanel}>
        {selDefs.length > 0 ? (
          <>
            {/* Header */}
            <div className={s.cfgHeader}>
              {selDefs.length === 1
                ? <span className={s.cfgTileId} title={selDefs[0].tileId}>{selDefs[0].tileId}</span>
                : <span className={s.cfgTileId}>{t('furnitureBrowser.entriesSelected', { count: selDefs.length })}</span>}
              {selDefs.length === 1 && config[selDefs[0].tileId] && <span className={s.alreadyImported}>{t('furnitureBrowser.alreadyConfigured')}</span>}
              {dirtyIds.size > 0 && <span className={s.pendingBadge}>{dirtyIds.size} ✎</span>}
            </div>

            {/* Layout preview + sprites – nur bei Einzelauswahl */}
            {selDefs.length === 1 && (() => {
              const def    = selDefs[0];
              const allIds = def.tileLayout.flat().filter(Boolean);
              const unique = [...new Set(allIds)].sort();
              return (
                <>
                  <div className={s.cfgLayoutPreview}>
                    <div style={{ display: 'inline-grid', gap: 4,
                      gridTemplateColumns: `repeat(${layoutCols(def)}, ${Math.round(SPRITE_W * CONF_ZOOM)}px)` }}>
                      {def.tileLayout.flatMap((row, ri) =>
                        row.map((cellId, ci) => {
                          const cw = Math.round(SPRITE_W * CONF_ZOOM);
                          const ch = Math.round(SPRITE_H * CONF_ZOOM);
                          return (
                            <div key={`${ri}-${ci}`} className={s.cfgCellWrap} title={cellId || t('furnitureBrowser.emptyCell', { row: ri, col: ci })}>
                              <div className={`${s.cfgCell} ${!cellId ? s.cfgCellEmptyBox : ''}`} style={{ width: cw, height: ch }}>
                                {cellId && spriteStyle(cellId, CONF_ZOOM) ? (
                                  <div style={spriteStyle(cellId, CONF_ZOOM)!} />
                                ) : (
                                  <span className={s.cfgCellEmpty}>—</span>
                                )}
                              </div>
                              <div className={s.cfgCellName} title={cellId || ''}>
                                {cellId || <span className={s.cfgCellNameEmpty}>{t('furnitureBrowser.empty')}</span>}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                    <p className={s.cfgLayoutDims}>{t('furnitureBrowser.cellsDims', { cols: layoutCols(def), rows: layoutRows(def) })}</p>
                  </div>
                  <div className={`${s.sectionTitle} ${s.collapsibleHeader}`} onClick={() => setSpritesOpen(v => !v)}>
                    <span>
                      {t('furnitureBrowser.usedSprites')}
                      <span className={s.spritesCount}> {t('furnitureBrowser.spritesCountInfo', { count: allIds.length, unique: unique.length })}</span>
                    </span>
                    <span className={`${s.collapseToggle} ${spritesOpen ? s.collapseToggleOpen : ''}`}>▶</span>
                  </div>
                  {spritesOpen && (
                    <div className={s.spritesList}>
                      {unique.map(id => (
                        <div key={id} className={s.spriteEntry} title={id}>
                          <span className={s.spriteEntryIcon}>
                            {(() => { const css = spriteStyle(id, 0.18);
                              return css ? <div style={{ ...css, width: Math.round(SPRITE_W*0.18), height: Math.round(SPRITE_H*0.18), flexShrink: 0 }} /> : null; })()}
                          </span>
                          <span className={s.spriteEntryId}>{id}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}

            {/* ── Allgemein ── */}
            <div className={s.sectionTitle}>{t('tileBrowser.basic')}</div>

            {selDefs.length === 1 && (
              <div className={s.fieldRow}>
                <span className={s.fieldLabel}>{t('tileBrowser.label')}</span>
                <input className={s.fieldInput} value={selDefs[0].label}
                  onChange={e => applyField('label', e.target.value)} />
              </div>
            )}

            {/* Gruppe */}
            {(() => {
              const mixed  = isMixed(d => d.group);
              const curVal = sv(d => d.group);
              return (
                <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
                  <span className={s.fieldLabel} style={mixed ? { color: '#bb8833' } : {}}>{t('tileBrowser.group')}{mixed ? ' ⚠' : ''}</span>
                  <div className={s.chipGroup}>
                    {allGroups.map(g => {
                      const isActive  = !mixed && curVal === g;
                      const isPartial =  mixed && selDefs.some(d => d.group === g);
                      return (
                        <span key={g}
                          className={`${s.chip} ${isActive ? s.chipActive : ''} ${isPartial ? s.chipPartial : ''}`}
                          onClick={() => applyField('group', g)}>{g}</span>
                      );
                    })}
                  </div>
                  <div style={{ display: 'flex', gap: 4, width: '100%' }}>
                    <input className={s.fieldInput} placeholder={t('common.newGroupPlaceholder')} value={groupInput}
                      onChange={e => setGroupInput(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleAddGroup()}
                      style={{ flex: 1 }} />
                    <button className={s.browseBtn} onClick={handleAddGroup} title={t('common.addGroup')}>＋</button>
                  </div>
                </div>
              );
            })()}

            {/* Orientierung */}
            {(() => {
              const mixed  = isMixed(d => d.orientation);
              const curVal = sv(d => d.orientation);
              return (
                <div className={s.fieldRow}>
                  <span className={s.fieldLabel} style={mixed ? { color: '#bb8833' } : {}}>{t('tileBrowser.orientation')}{mixed ? ' ⚠' : ''}</span>
                  <select className={s.fieldSelect} style={mixStyle(mixed)}
                    value={mixed ? '__mixed__' : (curVal ?? '')}
                    onChange={e => { if (e.target.value !== '__mixed__') applyField('orientation', e.target.value as TileDefinition['orientation']); }}>
                    {mixed && <option value="__mixed__" disabled>{t('furnitureBrowser.mixedValues')}</option>}
                    <option value="">{t('common.any')}</option>
                    {(['N','S','E','W'] as const).map(o => <option key={o}>{o}</option>)}
                  </select>
                </div>
              );
            })()}

            {/* Erlaubte Wandrichtungen */}
            <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
              <span className={s.fieldLabel}>{t('furnitureBrowser.allowedOrients')} <span className={s.fieldHint}>{t('furnitureBrowser.emptyMeansAll')}</span></span>
              <div className={s.chipGroup}>
                {(['N','S','E','W','NW','NE','SW','SE'] as const).map(o => {
                  const st = arrState(d => d.allowedOrients ?? [], o);
                  return (
                    <span key={o}
                      className={`${s.chip} ${st==='all'?s.chipActive:st==='some'?s.chipPartial:''}`}
                      onClick={() => toggleArrayField('allowedOrients', o)}>{o}</span>
                  );
                })}
              </div>
            </div>

            {/* Fenster-Sperrkante */}
            {(() => {
              const mixed  = isMixed(d => d.windowBlockedEdge ?? '');
              const curVal = sv(d => d.windowBlockedEdge ?? '');
              return (
                <div className={s.fieldRow}>
                  <span className={s.fieldLabel} style={mixed ? { color: '#bb8833' } : {}}>
                    {t('common.windowBlockedEdge')}{mixed ? ' ⚠' : ''}
                    <span
                      className={s.infoIcon}
                      title={t('common.windowBlockedEdgeInfo')}
                      aria-label={t('common.windowBlockedEdgeInfo')}
                    >ⓘ</span>
                  </span>
                  <select
                    className={s.fieldSelect}
                    style={mixStyle(mixed)}
                    value={mixed ? '__mixed__' : (curVal ?? '')}
                    onChange={e => {
                      if (e.target.value !== '__mixed__') {
                        applyField('windowBlockedEdge', e.target.value as TileDefinition['windowBlockedEdge']);
                      }
                    }}
                  >
                    {mixed && <option value="__mixed__" disabled>{t('furnitureBrowser.mixedValues')}</option>}
                    <option value="">{t('common.noneDefaultRule')}</option>
                    {(['N', 'E', 'S', 'W'] as const).map(edge => <option key={edge} value={edge}>{edge}</option>)}
                  </select>
                </div>
              );
            })()}

            {/* Layer */}
            {(() => {
              const mixed  = isMixed(d => d.layer);
              const curVal = sv(d => d.layer);
              return (
                <div className={s.fieldRow}>
                  <span className={s.fieldLabel} style={mixed ? { color: '#bb8833' } : {}}>{t('tileBrowser.layer')}{mixed ? ' ⚠' : ''}</span>
                  <select className={s.fieldSelect} style={mixStyle(mixed)}
                    value={mixed ? '__mixed__' : (curVal ?? 'Furniture')}
                    onChange={e => { if (e.target.value !== '__mixed__') applyField('layer', e.target.value as TileDefinition['layer']); }}>
                    {mixed && <option value="__mixed__" disabled>{t('furnitureBrowser.mixedValues')}</option>}
                    <option>Furniture</option><option>Furniture2</option><option>Furniture3</option>
                    <option>Furniture4</option><option>Wallfurniture</option><option>Wallfurniture2</option>
                    <option>Wallfurniture3</option><option>Wallfurniture4</option>
                    <option>FloorOverlay</option><option>FloorFurniture</option>
                  </select>
                </div>
              );
            })()}

            {/* ── Eigenschaften ── */}
            <div className={s.sectionTitle}>{t('tileBrowser.flags')}</div>
            {TILE_PROPERTIES.map(key => {
              const mixed  = isMixed(d => d[key]);
              const curVal = sv(d => d[key]) as boolean | undefined;
              return (
                <label key={key} className={s.checkRow} style={mixed ? { color: '#bb8833' } : {}}>
                  <IndeterminateCheckbox checked={mixed ? false : (curVal ?? false)} indeterminate={mixed}
                    onChange={v => applyField(key, v as TileDefinition[typeof key])} />
                  {t(`tileBrowser.properties.${key}`)}{mixed ? ' ⚠' : ''}
                </label>
              );
            })}

            {selDefs.length === 1 && (
              <>
                <div className={`${s.sectionTitle} ${s.collapsibleHeader}`} onClick={() => setNotesOpen(v => !v)}>
                  <span>{t('tileBrowser.notes')}</span>
                  <span className={`${s.collapseToggle} ${notesOpen ? s.collapseToggleOpen : ''}`}>▶</span>
                </div>
                {notesOpen && (
                  <textarea className={s.fieldInput} rows={2}
                    value={selDefs[0].notes}
                    onChange={e => applyField('notes', e.target.value)} />
                )}
              </>
            )}

            {/* ── Zufallsgenerator ── */}
            <div className={s.sectionTitle}>{t('common.randomizer')}</div>

            <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
              <span className={s.fieldLabel}>{t('common.colors')}</span>
              <div className={s.chipGroup}>
                {COLORS.map(c => { const st = arrState(d => d.colors, c); return (
                  <span key={c} className={`${s.chip} ${st==='all'?s.chipActive:st==='some'?s.chipPartial:''}`}
                    onClick={() => toggleArrayField('colors', c)}>{c}</span>
                ); })}
              </div>
            </div>

            {/* Materialien */}
            <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
              <span className={s.fieldLabel}>{t('common.materials')}</span>
              <div className={s.chipGroup}>
                {materialList.map(m => { const st = arrState(d => d.materials ?? [], m); return (
                  <span key={m} className={`${s.chip} ${st==='all'?s.chipActive:st==='some'?s.chipPartial:''}`}
                    onClick={() => toggleArrayField('materials', m)}>{m}</span>
                ); })}
              </div>
              {materialList.length === 0 && (
                <span style={{ fontSize: '0.75rem', color: '#888' }}>{t('common.noMaterialsConfigured')}</span>
              )}
            </div>

            <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
              <span className={s.fieldLabel}>{t('common.roomTypes')}</span>
              <div className={s.chipGroup}>
                {roomTypeList.map(r => { const st = arrState(d => d.roomTypes, r); return (
                  <span key={r} className={`${s.chip} ${st==='all'?s.chipActive:st==='some'?s.chipPartial:''}`}
                    onClick={() => toggleArrayField('roomTypes', r)}>{r}</span>
                ); })}
              </div>
            </div>



            {(() => {
              const mixed  = isMixed(d => d.variantGroup);
              const curVal = sv(d => d.variantGroup);
              return (
                <div className={s.fieldRow}>
                  <span className={s.fieldLabel} style={mixed ? { color: '#bb8833' } : {}}>{t('common.variantId')}{mixed ? ' ⚠' : ''}</span>
                  <input className={s.fieldInput}
                    placeholder={mixed ? t('furnitureBrowser.mixedValuesPlaceholder') : t('common.variantIdPlaceholder')}
                    value={mixed ? '' : (curVal ?? '')} style={mixStyle(mixed)}
                    onChange={e => applyField('variantGroup', e.target.value)} />
                </div>
              );
            })()}

            <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
              <span className={s.fieldLabel}>{t('common.styleTags')} <span className={s.fieldHint}>{t('furnitureBrowser.notYetActive')}</span></span>
              <div className={s.chipGroup}>
                {STYLE_TAGS.map(st => { const state = arrState(d => d.styleTags, st); return (
                  <span key={st} className={`${s.chip} ${state==='all'?s.chipActive:state==='some'?s.chipPartial:''}`}
                    onClick={() => toggleArrayField('styleTags', st)}>{st}</span>
                ); })}
              </div>
            </div>

            <div className={s.saveStickyBar}>
              <button className={s.saveBtn}
                disabled={saveState === 'saving' || dirtyIds.size === 0}
                onClick={handleSave}>
                {saveState === 'saving' ? t('furnitureBrowser.saving')
                 : saveState === 'ok'  ? t('furnitureBrowser.saved')
                 : saveState === 'err' ? t('furnitureBrowser.saveError')
                 : dirtyIds.size > 0  ? t('furnitureBrowser.saveEntries', { count: dirtyIds.size })
                 : t('furnitureBrowser.noChanges')}
              </button>
              <p className={s.saveHint}>
                {t('furnitureBrowser.saveHintPre')}<em>tile-definitions.json</em>{t('furnitureBrowser.saveHintPost')}
              </p>
            </div>
          </>
        ) : (
          <p className={s.hint} style={{ padding: 32 }}>
            {t('furnitureBrowser.selectEntryHint')}<br />
            <span style={{ color: '#446', fontSize: '0.75rem' }}>{t('furnitureBrowser.ctrlClickHint')}</span>
          </p>
        )}
      </div>
    </div>
  );
}
