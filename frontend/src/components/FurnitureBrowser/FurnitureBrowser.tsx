import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getBfPath, getBfGroups, getBfGroupDetail } from '../../api/bfApi';
import { getTileConfig, saveTileDefinition, sheetImageUrl, getSheets, getGroups } from '../../api/tilesApi';
import { getRoomTypeNames, getCategories, getMaterials, getColorNames, getThemes, getThemedCategories } from '../../api/settingsApi';
import type { BfGroupSummary, BfGroupDetail, BfEntryDto } from '../../types/bf';
import type { TileDefinition, TileConfigMap, TileProperty } from '../../types/tiles';
import { defaultDefinition, computeTileDefId, parseTileId, layoutCols, layoutRows, SHADES, shadeColor, STYLE_TAGS, TILE_PROPERTIES, isThemedCategory } from '../../types/tiles';
import { ConfigSetSelector } from '../ConfigSetSelector/ConfigSetSelector';
import { useActiveConfigSet } from '../../context/ActiveConfigSetContext';
import { useTileSettingsClipboard } from '../../context/TileSettingsClipboardContext';
import { CopyFromSetDialog } from '../CopyFromSetDialog/CopyFromSetDialog';
import { FURNITURE_LAYERS } from '../../types/roomTypes';
import { Spinner } from '../Spinner/Spinner';
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
  const { selectedSetId, sets } = useActiveConfigSet();

  // ── settings clipboard (shared with Tile Browser tab) ────────────────────
  const { clipboard, copiedFrom, copy: copyToClipboard, sourceSetId: clipboardSetId, omitted: clipboardOmitted } = useTileSettingsClipboard();
  const [clipboardFlash, setClipboardFlash] = useState<string | null>(null);
  const [copyFromOpen, setCopyFromOpen]     = useState(false);

  // ── property/layer highlight filter (independent of the config panel) ──
  const [highlightProps, setHighlightProps]   = useState<Set<TileProperty>>(new Set());
  const [highlightMode, setHighlightMode]     = useState<'AND' | 'OR'>('OR');
  const [highlightLayers, setHighlightLayers] = useState<Set<TileDefinition['layer']>>(new Set());

  const toggleHighlightProp = (p: TileProperty) => setHighlightProps(prev => {
    const next = new Set(prev);
    next.has(p) ? next.delete(p) : next.add(p);
    return next;
  });
  const toggleHighlightLayer = (l: TileDefinition['layer']) => setHighlightLayers(prev => {
    const next = new Set(prev);
    next.has(l) ? next.delete(l) : next.add(l);
    return next;
  });

  // Properties combine via the AND/OR toggle; layers are always any-of (a tile has one
  // layer, so "match all selected layers" would never match). The two categories combine
  // with AND between them, so picking a layer + a property narrows further.
  const matchesHighlight = (entryId: string): boolean => {
    const def = config[entryId];
    if (!def || (highlightProps.size === 0 && highlightLayers.size === 0)) return false;
    const propOk = highlightProps.size === 0 || (() => {
      const props = [...highlightProps];
      return highlightMode === 'AND' ? props.every(p => def[p]) : props.some(p => def[p]);
    })();
    const layerOk = highlightLayers.size === 0 || highlightLayers.has(def.layer);
    return propOk && layerOk;
  };

  // ── path (configured in Settings tab) ──────────────────────────────────
  const [pathInput, setPathInput] = useState('');
  const [pathOk, setPathOk]       = useState(false);
  const [backendOk, setBackendOk] = useState(true);

  // ── groups ────────────────────────────────────────────────────────────
  const [loading, setLoading]       = useState(false);
  const [groups, setGroups]         = useState<BfGroupSummary[]>([]);
  const [groupFilter, setGroupFilter] = useState('');
  const [configuredOnly, setConfiguredOnly] = useState(false);
  const [selGroup, setSelGroup]     = useState<BfGroupSummary | null>(null);

  // ── detail (lazy) ─────────────────────────────────────────────────────
  const [detail, setDetail]         = useState<BfGroupDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // ── entry preview zoom ──────────────────────────────────────────────────
  const [entryZoom, setEntryZoom] = useState(1);

  // ── multi-select & pending state ──────────────────────────────────────
  /** Ausgewählte Karten als "pieceIdx-entryIdx" */
  const [selKeys, setSelKeys]   = useState<string[]>([]);
  /** Alle geöffneten/geänderten Defs (keyed by computeTileDefId) – bleibt beim Gruppenwechsel erhalten */
  const [viewDefs, setViewDefs] = useState<Record<string, TileDefinition>>({});
  /** computeTileDefId-Werte mit ungespeicherten Änderungen */
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());

  // ── tile config (for "already imported" indicator) ────────────────────
  const [config, setConfig] = useState<TileConfigMap>({});
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'ok' | 'err' | 'noLayer'>('idle');
  /** sheet name → column count, loaded once for correct sprite positioning */
  const [sheetCols, setSheetCols] = useState<Record<string, number>>({});

  // ── room types (from settings) ────────────────────────────────────────────
  const [roomTypeList, setRoomTypeList] = useState<string[]>([]);

  // ── known categories (from settings) ──────────────────────────────────────
  const [knownCategories, setKnownCategories] = useState<string[]>([]);

  // ── groups already used on tiles, merged across every config set (global — not
  // scoped to selectedSetId) so switching sets never hides categories used elsewhere ──
  const [globalGroups, setGlobalGroups] = useState<string[]>([]);

  // ── known materials / colors (from settings) ───────────────────────────────
  const [materialList, setMaterialList] = useState<string[]>([]);
  const [colorList,    setColorList]    = useState<string[]>([]);
  const [themeList,    setThemeList]    = useState<string[]>([]);
  const [themedCats,   setThemedCats]   = useState<string[]>([]);

  // ── collapsible sections ──────────────────────────────────────────────────
  const [notesOpen, setNotesOpen]     = useState(false);
  const [spritesOpen, setSpritesOpen] = useState(false);

  // ── group selector ────────────────────────────────────────────────────
  const [extraGroups, setExtraGroups] = useState<string[]>([]);
  const [groupInput, setGroupInput]   = useState('');
  const [groupSearch, setGroupSearch] = useState('');

  const allGroups = useMemo(() => {
    const fromConfig = Object.values(config).map(d => d.group).filter(Boolean);
    const combined = [...knownCategories, ...globalGroups, ...fromConfig, ...extraGroups];
    const seen = new Set<string>();
    return combined.filter(g => { const l = g.toLowerCase(); if (seen.has(l)) return false; seen.add(l); return true; });
  }, [config, extraGroups, knownCategories, globalGroups]);

  // variantGroup value -> ids of tiles (in the saved config) using it, for the
  // "already in use" hint next to the Variant ID field. Reusing an id is intentional
  // (that's how variant groups work), so this is informational, not a validation error.
  const variantGroupUsage = useMemo(() => {
    const map = new Map<string, string[]>();
    Object.values(config).forEach(d => {
      if (!d.variantGroup) return;
      const ids = map.get(d.variantGroup) ?? [];
      ids.push(d.id);
      map.set(d.variantGroup, ids);
    });
    return map;
  }, [config]);

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

  const selIds = useMemo(() =>
    selKeys.map(k => {
      const e = keyToEntry[k]?.entry;
      return e ? computeTileDefId(e.rootTileId, e.tileLayout) : undefined;
    }).filter((id): id is string => !!id),
    [selKeys, keyToEntry]);

  const selDefs = useMemo(() =>
    selIds.map(id => viewDefs[id]).filter((d): d is TileDefinition => !!d),
    [selIds, viewDefs]);

  // ── position-ordered selection (piece/entry order, not click order) — used for
  // copy/paste so pasting onto a same-layout group maps entry-for-entry by position ──
  const selKeysOrdered = useMemo(() =>
    [...selKeys].sort((a, b) => {
      const [ap, ae] = a.split('-').map(Number);
      const [bp, be] = b.split('-').map(Number);
      return ap - bp || ae - be;
    }), [selKeys]);
  const selIdsOrdered = useMemo(() =>
    selKeysOrdered.map(k => {
      const e = keyToEntry[k]?.entry;
      return e ? computeTileDefId(e.rootTileId, e.tileLayout) : undefined;
    }).filter((id): id is string => !!id),
    [selKeysOrdered, keyToEntry]);
  const selDefsOrdered = useMemo(() =>
    selIdsOrdered.map(id => viewDefs[id]).filter((d): d is TileDefinition => !!d),
    [selIdsOrdered, viewDefs]);

  // ── init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    getBfPath()
      .then(r => { setPathInput(r.path); setPathOk(r.isValid); setBackendOk(true); })
      .catch(() => setBackendOk(false));
    getRoomTypeNames().then(setRoomTypeList).catch(console.error);
    getCategories().then(setKnownCategories).catch(console.error);
    getMaterials().then(setMaterialList).catch(console.error);
    getColorNames().then(setColorList).catch(console.error);
    getThemes().then(setThemeList).catch(console.error);
    getThemedCategories().then(setThemedCats).catch(console.error);
    getGroups().then(setGlobalGroups).catch(console.error);
  }, []);

  // Reload the raw config / sheet columns for whichever set is active whenever the selection changes.
  useEffect(() => {
    getTileConfig(selectedSetId).then(setConfig).catch(() => {});
  }, [selectedSetId]);

  useEffect(() => {
    getSheets(selectedSetId).then(r => {
      if (r.configured) {
        const map: Record<string, number> = {};
        r.sheets.forEach(sh => { map[sh.name] = sh.columns; });
        setSheetCols(map);
      }
    }).catch(() => {});
  }, [selectedSetId]);

  useEffect(() => {
    if (!pathOk) { setGroups([]); return; }
    setLoading(true);
    getBfGroups(selectedSetId)
      .then(r => setGroups(r.configured ? r.groups : []))
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, [pathOk, selectedSetId]);

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
    const key    = `${pi}-${ei}`;
    const rootId = entry.rootTileId;
    const id     = computeTileDefId(rootId, entry.tileLayout);

    setViewDefs(prev => {
      if (prev[id]) return prev;
      const existing = config[id];
      let def: TileDefinition;
      if (existing) {
        def = { ...existing };
      } else {
        def = defaultDefinition(rootId);
        def.id          = id;
        // entry.orient comes straight from Project Zomboid's own .bf file (already in PZ's
        // wall-side convention, not this tool's facing convention) — mark it as such so it
        // doesn't need to be hand-inverted after import.
        def.orientation = entry.orient as TileDefinition['orientation'];
        def.useFacingOrientation = false;
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
      selIds.forEach(id => { if (next[id]) next[id] = { ...next[id], [field]: value }; });
      return next;
    });
    setDirtyIds(prev => new Set([...prev, ...selIds]));
    setSaveState('idle');
  };

  const toggleArrayField = (field: keyof TileDefinition, val: string) => {
    const allHave = selDefs.every(d => ((d[field] as string[] | undefined) ?? []).includes(val));
    setViewDefs(prev => {
      const next = { ...prev };
      selDefs.forEach(def => {
        const cur     = (def[field] as string[] | undefined) ?? [];
        const updated = allHave ? cur.filter(x => x !== val) : cur.includes(val) ? cur : [...cur, val];
        next[def.id] = { ...next[def.id], [field]: updated };
      });
      return next;
    });
    setDirtyIds(prev => new Set([...prev, ...selIds]));
    setSaveState('idle');
  };

  // ── settings copy/paste ─────────────────────────────────────────────────
  /** Paste tooltip suffix: which set the clipboard came from and which fields were left out. */
  const clipboardOrigin = [
    clipboardSetId && clipboardSetId !== selectedSetId
      ? t('common.copyFromSet.fromSet', { set: sets.find(x => x.id === clipboardSetId)?.name ?? clipboardSetId }) : '',
    clipboardOmitted.length > 0
      ? t('common.copyFromSet.without', { fields: clipboardOmitted.map(f => t(`common.copyFromSet.field.${f}`)).join(', ') }) : '',
  ].filter(Boolean).join(' · ');
  const handleCopiedFromSet = (count: number) => {
    setClipboardFlash(count === 1 ? t('common.settingsCopied') : t('common.settingsCopiedMulti', { count }));
    setTimeout(() => setClipboardFlash(null), 2000);
  };

  const handleCopySettings = () => {
    if (selDefsOrdered.length === 0) return;
    copyToClipboard(selDefsOrdered);
    setClipboardFlash(selDefsOrdered.length === 1
      ? t('common.settingsCopied')
      : t('common.settingsCopiedMulti', { count: selDefsOrdered.length }));
    setTimeout(() => setClipboardFlash(null), 2000);
  };
  const handlePasteSettings = () => {
    if (!clipboard || selIds.length === 0) return;
    setViewDefs(prev => {
      const next = { ...prev };
      let prevPiece = -1;
      let pos = 0;
      selKeysOrdered.forEach((key, i) => {
        const piece = Number(key.split('-')[0]);
        if (piece !== prevPiece) { prevPiece = piece; pos = 0; }
        const id = selIdsOrdered[i];
        if (id && next[id]) next[id] = { ...next[id], ...clipboard[pos % clipboard.length] };
        pos++;
      });
      return next;
    });
    setDirtyIds(prev => new Set([...prev, ...selIds]));
    setSaveState('idle');
    setClipboardFlash(t('common.settingsPasted', { count: selIds.length }));
    setTimeout(() => setClipboardFlash(null), 2000);
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
    const toSave = [...dirtyIds].map(id => viewDefs[id]).filter((d): d is TileDefinition => !!d);
    if (toSave.some(d => !d.layer)) {
      setSaveState('noLayer');
      return;
    }
    setSaveState('saving');
    try {
      const saved: TileDefinition[] = [];
      for (const def of toSave) {
        saved.push(await saveTileDefinition(def, selectedSetId));
      }
      setConfig(prev => {
        const next = { ...prev };
        saved.forEach(def => { next[def.id] = def; });
        return next;
      });
      setDirtyIds(new Set());
      setSaveState('ok');
    } catch { setSaveState('err'); }
  };

  // ── helpers ───────────────────────────────────────────────────────────
  const filtered = groups.filter(g =>
    g.label.toLowerCase().includes(groupFilter.toLowerCase())
    && (!configuredOnly || g.configuredCount > 0));

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
      {/* ── Path status bar (path itself is configured in Settings) ── */}
      <div className={s.pathBar}>
        {!backendOk ? (
          <span className={s.statusErr} style={{ flex: 1 }}>
            {t('furnitureBrowser.backendUnreachable')}
          </span>
        ) : pathOk ? (
          <>
            <span className={s.pathLabel}>BuildingFurniture.txt:</span>
            <span className={s.statusOk}>{pathInput}</span>
            <span className={s.statusOk}>— {t('furnitureBrowser.groupsLoaded', { count: groups.length })}</span>
          </>
        ) : (
          <span className={s.statusErr}>✗ {t('furnitureBrowser.setPathHint')}</span>
        )}
      </div>

      {/* ── Config set bar ── */}
      <ConfigSetSelector />

      {/* ── Group list ── */}
      <div className={s.groupPanel}>
        <div className={s.panelHeader}>
          <input
            className={s.searchInput}
            placeholder={t('furnitureBrowser.searchGroup')}
            value={groupFilter}
            onChange={e => setGroupFilter(e.target.value)}
          />
          <label className={s.checkRow}>
            <input type="checkbox" checked={configuredOnly}
              onChange={e => setConfiguredOnly(e.target.checked)} />
            {t('common.showConfiguredOnly')}
          </label>
        </div>
        <div className={s.groupList}>
          {loading && <p className={`${s.hint} ${s.hintRow}`}><Spinner /> {t('furnitureBrowser.loadingGroups')}</p>}
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
            <span style={{ marginLeft: 'auto', color: '#778' }}>{t('tileBrowser.zoom')}:</span>
            {[0.5, 1, 1.5, 2, 3].map(z => (
              <button
                key={z}
                className={`${s.zoomBtn} ${entryZoom === z ? s.zoomActive : ''}`}
                onClick={() => setEntryZoom(z)}
              >{z}×</button>
            ))}
          </div>
          {selGroup && (
            <div className={s.highlightBar}>
              <span className={s.fieldHint}>{t('common.highlightHint')}</span>
              {TILE_PROPERTIES.map(p => (
                <span
                  key={p}
                  className={`${s.chipHighlight} ${highlightProps.has(p) ? s.chipHighlightActive : ''}`}
                  onClick={() => toggleHighlightProp(p)}
                >{t(`tileBrowser.properties.${p}`)}</span>
              ))}
              {highlightProps.size > 0 && (
                <div className={s.modeToggle}>
                  <button
                    className={`${s.modeBtn} ${highlightMode === 'OR' ? s.modeBtnActive : ''}`}
                    onClick={() => setHighlightMode('OR')}
                  >{t('common.matchAny')}</button>
                  <button
                    className={`${s.modeBtn} ${highlightMode === 'AND' ? s.modeBtnActive : ''}`}
                    onClick={() => setHighlightMode('AND')}
                  >{t('common.matchAll')}</button>
                </div>
              )}
            </div>
          )}
          {selGroup && (
            <div className={s.highlightBar}>
              <span className={s.fieldHint}>{t('common.highlightLayersHint')}</span>
              {FURNITURE_LAYERS.map(l => (
                <span
                  key={l}
                  className={`${s.chipHighlight} ${highlightLayers.has(l) ? s.chipHighlightActive : ''}`}
                  onClick={() => toggleHighlightLayer(l)}
                >{l}</span>
              ))}
            </div>
          )}
        </div>
        <div className={s.pieceList}>
          {detailLoading && <p className={`${s.hint} ${s.hintRow}`}><Spinner /> {t('furnitureBrowser.loading')}</p>}
          {!selGroup && !detailLoading && (
            <p className={s.hint}>{t('furnitureBrowser.selectGroupHint')}</p>
          )}
          {detail && detail.pieces.map((piece, pi) => (
            <div key={pi} className={s.pieceBlock}>
              {piece.layer && <div className={s.pieceLayer}>{piece.layer}</div>}
              <div className={s.entryList}>
                {piece.entries.map((entry, ei) => {
                  const key      = `${pi}-${ei}`;
                  const entryId  = computeTileDefId(entry.rootTileId, entry.tileLayout);
                  const isActive = selKeys.includes(key);
                  const isDirty  = dirtyIds.has(entryId);
                  const imported = !isDirty && !!config[entryId];
                  const highlighted = matchesHighlight(entryId);
                  const cols = entry.tileLayout[0]?.length ?? 1;
                  const rows = entry.tileLayout.length;
                  return (
                    <div
                      key={ei}
                      className={[
                        s.entryCard,
                        isActive    ? s.entryCardActive    : '',
                        isDirty     ? s.entryCardDirty     : '',
                        highlighted ? s.entryCardHighlight : '',
                      ].filter(Boolean).join(' ')}
                      onClick={evt => handleEntryClick(pi, ei, entry, detail.label, piece.layer ?? undefined, evt)}
                    >
                      {/* Mini layout preview – tooltip = full tileId */}
                      <div
                        className={s.miniLayout}
                        style={{ gridTemplateColumns: `repeat(${cols}, ${Math.round(SPRITE_W * ENTRY_ZOOM * entryZoom)}px)` }}
                      >
                        {entry.tileLayout.flatMap((row, ri) =>
                          row.map((cellId, ci) => {
                            const cw = Math.round(SPRITE_W * ENTRY_ZOOM * entryZoom);
                            const ch = Math.round(SPRITE_H * ENTRY_ZOOM * entryZoom);
                            return (
                              <div
                                key={`${ri}-${ci}`}
                                className={`${s.miniCell} ${!cellId ? s.miniCellEmpty : ''}`}
                                style={{ width: cw, height: ch }}
                                title={cellId || t('furnitureBrowser.emptyCell', { row: ri, col: ci })}
                              >
                                {cellId && spriteStyle(cellId, ENTRY_ZOOM * entryZoom) ? (
                                  <div style={spriteStyle(cellId, ENTRY_ZOOM * entryZoom)!} />
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
                          {viewDefs[entryId]?.orientation || entry.orient}
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
              {selDefs.length === 1 && config[selDefs[0].id] && <span className={s.alreadyImported}>{t('furnitureBrowser.alreadyConfigured')}</span>}
              {dirtyIds.size > 0 && <span className={s.pendingBadge}>{dirtyIds.size} ✎</span>}
            </div>

            {/* Settings copy/paste */}
            <div className={s.clipboardBar}>
              <button
                className={s.browseBtn}
                disabled={selDefs.length === 0}
                title={selDefs.length === 1 ? selDefs[0].tileId : undefined}
                onClick={handleCopySettings}
              >{t('common.copySettings')}</button>
              <button
                className={s.browseBtn}
                title={t('common.copyFromSet.buttonHint')}
                onClick={() => setCopyFromOpen(true)}
              >{t('common.copyFromSet.button')}</button>
              <button
                className={s.browseBtn}
                disabled={!clipboard || selIds.length === 0}
                title={
                  clipboard && copiedFrom
                    ? (clipboard.length === 1
                      ? t('common.settingsCopiedHint', { tileId: copiedFrom[0] })
                      : t('common.settingsCopiedHintMulti', { count: clipboard.length }))
                      + (clipboardOrigin ? `
${clipboardOrigin}` : '')
                    : undefined
                }
                onClick={handlePasteSettings}
              >{selIds.length > 1 ? t('common.pasteSettings', { count: selIds.length }) : t('common.pasteSettingsEmpty')}</button>
              {clipboardFlash && <span className={s.clipboardFlash}>{clipboardFlash}</span>}
            </div>
            {copyFromOpen && (
              <CopyFromSetDialog
                currentSetId={selectedSetId}
                onClose={() => setCopyFromOpen(false)}
                onCopied={handleCopiedFromSet}
              />
            )}

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
              const q = groupSearch.trim().toLowerCase();
              const groupChips = allGroups
                .map(g => ({
                  g,
                  isActive:  !mixed && curVal === g,
                  isPartial:  mixed && selDefs.some(d => d.group === g),
                }))
                .filter(({ g, isActive, isPartial }) => isActive || isPartial || !q || g.toLowerCase().includes(q));
              return (
                <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
                  <span className={s.fieldLabel} style={mixed ? { color: '#bb8833' } : {}}>{t('tileBrowser.group')}{mixed ? ' ⚠' : ''}</span>
                  {allGroups.length > 8 && (
                    <input
                      className={s.fieldInput}
                      placeholder={t('common.searchGroupsPlaceholder')}
                      value={groupSearch}
                      onChange={e => setGroupSearch(e.target.value)}
                      style={{ width: '100%' }}
                    />
                  )}
                  <div className={s.chipGroup}>
                    {groupChips.map(({ g, isActive, isPartial }) => (
                      <span key={g}
                        className={`${s.chip} ${isActive ? s.chipActive : ''} ${isPartial ? s.chipPartial : ''}`}
                        onClick={() => applyField('group', g)}>{g}</span>
                    ))}
                    {groupChips.length === 0 && <span className={s.fieldHint}>{t('common.noGroupsMatch')}</span>}
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

            {/* Themes — only for themed categories (settings, e.g. Picture/Poster) */}
            {selDefs.some(d => isThemedCategory(d.group, themedCats)) && (
              <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
                <span className={s.fieldLabel}>{t('common.themes')}</span>
                <div className={s.chipGroup}>
                  {themeList.map(th => { const st = arrState(d => d.themes ?? [], th); return (
                    <span key={th} className={`${s.chip} ${st==='all'?s.chipActive:st==='some'?s.chipPartial:''}`}
                      onClick={() => toggleArrayField('themes', th)}>{th}</span>
                  ); })}
                </div>
                {themeList.length === 0 && (
                  <span style={{ fontSize: '0.75rem', color: '#888' }}>{t('common.noThemesConfigured')}</span>
                )}
              </div>
            )}

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
                    {(['N','S','E','W','NW','NE','SW','SE'] as const).map(o => <option key={o}>{o}</option>)}
                  </select>
                </div>
              );
            })()}

            {/* PZ-Editor-Konvention statt Blickrichtung */}
            {(() => {
              const mixed  = isMixed(d => d.useFacingOrientation);
              const curVal = sv(d => d.useFacingOrientation) as boolean | undefined;
              return (
                <label className={s.checkRow} style={mixed ? { color: '#bb8833' } : {}}>
                  <IndeterminateCheckbox checked={mixed ? false : (curVal ?? true)} indeterminate={mixed}
                    onChange={v => applyField('useFacingOrientation', v as TileDefinition['useFacingOrientation'])} />
                  {t('tileBrowser.useFacingOrientation')}{mixed ? ' ⚠' : ''}
                  <span className={s.fieldHint}> {t('tileBrowser.useFacingOrientationHint')}</span>
                </label>
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
              const mixed   = isMixed(d => d.layer);
              const curVal  = sv(d => d.layer);
              const missing = !mixed && !curVal;
              return (
                <div className={s.fieldRow}>
                  <span className={s.fieldLabel} style={mixed || missing ? { color: '#bb8833' } : {}}>{t('tileBrowser.layer')}{mixed ? ' ⚠' : missing ? ' *' : ''}</span>
                  <select className={s.fieldSelect} style={mixed ? mixStyle(mixed) : missing ? { borderColor: '#cc4444' } : {}}
                    value={mixed ? '__mixed__' : (curVal ?? '')}
                    onChange={e => { if (e.target.value !== '__mixed__') applyField('layer', e.target.value as TileDefinition['layer']); }}>
                    {mixed && <option value="__mixed__" disabled>{t('furnitureBrowser.mixedValues')}</option>}
                    <option value="">{t('tileBrowser.selectLayer')}</option>
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
                {colorList.map(c => {
                  const st = arrState(d => d.colors, c);
                  const shadeStates = SHADES.map(sh => arrState(d => d.colors, shadeColor(c, sh)));
                  const showShades = st !== 'none' || shadeStates.some(st2 => st2 !== 'none');
                  return (
                    <span key={c} className={s.colorSwatch}>
                      <span className={`${s.chip} ${st==='all'?s.chipActive:st==='some'?s.chipPartial:''}`}
                        onClick={() => toggleArrayField('colors', c)}>{c}</span>
                      {showShades && SHADES.map((sh, i) => (
                        <span key={sh} className={`${s.chip} ${s.chipShade} ${shadeStates[i]==='all'?s.chipActive:shadeStates[i]==='some'?s.chipPartial:''}`}
                          onClick={() => toggleArrayField('colors', shadeColor(c, sh))}>{t(`common.shade${sh}`)}</span>
                      ))}
                    </span>
                  );
                })}
              </div>
              {colorList.length === 0 && (
                <span style={{ fontSize: '0.75rem', color: '#888' }}>{t('common.noColorsConfigured')}</span>
              )}
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
              const otherCount = !mixed && curVal
                ? (variantGroupUsage.get(curVal) ?? []).filter(id => !selIds.includes(id)).length
                : 0;
              return (
                <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
                  <span className={s.fieldLabel} style={mixed ? { color: '#bb8833' } : {}}>{t('common.variantId')}{mixed ? ' ⚠' : ''}</span>
                  <input className={s.fieldInput}
                    placeholder={mixed ? t('furnitureBrowser.mixedValuesPlaceholder') : t('common.variantIdPlaceholder')}
                    value={mixed ? '' : (curVal ?? '')} style={mixStyle(mixed)}
                    onChange={e => applyField('variantGroup', e.target.value)} />
                  {otherCount > 0 && (
                    <span className={s.fieldHint}>ℹ {t('common.variantIdInUse', { count: otherCount })}</span>
                  )}
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
                {saveState === 'saving' ? <><Spinner /> {t('furnitureBrowser.saving')}</>
                 : saveState === 'ok'  ? t('furnitureBrowser.saved')
                 : saveState === 'err' ? t('furnitureBrowser.saveError')
                 : saveState === 'noLayer' ? t('furnitureBrowser.selectLayerRequired')
                 : dirtyIds.size > 0  ? t('furnitureBrowser.saveEntries', { count: dirtyIds.size })
                 : t('furnitureBrowser.noChanges')}
              </button>
              {saveState === 'noLayer' && (
                <p className={s.saveErrorHint}>{t('furnitureBrowser.selectLayerRequired')}</p>
              )}
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
