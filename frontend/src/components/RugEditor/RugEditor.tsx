import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { getRugCatalog, saveRugDefinition, deleteRugDefinition } from '../../api/rugsApi';
import { getSheets, sheetImageUrl, getTileConfigSets } from '../../api/tilesApi';
import { getRoomTypeNames, getMaterials, getColorNames } from '../../api/settingsApi';
import type { RugDefinition, RugCatalogMap, RugRole, RugPreassembledSize } from '../../types/rugs';
import { RUG_ROLE_GRID, defaultRugDefinition } from '../../types/rugs';
import type { TileSheetInfo, TileConfigSetInfo } from '../../types/tiles';
import { makeTileId, parseTileId } from '../../types/tiles';
import s from './RugEditor.module.css';

const SPRITE_W = 128;
const SPRITE_H = 256;
const PICKER_ZOOM = 0.35;
/** Zoom for the small tile-preview thumbnails in the 3×3 role grid. */
const ROLE_ZOOM = 0.28;
/** Zoom for the small tile-preview thumbnails in the preassembled size grid. */
const LAYOUT_ZOOM = 0.22;

const ROLE_ORDER = RUG_ROLE_GRID.flat().filter((r): r is RugRole => r !== null);

function slugify(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'rug';
}

function resizeLayout(layout: string[][], cols: number, rows: number): string[][] {
  const out: string[][] = [];
  for (let r = 0; r < rows; r++) {
    const srcRow = layout[r] ?? [];
    const row: string[] = [];
    for (let c = 0; c < cols; c++) row.push(srcRow[c] ?? '');
    out.push(row);
  }
  return out;
}

function isTileIdUsedInDraft(draft: RugDefinition, tileId: string): boolean {
  if (draft.mode === 'modular') return Object.values(draft.pieces).includes(tileId);
  return draft.preassembledSizes.some(sz => sz.tileLayout.some(row => row.includes(tileId)));
}

function toggleInArray(arr: string[], val: string): string[] {
  return arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val];
}

/**
 * Background-image crop for a small tile preview thumbnail, resolving the
 * tileId's own sheet (which may differ from whichever sheet is currently
 * active in the picker). Returns null if the sheet isn't known (e.g. its
 * tile set was switched away from), in which case callers fall back to text.
 */
function tilePreviewStyle(tileId: string, sheets: TileSheetInfo[], zoom: number): React.CSSProperties | null {
  const parsed = parseTileId(tileId);
  if (!parsed) return null;
  const sheet = sheets.find(sh => sh.name === parsed.sheet);
  if (!sheet) return null;
  return {
    backgroundImage: `url(${sheetImageUrl(sheet.name)})`,
    backgroundRepeat: 'no-repeat',
    backgroundSize: `${Math.round(sheet.sheetWidth * zoom)}px ${Math.round(sheet.sheetHeight * zoom)}px`,
    backgroundPosition: `${-Math.round((parsed.index % sheet.columns) * SPRITE_W * zoom)}px `
                       + `${-Math.round(Math.floor(parsed.index / sheet.columns) * SPRITE_H * zoom)}px`,
  };
}

export function RugEditor() {
  const { t } = useTranslation();

  const [rugs, setRugs]           = useState<RugCatalogMap>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft]         = useState<RugDefinition | null>(null);
  const [dirty, setDirty]         = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'ok' | 'err'>('idle');

  const [configSets, setConfigSets] = useState<TileConfigSetInfo[]>([]);
  const [sheets, setSheets]         = useState<TileSheetInfo[]>([]);
  const [activeSheetName, setActiveSheetName] = useState('');
  /** Narrows which sheets appear in the sheet dropdown. */
  const [sheetFilter, setSheetFilter]   = useState('');
  /** Dims sprites in the active sheet's grid that don't match (substring, case-insensitive). */
  const [spriteFilter, setSpriteFilter] = useState('');
  /** Multiplier on top of PICKER_ZOOM, so sprites in the picker can be made easier to see. */
  const [pickerZoom, setPickerZoom]     = useState(1);

  const [armedRole, setArmedRole]         = useState<RugRole | null>(null);
  const [selectedSizeIdx, setSelectedSizeIdx] = useState<number | null>(null);
  const [selectedCell, setSelectedCell]   = useState<{ row: number; col: number } | null>(null);

  const [roomTypeList, setRoomTypeList] = useState<string[]>([]);
  const [materialList, setMaterialList] = useState<string[]>([]);
  const [colorList, setColorList]       = useState<string[]>([]);

  useEffect(() => {
    getRugCatalog().then(setRugs).catch(console.error);
    getTileConfigSets().then(setConfigSets).catch(console.error);
    getRoomTypeNames().then(setRoomTypeList).catch(console.error);
    getMaterials().then(setMaterialList).catch(console.error);
    getColorNames().then(setColorList).catch(console.error);
  }, []);

  const activeSheet = useMemo(
    () => sheets.find(sh => sh.name === activeSheetName) ?? null,
    [sheets, activeSheetName],
  );

  const filteredSheets = useMemo(
    () => sheets.filter(sh => sh.name.toLowerCase().includes(sheetFilter.trim().toLowerCase())),
    [sheets, sheetFilter],
  );

  // Reload sprite sheets scoped to the draft's tile set whenever it changes.
  useEffect(() => {
    if (!draft) { setSheets([]); return; }
    getSheets(draft.tileSetId)
      .then(r => setSheets(r.configured ? r.sheets : []))
      .catch(() => setSheets([]));
  }, [draft?.tileSetId]);

  useEffect(() => {
    if (sheets.length === 0) { setActiveSheetName(''); return; }
    if (!sheets.some(sh => sh.name === activeSheetName)) setActiveSheetName(sheets[0].name);
  }, [sheets]);

  const selectRug = (id: string) => {
    setSelectedId(id);
    setDraft({ ...rugs[id] });
    setDirty(false);
    setSaveState('idle');
    setArmedRole(null);
    setSelectedSizeIdx(null);
    setSelectedCell(null);
  };

  const newRug = () => {
    setSelectedId(null);
    setDraft(defaultRugDefinition(`rug_new_${Date.now()}`));
    setDirty(true);
    setSaveState('idle');
    setArmedRole(null);
    setSelectedSizeIdx(null);
    setSelectedCell(null);
  };

  /** Copies an existing rug's full settings into a new unsaved draft, so it can be
   *  tweaked and saved under its own id without redoing sprite assignments. */
  const duplicateRug = (id: string) => {
    const source = rugs[id];
    if (!source) return;
    setSelectedId(null);
    setDraft({ ...source, id: '', label: `${source.label || source.id} (copy)` });
    setDirty(true);
    setSaveState('idle');
    setArmedRole(null);
    setSelectedSizeIdx(null);
    setSelectedCell(null);
  };

  const updateDraft = (patch: Partial<RugDefinition>) => {
    setDraft(d => d ? { ...d, ...patch } : d);
    setDirty(true);
    setSaveState('idle');
  };

  const handleSpriteClick = (idx: number) => {
    if (!activeSheet || !draft) return;
    const tileId = makeTileId(activeSheet.name, idx);

    if (draft.mode === 'modular') {
      if (!armedRole) return;
      updateDraft({ pieces: { ...draft.pieces, [armedRole]: tileId } });
      const i = ROLE_ORDER.indexOf(armedRole);
      setArmedRole(i >= 0 && i + 1 < ROLE_ORDER.length ? ROLE_ORDER[i + 1] : null);
    } else {
      if (selectedSizeIdx === null || !selectedCell) return;
      const sizes = [...draft.preassembledSizes];
      const size = sizes[selectedSizeIdx];
      const newLayout = size.tileLayout.map((row, ri) =>
        row.map((c, ci) => (ri === selectedCell.row && ci === selectedCell.col ? tileId : c)));
      sizes[selectedSizeIdx] = { ...size, tileLayout: newLayout };
      updateDraft({ preassembledSizes: sizes });

      const cols = newLayout[0]?.length ?? 1;
      const rows = newLayout.length;
      const nextCol = selectedCell.col + 1;
      if (nextCol < cols) setSelectedCell({ row: selectedCell.row, col: nextCol });
      else if (selectedCell.row + 1 < rows) setSelectedCell({ row: selectedCell.row + 1, col: 0 });
      else setSelectedCell(null);
    }
  };

  const addSize = () => {
    if (!draft) return;
    const size: RugPreassembledSize = { width: 2, height: 2, tileLayout: [['', ''], ['', '']] };
    updateDraft({ preassembledSizes: [...draft.preassembledSizes, size] });
  };
  const removeSize = (idx: number) => {
    if (!draft) return;
    updateDraft({ preassembledSizes: draft.preassembledSizes.filter((_, i) => i !== idx) });
    if (selectedSizeIdx === idx) { setSelectedSizeIdx(null); setSelectedCell(null); }
  };
  const resizeSize = (idx: number, w: number, h: number) => {
    if (!draft) return;
    w = Math.max(1, w); h = Math.max(1, h);
    const sizes = [...draft.preassembledSizes];
    sizes[idx] = { ...sizes[idx], width: w, height: h, tileLayout: resizeLayout(sizes[idx].tileLayout, w, h) };
    updateDraft({ preassembledSizes: sizes });
  };

  const handleSave = async () => {
    if (!draft) return;
    let id = draft.id;
    if (selectedId === null) {
      // Brand-new rug: derive a stable id from the label now. Once saved, the id
      // never changes again even if the label is edited later (avoids orphaning
      // references from a room-type slot's allowedRugIds).
      const slug = slugify(draft.label);
      id = slug;
      let n = 2;
      while (rugs[id]) id = `${slug}-${n++}`;
    }
    setSaveState('saving');
    try {
      const saved = await saveRugDefinition({ ...draft, id });
      setRugs(prev => ({ ...prev, [saved.id]: saved }));
      setSelectedId(saved.id);
      setDraft(saved);
      setDirty(false);
      setSaveState('ok');
    } catch { setSaveState('err'); }
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    await deleteRugDefinition(selectedId);
    setRugs(prev => { const next = { ...prev }; delete next[selectedId]; return next; });
    setSelectedId(null);
    setDraft(null);
    setDirty(false);
  };

  const sortedRugs = useMemo(
    () => Object.values(rugs).sort((a, b) => (a.label || a.id).localeCompare(b.label || b.id)),
    [rugs],
  );

  return (
    <div className={s.layout}>
      {/* ── Rug design list ── */}
      <div className={s.listPanel}>
        <div className={s.listHeader}>
          <span>{t('rugEditor.designs', { defaultValue: 'Rug designs' })}</span>
          <button className={s.newBtn} onClick={newRug}>{t('rugEditor.new', { defaultValue: '+ New' })}</button>
        </div>
        <div className={s.list}>
          {sortedRugs.map(r => (
            <div
              key={r.id}
              className={`${s.listItem} ${selectedId === r.id ? s.listItemActive : ''}`}
              onClick={() => selectRug(r.id)}
            >
              <span className={s.listItemLabel}>{r.label || r.id}</span>
              <span className={s.listItemMode}>{r.mode}</span>
              <button
                className={s.duplicateBtn}
                title={t('rugEditor.duplicateTitle', { defaultValue: 'Duplicate this rug design' })}
                onClick={e => { e.stopPropagation(); duplicateRug(r.id); }}
              >⧉</button>
            </div>
          ))}
          {sortedRugs.length === 0 && (
            <p className={s.emptyHint}>{t('rugEditor.noRugs', { defaultValue: 'No rug designs yet.' })}</p>
          )}
        </div>
      </div>

      {/* ── Sprite picker ── */}
      <div className={s.pickerPanel}>
        {draft ? (
          <>
            <div className={s.pickerToolbar}>
              <input
                className={s.filterInput}
                placeholder={t('rugEditor.filterSheets', { defaultValue: 'Filter sheets…' })}
                value={sheetFilter}
                onChange={e => setSheetFilter(e.target.value)}
              />
              <select className={s.sheetSelect} value={activeSheetName} onChange={e => setActiveSheetName(e.target.value)}>
                {filteredSheets.length === 0 && <option value="">{t('rugEditor.noSheets', { defaultValue: 'No sheets' })}</option>}
                {filteredSheets.map(sh => <option key={sh.name} value={sh.name}>{sh.name}</option>)}
              </select>
              <input
                className={s.filterInput}
                placeholder={t('rugEditor.filterTiles', { defaultValue: 'Filter tiles…' })}
                value={spriteFilter}
                onChange={e => setSpriteFilter(e.target.value)}
              />
              {draft.mode === 'modular' && armedRole && (
                <span className={s.armedHint}>{t('rugEditor.assigningRole', { role: armedRole, defaultValue: `Assigning: ${armedRole}` })}</span>
              )}
              {draft.mode === 'preassembled' && selectedCell && (
                <span className={s.armedHint}>
                  {t('rugEditor.assigningCell', { row: selectedCell.row, col: selectedCell.col, defaultValue: `Assigning cell (${selectedCell.row},${selectedCell.col})` })}
                </span>
              )}
              <div className={s.zoomGroup}>
                {[0.5, 1, 1.5, 2, 3].map(z => (
                  <button
                    key={z}
                    className={`${s.zoomBtn} ${pickerZoom === z ? s.zoomBtnActive : ''}`}
                    onClick={() => setPickerZoom(z)}
                  >{z}×</button>
                ))}
              </div>
            </div>
            <div className={s.pickerScroll}>
              {activeSheet && (() => {
                const effZoom = PICKER_ZOOM * pickerZoom;
                return (
                <div style={{ position: 'relative', width: activeSheet.sheetWidth * effZoom, height: activeSheet.sheetHeight * effZoom }}>
                  <img
                    src={sheetImageUrl(activeSheet.name)}
                    width={activeSheet.sheetWidth * effZoom}
                    height={activeSheet.sheetHeight * effZoom}
                    draggable={false}
                    alt={activeSheet.name}
                    style={{ position: 'absolute', top: 0, left: 0 }}
                  />
                  <div
                    className={s.spriteOverlay}
                    style={{
                      position: 'absolute', top: 0, left: 0,
                      gridTemplateColumns: `repeat(${activeSheet.columns}, ${SPRITE_W * effZoom}px)`,
                      gridTemplateRows:    `repeat(${activeSheet.rows},    ${SPRITE_H * effZoom}px)`,
                    }}
                  >
                    {Array.from({ length: activeSheet.spriteCount }, (_, i) => {
                      const tileId = makeTileId(activeSheet.name, i);
                      const assigned = isTileIdUsedInDraft(draft, tileId);
                      const dimmed = spriteFilter.trim() !== '' && !tileId.toLowerCase().includes(spriteFilter.trim().toLowerCase());
                      return (
                        <div
                          key={i}
                          className={`${s.spriteCell} ${assigned ? s.spriteAssigned : ''} ${dimmed ? s.spriteDimmed : ''}`}
                          onClick={() => handleSpriteClick(i)}
                          title={tileId}
                        />
                      );
                    })}
                  </div>
                </div>
                );
              })()}
            </div>
          </>
        ) : (
          <p className={s.emptyHint}>{t('rugEditor.selectOrNew', { defaultValue: 'Select a rug design or create a new one.' })}</p>
        )}
      </div>

      {/* ── Detail panel ── */}
      <div className={s.detailPanel}>
        {draft ? (
          <>
            <div className={s.sectionTitle}>{t('rugEditor.basic', { defaultValue: 'Basic' })}</div>
            <div className={s.fieldRow}>
              <span className={s.fieldLabel}>{t('rugEditor.label', { defaultValue: 'Label' })}</span>
              <input className={s.fieldInput} value={draft.label} onChange={e => updateDraft({ label: e.target.value })} />
            </div>
            {selectedId && (
              <div className={s.fieldRow}>
                <span className={s.fieldLabel}>{t('rugEditor.id', { defaultValue: 'ID' })}</span>
                <span style={{ fontSize: '0.78rem', color: '#778' }}>{draft.id}</span>
              </div>
            )}
            <div className={s.fieldRow}>
              <span className={s.fieldLabel}>{t('rugEditor.tileSet', { defaultValue: 'Tile set' })}</span>
              <select className={s.fieldSelect} value={draft.tileSetId} onChange={e => updateDraft({ tileSetId: e.target.value })}>
                {configSets.map(cs => <option key={cs.id} value={cs.id}>{cs.name}</option>)}
              </select>
            </div>
            <div className={s.fieldRow}>
              <span className={s.fieldLabel}>{t('rugEditor.group', { defaultValue: 'Group' })}</span>
              <input className={s.fieldInput} value={draft.group} onChange={e => updateDraft({ group: e.target.value })} />
            </div>
            <div className={s.fieldRow}>
              <span className={s.fieldLabel}>{t('rugEditor.variantGroup', { defaultValue: 'Variant group' })}</span>
              <input className={s.fieldInput} value={draft.variantGroup} onChange={e => updateDraft({ variantGroup: e.target.value })} />
            </div>

            <div className={s.modeToggle}>
              <button className={`${s.modeBtn} ${draft.mode === 'modular' ? s.modeBtnActive : ''}`}
                onClick={() => updateDraft({ mode: 'modular' })}>{t('rugEditor.modular', { defaultValue: 'Modular' })}</button>
              <button className={`${s.modeBtn} ${draft.mode === 'preassembled' ? s.modeBtnActive : ''}`}
                onClick={() => updateDraft({ mode: 'preassembled' })}>{t('rugEditor.preassembled', { defaultValue: 'Preassembled' })}</button>
            </div>

            <div className={s.sectionTitle}>{t('rugEditor.roomTypes', { defaultValue: 'Room types' })}</div>
            <div className={s.chipGroup}>
              {roomTypeList.map(rt => (
                <span key={rt} className={`${s.chip} ${draft.roomTypes.includes(rt) ? s.chipActive : ''}`}
                  onClick={() => updateDraft({ roomTypes: toggleInArray(draft.roomTypes, rt) })}>{rt}</span>
              ))}
            </div>

            <div className={s.sectionTitle}>{t('common.colors', { defaultValue: 'Colors' })}</div>
            <div className={s.chipGroup}>
              {colorList.map(c => (
                <span key={c} className={`${s.chip} ${draft.colors.includes(c) ? s.chipActive : ''}`}
                  onClick={() => updateDraft({ colors: toggleInArray(draft.colors, c) })}>{c}</span>
              ))}
            </div>

            <div className={s.sectionTitle}>{t('common.materials', { defaultValue: 'Materials' })}</div>
            <div className={s.chipGroup}>
              {materialList.map(m => (
                <span key={m} className={`${s.chip} ${draft.materials.includes(m) ? s.chipActive : ''}`}
                  onClick={() => updateDraft({ materials: toggleInArray(draft.materials, m) })}>{m}</span>
              ))}
            </div>

            {draft.mode === 'modular' ? (
              <>
                <div className={s.sectionTitle}>{t('rugEditor.pieces', { defaultValue: 'Pieces (click a role, then a sprite)' })}</div>
                <div className={s.roleGrid} style={{
                  gridTemplateColumns: `repeat(3, ${Math.round(SPRITE_W * ROLE_ZOOM)}px)`,
                  gridTemplateRows: `repeat(3, ${Math.round(SPRITE_H * ROLE_ZOOM)}px)`,
                }}>
                  {RUG_ROLE_GRID.flat().map((role, i) => {
                    if (!role) return <div key={i} />;
                    const tileId = draft.pieces[role] ?? '';
                    const preview = tileId ? tilePreviewStyle(tileId, sheets, ROLE_ZOOM) : null;
                    return (
                      <div
                        key={role}
                        className={`${s.roleCell} ${armedRole === role ? s.roleCellActive : ''} ${tileId ? s.roleCellFilled : ''}`}
                        onClick={() => setArmedRole(armedRole === role ? null : role)}
                        title={tileId || role}
                      >
                        <span className={s.roleLabelBadge}>{role}</span>
                        {preview ? (
                          <div className={s.roleCellSprite} style={preview} />
                        ) : (
                          <span className={s.roleCellPlaceholder}>{tileId ? tileId.split('_').pop() : '+'}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className={s.fieldRow}>
                  <span className={s.fieldLabel}>{t('rugEditor.minWidth', { defaultValue: 'Min width' })}</span>
                  <input type="number" min={2} className={s.fieldInput} value={draft.minWidth}
                    onChange={e => updateDraft({ minWidth: Math.max(2, Number(e.target.value)) })} />
                </div>
                <div className={s.fieldRow}>
                  <span className={s.fieldLabel}>{t('rugEditor.minHeight', { defaultValue: 'Min height' })}</span>
                  <input type="number" min={2} className={s.fieldInput} value={draft.minHeight}
                    onChange={e => updateDraft({ minHeight: Math.max(2, Number(e.target.value)) })} />
                </div>
              </>
            ) : (
              <>
                <div className={s.sectionTitle}>{t('rugEditor.sizes', { defaultValue: 'Fixed sizes' })}</div>
                {draft.preassembledSizes.map((size, sIdx) => (
                  <div key={sIdx} className={s.sizeCard}>
                    <div className={s.sizeCardHeader}>
                      <span className={s.sizeDimLabel}>W</span>
                      <input type="number" min={1} className={s.fieldInput} style={{ flex: '0 1 42px', minWidth: 0 }}
                        value={size.width} onChange={e => resizeSize(sIdx, Number(e.target.value), size.height)} />
                      <span className={s.sizeDimLabel}>H</span>
                      <input type="number" min={1} className={s.fieldInput} style={{ flex: '0 1 42px', minWidth: 0 }}
                        value={size.height} onChange={e => resizeSize(sIdx, size.width, Number(e.target.value))} />
                      <button className={`${s.smallBtn} ${s.removeBtn}`} onClick={() => removeSize(sIdx)}>✕</button>
                    </div>
                    <div className={s.layoutGrid} style={{
                      gridTemplateColumns: `repeat(${size.width}, ${Math.round(SPRITE_W * LAYOUT_ZOOM)}px)`,
                      gridTemplateRows: `repeat(${size.height}, ${Math.round(SPRITE_H * LAYOUT_ZOOM)}px)`,
                    }}>
                      {size.tileLayout.flatMap((row, ri) => row.map((cellId, ci) => {
                        const isSel = selectedSizeIdx === sIdx && selectedCell?.row === ri && selectedCell?.col === ci;
                        const preview = cellId ? tilePreviewStyle(cellId, sheets, LAYOUT_ZOOM) : null;
                        return (
                          <div
                            key={`${ri}-${ci}`}
                            className={`${s.layoutCell} ${isSel ? s.layoutCellSelected : ''} ${cellId ? s.layoutCellFilled : ''}`}
                            onClick={() => { setSelectedSizeIdx(sIdx); setSelectedCell({ row: ri, col: ci }); }}
                            title={cellId || `${ri},${ci}`}
                          >
                            {preview ? (
                              <div className={s.layoutCellSprite} style={preview} />
                            ) : (
                              <span className={s.layoutCellPlaceholder}>{cellId ? cellId.split('_').pop() : '+'}</span>
                            )}
                          </div>
                        );
                      }))}
                    </div>
                  </div>
                ))}
                <button className={s.smallBtn} onClick={addSize}>{t('rugEditor.addSize', { defaultValue: '+ Add size' })}</button>
              </>
            )}

            <div className={s.saveBar}>
              <button className={s.saveBtn} disabled={saveState === 'saving' || !dirty} onClick={handleSave}>
                {saveState === 'saving' ? t('rugEditor.saving', { defaultValue: 'Saving…' })
                  : saveState === 'ok'  ? t('rugEditor.saved', { defaultValue: 'Saved' })
                  : saveState === 'err' ? t('rugEditor.saveError', { defaultValue: 'Save failed' })
                  : t('rugEditor.save', { defaultValue: 'Save' })}
              </button>
              {selectedId && (
                <button className={s.deleteBtn} onClick={handleDelete}>{t('rugEditor.delete', { defaultValue: 'Delete' })}</button>
              )}
            </div>
          </>
        ) : (
          <p className={s.emptyHint}>{t('rugEditor.selectOrNew', { defaultValue: 'Select a rug design or create a new one.' })}</p>
        )}
      </div>
    </div>
  );
}
