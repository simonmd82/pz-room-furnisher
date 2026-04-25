import { useState, useEffect, useCallback } from 'react';
import {
  SIZE_KEYS, ANCHOR_POSITIONS, REQUIRED_PROPERTIES, FURNITURE_LAYERS,
  COMMON_FOOTPRINTS, defaultSlot, defaultRoomTypeConfig, defaultPlacementRules,
} from '../../types/roomTypes';
import type { AnchorRule, RoomTypeConfig, RoomTypeConfigMap, RoomTypeSlot } from '../../types/roomTypes';
import { getRoomTypes, saveRoomType, deleteRoomType } from '../../api/roomTypesApi';
import { getRoomTypeNames, saveRoomTypeNames, getCategories } from '../../api/settingsApi';
import { getGroups } from '../../api/tilesApi';
import { TILE_PROPERTY_LABELS_DE } from '../../types/tiles';
import s from './RoomTypeEditor.module.css';

const FALLBACK_GROUPS = [
  'Beds', 'Bedtable', 'Cabinet', 'Mirror', 'Walldecoration',
  'Chair', 'Sofa', 'Table', 'DiningChair', 'Shelf',
  'Lamp', 'Plant', 'Decoration', 'Appliance', 'Storage',
];

/** Farbpalette für Slot-Gruppen (zyklisch) */
const GROUP_COLORS = [
  '#c87941', '#41a8c8', '#7ec841', '#9c41c8',
  '#c84141', '#41c8a0', '#c8b841', '#4160c8',
];

function getGroupColor(groupId: string, allGroupIds: string[]): string {
  const idx = allGroupIds.indexOf(groupId);
  return GROUP_COLORS[idx % GROUP_COLORS.length];
}

const SLOT_INFO_TEXT = `\
📦 Slot-Konzepte auf einen Blick

• Jeder Slot ist eine „Anfrage" an den Generator.
  Er legt fest: Größe, Kategorie, Platzierungsregeln.

• Fußabdruck (B × H): Wie viele Zellen im Raum belegt werden.
  „Drehbar" erlaubt dem Generator B und H zu tauschen.

• Pflicht-Slot: Wird immer befüllt, egal wie groß der Raum.

• Priorität: Optionale Slots werden in Reihenfolge der Priorität
  gezogen (0 = zuerst). Bei gleicher Prio zufällig.

• Anker-Regeln: Verknüpft diesen Slot relativ zu einem anderen.
  – Anker-Ziel: Slot-ID eines anderen Slots ODER eine Varianten-Gruppen-ID.
    (Gruppen-ID → der Generator nimmt den tatsächlich gewählten Slot der Gruppe.)
  – Positionen (OR): Mehrere Positionen = Generator wählt eine davon.
    Beispiel: HeadLeft + HeadRight → Nachttisch links oder rechts vom Bett.
  – AND (beide Seiten gleichzeitig): Zwei separate Slots mit je einer Regel,
    einer mit „HeadLeft", einer mit „HeadRight".
  – Mehrere Regeln: Wenn der Anker eine Gruppen-ID ist, kann pro
    Gruppen-Variante eine eigene Regel mit anderen Positionen hinterlegt werden.

• 🔀 Varianten-Gruppe (one-of):
  Mehrere Slots in einer Gruppe → der Generator wählt genau
  EINE Variante aus und ignoriert die anderen.
  Beispiel Wohnzimmer:
    Gruppe "sitz" – Variante A: 1× Sofa (Gewicht 3)
    Gruppe "sitz" – Variante B: Sofa + Tisch (Gewicht 2)
  → Wahrscheinlichkeit A = 3/5, B = 2/5

  Zur Variante können auch verknüpfte Anker-Slots gehören
  (die Anker-Slots teilen keine eigene Gruppen-ID – sie
  werden automatisch mitgezogen wenn ihr Haupt-Slot gewählt wird).`;

const PLACEMENT_RULE_LABELS: Record<string, string> = {
  nearWall:   'An der Wand',
  nearDoor:   'An einer Tür',
  nearWindow: 'An einem Fenster',
  centerRoom: 'Raummitte',
  cornerOnly: 'Nur in Ecken',
};

const SIZE_LABELS: Record<string, string> = {
  XS: '1–4 Felder', S: '5–12 Felder', M: '13–25 Felder', L: '26–50 Felder', XL: '51+ Felder',
};
const SIZE_EXAMPLES: Record<string, string> = {
  XS: 'Bad, Klo', S: 'Kleines Zimmer', M: 'Schlafzimmer', L: 'Wohnzimmer', XL: 'Halle, Garage',
};

export function RoomTypeEditor() {
  const [configs, setConfigs]         = useState<RoomTypeConfigMap>({});
  const [knownRooms, setKnownRooms]   = useState<string[]>([]);
  const [availGroups, setAvailGroups] = useState<string[]>(FALLBACK_GROUPS);
  const [selected, setSelected]       = useState<string | null>(null);
  const [draft, setDraft]             = useState<RoomTypeConfig | null>(null);
  const [dirty, setDirty]             = useState(false);
  const [saving, setSaving]           = useState(false);
  const [status, setStatus]           = useState<string | null>(null);
  const [newRoomName, setNewRoomName] = useState('');
  const [infoOpen, setInfoOpen]       = useState(false);
  /** Indices der eingeklappten Slot-Karten */
  const [collapsedSlots, setCollapsedSlots] = useState<Set<number>>(new Set());

  useEffect(() => {
    getRoomTypes().then(cfgs => setConfigs(cfgs)).catch(console.error);
    getRoomTypeNames().then(names => setKnownRooms(names)).catch(console.error);
    // Kategorien primär aus Settings laden, Tile-DB-Gruppen als Ergänzung
    Promise.all([getCategories(), getGroups()]).then(([cats, tileGroups]) => {
      const merged = Array.from(new Set([...cats, ...tileGroups]));
      setAvailGroups(merged.length > 0 ? merged : FALLBACK_GROUPS);
    }).catch(console.error);
  }, []);

  const selectRoom = useCallback((rt: string) => {
    setSelected(rt);
    setDraft(configs[rt]
      ? {
          ...configs[rt],
          slots: configs[rt].slots.map(sl => {
            // Migration: alte anchorSlotId/anchorPosition → anchorRules
            const legacyAnchor = (sl as any).anchorSlotId as string | undefined;
            const legacyPos    = (sl as any).anchorPosition as string | undefined;
            const migratedRules: AnchorRule[] = sl.anchorRules?.length
              ? sl.anchorRules
              : legacyAnchor
                ? [{ anchorTarget: legacyAnchor, positions: legacyPos ? [legacyPos as typeof ANCHOR_POSITIONS[number]] : [] }]
                : [];
            return {
              ...defaultSlot(),
              ...sl,
              footprint: { width: 1, height: 1, ...(sl.footprint ?? {}) },
              allowedCategories: { ...(sl.allowedCategories ?? {}) },
              placementRules: { ...defaultPlacementRules(), ...(sl.placementRules ?? {}) },
              requiredProperties: [...(sl.requiredProperties ?? [])],
              anchorRules: migratedRules,
            };
          })
        }
      : defaultRoomTypeConfig(rt));
    setDirty(false);
    setStatus(null);
    // Alle Slots beim Raumwechsel einklappen
    setCollapsedSlots(prev => {
      if (configs[rt]) {
        const all = new Set<number>(configs[rt].slots.map((_, i) => i));
        return all;
      }
      return new Set();
    });
  }, [configs]);

  const updateSlot = (idx: number, patch: Partial<RoomTypeSlot>) => {
    if (!draft) return;
    setDraft({ ...draft, slots: draft.slots.map((sl, i) => i === idx ? { ...sl, ...patch } : sl) });
    setDirty(true);
  };

  const addSlot = () => {
    if (!draft) return;
    const newIdx = draft.slots.length;
    setDraft({ ...draft, slots: [...draft.slots, defaultSlot()] });
    setDirty(true);
    // Alle bestehenden einklappen, neuen aufklappen
    setCollapsedSlots(prev => {
      const next = new Set<number>();
      for (let i = 0; i < newIdx; i++) next.add(i);
      return next;
    });
  };

  const removeSlot = (idx: number, slotLabel: string) => {
    if (!draft) return;
    const name = slotLabel.trim() || `#${idx + 1}`;
    if (!window.confirm(`Slot „${name}" wirklich löschen?`)) return;
    setDraft({ ...draft, slots: draft.slots.filter((_, i) => i !== idx) });
    setDirty(true);
    // Indizes nach dem gelöschten verschieben
    setCollapsedSlots(prev => {
      const next = new Set<number>();
      prev.forEach(i => { if (i < idx) next.add(i); else if (i > idx) next.add(i - 1); });
      return next;
    });
  };

  const toggleGroup = (slotIdx: number, group: string) => {
    if (!draft) return;
    const slot = draft.slots[slotIdx];
    const cats = { ...slot.allowedCategories };
    if (cats[group] !== undefined) {
      delete cats[group];
    } else {
      cats[group] = 5; // Standardgewichtung
    }
    updateSlot(slotIdx, { allowedCategories: cats });
  };

  const setCategoryWeight = (slotIdx: number, group: string, weight: number) => {
    if (!draft) return;
    const cats = { ...draft.slots[slotIdx].allowedCategories, [group]: Math.max(1, Math.min(10, weight)) };
    updateSlot(slotIdx, { allowedCategories: cats });
  };

  const toggleRequiredProperty = (slotIdx: number, prop: string) => {
    if (!draft) return;
    const slot = draft.slots[slotIdx];
    const props = slot.requiredProperties.includes(prop)
      ? slot.requiredProperties.filter(p => p !== prop)
      : [...slot.requiredProperties, prop];
    updateSlot(slotIdx, { requiredProperties: props });
  };

  const addAnchorRule = (slotIdx: number) => {
    if (!draft) return;
    const rules = [...draft.slots[slotIdx].anchorRules, { anchorTarget: '', positions: [] }];
    updateSlot(slotIdx, { anchorRules: rules });
  };

  const removeAnchorRule = (slotIdx: number, ruleIdx: number) => {
    if (!draft) return;
    const rules = draft.slots[slotIdx].anchorRules.filter((_, i) => i !== ruleIdx);
    updateSlot(slotIdx, { anchorRules: rules });
  };

  const updateAnchorRule = (slotIdx: number, ruleIdx: number, patch: Partial<AnchorRule>) => {
    if (!draft) return;
    const rules = draft.slots[slotIdx].anchorRules.map((r, i) => i === ruleIdx ? { ...r, ...patch } : r);
    updateSlot(slotIdx, { anchorRules: rules });
  };

  const toggleAnchorPosition = (slotIdx: number, ruleIdx: number, pos: typeof ANCHOR_POSITIONS[number]) => {
    if (!draft) return;
    const rule = draft.slots[slotIdx].anchorRules[ruleIdx];
    const positions = rule.positions.includes(pos)
      ? rule.positions.filter(p => p !== pos)
      : [...rule.positions, pos] as typeof ANCHOR_POSITIONS[number][];
    updateAnchorRule(slotIdx, ruleIdx, { positions });
  };

  const duplicateSlot = (idx: number) => {
    if (!draft) return;
    const copy = { ...draft.slots[idx], id: draft.slots[idx].id ? draft.slots[idx].id + '_copy' : '' };
    const newSlots = [...draft.slots];
    newSlots.splice(idx + 1, 0, copy);
    setDraft({ ...draft, slots: newSlots });
    setDirty(true);
    // Bisherige collapsed-Indices ab idx+1 um 1 verschieben, Duplikat aufklappen
    setCollapsedSlots(prev => {
      const next = new Set<number>();
      prev.forEach(i => { next.add(i <= idx ? i : i + 1); });
      return next; // Duplikat (idx+1) ist nicht in Set → aufgeklappt
    });
  };

  const handleSave = async () => {
    if (!draft) return;
    // Validierung: Layer ist Pflichtfeld
    const missingLayer = draft.slots.findIndex(sl => !sl.requiredLayer);
    if (missingLayer !== -1) {
      const name = draft.slots[missingLayer].label || draft.slots[missingLayer].id || `#${missingLayer + 1}`;
      setStatus(`⚠ Slot „${name}" hat keinen Layer – bitte Layer auswählen.`);
      // Slot aufklappen damit der Nutzer ihn sieht
      setCollapsedSlots(prev => { const next = new Set(prev); next.delete(missingLayer); return next; });
      return;
    }
    setSaving(true); setStatus(null);
    try {
      const raw = await saveRoomType(draft);
      // Fehlende / null-Felder aus dem Backend normalisieren
      const saved: RoomTypeConfig = {
        ...raw,
        slots: raw.slots.map(sl => ({
          ...defaultSlot(),
          ...sl,
          footprint:          { width: 1, height: 1, ...(sl.footprint ?? {}) },
          allowedCategories:  { ...(sl.allowedCategories ?? {}) },
          placementRules:     { ...defaultPlacementRules(), ...(sl.placementRules ?? {}) },
          requiredProperties: [...(sl.requiredProperties ?? [])],
          anchorRules:        sl.anchorRules ?? [],
        })),
      };
      setConfigs(prev => ({ ...prev, [saved.roomType]: saved }));
      setDraft(saved); setDirty(false); setStatus('✓ Gespeichert');
      // Nach Speichern alle Slots einklappen
      setCollapsedSlots(new Set(saved.slots.map((_, i) => i)));
    } catch (e) { setStatus('Fehler: ' + String(e)); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!selected || !window.confirm(`"${selected}" wirklich löschen?`)) return;
    await deleteRoomType(selected);
    setConfigs(prev => { const n = { ...prev }; delete n[selected]; return n; });
    // also remove from knownRooms
    const updated = knownRooms.filter(r => r !== selected);
    setKnownRooms(updated);
    await saveRoomTypeNames(updated);
    setSelected(null); setDraft(null);
  };

  const handleRemoveRoom = async (rt: string) => {
    if (!window.confirm(`"${rt}" aus der Liste entfernen${configs[rt] ? ' und die gespeicherte Konfiguration löschen' : ''}?`)) return;
    if (configs[rt]) {
      await deleteRoomType(rt);
      setConfigs(prev => { const n = { ...prev }; delete n[rt]; return n; });
    }
    const updated = knownRooms.filter(r => r !== rt);
    setKnownRooms(updated);
    await saveRoomTypeNames(updated);
    if (selected === rt) { setSelected(null); setDraft(null); }
  };

  const handleAddNew = async () => {
    const name = newRoomName.trim();
    if (!name || knownRooms.includes(name)) return;
    const updated = [...knownRooms, name];
    setKnownRooms(updated);
    await saveRoomTypeNames(updated);
    setNewRoomName('');
    setSelected(name);
    setDraft(defaultRoomTypeConfig(name));
    setDirty(true);
    setStatus(null);
  };

  const allRooms = knownRooms;

  return (
    <div className={s.layout}>
      {/* ── Left: list ── */}
      <div className={s.listPanel}>
        <div className={s.panelHeader}>
          <span className={s.panelTitle}>🏠 Raumtypen</span>
        </div>
        <div className={s.list}>
          {allRooms.map(rt => (
            <div key={rt} className={`${s.listItem} ${selected === rt ? s.listItemActive : ''}`}
              onClick={() => selectRoom(rt)}>
              <span className={s.listItemName}>{rt}</span>
              {configs[rt] && <span className={s.listItemBadge}>{configs[rt].slots.length}</span>}
              <span className={s.listItemRemove} title={`"${rt}" entfernen`}
                onClick={e => { e.stopPropagation(); handleRemoveRoom(rt); }}>✕</span>
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
      </div>

      {/* ── Right: editor + ref footer ── */}
      <div className={s.rightPane}>
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
              <button
                className={`${s.infoBtn} ${infoOpen ? s.infoBtnActive : ''}`}
                onClick={() => setInfoOpen(v => !v)}
                title="Konzepte erklären">
                ℹ
              </button>
              <button className={s.addSlotBtn} onClick={addSlot}>+ Slot hinzufügen</button>
            </div>

            {infoOpen && (
              <pre className={s.infoPanel}>{SLOT_INFO_TEXT}</pre>
            )}

            {draft.slots.length === 0 && (
              <div className={s.hint} style={{ padding: '12px' }}>Noch keine Slots – klicke "+ Slot hinzufügen"</div>
            )}

            {(() => {
              // Eindeutige, nicht-leere Gruppen-IDs (für Farb-Zuweisung)
              const uniqueGroupIds = Array.from(new Set(
                draft.slots.map(sl => sl.slotGroupId).filter(g => g)
              ));
              // Alle vorhandenen Slot-IDs als Datalist für Anker
              return draft.slots.map((slot, idx) => {
                const groupColor = slot.slotGroupId
                  ? getGroupColor(slot.slotGroupId, uniqueGroupIds)
                  : undefined;
                const isCollapsed = collapsedSlots.has(idx);
                const toggleCollapse = () => setCollapsedSlots(prev => {
                  const next = new Set(prev);
                  next.has(idx) ? next.delete(idx) : next.add(idx);
                  return next;
                });
                return (
              <div key={idx}
                className={`${s.slotCard} ${slot.required ? s.slotCardRequired : ''} ${slot.slotGroupId ? s.slotCardGrouped : ''}`}
                style={groupColor ? { '--group-color': groupColor } as React.CSSProperties : undefined}>

                {/* ── Zusammengeklappte Zusammenfassung (immer sichtbar) ── */}
                <div className={s.slotSummaryBar} onClick={toggleCollapse} style={{ cursor: 'pointer' }}>
                  <span className={s.slotIndex}>#{idx + 1}</span>
                  <span className={s.collapseToggleIcon}>{isCollapsed ? '▶' : '▼'}</span>
                  <span className={s.slotSummaryId} style={{ color: slot.id ? '#aac' : '#446', fontStyle: slot.id ? 'normal' : 'italic' }}>
                    {slot.id || 'keine ID'}
                  </span>
                  {slot.label && <span className={s.slotSummaryLabel}>{slot.label}</span>}
                  <span className={s.slotSummaryBadge} style={{ background: slot.required ? '#2a4a2a' : '#2a2a4a', color: slot.required ? '#6c6' : '#88a' }}>
                    {slot.required ? 'Pflicht' : 'Optional'}
                  </span>
                  <span className={s.slotSummaryBadge} style={{ background: '#1a2a3a', color: '#68a' }}>
                    {slot.footprint.width}×{slot.footprint.height}
                  </span>
                  {!slot.slotGroupId && !slot.required && (
                    <span className={s.slotSummaryBadge} style={{ background: '#1a1a2a', color: '#778' }}
                      title="Priorität: Optionale Slots werden in aufsteigender Reihenfolge gezogen (0 = zuerst)">
                      P{slot.priority}
                    </span>
                  )}
                  {slot.slotGroupId && (
                    <span className={s.slotSummaryBadge} style={{ background: '#2a1a2a', color: groupColor ?? '#a8a' }}>
                      🔀 {slot.slotGroupId}
                    </span>
                  )}
                  {slot.anchorRules.length > 0 && (
                    <span className={s.slotSummaryBadge} style={{ background: '#1a2a1a', color: '#8c8' }}>
                      📎 {slot.anchorRules.length === 1
                        ? `${slot.anchorRules[0].anchorTarget || '?'} → ${slot.anchorRules[0].positions.join('/') || '?'}`
                        : `${slot.anchorRules.length} Anker`}
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  <button className={s.duplicateSlotBtn} title="Slot duplizieren"
                    onClick={e => { e.stopPropagation(); duplicateSlot(idx); }}>⎘</button>
                  <button className={s.removeSlotBtn}
                    onClick={e => { e.stopPropagation(); removeSlot(idx, slot.label || slot.id); }}>✕</button>
                </div>

                {/* ── Aufgeklappter Inhalt ── */}
                {!isCollapsed && (<>
                <div className={s.slotCardHeader}>
                  <span className={s.slotIndex} style={{ visibility: 'hidden' }}>#{idx + 1}</span>

                  {/* Footprint: Schnellauswahl + manuelle Eingabe */}
                  <span className={s.slotGroupLabel} style={{ whiteSpace: 'nowrap' }}>B×H</span>
                  <input type="number" min={1} max={5} className={s.slotNumInput}
                    title="Breite (Spalten)"
                    value={slot.footprint.width}
                    onChange={e => updateSlot(idx, { footprint: { ...slot.footprint, width: Math.max(1, Math.min(5, +e.target.value)) } })} />
                  <span style={{ color: '#446' }}>×</span>
                  <input type="number" min={1} max={5} className={s.slotNumInput}
                    title="Höhe (Zeilen)"
                    value={slot.footprint.height}
                    onChange={e => updateSlot(idx, { footprint: { ...slot.footprint, height: Math.max(1, Math.min(5, +e.target.value)) } })} />
                  {/* canRotate toggle – nur sinnvoll bei nicht-quadratischen Footprints */}
                  {slot.footprint.width !== slot.footprint.height && (
                    <span
                      className={`${s.chip} ${slot.footprint.canRotate ? s.chipActive : ''}`}
                      title="Drehbar: Slot kann auch um 90° gedreht platziert werden"
                      onClick={() => updateSlot(idx, { footprint: { ...slot.footprint, canRotate: !slot.footprint.canRotate } })}>
                      ⟳ drehbar
                    </span>
                  )}
                  {/* Mini-Visualisierung: bei canRotate beide Orientierungen zeigen */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div style={{
                      display: 'inline-grid', gap: 2, alignSelf: 'center',
                      gridTemplateColumns: `repeat(${slot.footprint.width}, 10px)`,
                    }}>
                      {Array.from({ length: slot.footprint.width * slot.footprint.height }).map((_, i) => (
                        <div key={i} style={{ width: 10, height: 10, background: '#5a8fff', borderRadius: 2, opacity: 0.8 }} />
                      ))}
                    </div>
                    {slot.footprint.canRotate && slot.footprint.width !== slot.footprint.height && (<>
                      <span style={{ color: '#446', fontSize: '0.7rem' }}>/</span>
                      <div style={{
                        display: 'inline-grid', gap: 2, alignSelf: 'center',
                        gridTemplateColumns: `repeat(${slot.footprint.height}, 10px)`,
                      }}>
                        {Array.from({ length: slot.footprint.width * slot.footprint.height }).map((_, i) => (
                          <div key={i} style={{ width: 10, height: 10, background: '#5a8fff', borderRadius: 2, opacity: 0.4 }} />
                        ))}
                      </div>
                    </>)}
                  </div>

                  <label className={s.slotCheck}>
                    <input type="checkbox" checked={slot.required}
                      onChange={e => updateSlot(idx, { required: e.target.checked })} />
                    Pflicht
                  </label>

                  <span className={s.slotFieldSmall}>
                    Prio
                    <input type="number" min={0} max={99} className={s.slotNumInput}
                      title={slot.required ? 'Priorität hat bei Pflicht-Slots keine Wirkung – Pflicht-Slots werden immer ausgeführt.' : 'Optionale Slots werden in aufsteigender Priorität gezogen (0 = zuerst).'}
                      value={slot.priority} onChange={e => updateSlot(idx, { priority: +e.target.value })}
                      style={slot.required ? { opacity: 0.4 } : {}} />
                  </span>

                  <button className={s.duplicateSlotBtn} title="Slot duplizieren" onClick={() => duplicateSlot(idx)}>⎘</button>
                  <button className={s.removeSlotBtn} onClick={() => removeSlot(idx, slot.label || slot.id)}>✕</button>
                </div>

                <div className={s.slotCardBody}>
                  {/* ID & Label */}
                  <div className={s.slotRow} style={{ gap: 8 }}>
                    <span className={s.slotGroupLabel}>ID</span>
                    <input className={s.slotSizeInput} style={{ flex: 1 }}
                      placeholder="z.B. slot_bed_main"
                      value={slot.id}
                      onChange={e => updateSlot(idx, { id: e.target.value })} />
                    <span className={s.slotGroupLabel}>Bezeichnung</span>
                    <input className={s.slotSizeInput} style={{ flex: 2 }}
                      placeholder="z.B. Bett"
                      value={slot.label}
                      onChange={e => updateSlot(idx, { label: e.target.value })} />
                  </div>

                  {/* Min/Max per room size table */}
                  <div className={s.sizeTableWrap}>
                  <table className={s.sizeTable}>
                    <thead>
                      <tr>
                        <th className={s.sizeTableLead} style={{ color: '#778', fontSize: '0.68rem', fontWeight: 400, textAlign: 'right', paddingRight: 4 }}>
                          Raumgröße →
                        </th>
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

                  {/* ── Erlaubte Kategorien mit Gewichtung ── */}
                  <div className={s.slotRow} style={{ marginTop: 6 }}>
                    <span className={s.slotGroupLabel}>
                      Erlaubte Kategorien{' '}
                      <span style={{ color: '#446', fontStyle: 'italic' }}>
                        {Object.keys(slot.allowedCategories).length === 0
                          ? '(alle passenden)'
                          : `(${Object.keys(slot.allowedCategories).length} gewählt)`}
                      </span>
                    </span>
                  </div>
                  {/* Selected categories with weight inputs */}
                  {Object.entries(slot.allowedCategories).map(([cat, w]) => (
                    <div key={cat} className={s.slotRow} style={{ gap: 6, marginTop: 2 }}>
                      <span
                        className={`${s.chip} ${s.chipActive}`}
                        title="Klicken zum Entfernen"
                        onClick={() => toggleGroup(idx, cat)}
                      >
                        {cat} ✕
                      </span>
                      <input type="number" min={1} max={10} className={s.slotNumInput}
                        value={w}
                        onChange={e => setCategoryWeight(idx, cat, +e.target.value)} />
                      <span className={s.slotHint} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        Gewicht <span style={{ color: '#446', fontSize: '0.68rem' }}>(1–10)</span>
                        <span
                          title="Wertebereich: 1–10\n\nBestimmt, wie oft diese Kategorie gegenüber anderen erlaubten Kategorien bevorzugt wird.\n\nBeispiel: Kategorie A mit Gewicht 3 und B mit Gewicht 1 → A wird 75% der Zeit gewählt.\n\nGilt nur für die Auswahl WELCHES Tile platziert wird, nicht OB der Slot befüllt wird."
                          style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem' }}
                        >ℹ</span>
                      </span>
                    </div>
                  ))}
                  {/* Add category chips */}
                  <div className={s.chipGroup} style={{ marginTop: 4 }}>
                    {availGroups.filter(g => slot.allowedCategories[g] === undefined).map(g => (
                      <span key={g} className={s.chip} title="Klicken zum Hinzufügen" onClick={() => toggleGroup(idx, g)}>{g}</span>
                    ))}
                  </div>

                  {/* ── Platzierungsregeln ── */}
                  <div className={s.slotRow} style={{ marginTop: 6 }}>
                    <span className={s.slotGroupLabel}>Platzierungsregeln</span>
                  </div>
                  <div className={s.chipGroup}>
                    {(Object.keys(PLACEMENT_RULE_LABELS) as (keyof typeof PLACEMENT_RULE_LABELS)[]).map(key => (
                      <span key={key}
                        className={`${s.chip} ${slot.placementRules[key as keyof typeof slot.placementRules] ? s.chipActive : ''}`}
                        onClick={() => updateSlot(idx, {
                          placementRules: {
                            ...slot.placementRules,
                            [key]: !slot.placementRules[key as keyof typeof slot.placementRules],
                          }
                        })}>
                        {PLACEMENT_RULE_LABELS[key]}
                      </span>
                    ))}
                  </div>

                  {/* ── Erlaubter Layer & Erforderliche Eigenschaften ── */}
                  <div className={s.slotRow} style={{ marginTop: 6, gap: 8 }}>
                    <span className={s.slotGroupLabel}>
                      Layer <span style={{ color: '#f66' }}>*</span>
                    </span>
                    <select className={s.slotSelect}
                      value={slot.requiredLayer}
                      style={!slot.requiredLayer ? { borderColor: '#8a3a3a', color: '#a66' } : {}}
                      onChange={e => updateSlot(idx, { requiredLayer: e.target.value })}>
                      <option value="" disabled>– bitte wählen –</option>
                      {FURNITURE_LAYERS.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                    {!slot.requiredLayer && (
                      <span style={{ fontSize: '0.68rem', color: '#f66' }}>Pflichtfeld</span>
                    )}
                  </div>
                  <div className={s.slotRow} style={{ marginTop: 4 }}>
                    <span className={s.slotGroupLabel}>Erforderliche Eigenschaften</span>
                  </div>
                  <div className={s.chipGroup}>
                    {REQUIRED_PROPERTIES.map(prop => (
                      <span key={prop}
                        className={`${s.chip} ${slot.requiredProperties.includes(prop) ? s.chipActive : ''}`}
                        onClick={() => toggleRequiredProperty(idx, prop)}>
                        {TILE_PROPERTY_LABELS_DE[prop]}
                      </span>
                    ))}
                  </div>

                  {/* ── Varianten-Gruppe ── */}
                  <div className={s.slotRow} style={{ marginTop: 6, gap: 8, flexWrap: 'wrap' }}>
                    <span className={s.slotGroupLabel}>Varianten-Gruppe</span>
                    <datalist id={`group-ids-${idx}`}>
                      {uniqueGroupIds.map(gid => (
                        <option key={gid} value={gid} />
                      ))}
                    </datalist>
                    <input className={s.slotSizeInput} style={{ flex: 2 }}
                      list={`group-ids-${idx}`}
                      placeholder="z.B. sitz_variante (leer = kein Gruppen-Modus)"
                      value={slot.slotGroupId}
                      onChange={e => updateSlot(idx, {
                        slotGroupId: e.target.value,
                        slotGroupMode: e.target.value ? 'one-of' : '',
                      })} />
                    {slot.slotGroupId && (<>
                      <span className={s.slotGroupLabel} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        Gewicht <span style={{ color: '#446', fontSize: '0.68rem' }}>(1–10)</span>
                        <span
                          title={
                            slot.required
                              ? 'Wertebereich: 1–10\n\nGewichtung bestimmt die Auswahlwahrscheinlichkeit innerhalb der Varianten-Gruppe.\n\nDieser Slot ist Pflicht (✅) – der Generator wählt GARANTIERT eine Variante aus der Gruppe. Das Gewicht steuert NUR, welche Variante gewählt wird, nicht ob eine platziert wird.'
                              : 'Wertebereich: 1–10\n\nGewichtung bestimmt die Auswahlwahrscheinlichkeit innerhalb der Varianten-Gruppe.\n\nDieser Slot ist optional (☐) – der Generator entscheidet anhand von Priorität und Raumgröße, ob die Gruppe überhaupt gezogen wird. Wenn ja, bestimmt das Gewicht die Variante.\n\nBeispiel: Gewicht 3 vs. 2 → 60% vs. 40% Wahrscheinlichkeit.'
                          }
                          style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem' }}
                        >ℹ</span>
                      </span>
                      <input type="number" min={1} max={10} className={s.slotNumInput}
                        value={slot.groupWeight}
                        onChange={e => updateSlot(idx, { groupWeight: Math.max(1, Math.min(10, +e.target.value)) })} />
                    </>)}
                  </div>
                  {slot.slotGroupId && (() => {
                    const groupSize = draft.slots.filter(sl => sl.slotGroupId === slot.slotGroupId).length;
                    const allRequired = draft.slots
                      .filter(sl => sl.slotGroupId === slot.slotGroupId)
                      .every(sl => sl.required);
                    const mixedRequired = !allRequired && draft.slots
                      .filter(sl => sl.slotGroupId === slot.slotGroupId)
                      .some(sl => sl.required);
                    return (
                      <>
                        <div className={s.slotHint} style={{ marginTop: 2, color: groupColor }}>
                          {allRequired
                            ? `✅🔀 Pflicht-Gruppe „${slot.slotGroupId}" – garantiert genau eine von ${groupSize} Varianten wird platziert (Gewicht: ${slot.groupWeight})`
                            : `☐🔀 Optionale Gruppe „${slot.slotGroupId}" – eine von ${groupSize} Varianten kann platziert werden (Gewicht: ${slot.groupWeight})`
                          }
                        </div>
                        {mixedRequired && (
                          <div className={s.slotHint} style={{ marginTop: 2, color: '#f4a261' }}>
                            ⚠ Gruppe „{slot.slotGroupId}" hat gemischte Pflicht/Optional-Slots – alle Slots in einer Gruppe sollten denselben Pflicht-Status haben.
                          </div>
                        )}
                      </>
                    );
                  })()}

                  {/* ── Anker-Regeln ── */}
                  <div className={s.slotRow} style={{ marginTop: 6, justifyContent: 'space-between' }}>
                    <span className={s.slotGroupLabel}>
                      Anker-Regeln
                      <span
                        title={"Verknüpft diesen Slot relativ zu einem anderen Slot oder einer Varianten-Gruppe.\n\n• Anker-Ziel: Slot-ID oder Gruppen-ID\n• Positionen (OR): Generator wählt eine davon\n• Mehrere Regeln: für verschiedene Gruppen-Varianten unterschiedliche Positionen"}
                        style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem', marginLeft: 4 }}
                      >ℹ</span>
                    </span>
                    <button
                      className={s.addSlotBtn}
                      style={{ fontSize: '0.7rem', padding: '2px 8px' }}
                      onClick={() => addAnchorRule(idx)}>
                      + Regel
                    </button>
                  </div>

                  {/* datalist: Slot-IDs + Gruppen-IDs als Vorschläge */}
                  <datalist id={`anchor-targets-${idx}`}>
                    {draft.slots.filter((sl, i) => i !== idx && sl.id).map(sl => (
                      <option key={sl.id} value={sl.id}>
                        {sl.label ? `${sl.id} (${sl.label})` : sl.id}
                      </option>
                    ))}
                    {uniqueGroupIds.map(gid => (
                      <option key={`grp_${gid}`} value={gid}>Gruppe: {gid}</option>
                    ))}
                  </datalist>

                  {slot.anchorRules.length === 0 && (
                    <div className={s.slotHint}>Kein Anker – freie Platzierung im Raum</div>
                  )}

                  {slot.anchorRules.map((rule, rIdx) => (
                    <div key={rIdx} className={s.anchorRuleCard}>
                      <div className={s.slotRow} style={{ gap: 6 }}>
                        <span className={s.slotGroupLabel} style={{ minWidth: 44 }}>Regel {rIdx + 1}</span>
                        <span className={s.slotGroupLabel}>Anker</span>
                        <input className={s.slotSizeInput} style={{ flex: 2 }}
                          list={`anchor-targets-${idx}`}
                          placeholder="Slot-ID oder Gruppen-ID"
                          value={rule.anchorTarget}
                          onChange={e => updateAnchorRule(idx, rIdx, { anchorTarget: e.target.value })} />
                        <button className={s.removeSlotBtn}
                          onClick={() => removeAnchorRule(idx, rIdx)}>✕</button>
                      </div>
                      <div className={s.chipGroup} style={{ marginTop: 4 }}>
                        {ANCHOR_POSITIONS.map(pos => (
                          <span key={pos}
                            className={`${s.chip} ${rule.positions.includes(pos) ? s.chipActive : ''}`}
                            onClick={() => toggleAnchorPosition(idx, rIdx, pos)}>
                            {pos}
                          </span>
                        ))}
                      </div>
                      {rule.positions.length > 1 && (
                        <div className={s.slotHint} style={{ marginTop: 3 }}>
                          ↕ ODER: Generator wählt eine der {rule.positions.length} erlaubten Positionen
                        </div>
                      )}
                      {rule.anchorTarget && rule.positions.length > 0 && (
                        <div className={s.slotHint} style={{ marginTop: 2, color: '#8c8' }}>
                          📎 „{rule.anchorTarget}" → {rule.positions.join(' | ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                </>)} {/* end isCollapsed */}
              </div>
              ); // end return slot card
              }); // end map
            })()} {/* end IIFE */}

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

        {/* ── Ref footer (horizontal) ── */}
        <div className={s.refPanel}>
          {/* Footprint-Kacheln */}
          <div style={{ flexShrink: 0 }}>
            <div style={{ fontSize: '0.68rem', color: '#778', marginBottom: 6 }}>Häufige Footprints</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {COMMON_FOOTPRINTS.map(fp => (
                <div key={`${fp.width}x${fp.height}`}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                  <div style={{
                    display: 'inline-grid', gap: 2,
                    gridTemplateColumns: `repeat(${fp.width}, 12px)`,
                  }}>
                    {Array.from({ length: fp.width * fp.height }).map((_, i) => (
                      <div key={i} style={{ width: 12, height: 12, background: '#3a5aaa', borderRadius: 2 }} />
                    ))}
                  </div>
                  <span style={{ fontSize: '0.65rem', color: '#778' }}>{fp.width}×{fp.height}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Raumgrößen */}
          <div style={{ flexShrink: 0 }}>
            <div style={{ fontSize: '0.68rem', color: '#778', marginBottom: 2 }}>Raumgrößen</div>
            <div className={s.refTable}>
              {Object.entries(SIZE_LABELS).map(([size, range]) => (
                <div key={size} className={s.refRow}>
                  <span className={s.refSize}>{size}</span>
                  <span className={s.refRange}>{range}</span>
                  <span className={s.refEx}>{SIZE_EXAMPLES[size]}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Hinweise */}
          <p className={s.refNote}>
            <strong>Pflicht-Slots</strong> werden immer befüllt.<br />
            <strong>Optionale Slots</strong> nach Priorität (0 = zuerst).<br />
            <strong>Max -1</strong> = unbegrenzt.<br />
            <strong>Kategorien leer</strong> = alle passenden.
          </p>
        </div>
      </div>
    </div>
  );
}



































