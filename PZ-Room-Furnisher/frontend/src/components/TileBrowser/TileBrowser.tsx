import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getTilesPath, setTilesPath, getSheets, getTileConfig,
  saveTileDefinition, deleteTileDefinition, sheetImageUrl, exportConfigUrl,
} from '../../api/tilesApi';
import type { TileSheetInfo, TileDefinition, TileConfigMap } from '../../types/tiles';
import {
  makeTileId, defaultDefinition, parseTileId,
  layoutCols, layoutRows, COLORS, STYLE_TAGS,
  TILE_PROPERTIES, TILE_PROPERTY_LABELS_DE,
} from '../../types/tiles';
import { getRoomTypeNames, getCategories } from '../../api/settingsApi';
import { DirPicker } from './DirPicker';
import s from './TileBrowser.module.css';

const SPRITE_W = 128;
const SPRITE_H = 256;
/** Zoom factor used for the mini layout-cell previews in the config panel */
const LAYOUT_ZOOM = 0.28;

export function TileBrowser() {
  const { t } = useTranslation();

  // ── path ─────────────────────────────────────────────────────────────
  const [pathInput, setPathInput] = useState('');
  const [pathOk, setPathOk]   = useState(false);
  const [pathErr, setPathErr] = useState('');
  const [pathTried, setPathTried] = useState(false);
  const [backendOk, setBackendOk] = useState(true);

  // ── sheets ────────────────────────────────────────────────────────────
  const [sheets, setSheets]           = useState<TileSheetInfo[]>([]);
  const [sheetFilter, setSheetFilter] = useState('');
  const [active, setActive]           = useState<TileSheetInfo | null>(null);

  // ── config ────────────────────────────────────────────────────────────
  const [config, setConfig] = useState<TileConfigMap>({});

  // ── group selector ─────────────────────────────────────────────────────
  const [extraGroups, setExtraGroups] = useState<string[]>([]);
  const [groupInput, setGroupInput]   = useState('');

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
      setEditDef(prev => prev ? { ...prev, group: existing } : prev);
    } else {
      setExtraGroups(prev => [...prev, trimmed]);
      setEditDef(prev => prev ? { ...prev, group: trimmed } : prev);
    }
    setGroupInput('');
  };

  // ── selection ─────────────────────────────────────────────────────────
  const [selIdx, setSelIdx]   = useState<number | null>(null);
  const [editDef, setEditDef] = useState<TileDefinition | null>(null);
  /** Which layout cell is currently active for sprite assignment (null = none) */
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null);

  // ── zoom ──────────────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(1);

  // ── dir picker ────────────────────────────────────────────────────────
  const [showPicker, setShowPicker] = useState(false);

  // ── room types (from settings) ────────────────────────────────────────────
  const [roomTypeList, setRoomTypeList] = useState<string[]>([]);

  // ── init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    getTilesPath()
      .then(r => { setPathInput(r.path); setPathOk(r.isValid); setBackendOk(true); })
      .catch(() => setBackendOk(false));
    getTileConfig()
      .then(setConfig)
      .catch(() => { /* ignore */ });
    getRoomTypeNames().then(setRoomTypeList).catch(console.error);
    getCategories().then(setKnownCategories).catch(console.error);
  }, []);

  useEffect(() => {
    if (!pathOk) { setSheets([]); return; }
    getSheets().then(r => setSheets(r.configured ? r.sheets : []));
  }, [pathOk]);

  // ── path ─────────────────────────────────────────────────────────────
  const applyPath = async (p: string) => {
    setPathErr('');
    setPathTried(true);
    try {
      const r = await setTilesPath(p);
      setPathInput(r.path);
      setPathOk(r.isValid);
      getSheets().then(r2 => setSheets(r2.configured ? r2.sheets : []));
    } catch (e) {
      setPathOk(false);
      setPathErr(e instanceof Error ? e.message : 'Fehler beim Setzen des Pfades');
    }
  };

  const handleSetPath = () => applyPath(pathInput);
  const handlePickerSelect = (picked: string) => { setShowPicker(false); applyPath(picked); };

  // ── sprite click ──────────────────────────────────────────────────────
  const handleSprite = useCallback((idx: number) => {
    if (!active) return;
    const tileId = makeTileId(active.name, idx);

    // If a layout cell is selected → assign this sprite to that cell
    if (selectedCell && editDef) {
      const next = editDef.tileLayout.map((row, ri) =>
        row.map((cell, ci) =>
          ri === selectedCell.row && ci === selectedCell.col ? tileId : cell
        )
      );
      const updated = { ...editDef, tileLayout: next };
      setEditDef(updated);
      setSelIdx(idx);

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
      return;
    }

    // Otherwise → open / create definition for this sprite
    setSelIdx(idx);
    setSelectedCell(null);
    setEditDef(config[tileId] ? { ...config[tileId] } : defaultDefinition(tileId));
  }, [active, config, selectedCell, editDef]);

  // ── layout manipulation ───────────────────────────────────────────────
  const clearCell = (row: number, col: number) => {
    if (!editDef) return;
    setEditDef({
      ...editDef,
      tileLayout: editDef.tileLayout.map((r, ri) =>
        r.map((c, ci) => ri === row && ci === col ? '' : c)
      ),
    });
  };
  const addRow = () => {
    if (!editDef) return;
    setEditDef({ ...editDef, tileLayout: [...editDef.tileLayout, Array(layoutCols(editDef)).fill('')] });
  };
  const removeRow = () => {
    if (!editDef || layoutRows(editDef) <= 1) return;
    setEditDef({ ...editDef, tileLayout: editDef.tileLayout.slice(0, -1) });
  };
  const addCol = () => {
    if (!editDef) return;
    setEditDef({ ...editDef, tileLayout: editDef.tileLayout.map(r => [...r, '']) });
  };
  const removeCol = () => {
    if (!editDef || layoutCols(editDef) <= 1) return;
    setEditDef({ ...editDef, tileLayout: editDef.tileLayout.map(r => r.slice(0, -1)) });
  };

  // ── save / delete ─────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!editDef) return;
    const saved = await saveTileDefinition(editDef);
    const next = { ...config, [saved.tileId]: saved };
    setConfig(next);
    if (active) {
      setSheets(prev => prev.map(sh =>
        sh.name === active.name
          ? { ...sh, definedCount: Object.keys(next).filter(k => k.startsWith(sh.name + '_')).length }
          : sh
      ));
    }
  };

  const handleDelete = async () => {
    if (!editDef) return;
    await deleteTileDefinition(editDef.tileId);
    const next = { ...config };
    delete next[editDef.tileId];
    setConfig(next);
    if (active) {
      setSheets(prev => prev.map(sh =>
        sh.name === active.name
          ? { ...sh, definedCount: Object.keys(next).filter(k => k.startsWith(sh.name + '_')).length }
          : sh
      ));
    }
    setEditDef(defaultDefinition(editDef.tileId));
  };

  // ── helpers ───────────────────────────────────────────────────────────
  const filtered = sheets.filter(sh =>
    sh.name.toLowerCase().includes(sheetFilter.toLowerCase()));

  const previewBgPos = (active && selIdx !== null)
    ? `${-(selIdx % active.columns) * SPRITE_W * zoom}px ${-Math.floor(selIdx / active.columns) * SPRITE_H * zoom}px`
    : '0 0';

  return (
    <div className={s.layout}>

      {/* Dir picker modal */}
      {showPicker && (
        <DirPicker onSelect={handlePickerSelect} onClose={() => setShowPicker(false)} />
      )}

      {/* ── Path bar ── */}
      <div className={s.pathBar}>
        {!backendOk ? (
          <span className={s.statusErr} style={{ flex: 1 }}>
            ⚠ Backend nicht erreichbar – bitte starte das Backend (dotnet run) und lade die Seite neu.
          </span>
        ) : (
          <>
            <span>{t('tileBrowser.tilesPath')}:</span>
            <input
              className={s.pathInput}
              value={pathInput}
              onChange={e => setPathInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSetPath()}
              placeholder="z.B. C:\Games\ProjectZomboid\media\textures"
            />
            <button className={s.browseBtn} onClick={() => setShowPicker(true)} title={t('tileBrowser.browse')}></button>
            <button className={s.setBtn} onClick={handleSetPath}>{t('tileBrowser.setPath')}</button>
            {pathOk
              ? <span className={s.statusOk}>✓ {t('tileBrowser.pathOk')} — {sheets.length} Sheets</span>
              : pathTried && !pathErr
                ? <span className={s.statusErr}>✗ {t('tileBrowser.pathNotFound')}</span>
                : null}
            {pathErr && <span className={s.statusErr}>✗ {pathErr}</span>}
            {pathOk && (
              <a className={s.exportLink} href={exportConfigUrl()} download="tile-definitions.json">
                ⬇ {t('tileBrowser.export')}
              </a>
            )}
          </>
        )}
      </div>

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
              onClick={() => { setActive(sh); setSelIdx(null); setEditDef(null); setSelectedCell(null); }}
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
                  ✏ Zelle [{selectedCell.row},{selectedCell.col}] aktiv – Sprite anklicken zum Zuweisen
                </span>
              )}
              <span style={{ marginLeft: 'auto', color: '#778' }}>{t('tileBrowser.zoom')}:</span>
              {[0.5, 1, 1.5, 2].map(z => (
                <button
                  key={z}
                  className={`${s.zoomBtn} ${zoom === z ? s.zoomActive : ''}`}
                  onClick={() => setZoom(z)}
                >{z}×</button>
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
                    const tileId   = makeTileId(active.name, i);
                    const defined  = !!config[tileId];
                    const selected = selIdx === i;
                    return (
                      <div
                        key={i}
                        className={[
                          s.spriteCell,
                          defined  ? s.spriteDefined  : '',
                          selected ? s.spriteSelected : '',
                          selectedCell ? s.spriteCellAssignMode : '',
                        ].join(' ')}
                        onClick={() => handleSprite(i)}
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
        {editDef && active && selIdx !== null ? (
          <>
            {/* Sprite preview (root tile) */}
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
              <p className={s.previewTileId}>{editDef.tileId}</p>
            </div>

            {/* ── Basic ── */}
            <div className={s.sectionTitle}>{t('tileBrowser.basic')}</div>
            <div className={s.fieldRow}>
              <span className={s.fieldLabel}>{t('tileBrowser.label')}</span>
              <input className={s.fieldInput} value={editDef.label}
                onChange={e => setEditDef({ ...editDef, label: e.target.value })} />
            </div>
            <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
              <span className={s.fieldLabel}>{t('tileBrowser.group')}</span>
              <div className={s.chipGroup}>
                {allGroups.map(g => (
                  <span
                    key={g}
                    className={`${s.chip} ${editDef.group === g ? s.chipActive : ''}`}
                    onClick={() => setEditDef({ ...editDef, group: g })}
                  >{g}</span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 4, width: '100%' }}>
                <input
                  className={s.fieldInput}
                  placeholder="Neue Gruppe…"
                  value={groupInput}
                  onChange={e => setGroupInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddGroup()}
                  style={{ flex: 1 }}
                />
                <button className={s.layoutBtn} onClick={handleAddGroup} title="Gruppe hinzufügen">＋</button>
              </div>
            </div>
            <div className={s.fieldRow}>
              <span className={s.fieldLabel}>{t('tileBrowser.orientation')}</span>
              <select className={s.fieldSelect} value={editDef.orientation}
                onChange={e => setEditDef({ ...editDef, orientation: e.target.value as TileDefinition['orientation'] })}>
                <option value="">Beliebig (keine)</option>
                {(['N','S','E','W'] as const).map(o => <option key={o}>{o}</option>)}
              </select>
            </div>
            <div className={s.fieldRow}>
              <span className={s.fieldLabel}>{t('tileBrowser.layer')}</span>
              <select className={s.fieldSelect} value={editDef.layer}
                onChange={e => setEditDef({ ...editDef, layer: e.target.value as TileDefinition['layer'] })}>
                {['Furniture','Furniture2','Furniture3','Furniture4','Wallfurniture','Wallfurniture2','Wallfurniture3','Wallfurniture4','FloorOverlay','FloorFurniture'].map(l => <option key={l}>{l}</option>)}
              </select>
            </div>

            {/* ── Tile layout editor ── */}
            <div className={s.sectionTitle}>
              {t('tileBrowser.tileLayout')}
              <span className={s.layoutDims}>&nbsp;{layoutCols(editDef)}×{layoutRows(editDef)}</span>
            </div>
            <p className={s.layoutHint}>{t('tileBrowser.tileLayoutHint')}</p>

            <div
              className={s.layoutGrid}
              style={{ gridTemplateColumns: `repeat(${layoutCols(editDef)}, ${Math.round(SPRITE_W * LAYOUT_ZOOM)}px)` }}
            >
              {editDef.tileLayout.flatMap((row, ri) =>
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
                      title={cellId || `[${ri},${ci}] anklicken, dann Sprite wählen`}
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
                          title="Leeren"
                        >×</button>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <div className={s.layoutControls}>
              <button className={s.layoutBtn} onClick={addCol}>＋ Spalte</button>
              <button className={s.layoutBtn} onClick={removeCol} disabled={layoutCols(editDef) <= 1}>－ Spalte</button>
              <button className={s.layoutBtn} onClick={addRow}>＋ Zeile</button>
              <button className={s.layoutBtn} onClick={removeRow} disabled={layoutRows(editDef) <= 1}>－ Zeile</button>
            </div>

            {/* ── Eigenschaften ── */}
            <div className={s.sectionTitle}>{t('tileBrowser.flags')}</div>
            {TILE_PROPERTIES.map(key => (
              <label key={key} className={s.checkRow}>
                <input type="checkbox" checked={editDef[key] as boolean}
                  onChange={e => setEditDef({ ...editDef, [key]: e.target.checked })} />
                {TILE_PROPERTY_LABELS_DE[key]}
              </label>
            ))}

            {/* ── Notes ── */}
            <div className={s.sectionTitle}>{t('tileBrowser.notes')}</div>
            <textarea className={s.fieldInput} rows={2}
              value={editDef.notes}
              onChange={e => setEditDef({ ...editDef, notes: e.target.value })} />

            {/* ── Randomiser meta ── */}
            <div className={s.sectionTitle}>Zufallsgenerator</div>

            {/* Colors */}
            <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
              <span className={s.fieldLabel}>Farben</span>
              <div className={s.chipGroup}>
                {COLORS.map(c => (
                  <span
                    key={c}
                    className={`${s.chip} ${editDef.colors.includes(c) ? s.chipActive : ''}`}
                    onClick={() => setEditDef({
                      ...editDef,
                      colors: editDef.colors.includes(c)
                        ? editDef.colors.filter(x => x !== c)
                        : [...editDef.colors, c],
                    })}
                  >{c}</span>
                ))}
              </div>
            </div>

            {/* Room types */}
            <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
              <span className={s.fieldLabel}>Raumtypen</span>
              <div className={s.chipGroup}>
                {roomTypeList.map(r => (
                  <span
                    key={r}
                    className={`${s.chip} ${editDef.roomTypes.includes(r) ? s.chipActive : ''}`}
                    onClick={() => setEditDef({
                      ...editDef,
                      roomTypes: editDef.roomTypes.includes(r)
                        ? editDef.roomTypes.filter(x => x !== r)
                        : [...editDef.roomTypes, r],
                    })}
                  >{r}</span>
                ))}
              </div>
            </div>

            {/* Variant group */}
            <div className={s.fieldRow}>
              <span className={s.fieldLabel}>Varianten-ID</span>
              <input className={s.fieldInput}
                placeholder="z.B. sofa_brown"
                value={editDef.variantGroup}
                onChange={e => setEditDef({ ...editDef, variantGroup: e.target.value })} />
            </div>

            {/* Fenster-Sperrkante */}
            <div className={s.fieldRow}>
              <span className={s.fieldLabel}>
                Fenster-Sperrkante
                <span
                  className={s.infoIcon}
                  title="Nur diese Kante darf kein Fenster beruehren"
                  aria-label="Info: Nur diese Kante darf kein Fenster beruehren"
                >ⓘ</span>
              </span>
              <select
                className={s.fieldSelect}
                value={editDef.windowBlockedEdge ?? ''}
                onChange={e => setEditDef({ ...editDef, windowBlockedEdge: e.target.value as TileDefinition['windowBlockedEdge'] })}
              >
                <option value="">Keine (Standardregel)</option>
                {(['N', 'E', 'S', 'W'] as const).map(edge => <option key={edge} value={edge}>{edge}</option>)}
              </select>
            </div>

            {/* Style tags */}
            <div className={s.fieldRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
              <span className={s.fieldLabel}>Style-Tags <span className={s.fieldHint}>(gespeichert, noch nicht aktiv)</span></span>
              <div className={s.chipGroup}>
                {STYLE_TAGS.map(st => (
                  <span
                    key={st}
                    className={`${s.chip} ${editDef.styleTags.includes(st) ? s.chipActive : ''}`}
                    onClick={() => setEditDef({
                      ...editDef,
                      styleTags: editDef.styleTags.includes(st)
                        ? editDef.styleTags.filter(x => x !== st)
                        : [...editDef.styleTags, st],
                    })}
                  >{st}</span>
                ))}
              </div>
            </div>

            <button className={s.saveBtn} onClick={handleSave}> {t('tileBrowser.save')}</button>
            {config[editDef.tileId] && (
              <button className={s.deleteBtn} onClick={handleDelete}> {t('tileBrowser.delete')}</button>
            )}
          </>
        ) : (
          <p className={s.configEmpty}>{t('tileBrowser.selectSprite')}</p>
        )}
      </div>

    </div>
  );
}





