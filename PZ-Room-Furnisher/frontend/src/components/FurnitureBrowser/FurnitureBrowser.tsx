import React, { useState, useEffect, useMemo, useRef } from 'react';

// Checkbox mit indeterminate-Support – muss AUSSERHALB der Hauptkomponente definiert sein
function IndeterminateCheckbox({ checked, indeterminate, onChange }: {
  checked: boolean; indeterminate: boolean; onChange: (v: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />;
}
import { getBfPath, setBfPath, getBfGroups, getBfGroupDetail } from '../../api/bfApi';
import { getTileConfig, saveTileDefinition, sheetImageUrl, getSheets } from '../../api/tilesApi';
import type { BfGroupSummary, BfGroupDetail, BfEntryDto } from '../../types/bf';
import type { TileDefinition, TileConfigMap, PlacementRules } from '../../types/tiles';
import { defaultDefinition, parseTileId, layoutCols, layoutRows, COLORS, ROOM_TYPES, STYLE_TAGS, PREDEFINED_GROUPS } from '../../types/tiles';
import { DirPicker } from '../TileBrowser/DirPicker';
import s from './FurnitureBrowser.module.css';

const SPRITE_W   = 128;
const SPRITE_H   = 256;
const ENTRY_ZOOM = 0.22; // tiny previews in entry list
const CONF_ZOOM  = 0.30; // config panel previews

export function FurnitureBrowser() {
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

  // ── group selector ────────────────────────────────────────────────────
  const [extraGroups, setExtraGroups] = useState<string[]>([]);
  const [groupInput, setGroupInput]   = useState('');

  const allGroups = useMemo(() => {
    const fromConfig = Object.values(config).map(d => d.group).filter(Boolean);
    const combined = [...PREDEFINED_GROUPS, ...fromConfig, ...extraGroups];
    const seen = new Set<string>();
    return combined.filter(g => { const l = g.toLowerCase(); if (seen.has(l)) return false; seen.add(l); return true; });
  }, [config, extraGroups]);

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
      setPathErr(e instanceof Error ? e.message : 'Fehler');
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

  const applyPlacementRule = (field: keyof PlacementRules, value: boolean) => {
    setViewDefs(prev => {
      const next = { ...prev };
      selRootIds.forEach(id => {
        if (next[id]) next[id] = { ...next[id], placementRules: { ...next[id].placementRules, [field]: value } };
      });
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
            ⚠ Backend nicht erreichbar
          </span>
        ) : (
          <>
            <span className={s.pathLabel}>BuildingFurniture.txt:</span>
            <input
              className={s.pathInput}
              value={pathInput}
              onChange={e => setPathInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && applyPath(pathInput)}
              placeholder="z.B. C:\Users\…\TileZed\BuildingFurniture.txt"
            />
            <button className={s.browseBtn} onClick={() => setShowPicker(true)} title="Datei suchen">📁</button>
            <button className={s.setBtn} onClick={() => applyPath(pathInput)}>Laden</button>
            {pathOk && <span className={s.statusOk}>✓ {groups.length} Gruppen geladen</span>}
            {pathErr && <span className={s.statusErr}>✗ {pathErr}</span>}
          </>
        )}
      </div>

      {/* ── Group list ── */}
      <div className={s.groupPanel}>
        <div className={s.panelHeader}>
          <input
            className={s.searchInput}
            placeholder="Gruppe suchen…"
            value={groupFilter}
            onChange={e => setGroupFilter(e.target.value)}
          />
        </div>
        <div className={s.groupList}>
          {loading && <p className={s.hint}>Lade Gruppen…</p>}
          {!loading && !pathOk && (
            <p className={s.hint}>Bitte BuildingFurniture.txt Pfad setzen.</p>
          )}
          {!loading && pathOk && filtered.length === 0 && (
            <p className={s.hint}>Keine Gruppen gefunden.</p>
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
            {selGroup ? selGroup.label : 'Gruppe wählen'}
          </span>
          <div className={s.pieceSubHeader}>
            {selKeys.length > 0 && <span className={s.selCount}>{selKeys.length} ausgewählt</span>}
            {dirtyIds.size > 0 && <span className={s.dirtyBadge}>{dirtyIds.size} ✎ ungespeichert</span>}
            <span className={s.ctrlHint}>Strg+Klick = Mehrfachauswahl</span>
          </div>
        </div>
        <div className={s.pieceList}>
          {detailLoading && <p className={s.hint}>Lade…</p>}
          {!selGroup && !detailLoading && (
            <p className={s.hint}>Eine Gruppe aus der Liste wählen.</p>
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
                                title={cellId || `[${ri},${ci}] leer`}
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
                        <span className={s.entryOrient}>{entry.orient}</span>
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
                : <span className={s.cfgTileId}>{selDefs.length} Einträge ausgewählt</span>}
              {selDefs.length === 1 && config[selDefs[0].tileId] && <span className={s.alreadyImported}>bereits konfiguriert</span>}
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
                            <div key={`${ri}-${ci}`} className={s.cfgCellWrap} title={cellId || `[${ri},${ci}] leer`}>
                              <div className={`${s.cfgCell} ${!cellId ? s.cfgCellEmptyBox : ''}`} style={{ width: cw, height: ch }}>
                                {cellId && spriteStyle(cellId, CONF_ZOOM) ? (
                                  <div style={spriteStyle(cellId, CONF_ZOOM)!} />
                                ) : (
                                  <span className={s.cfgCellEmpty}>—</span>
                                )}
                              </div>
                              <div className={s.cfgCellName} title={cellId || ''}>
                                {cellId || <span className={s.cfgCellNameEmpty}>leer</span>}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                    <p className={s.cfgLayoutDims}>{layoutCols(def)} × {layoutRows(def)} Zellen</p>
                  </div>
                  <div className={s.sectionTitle}>
                    Verwendete Sprites
                    <span className={s.spritesCount}> ({allIds.length} Zellen · {unique.length} eindeutig)</span>
                  </div>
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
                </>
              );
            })()}

            {/* ── Allgemein ── */}
            <div className={s.sectionTitle}>Allgemein</div>

            {selDefs.length === 1 && (
              <div className={s.fieldRow}>
                <span className={s.fieldLabel}>Bezeichnung</span>
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
                  <span className={s.fieldLabel} style={mixed ? { color: '#bb8833' } : {}}>Gruppe{mixed ? ' ⚠' : ''}</span>
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
                    <input className={s.fieldInput} placeholder="Neue Gruppe…" value={groupInput}
                      onChange={e => setGroupInput(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleAddGroup()}
                      style={{ flex: 1 }} />
                    <button className={s.browseBtn} onClick={handleAddGroup} title="Gruppe hinzufügen">＋</button>
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
                  <span className={s.fieldLabel} style={mixed ? { color: '#bb8833' } : {}}>Orientierung{mixed ? ' ⚠' : ''}</span>
                  <select className={s.fieldSelect} style={mixStyle(mixed)}
                    value={mixed ? '__mixed__' : (curVal ?? '')}
                    onChange={e => { if (e.target.value !== '__mixed__') applyField('orientation', e.target.value as TileDefinition['orientation']); }}>
                    {mixed && <option value="__mixed__" disabled>— Verschiedene —</option>}
                    <option value="">Beliebig (keine)</option>
                    {(['N','S','E','W'] as const).map(o => <option key={o}>{o}</option>)}
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
                  <span className={s.fieldLabel} style={mixed ? { color: '#bb8833' } : {}}>Layer{mixed ? ' ⚠' : ''}</span>
                  <select className={s.fieldSelect} style={mixStyle(mixed)}
                    value={mixed ? '__mixed__' : (curVal ?? 'Furniture')}
                    onChange={e => { if (e.target.value !== '__mixed__') applyField('layer', e.target.value as TileDefinition['layer']); }}>
                    {mixed && <option value="__mixed__" disabled>— Verschiedene —</option>}
                    <option>Furniture</option><option>Furniture2</option><option>Furniture3</option>
                    <option>Furniture4</option><option>Wallfurniture</option><option>Wallfurniture2</option>
                    <option>Wallfurniture3</option><option>Wallfurniture4</option>
                    <option>FloorOverlay</option><option>FloorFurniture</option>
                  </select>
                </div>
              );
            })()}

            {/* Höhe Chips */}
            <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
              <span className={s.fieldLabel}>Höhe</span>
              <div className={s.chipGroup}>
                {(['low','high'] as const).map(h => {
                  const st = arrState(d => d.height, h);
                  return (
                    <span key={h}
                      className={`${s.chip} ${st === 'all' ? s.chipActive : st === 'some' ? s.chipPartial : ''}`}
                      onClick={() => toggleArrayField('height', h)}>
                      {h === 'low' ? 'niedrig (low)' : 'hoch (high)'}
                    </span>
                  );
                })}
              </div>
            </div>

            {/* ── Eigenschaften ── */}
            <div className={s.sectionTitle}>Eigenschaften</div>
            {([
              ['blocksPathing', 'Blockiert Bewegung'],
              ['wallMounted',   'Wandmontiert'],
              ['canStack',      'Stapelbar'],
            ] as [keyof TileDefinition, string][]).map(([field, lbl]) => {
              const mixed  = isMixed(d => d[field]);
              const curVal = sv(d => d[field]) as boolean | undefined;
              return (
                <label key={field} className={s.checkRow} style={mixed ? { color: '#bb8833' } : {}}>
                  <IndeterminateCheckbox checked={mixed ? false : (curVal ?? false)} indeterminate={mixed}
                    onChange={v => applyField(field, v as TileDefinition[typeof field])} />
                  {lbl}{mixed ? ' ⚠' : ''}
                </label>
              );
            })}

            {/* ── Platzierungsregeln ── */}
            <div className={s.sectionTitle}>Platzierungsregeln</div>
            {([
              ['nearWall',   'Nahe Wand bevorzugt'],
              ['nearDoor',   'Nahe Tür bevorzugt'],
              ['nearWindow', 'Nahe Fenster bevorzugt'],
              ['centerRoom', 'Raummitte bevorzugt'],
              ['cornerOnly', 'Nur Ecken'],
            ] as [keyof PlacementRules, string][]).map(([field, lbl]) => {
              const mixed  = isMixed(d => d.placementRules[field]);
              const curVal = sv(d => d.placementRules[field]) as boolean | undefined;
              return (
                <label key={field} className={s.checkRow} style={mixed ? { color: '#bb8833' } : {}}>
                  <IndeterminateCheckbox checked={mixed ? false : (curVal ?? false)} indeterminate={mixed}
                    onChange={v => applyPlacementRule(field, v)} />
                  {lbl}{mixed ? ' ⚠' : ''}
                </label>
              );
            })}

            {selDefs.length === 1 && (
              <>
                <div className={s.sectionTitle}>Notizen</div>
                <textarea className={s.fieldInput} rows={2}
                  value={selDefs[0].notes}
                  onChange={e => applyField('notes', e.target.value)} />
              </>
            )}

            {/* ── Zufallsgenerator ── */}
            <div className={s.sectionTitle}>Zufallsgenerator</div>

            <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
              <span className={s.fieldLabel}>Farben</span>
              <div className={s.chipGroup}>
                {COLORS.map(c => { const st = arrState(d => d.colors, c); return (
                  <span key={c} className={`${s.chip} ${st==='all'?s.chipActive:st==='some'?s.chipPartial:''}`}
                    onClick={() => toggleArrayField('colors', c)}>{c}</span>
                ); })}
              </div>
            </div>

            <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
              <span className={s.fieldLabel}>Raumtypen</span>
              <div className={s.chipGroup}>
                {ROOM_TYPES.map(r => { const st = arrState(d => d.roomTypes, r); return (
                  <span key={r} className={`${s.chip} ${st==='all'?s.chipActive:st==='some'?s.chipPartial:''}`}
                    onClick={() => toggleArrayField('roomTypes', r)}>{r}</span>
                ); })}
              </div>
            </div>

            {(() => {
              const mixed  = isMixed(d => d.weight);
              const curVal = sv(d => d.weight) as number | undefined;
              return (
                <div className={s.fieldRow}>
                  <span className={s.fieldLabel} style={mixed ? { color: '#bb8833' } : {}}>
                    Gewichtung{mixed ? ' ⚠' : ''}
                  </span>
                  <input type="number" min={1} max={10}
                    className={s.fieldInputSmall}
                    value={mixed ? '' : (curVal ?? 5)}
                    placeholder={mixed ? '—' : ''} style={mixStyle(mixed)}
                    onChange={e => applyField('weight', Math.max(1, Math.min(10, Number(e.target.value))))} />
                  <span className={s.fieldHint}>1=selten · 10=häufig</span>
                </div>
              );
            })()}

            {(() => {
              const mixed  = isMixed(d => d.variantGroup);
              const curVal = sv(d => d.variantGroup);
              return (
                <div className={s.fieldRow}>
                  <span className={s.fieldLabel} style={mixed ? { color: '#bb8833' } : {}}>Varianten-ID{mixed ? ' ⚠' : ''}</span>
                  <input className={s.fieldInput}
                    placeholder={mixed ? '⚠ Verschiedene Werte' : 'z.B. sofa_brown'}
                    value={mixed ? '' : (curVal ?? '')} style={mixStyle(mixed)}
                    onChange={e => applyField('variantGroup', e.target.value)} />
                </div>
              );
            })()}

            <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
              <span className={s.fieldLabel}>Style-Tags <span className={s.fieldHint}>(noch nicht aktiv)</span></span>
              <div className={s.chipGroup}>
                {STYLE_TAGS.map(st => { const state = arrState(d => d.styleTags, st); return (
                  <span key={st} className={`${s.chip} ${state==='all'?s.chipActive:state==='some'?s.chipPartial:''}`}
                    onClick={() => toggleArrayField('styleTags', st)}>{st}</span>
                ); })}
              </div>
            </div>

            <button className={s.saveBtn}
              disabled={saveState === 'saving' || dirtyIds.size === 0}
              onClick={handleSave}>
              {saveState === 'saving' ? '⏳ Speichert…'
               : saveState === 'ok'  ? '✅ Gespeichert'
               : saveState === 'err' ? '❌ Fehler'
               : dirtyIds.size > 0  ? `💾 ${dirtyIds.size} Eintrag${dirtyIds.size !== 1 ? 'e' : ''} speichern`
               : '💾 Keine Änderungen'}
            </button>
            <p className={s.saveHint}>
              Speichert in <em>tile-definitions.json</em> – BuildingFurniture.txt bleibt unverändert.
            </p>
          </>
        ) : (
          <p className={s.hint} style={{ padding: 32 }}>
            Einen Eintrag aus der Liste wählen um ihn zu konfigurieren.<br />
            <span style={{ color: '#446', fontSize: '0.75rem' }}>Strg+Klick für Mehrfachauswahl</span>
          </p>
        )}
      </div>
    </div>
  );
}
