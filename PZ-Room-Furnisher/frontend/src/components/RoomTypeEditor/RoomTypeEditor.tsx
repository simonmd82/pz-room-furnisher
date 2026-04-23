import { useState, useEffect, useCallback } from 'react';
import { ROOM_TYPES } from '../../types/tiles';
import { SLOT_TYPES, SIZE_KEYS, defaultSlot, defaultRoomTypeConfig } from '../../types/roomTypes';
import type { RoomTypeConfig, RoomTypeConfigMap, SlotSizeConfig, RoomTypeSlot } from '../../types/roomTypes';
import {
  getRoomTypes, saveRoomType, deleteRoomType,
  getSlotSizes, saveSlotSizes,
} from '../../api/roomTypesApi';
import s from './RoomTypeEditor.module.css';

const KNOWN_GROUPS = [
  'Beds', 'Bedtable', 'Cabinet', 'Mirror', 'Walldecoration',
  'Chair', 'Sofa', 'Table', 'DiningChair', 'Shelf',
  'Lamp', 'Plant', 'Decoration', 'Appliance', 'Storage',
];

const SIZE_LABELS: Record<string, string> = {
  XS: '1–4 Felder', S: '5–12 Felder', M: '13–25 Felder', L: '26–50 Felder', XL: '51+ Felder',
};
const SIZE_EXAMPLES: Record<string, string> = {
  XS: 'Bad, Klo', S: 'Kleines Zimmer', M: 'Schlafzimmer', L: 'Wohnzimmer', XL: 'Halle, Garage',
};

export function RoomTypeEditor() {
  const [configs, setConfigs] = useState<RoomTypeConfigMap>({});
  const [slotSizes, setSlotSizes] = useState<SlotSizeConfig>({ smallMax: 1, mediumMax: 2, largeMax: 4 });
  const [slotSizesDraft, setSlotSizesDraft] = useState<SlotSizeConfig>({ smallMax: 1, mediumMax: 2, largeMax: 4 });
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<RoomTypeConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [newRoomName, setNewRoomName] = useState('');

  useEffect(() => {
    Promise.all([getRoomTypes(), getSlotSizes()]).then(([cfgs, sizes]) => {
      setConfigs(cfgs);
      setSlotSizes(sizes);
      setSlotSizesDraft(sizes);
    }).catch(console.error);
  }, []);

  const selectRoom = useCallback((rt: string) => {
    setSelected(rt);
    setDraft(configs[rt]
      ? { ...configs[rt], slots: configs[rt].slots.map(sl => ({ ...sl, groups: [...sl.groups] })) }
      : defaultRoomTypeConfig(rt));
    setDirty(false);
    setStatus(null);
  }, [configs]);

  const updateSlot = (idx: number, patch: Partial<RoomTypeSlot>) => {
    if (!draft) return;
    setDraft({ ...draft, slots: draft.slots.map((sl, i) => i === idx ? { ...sl, ...patch } : sl) });
    setDirty(true);
  };

  const addSlot = () => {
    if (!draft) return;
    setDraft({ ...draft, slots: [...draft.slots, defaultSlot()] });
    setDirty(true);
  };

  const removeSlot = (idx: number) => {
    if (!draft) return;
    setDraft({ ...draft, slots: draft.slots.filter((_, i) => i !== idx) });
    setDirty(true);
  };

  const toggleGroup = (slotIdx: number, group: string) => {
    if (!draft) return;
    const slot = draft.slots[slotIdx];
    const groups = slot.groups.includes(group)
      ? slot.groups.filter(g => g !== group)
      : [...slot.groups, group];
    updateSlot(slotIdx, { groups });
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true); setStatus(null);
    try {
      const saved = await saveRoomType(draft);
      setConfigs(prev => ({ ...prev, [saved.roomType]: saved }));
      setDraft(saved); setDirty(false); setStatus('✓ Gespeichert');
    } catch (e) { setStatus('Fehler: ' + String(e)); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!selected || !window.confirm(`"${selected}" wirklich löschen?`)) return;
    await deleteRoomType(selected);
    setConfigs(prev => { const n = { ...prev }; delete n[selected]; return n; });
    setSelected(null); setDraft(null);
  };

  const handleAddNew = () => {
    const name = newRoomName.trim();
    if (!name) return;
    setNewRoomName('');
    // selectRoom reads from configs, but new room isn't there yet – build draft directly
    setSelected(name);
    setDraft(defaultRoomTypeConfig(name));
    setDirty(true);
    setStatus(null);
  };

  const handleSaveSlotSizes = async () => {
    try {
      const saved = await saveSlotSizes(slotSizesDraft);
      setSlotSizes(saved); setSlotSizesDraft(saved);
      setStatus('✓ Slot-Größen gespeichert');
    } catch (e) { setStatus('Fehler: ' + String(e)); }
  };

  const allRooms = Array.from(new Set([...ROOM_TYPES, ...Object.keys(configs)]));

  return (
    <div className={s.layout}>
      {/* ── Left: list ── */}
      <div className={s.listPanel}>
        <div className={s.panelHeader}>
          <span className={s.panelTitle}>🏠 Raumtypen</span>
        </div>
        <div className={s.list}>
          {allRooms.map(rt => (
            <div key={rt} className={`${s.listItem} ${selected === rt ? s.listItemActive : ''}`} onClick={() => selectRoom(rt)}>
              <span className={s.listItemName}>{rt}</span>
              {configs[rt] && <span className={s.listItemBadge}>{configs[rt].slots.length}</span>}
            </div>
          ))}
        </div>

        {/* Add custom room */}
        <div style={{ padding: '8px 10px', borderTop: '1px solid #2a2a3a', display: 'flex', gap: 4 }}>
          <input
            className={s.slotSizeInput} style={{ flex: 1, width: 'auto' }}
            placeholder="Neuer Typ…" value={newRoomName}
            onChange={e => setNewRoomName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAddNew()}
          />
          <button className={s.slotSizeBtn} style={{ width: 'auto', margin: 0, padding: '3px 10px' }} onClick={handleAddNew}>+</button>
        </div>

        {/* Slot size config */}
        <div className={s.slotSizeBox}>
          <div className={s.slotSizeTitle}>Slot-Größen (global)</div>
          <div className={s.slotSizeRow}>
            <span className={s.slotSizeLabel}>small ≤</span>
            <input type="number" min={1} max={99} className={s.slotSizeInput}
              value={slotSizesDraft.smallMax}
              onChange={e => setSlotSizesDraft(p => ({ ...p, smallMax: +e.target.value }))} />
            <span className={s.slotSizeUnit}>Feld(er)</span>
          </div>
          <div className={s.slotSizeRow}>
            <span className={s.slotSizeLabel}>medium ≤</span>
            <input type="number" min={1} max={99} className={s.slotSizeInput}
              value={slotSizesDraft.mediumMax}
              onChange={e => setSlotSizesDraft(p => ({ ...p, mediumMax: +e.target.value }))} />
            <span className={s.slotSizeUnit}>Felder</span>
          </div>
          <div className={s.slotSizeRow}>
            <span className={s.slotSizeLabel}>large ≤</span>
            <input type="number" min={1} max={99} className={s.slotSizeInput}
              value={slotSizesDraft.largeMax}
              onChange={e => setSlotSizesDraft(p => ({ ...p, largeMax: +e.target.value }))} />
            <span className={s.slotSizeUnit}>Felder</span>
          </div>
          <div className={s.slotSizeHint}>extralarge &gt; {slotSizesDraft.largeMax ?? 4} Felder</div>
          <button className={s.slotSizeBtn} onClick={handleSaveSlotSizes}>Speichern</button>
        </div>
      </div>

      {/* ── Center: editor ── */}
      <div className={s.editorPanel}>
        {!draft ? (
          <div className={s.hint}>← Raumtyp auswählen oder neu anlegen</div>
        ) : (<>
          <div className={s.editorHeader}>
            <span className={s.editorTitle}>{draft.roomType}</span>
            {configs[draft.roomType] && (
              <button className={s.deleteBtn} onClick={handleDelete}>Löschen</button>
            )}
          </div>

          <div className={s.slotsHeader}>
            <span className={s.slotsLabel}>Slots ({draft.slots.length})</span>
            <button className={s.addSlotBtn} onClick={addSlot}>+ Slot hinzufügen</button>
          </div>

          {draft.slots.length === 0 && (
            <div className={s.hint} style={{ padding: '12px' }}>Noch keine Slots – klicke "+ Slot hinzufügen"</div>
          )}

          {draft.slots.map((slot, idx) => (
            <div key={idx} className={`${s.slotCard} ${slot.required ? s.slotCardRequired : ''}`}>
              <div className={s.slotCardHeader}>
                <span className={s.slotIndex}>#{idx + 1}</span>

                <select className={s.slotSelect} value={slot.slotType}
                  onChange={e => updateSlot(idx, { slotType: e.target.value as 'small' | 'medium' | 'large' })}>
                  {SLOT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>

                <label className={s.slotCheck}>
                  <input type="checkbox" checked={slot.required}
                    onChange={e => updateSlot(idx, { required: e.target.checked })} />
                  Pflicht
                </label>

                <span className={s.slotFieldSmall}>
                  Prio
                  <input type="number" min={0} max={99} className={s.slotNumInput}
                    value={slot.priority} onChange={e => updateSlot(idx, { priority: +e.target.value })} />
                </span>

                <button className={s.removeSlotBtn} onClick={() => removeSlot(idx)}>✕</button>
              </div>

              <div className={s.slotCardBody}>
                {/* Min/Max per room size table */}
                <div className={s.sizeTableWrap}>
                <table className={s.sizeTable}>
                  <thead>
                    <tr>
                      <th className={s.sizeTableLead}></th>
                      {SIZE_KEYS.map(sz => (
                        <th key={sz} className={s.sizeTableHead}
                          title={`${sz}: ${SIZE_LABELS[sz]} (${SIZE_EXAMPLES[sz]})`}>
                          {sz}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className={s.sizeTableLead}>Min</td>
                      {SIZE_KEYS.map(sz => (
                        <td key={sz}>
                          <input type="number" min={0} max={99} className={s.sizeNumInput}
                            value={slot.countBySize[sz].min}
                            onChange={e => updateSlot(idx, {
                              countBySize: { ...slot.countBySize, [sz]: { ...slot.countBySize[sz], min: +e.target.value } }
                            })} />
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className={s.sizeTableLead}>Max</td>
                      {SIZE_KEYS.map(sz => (
                        <td key={sz}>
                          <input type="number" min={-1} max={99} className={s.sizeNumInput}
                            value={slot.countBySize[sz].max}
                            onChange={e => updateSlot(idx, {
                              countBySize: { ...slot.countBySize, [sz]: { ...slot.countBySize[sz], max: +e.target.value } }
                            })} />
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
                </div>
                <div className={s.slotHint} style={{ marginTop: 2 }}>Max -1 = unbegrenzt</div>
                <div className={s.slotRow}>
                  <span className={s.slotGroupLabel}>
                    Möbelgruppen{' '}
                    <span style={{ color: '#446', fontStyle: 'italic' }}>
                      {slot.groups.length === 0 ? '(alle passenden)' : `(${slot.groups.length} gewählt)`}
                    </span>
                  </span>
                  {slot.groups.length > 0 && (
                    <span className={s.slotPreviewCount} style={{ cursor: 'pointer' }}
                      onClick={() => updateSlot(idx, { groups: [] })}>
                      Auswahl löschen ✕
                    </span>
                  )}
                </div>
                <div className={s.chipGroup}>
                  {KNOWN_GROUPS.map(g => (
                    <span key={g}
                      className={`${s.chip} ${slot.groups.includes(g) ? s.chipActive : ''}`}
                      onClick={() => toggleGroup(idx, g)}>
                      {g}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}

          <button className={s.saveBtn} disabled={!dirty || saving} onClick={handleSave}>
            {saving ? 'Speichert…' : `💾 ${draft.roomType} speichern`}
          </button>

          {status && (
            <div style={{ fontSize: '0.76rem', color: status.startsWith('✓') ? '#6c6' : '#f88', textAlign: 'center' }}>
              {status}
            </div>
          )}
        </>)}
      </div>

      {/* ── Right: reference ── */}
      <div className={s.refPanel}>
        <div className={s.panelHeader} style={{ padding: '8px 10px' }}>
          <span className={s.panelTitle}>Raumgrößen Referenz</span>
        </div>
        <div className={s.refTable}>
          {Object.entries(SIZE_LABELS).map(([size, range]) => (
            <div key={size} className={s.refRow}>
              <span className={s.refSize}>{size}</span>
              <span className={s.refRange}>{range}</span>
              <span className={s.refEx}>{SIZE_EXAMPLES[size]}</span>
            </div>
          ))}
        </div>
        <div className={s.refSlotBox}>
          <div className={s.refSlotRow}>
            <span className={s.refSlotLabel}>small</span>
            <span>≤ {slotSizes.smallMax} Feld(er)</span>
          </div>
          <div className={s.refSlotRow}>
            <span className={s.refSlotLabel}>medium</span>
            <span>≤ {slotSizes.mediumMax} Felder</span>
          </div>
          <div className={s.refSlotRow}>
            <span className={s.refSlotLabel}>large</span>
            <span>≤ {slotSizes.largeMax ?? 4} Felder</span>
          </div>
          <div className={s.refSlotRow}>
            <span className={s.refSlotLabel}>extralarge</span>
            <span>&gt; {slotSizes.largeMax ?? 4} Felder</span>
          </div>
        </div>
        <p className={s.refNote}>
          <strong>Footprint</strong> = nicht-leere Zellen im tileLayout.<br /><br />
          <strong>Pflicht-Slots</strong> werden immer befüllt.<br /><br />
          <strong>Optionale Slots</strong> nach Priorität (0 = zuerst) bis keine Felder mehr frei.<br /><br />
          <strong>Max -1</strong> = unbegrenzt.<br /><br />
          <strong>Gruppen leer</strong> = alle Möbel passender Größe mit passendem roomType.
        </p>
      </div>
    </div>
  );
}












