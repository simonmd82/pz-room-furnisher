import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getTilesPath, getSheets, getTileConfig,
  saveTileDefinition, deleteTileDefinition, sheetImageUrl, exportConfigUrl,
} from '../../api/tilesApi';
import type { TileSheetInfo, TileDefinition, TileConfigMap, TileProperty } from '../../types/tiles';
import {
  makeTileId, defaultDefinition, parseTileId, computeTileDefId,
  layoutCols, layoutRows, COLORS, STYLE_TAGS,
  TILE_PROPERTIES,
} from '../../types/tiles';
import { getRoomTypeNames, getCategories, getMaterials } from '../../api/settingsApi';
import { FURNITURE_LAYERS } from '../../types/roomTypes';
import { ConfigSetSelector } from '../ConfigSetSelector/ConfigSetSelector';
import { useActiveConfigSet } from '../../context/ActiveConfigSetContext';
import { useTileSettingsClipboard } from '../../context/TileSettingsClipboardContext';
import s from './TileBrowser.module.css';

// Checkbox mit indeterminate-Support – muss AUSSERHALB der Hauptkomponente definiert sein
function IndeterminateCheckbox({ checked, indeterminate, onChange }: {
  checked: boolean; indeterminate: boolean; onChange: (v: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />;
}

const SPRITE_W = 128;
const SPRITE_H = 256;
/** Zoom factor used for the mini layout-cell previews in the config panel */
const LAYOUT_ZOOM = 0.28;

export function TileBrowser() {
  const { t } = useTranslation();

  // ── path (configured in Settings tab) ──────────────────────────────────
  const [pathInput, setPathInput] = useState('');
  const [pathOk, setPathOk]   = useState(false);
  const [backendOk, setBackendOk] = useState(true);

  // ── sheets ────────────────────────────────────────────────────────────
  const [sheets, setSheets]           = useState<TileSheetInfo[]>([]);
  const [sheetFilter, setSheetFilter] = useState('');
  const [active, setActive]           = useState<TileSheetInfo | null>(null);

  // ── config ────────────────────────────────────────────────────────────
  const [config, setConfig] = useState<TileConfigMap>({});

  // ── config sets (vanilla / mod packs) ───────────────────────────────────
  const { selectedSetId, reloadSets } = useActiveConfigSet();

  // ── settings clipboard (shared with Furniture Templates tab) ────────────
  const { clipboard, copiedFrom, copy: copyToClipboard } = useTileSettingsClipboard();
  const [clipboardFlash, setClipboardFlash] = useState<string | null>(null);

  // ── group selector ─────────────────────────────────────────────────────
  const [extraGroups, setExtraGroups] = useState<string[]>([]);
  const [groupInput, setGroupInput]   = useState('');
  const [groupSearch, setGroupSearch] = useState('');

  // ── known categories (from settings) ──────────────────────────────────────
  const [knownCategories, setKnownCategories] = useState<string[]>([]);

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

  // ── selection ─────────────────────────────────────────────────────────
  /** Sprite indices selected within the active sheet (Ctrl+Click = multi-select) */
  const [selIndices, setSelIndices] = useState<number[]>([]);
  /** All opened/edited defs – persists across sheet switches */
  const [viewDefs, setViewDefs] = useState<Record<string, TileDefinition>>({});
  /** tileIds with unsaved changes */
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'ok' | 'err'>('idle');
  const [notesOpen, setNotesOpen] = useState(false);
  /** Which layout cell is currently active for sprite assignment (null = none) */
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null);

  // ── composite-def resolution ─────────────────────────────────────────────
  /** root sprite tileId -> id of the multi-cell def rooted there (if any) */
  const compositeByRoot = useMemo(() => {
    const map = new Map<string, string>();
    Object.values(config).forEach(d => { if (d.id !== d.tileId) map.set(d.tileId, d.id); });
    return map;
  }, [config]);

  /**
   * Resolves a clicked sprite's tileId to the identity key of its existing definition.
   * A multi-cell def rooted at this sprite (e.g. one created from the Furniture Templates
   * tab) takes priority over a plain 1x1 match — a sprite shouldn't normally have both,
   * and if it does (leftover from before this resolution existed), the multi-cell one is
   * the more complete/authoritative entry to keep editing.
   */
  const resolveDefId = useCallback((spriteTileId: string): string =>
    compositeByRoot.get(spriteTileId) ?? spriteTileId,
  [compositeByRoot]);

  // ── derived selection ─────────────────────────────────────────────────
  const selTileIds = useMemo(() =>
    active ? selIndices.map(i => resolveDefId(makeTileId(active.name, i))) : [],
    [active, selIndices, resolveDefId]);

  const selDefs = useMemo(() =>
    selTileIds.map(id => viewDefs[id]).filter((d): d is TileDefinition => !!d),
    [selTileIds, viewDefs]);

  // ── field helpers ───────────────────────────────────────────────────────
  const applyField = <K extends keyof TileDefinition>(field: K, value: TileDefinition[K]) => {
    setViewDefs(prev => {
      const next = { ...prev };
      selTileIds.forEach(id => { if (next[id]) next[id] = { ...next[id], [field]: value }; });
      return next;
    });
    setDirtyIds(prev => new Set([...prev, ...selTileIds]));
    setSaveState('idle');
  };

  const toggleArrayField = (field: keyof TileDefinition, val: string) => {
    const allHave = selDefs.every(d => (d[field] as string[]).includes(val));
    setViewDefs(prev => {
      const next = { ...prev };
      selDefs.forEach(def => {
        const cur     = def[field] as string[];
        const updated = allHave ? cur.filter(x => x !== val) : cur.includes(val) ? cur : [...cur, val];
        next[def.id] = { ...next[def.id], [field]: updated };
      });
      return next;
    });
    setDirtyIds(prev => new Set([...prev, ...selTileIds]));
    setSaveState('idle');
  };

  // ── settings copy/paste ─────────────────────────────────────────────────
  const handleCopySettings = () => {
    if (selDefs.length !== 1) return;
    copyToClipboard(selDefs[0]);
    setClipboardFlash(t('common.settingsCopied'));
    setTimeout(() => setClipboardFlash(null), 2000);
  };
  const handlePasteSettings = () => {
    if (!clipboard || selTileIds.length === 0) return;
    setViewDefs(prev => {
      const next = { ...prev };
      selTileIds.forEach(id => { if (next[id]) next[id] = { ...next[id], ...clipboard }; });
      return next;
    });
    setDirtyIds(prev => new Set([...prev, ...selTileIds]));
    setSaveState('idle');
    setClipboardFlash(t('common.settingsPasted', { count: selTileIds.length }));
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

  // ── zoom ──────────────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(1);

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

  /** Saved def for a sprite, resolving through the composite-def root if needed */
  const getEffectiveDef = useCallback((tileId: string): TileDefinition | undefined => {
    if (config[tileId]) return config[tileId];
    const compositeId = compositeByRoot.get(tileId);
    return compositeId ? config[compositeId] : undefined;
  }, [config, compositeByRoot]);

  // Properties combine via the AND/OR toggle; layers are always any-of (a tile has one
  // layer, so "match all selected layers" would never match). The two categories combine
  // with AND between them, so picking a layer + a property narrows further.
  const matchesHighlight = useCallback((def: TileDefinition | undefined): boolean => {
    if (!def || (highlightProps.size === 0 && highlightLayers.size === 0)) return false;
    const propOk = highlightProps.size === 0 || (() => {
      const props = [...highlightProps];
      return highlightMode === 'AND' ? props.every(p => def[p]) : props.some(p => def[p]);
    })();
    const layerOk = highlightLayers.size === 0 || highlightLayers.has(def.layer);
    return propOk && layerOk;
  }, [highlightProps, highlightMode, highlightLayers]);

  // ── room types (from settings) ────────────────────────────────────────────
  const [roomTypeList, setRoomTypeList] = useState<string[]>([]);
  const [materialList, setMaterialList] = useState<string[]>([]);

  // ── init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    getTilesPath()
      .then(r => { setPathInput(r.path); setPathOk(r.isValid); setBackendOk(true); })
      .catch(() => setBackendOk(false));
    reloadSets();
    getRoomTypeNames().then(setRoomTypeList).catch(console.error);
    getCategories().then(setKnownCategories).catch(console.error);
    getMaterials().then(setMaterialList).catch(console.error);
  }, [reloadSets]);

  // Reload the raw config of whichever set is being edited whenever the selection changes.
  useEffect(() => {
    getTileConfig(selectedSetId)
      .then(setConfig)
      .catch(() => { /* ignore */ });
  }, [selectedSetId]);

  useEffect(() => {
    if (!pathOk) { setSheets([]); return; }
    getSheets(selectedSetId).then(r => setSheets(r.configured ? r.sheets : []));
  }, [pathOk, selectedSetId]);

  // ── sheet select ──────────────────────────────────────────────────────
  const handleSheetSelect = (sh: TileSheetInfo) => {
    setActive(sh);
    setSelIndices([]);
    setSelectedCell(null);
  };

  // ── sprite click (Ctrl = multi-select) ─────────────────────────────────
  const handleSprite = useCallback((idx: number, evt?: React.MouseEvent) => {
    if (!active) return;
    const spriteTileId = makeTileId(active.name, idx);

    // If exactly one sprite is being edited and a layout cell is selected → assign this sprite to that cell
    if (selectedCell && selIndices.length === 1) {
      const def = viewDefs[selTileIds[0]];
      if (def) {
        const next = def.tileLayout.map((row, ri) =>
          row.map((cell, ci) =>
            ri === selectedCell.row && ci === selectedCell.col ? spriteTileId : cell
          )
        );
        const updated = { ...def, tileLayout: next };
        setViewDefs(prev => ({ ...prev, [def.id]: updated }));
        setDirtyIds(prev => new Set([...prev, def.id]));
        setSaveState('idle');

        // Auto-advance selection to the next cell (right → next row → done)
        const cols = layoutCols(updated);
        const rows = layoutRows(updated);
        const nextCol = selectedCell.col + 1;
        if (nextCol < cols) {
          setSelectedCell({ row: selectedCell.row, col: nextCol });
        } else if (selectedCell.row + 1 < rows) {
          setSelectedCell({ row: selectedCell.row + 1, col: 0 });
        } else {
          setSelectedCell(null);
        }
      }
      return;
    }

    // Resolve to an existing def's identity (a plain match, or a multi-cell def rooted
    // at this sprite — e.g. saved from the Furniture Templates tab) and lazily seed
    // viewDefs for it, preserving any in-progress edit.
    const defId = resolveDefId(spriteTileId);
    setViewDefs(prev => {
      if (prev[defId]) return prev;
      return { ...prev, [defId]: config[defId] ? { ...config[defId] } : defaultDefinition(spriteTileId) };
    });

    if (evt?.ctrlKey || evt?.metaKey) {
      setSelIndices(prev => {
        const next = prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx];
        if (next.length !== 1) setSelectedCell(null);
        return next;
      });
    } else {
      setSelIndices([idx]);
      setSelectedCell(null);
    }
    setSaveState('idle');
  }, [active, config, selectedCell, selIndices, selTileIds, viewDefs, resolveDefId]);

  // ── layout manipulation (single-select only) ───────────────────────────
  const clearCell = (row: number, col: number) => {
    if (selDefs.length !== 1) return;
    const def = selDefs[0];
    const updated = {
      ...def,
      tileLayout: def.tileLayout.map((r, ri) =>
        r.map((c, ci) => ri === row && ci === col ? '' : c)
      ),
    };
    setViewDefs(prev => ({ ...prev, [def.id]: updated }));
    setDirtyIds(prev => new Set([...prev, def.id]));
    setSaveState('idle');
  };
  const addRow = () => {
    if (selDefs.length !== 1) return;
    const def = selDefs[0];
    const updated = { ...def, tileLayout: [...def.tileLayout, Array(layoutCols(def)).fill('')] };
    setViewDefs(prev => ({ ...prev, [def.id]: updated }));
    setDirtyIds(prev => new Set([...prev, def.id]));
    setSaveState('idle');
  };
  const removeRow = () => {
    if (selDefs.length !== 1 || layoutRows(selDefs[0]) <= 1) return;
    const def = selDefs[0];
    const updated = { ...def, tileLayout: def.tileLayout.slice(0, -1) };
    setViewDefs(prev => ({ ...prev, [def.id]: updated }));
    setDirtyIds(prev => new Set([...prev, def.id]));
    setSaveState('idle');
  };
  const addCol = () => {
    if (selDefs.length !== 1) return;
    const def = selDefs[0];
    const updated = { ...def, tileLayout: def.tileLayout.map(r => [...r, '']) };
    setViewDefs(prev => ({ ...prev, [def.id]: updated }));
    setDirtyIds(prev => new Set([...prev, def.id]));
    setSaveState('idle');
  };
  const removeCol = () => {
    if (selDefs.length !== 1 || layoutCols(selDefs[0]) <= 1) return;
    const def = selDefs[0];
    const updated = { ...def, tileLayout: def.tileLayout.map(r => r.slice(0, -1)) };
    setViewDefs(prev => ({ ...prev, [def.id]: updated }));
    setDirtyIds(prev => new Set([...prev, def.id]));
    setSaveState('idle');
  };

  const recomputeDefinedCounts = (next: TileConfigMap) => {
    setSheets(prev => prev.map(sh => ({
      ...sh,
      definedCount: Object.keys(next).filter(k => k.startsWith(sh.name + '_')).length,
    })));
  };

  // ── save ALL dirty (sequenziell – verhindert gleichzeitige Datei-Schreibzugriffe) ──
  // Recomputes each def's identity key from its current footprint before saving (same
  // convention as the Furniture Templates tab), and cleans up the old key if the
  // footprint changed shape since it was last saved.
  const handleSave = async () => {
    if (dirtyIds.size === 0) return;
    setSaveState('saving');
    try {
      const drafts = [...dirtyIds]
        .map(oldId => ({ oldId, def: viewDefs[oldId] }))
        .filter((e): e is { oldId: string; def: TileDefinition } => !!e.def);

      const nextConfig = { ...config };
      const viewUpdates: Record<string, TileDefinition> = {};
      const staleIds: string[] = [];

      for (const { oldId, def } of drafts) {
        const newId = computeTileDefId(def.tileId, def.tileLayout);
        const saved = await saveTileDefinition({ ...def, id: newId }, selectedSetId);
        if (newId !== oldId) {
          await deleteTileDefinition(oldId, selectedSetId);
          delete nextConfig[oldId];
          staleIds.push(oldId);
        }
        nextConfig[saved.id] = saved;
        viewUpdates[saved.id] = saved;
      }

      setConfig(nextConfig);
      recomputeDefinedCounts(nextConfig);
      setViewDefs(prev => {
        const next = { ...prev, ...viewUpdates };
        staleIds.forEach(id => delete next[id]);
        return next;
      });
      setDirtyIds(new Set());
      setSaveState('ok');
    } catch { setSaveState('err'); }
  };

  const handleDelete = async () => {
    if (selDefs.length !== 1) return;
    const def = selDefs[0];
    await deleteTileDefinition(def.id, selectedSetId);
    const next = { ...config };
    delete next[def.id];
    setConfig(next);
    recomputeDefinedCounts(next);
    setViewDefs(prev => {
      const nextViews = { ...prev };
      delete nextViews[def.id];
      nextViews[def.tileId] = defaultDefinition(def.tileId);
      return nextViews;
    });
    setDirtyIds(prev => { const nextDirty = new Set(prev); nextDirty.delete(def.id); return nextDirty; });
  };

  // ── helpers ───────────────────────────────────────────────────────────
  const filtered = sheets.filter(sh =>
    sh.name.toLowerCase().includes(sheetFilter.toLowerCase()));

  const previewBgPos = (active && selIndices.length === 1)
    ? `${-(selIndices[0] % active.columns) * SPRITE_W * zoom}px ${-Math.floor(selIndices[0] / active.columns) * SPRITE_H * zoom}px`
    : '0 0';

  return (
    <div className={s.layout}>

      {/* ── Path status bar (path itself is configured in Settings) ── */}
      <div className={s.pathBar}>
        {!backendOk ? (
          <span className={s.statusErr} style={{ flex: 1 }}>
            {t('tileBrowser.backendUnreachable')}
          </span>
        ) : pathOk ? (
          <>
            <span className={s.statusOk}>✓ {t('tileBrowser.tilesPath')}: {pathInput}</span>
            <span className={s.statusOk}>— {t('tileBrowser.sheetsCount', { count: sheets.length })}</span>
            <a className={s.exportLink} href={exportConfigUrl(selectedSetId)} download={`${selectedSetId}-tile-definitions.json`}>
              ⬇ {t('tileBrowser.export')}
            </a>
          </>
        ) : (
          <span className={s.statusErr}>✗ {t('tileBrowser.configurePath')}</span>
        )}
      </div>

      {/* ── Config set bar ── */}
      <ConfigSetSelector />

      {/* ── Sheet list ── */}
      <div className={s.sheetPanel}>
        <div className={s.sheetSearch}>
          <input
            className={s.sheetSearchInput}
            placeholder={t('tileBrowser.searchSheets')}
            value={sheetFilter}
            onChange={e => setSheetFilter(e.target.value)}
          />
        </div>
        <div className={s.sheetList}>
          {filtered.map(sh => (
            <div
              key={sh.name}
              className={`${s.sheetItem} ${active?.name === sh.name ? s.sheetItemActive : ''}`}
              onClick={() => handleSheetSelect(sh)}
            >
              <span className={s.sheetName}>{sh.name}</span>
              {sh.definedCount > 0 && (
                <span className={s.sheetBadge}>{sh.definedCount}/{sh.spriteCount}</span>
              )}
            </div>
          ))}
          {filtered.length === 0 && (
            <p className={s.emptyHint}>
              {pathOk ? t('tileBrowser.noSheets') : t('tileBrowser.configurePath')}
            </p>
          )}
        </div>
      </div>

      {/* ── Sheet viewer ── */}
      <div className={s.viewerPanel}>
        {active ? (
          <>
            <div className={s.viewerToolbar}>
              <span style={{ fontWeight: 600, color: '#ddf' }}>{active.name}</span>
              <span style={{ color: '#446' }}>|</span>
              <span>{active.spriteCount} Sprites · {active.columns}×{active.rows}</span>
              {selectedCell && (
                <span className={s.cellAssignHint}>
                  {t('tileBrowser.cellAssignHint', { row: selectedCell.row, col: selectedCell.col })}
                </span>
              )}
              {selIndices.length > 0 && <span className={s.selCount}>{t('tileBrowser.selectedCount', { count: selIndices.length })}</span>}
              {dirtyIds.size > 0 && <span className={s.dirtyBadge}>{t('tileBrowser.unsavedCount', { count: dirtyIds.size })}</span>}
              <span className={s.ctrlHint}>{t('tileBrowser.ctrlClickHint')}</span>
              <span style={{ marginLeft: 'auto', color: '#778' }}>{t('tileBrowser.zoom')}:</span>
              {[0.5, 1, 1.5, 2].map(z => (
                <button
                  key={z}
                  className={`${s.zoomBtn} ${zoom === z ? s.zoomActive : ''}`}
                  onClick={() => setZoom(z)}
                >{z}×</button>
              ))}
            </div>
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
            <div className={s.viewerScroll}>
              <div
                className={s.sheetWrap}
                style={{ width: active.sheetWidth * zoom, height: active.sheetHeight * zoom }}
              >
                <img
                  className={s.sheetImg}
                  src={sheetImageUrl(active.name)}
                  width={active.sheetWidth * zoom}
                  height={active.sheetHeight * zoom}
                  alt={active.name}
                  draggable={false}
                />
                <div
                  className={s.spriteOverlay}
                  style={{
                    gridTemplateColumns: `repeat(${active.columns}, ${SPRITE_W * zoom}px)`,
                    gridTemplateRows:    `repeat(${active.rows},    ${SPRITE_H * zoom}px)`,
                  }}
                >
                  {Array.from({ length: active.spriteCount }, (_, i) => {
                    const tileId     = makeTileId(active.name, i);
                    const defined    = !!config[tileId] || compositeByRoot.has(tileId);
                    const selected   = selIndices.includes(i);
                    const dirty      = dirtyIds.has(tileId);
                    const highlighted = matchesHighlight(getEffectiveDef(tileId));
                    return (
                      <div
                        key={i}
                        className={[
                          s.spriteCell,
                          defined     ? s.spriteDefined     : '',
                          selected    ? s.spriteSelected    : '',
                          dirty       ? s.spriteCellDirty   : '',
                          highlighted ? s.spriteHighlighted : '',
                          selectedCell ? s.spriteCellAssignMode : '',
                        ].join(' ')}
                        onClick={evt => handleSprite(i, evt)}
                        title={tileId}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        ) : (
          <p className={s.emptyHint}>
            {pathOk ? t('tileBrowser.selectSheet') : t('tileBrowser.configurePath')}
          </p>
        )}
      </div>

      {/* ── Config panel ── */}
      <div className={s.configPanel}>
        {selDefs.length > 0 && active ? (
          <>
            {/* Header */}
            <div className={s.cfgHeader}>
              {selDefs.length === 1
                ? <span className={s.cfgTileId} title={selDefs[0].tileId}>{selDefs[0].tileId}</span>
                : <span className={s.cfgTileId}>{t('tileBrowser.spritesSelected', { count: selDefs.length })}</span>}
              {selDefs.length === 1 && config[selDefs[0].id] && <span className={s.alreadyImported}>{t('tileBrowser.alreadyConfigured')}</span>}
              {dirtyIds.size > 0 && <span className={s.pendingBadge}>{dirtyIds.size} ✎</span>}
            </div>

            {/* Settings copy/paste */}
            <div className={s.clipboardBar}>
              <button
                className={s.layoutBtn}
                disabled={selDefs.length !== 1}
                title={selDefs.length === 1 ? selDefs[0].tileId : undefined}
                onClick={handleCopySettings}
              >{t('common.copySettings')}</button>
              <button
                className={s.layoutBtn}
                disabled={!clipboard || selTileIds.length === 0}
                title={clipboard && copiedFrom ? t('common.settingsCopiedHint', { tileId: copiedFrom }) : undefined}
                onClick={handlePasteSettings}
              >{selTileIds.length > 1 ? t('common.pasteSettings', { count: selTileIds.length }) : t('common.pasteSettingsEmpty')}</button>
              {clipboardFlash && <span className={s.clipboardFlash}>{clipboardFlash}</span>}
            </div>

            {/* Sprite preview (root tile) – single-select only */}
            {selIndices.length === 1 && (
              <div className={s.spritePreviewBox}>
                <div
                  className={s.spritePreviewDiv}
                  style={{
                    width:  SPRITE_W * zoom,
                    height: SPRITE_H * zoom,
                    backgroundImage: `url(${sheetImageUrl(active.name)})`,
                    backgroundRepeat: 'no-repeat',
                    backgroundSize: `${active.sheetWidth * zoom}px ${active.sheetHeight * zoom}px`,
                    backgroundPosition: previewBgPos,
                  }}
                />
                <p className={s.previewTileId}>{selDefs[0].tileId}</p>
              </div>
            )}

            {/* ── Basic ── */}
            <div className={s.sectionTitle}>{t('tileBrowser.basic')}</div>
            {selDefs.length === 1 && (
              <div className={s.fieldRow}>
                <span className={s.fieldLabel}>{t('tileBrowser.label')}</span>
                <input className={s.fieldInput} value={selDefs[0].label}
                  onChange={e => applyField('label', e.target.value)} />
              </div>
            )}
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
                      <span
                        key={g}
                        className={`${s.chip} ${isActive ? s.chipActive : ''} ${isPartial ? s.chipPartial : ''}`}
                        onClick={() => applyField('group', g)}
                      >{g}</span>
                    ))}
                    {groupChips.length === 0 && <span className={s.fieldHint}>{t('common.noGroupsMatch')}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 4, width: '100%' }}>
                    <input
                      className={s.fieldInput}
                      placeholder={t('common.newGroupPlaceholder')}
                      value={groupInput}
                      onChange={e => setGroupInput(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleAddGroup()}
                      style={{ flex: 1 }}
                    />
                    <button className={s.layoutBtn} onClick={handleAddGroup} title={t('common.addGroup')}>＋</button>
                  </div>
                </div>
              );
            })()}

            {(() => {
              const mixed  = isMixed(d => d.orientation);
              const curVal = sv(d => d.orientation);
              return (
                <div className={s.fieldRow}>
                  <span className={s.fieldLabel} style={mixed ? { color: '#bb8833' } : {}}>{t('tileBrowser.orientation')}{mixed ? ' ⚠' : ''}</span>
                  <select className={s.fieldSelect} style={mixStyle(mixed)}
                    value={mixed ? '__mixed__' : (curVal ?? '')}
                    onChange={e => { if (e.target.value !== '__mixed__') applyField('orientation', e.target.value as TileDefinition['orientation']); }}>
                    {mixed && <option value="__mixed__" disabled>{t('tileBrowser.mixedValues')}</option>}
                    <option value="">{t('common.any')}</option>
                    {(['N','S','E','W'] as const).map(o => <option key={o}>{o}</option>)}
                  </select>
                </div>
              );
            })()}
            {/* Allowed placement directions */}
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

            {(() => {
              const mixed  = isMixed(d => d.layer);
              const curVal = sv(d => d.layer);
              return (
                <div className={s.fieldRow}>
                  <span className={s.fieldLabel} style={mixed ? { color: '#bb8833' } : {}}>{t('tileBrowser.layer')}{mixed ? ' ⚠' : ''}</span>
                  <select className={s.fieldSelect} style={mixStyle(mixed)}
                    value={mixed ? '__mixed__' : (curVal ?? 'Furniture')}
                    onChange={e => { if (e.target.value !== '__mixed__') applyField('layer', e.target.value as TileDefinition['layer']); }}>
                    {mixed && <option value="__mixed__" disabled>{t('tileBrowser.mixedValues')}</option>}
                    {['Furniture','Furniture2','Furniture3','Furniture4','Wallfurniture','Wallfurniture2','Wallfurniture3','Wallfurniture4','FloorOverlay','FloorFurniture'].map(l => <option key={l}>{l}</option>)}
                  </select>
                </div>
              );
            })()}

            {/* ── Tile layout editor (single-select only) ── */}
            {selDefs.length === 1 && (() => {
              const def = selDefs[0];
              return (
                <>
                  <div className={s.sectionTitle}>
                    {t('tileBrowser.tileLayout')}
                    <span className={s.layoutDims}>&nbsp;{layoutCols(def)}×{layoutRows(def)}</span>
                  </div>
                  <p className={s.layoutHint}>{t('tileBrowser.tileLayoutHint')}</p>

                  <div
                    className={s.layoutGrid}
                    style={{ gridTemplateColumns: `repeat(${layoutCols(def)}, ${Math.round(SPRITE_W * LAYOUT_ZOOM)}px)` }}
                  >
                    {def.tileLayout.flatMap((row, ri) =>
                      row.map((cellId, ci) => {
                        const isSelected = selectedCell?.row === ri && selectedCell?.col === ci;
                        const parsed = cellId ? parseTileId(cellId) : null;
                        const isSameSheet = parsed?.sheet === active.name;
                        const cw = Math.round(SPRITE_W * LAYOUT_ZOOM);
                        const ch = Math.round(SPRITE_H * LAYOUT_ZOOM);
                        return (
                          <div
                            key={`${ri}-${ci}`}
                            className={[
                              s.layoutCell,
                              isSelected   ? s.layoutCellSelected : '',
                              !cellId      ? s.layoutCellEmpty    : '',
                            ].join(' ')}
                            style={{ width: cw, height: ch }}
                            onClick={() => setSelectedCell(isSelected ? null : { row: ri, col: ci })}
                            title={cellId || t('tileBrowser.clickToAssign', { row: ri, col: ci })}
                          >
                            {cellId && isSameSheet && parsed ? (
                              <div
                                className={s.layoutCellSprite}
                                style={{
                                  backgroundImage:    `url(${sheetImageUrl(active.name)})`,
                                  backgroundRepeat:   'no-repeat',
                                  backgroundSize:     `${Math.round(active.sheetWidth  * LAYOUT_ZOOM)}px ${Math.round(active.sheetHeight * LAYOUT_ZOOM)}px`,
                                  backgroundPosition: `${-Math.round((parsed.index % active.columns) * SPRITE_W * LAYOUT_ZOOM)}px `
                                                    + `${-Math.round(Math.floor(parsed.index / active.columns) * SPRITE_H * LAYOUT_ZOOM)}px`,
                                }}
                              />
                            ) : cellId ? (
                              <span className={s.layoutCellIdText}>{cellId.split('_').pop()}</span>
                            ) : (
                              <span className={s.layoutCellPlus}>＋</span>
                            )}
                            {cellId && (
                              <button
                                className={s.layoutCellClear}
                                onClick={e => { e.stopPropagation(); clearCell(ri, ci); }}
                                title={t('common.clear')}
                              >×</button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>

                  <div className={s.layoutControls}>
                    <button className={s.layoutBtn} onClick={addCol}>{t('tileBrowser.addCol')}</button>
                    <button className={s.layoutBtn} onClick={removeCol} disabled={layoutCols(def) <= 1}>{t('tileBrowser.removeCol')}</button>
                    <button className={s.layoutBtn} onClick={addRow}>{t('tileBrowser.addRow')}</button>
                    <button className={s.layoutBtn} onClick={removeRow} disabled={layoutRows(def) <= 1}>{t('tileBrowser.removeRow')}</button>
                  </div>
                </>
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

            {/* ── Notes (collapsible, single-select only) ── */}
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

            {/* ── Randomiser meta ── */}
            <div className={s.sectionTitle}>{t('common.randomizer')}</div>

            {/* Colors */}
            <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
              <span className={s.fieldLabel}>{t('common.colors')}</span>
              <div className={s.chipGroup}>
                {COLORS.map(c => { const st = arrState(d => d.colors, c); return (
                  <span key={c} className={`${s.chip} ${st==='all'?s.chipActive:st==='some'?s.chipPartial:''}`}
                    onClick={() => toggleArrayField('colors', c)}>{c}</span>
                ); })}
              </div>
            </div>

            {/* Materials */}
            <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
              <span className={s.fieldLabel}>{t('common.materials')}</span>
              <div className={s.chipGroup}>
                {materialList.map(m => { const st = arrState(d => d.materials ?? [], m); return (
                  <span key={m} className={`${s.chip} ${st==='all'?s.chipActive:st==='some'?s.chipPartial:''}`}
                    onClick={() => toggleArrayField('materials', m)}>{m}</span>
                ); })}
              </div>
              {materialList.length === 0 && (
                <span style={{ fontSize: '0.75rem', color: '#888' }}>
                  {t('common.noMaterialsConfigured')}
                </span>
              )}
            </div>

            {/* Room types */}
            <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
              <span className={s.fieldLabel}>{t('common.roomTypes')}</span>
              <div className={s.chipGroup}>
                {roomTypeList.map(r => { const st = arrState(d => d.roomTypes, r); return (
                  <span key={r} className={`${s.chip} ${st==='all'?s.chipActive:st==='some'?s.chipPartial:''}`}
                    onClick={() => toggleArrayField('roomTypes', r)}>{r}</span>
                ); })}
              </div>
            </div>

            {/* Variant group */}
            {(() => {
              const mixed  = isMixed(d => d.variantGroup);
              const curVal = sv(d => d.variantGroup);
              return (
                <div className={s.fieldRow}>
                  <span className={s.fieldLabel} style={mixed ? { color: '#bb8833' } : {}}>{t('common.variantId')}{mixed ? ' ⚠' : ''}</span>
                  <input className={s.fieldInput}
                    placeholder={mixed ? t('tileBrowser.mixedValuesPlaceholder') : t('common.variantIdPlaceholder')}
                    value={mixed ? '' : (curVal ?? '')} style={mixStyle(mixed)}
                    onChange={e => applyField('variantGroup', e.target.value)} />
                </div>
              );
            })()}

            {/* Window-blocked edge */}
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
                    {mixed && <option value="__mixed__" disabled>{t('tileBrowser.mixedValues')}</option>}
                    <option value="">{t('common.noneDefaultRule')}</option>
                    {(['N', 'E', 'S', 'W'] as const).map(edge => <option key={edge} value={edge}>{edge}</option>)}
                  </select>
                </div>
              );
            })()}

            {/* Style tags */}
            <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
              <span className={s.fieldLabel}>{t('common.styleTags')} <span className={s.fieldHint}>{t('common.styleTagsSavedNotActive')}</span></span>
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
                {saveState === 'saving' ? t('tileBrowser.saving')
                 : saveState === 'ok'  ? t('tileBrowser.saved')
                 : saveState === 'err' ? t('tileBrowser.saveError')
                 : dirtyIds.size > 0  ? t('tileBrowser.saveEntries', { count: dirtyIds.size })
                 : t('tileBrowser.noChanges')}
              </button>
              <p className={s.saveHint}>
                {t('tileBrowser.saveHintPre')}<em>tile-definitions.json</em>{t('tileBrowser.saveHintPost')}
              </p>
              {selDefs.length === 1 && config[selDefs[0].id] && (
                <button className={s.deleteBtn} onClick={handleDelete}> {t('tileBrowser.delete')}</button>
              )}
            </div>
          </>
        ) : (
          <p className={s.configEmpty}>
            {t('tileBrowser.selectSprite')}<br />
            <span style={{ color: '#446', fontSize: '0.75rem' }}>{t('tileBrowser.ctrlClickHint')}</span>
          </p>
        )}
      </div>

    </div>
  );
}








