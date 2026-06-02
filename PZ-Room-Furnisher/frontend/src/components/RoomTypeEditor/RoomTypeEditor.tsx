import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SIZE_KEYS, ANCHOR_POSITIONS, ANCHOR_POSITION_TOOLTIPS, ANCHOR_ORIENT_TOOLTIPS,
  REQUIRED_PROPERTIES, FURNITURE_LAYERS,
  COMMON_FOOTPRINTS, defaultSlot, defaultRoomTypeConfig, defaultPlacementRules,
} from '../../types/roomTypes';
import type { AnchorRule, PlacementRules, RoomTypeConfig, RoomTypeConfigMap, RoomTypeSlot } from '../../types/roomTypes';
import { getRoomTypes, saveRoomType, deleteRoomType } from '../../api/roomTypesApi';
import { getRoomTypeNames, saveRoomTypeNames, getCategories, getMaterials } from '../../api/settingsApi';
import { getGroups, getColors } from '../../api/tilesApi';
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
  nearWall:    'An der Wand',
  nearDoor:    'An einer Tür',
  nearWindow:  'An einem Fenster',
  centerRoom:  'Raummitte',
  cornerOnly:  'Nur in Ecken',
};
const PLACEMENT_RULE_DESCRIPTIONS: Record<string, string> = {
  nearWall:    'Slot muss an einer Wand platziert werden.',
  nearDoor:    'Slot muss in der Nähe einer Tür platziert werden.',
  nearWindow:  'Slot muss in der Nähe eines Fensters platziert werden.',
  centerRoom:  'Slot muss in der Raummitte platziert werden.',
  cornerOnly:  'Slot darf nur in einer Ecke platziert werden.',
};

const WALL_ALIGNMENT_OPTIONS: { value: PlacementRules['wallAlignment']; label: string; title: string }[] = [
  { value: 'any',          label: 'Automatisch',  title: 'Generator wählt die beste passende Tile-Variante – keine Richtungseinschränkung.' },
  { value: 'perpendicular',label: '⊥ Senkrecht',  title: 'Rücken an der Wand, Vorderseite zeigt in den Raum.\nDie lange Achse geht in den Raum hinein (z.B. Bett, Schreibtisch, WC).\nBevorzugt Tile-Varianten mit fpH > fpW bei N/S-Wand.' },
  { value: 'parallel',     label: '∥ Parallel',   title: 'Längsseite entlang der Wand.\nDas Möbelstück läuft parallel zur Wand (z.B. Sofa, Regal, Kommode).\nBevorzugt Tile-Varianten mit fpW > fpH bei N/S-Wand.' },
];

const SIZE_LABELS: Record<string, string> = {
  XS: '1–4 Felder', S: '5–12 Felder', M: '13–25 Felder', L: '26–50 Felder', XL: '51+ Felder',
};
const SIZE_EXAMPLES: Record<string, string> = {
  XS: 'Bad, Klo', S: 'Kleines Zimmer', M: 'Schlafzimmer', L: 'Wohnzimmer', XL: 'Halle, Garage',
};

/**
 * Erklärung der Anker-Positionen.
 * Bezugspunkt: Perspektive vom Fußende zum Kopfende.
 * Beispiel Bett (Orient S = Kopf oben/Norden, Füße unten/Süden):
 *   HeadLeft  = links vom Kopfende  (West-Seite oben)
 *   HeadRight = rechts vom Kopfende (Ost-Seite oben)
 *   FootLeft  = links vom Fußende   (West-Seite unten)
 *   FootRight = rechts vom Fußende  (Ost-Seite unten)
 */

export function RoomTypeEditor() {
  const { t } = useTranslation();
  const [configs, setConfigs]         = useState<RoomTypeConfigMap>({});
  const [knownRooms, setKnownRooms]   = useState<string[]>([]);
  const [availGroups, setAvailGroups] = useState<string[]>(FALLBACK_GROUPS);
  const [availColors, setAvailColors] = useState<string[]>([]);
  const [availMaterials, setAvailMaterials] = useState<string[]>([]);
  const [selected, setSelected]       = useState<string | null>(null);
  const [draft, setDraft]             = useState<RoomTypeConfig | null>(null);
  const [dirty, setDirty]             = useState(false);
  const [saving, setSaving]           = useState(false);
  const [status, setStatus]           = useState<string | null>(null);
  const [newRoomName, setNewRoomName] = useState('');
  const [infoOpen, setInfoOpen]       = useState(false);
  /** Indices der eingeklappten Slot-Karten */
  const [collapsedSlots, setCollapsedSlots] = useState<Set<number>>(new Set());
  /** Drag & Drop: Index des aktuell gezogenen Slots */
  const dragIndexRef = useRef<number | null>(null);
  /** Index des Slots über dem der Cursor gerade schwebt */
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
   /** Zwischenablage: kopierter Slot + Quellenraum */
   const [copiedSlot, setCopiedSlot] = useState<{ slot: RoomTypeSlot; fromRoom: string } | null>(null);
   /** Drag & Drop für Layout-Varianten: welche Variante/Slot wird gerade gezogen */
   const dragLayoutVariantRef = useRef<{ variantIdx: number; slotIdx: number } | null>(null);
   const [dragOverLayoutSlot, setDragOverLayoutSlot] = useState<{ variantIdx: number; slotIdx: number } | null>(null);
   /** Welche Varianten-Drop-Zone ist gerade im Hover-Modus */
   const [dragOverLayoutVariant, setDragOverLayoutVariant] = useState<number | null>(null);

  useEffect(() => {
    getRoomTypes().then(cfgs => setConfigs(cfgs)).catch(console.error);
    getRoomTypeNames().then(names => setKnownRooms(names)).catch(console.error);
    // Kategorien primär aus Settings laden, Tile-DB-Gruppen als Ergänzung
    Promise.all([getCategories(), getGroups()]).then(([cats, tileGroups]) => {
      const merged = Array.from(new Set([...cats, ...tileGroups]));
      setAvailGroups(merged.length > 0 ? merged : FALLBACK_GROUPS);
    }).catch(console.error);
    getColors().then(setAvailColors).catch(console.error);
    getMaterials().then(setAvailMaterials).catch(console.error);
  }, []);

  const selectRoom = useCallback((rt: string) => {
    setSelected(rt);
    setDraft(configs[rt]
      ? {
          ...configs[rt],
          pathStyle:     configs[rt].pathStyle    ?? 'wall',
          colorGroupId:  configs[rt].colorGroupId ?? '',
          colorPalettes: configs[rt].colorPalettes ?? {},
          layoutVariants: configs[rt].layoutVariants ?? [],
          commonSlotIds: configs[rt].commonSlotIds ?? [],
          slots: configs[rt].slots.map(sl => {
            // Migration: alte anchorSlotId/anchorPosition → anchorRules
            const legacyAnchor = (sl as any).anchorSlotId as string | undefined;
            const legacyPos    = (sl as any).anchorPosition as string | undefined;
            const migratedRules: AnchorRule[] = sl.anchorRules?.length
              ? sl.anchorRules
              : legacyAnchor
                ? [{ anchorTarget: legacyAnchor, positions: legacyPos ? [legacyPos as typeof ANCHOR_POSITIONS[number]] : [] }]
                : [];
            const fp = sl.footprint ?? {};
            return {
              ...defaultSlot(),
              ...sl,
              footprint: { width: fp.width ?? 1, height: fp.height ?? 1, canRotate: fp.canRotate ?? false },
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
    setCollapsedSlots(() => {
      if (configs[rt]) {
        return new Set<number>(configs[rt].slots.map((_, i) => i));
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
    setCollapsedSlots(() => {
      const next = new Set<number>();
      for (let i = 0; i < newIdx; i++) next.add(i);
      return next;
    });
  };

  const addLayoutVariant = () => {
    if (!draft) return;
    const next = [...(draft.layoutVariants ?? []), { id: '', label: '', weight: 5, slotIds: [] }];
    setDraft({ ...draft, layoutVariants: next });
    setDirty(true);
  };

  const updateLayoutVariant = (idx: number, patch: Partial<NonNullable<RoomTypeConfig['layoutVariants']>[number]>) => {
    if (!draft) return;
    const variants = [...(draft.layoutVariants ?? [])];
    variants[idx] = { ...variants[idx], ...patch };
    setDraft({ ...draft, layoutVariants: variants });
    setDirty(true);
  };

   const removeLayoutVariant = (idx: number) => {
     if (!draft) return;
     if (!window.confirm(`Layout-Variante #${idx + 1} wirklich löschen?`)) return;
     const variants = [...(draft.layoutVariants ?? [])];
     variants.splice(idx, 1);
     setDraft({ ...draft, layoutVariants: variants });
     setDirty(true);
   };

   const addSlotToLayoutVariant = (variantIdx: number, slotId: string) => {
     if (!draft) return;
     const variants = [...(draft.layoutVariants ?? [])];
     const variant = variants[variantIdx];
     if (!variant) return;
     if (!variant.slotIds.includes(slotId)) {
       variant.slotIds = [...variant.slotIds, slotId];
       setDraft({ ...draft, layoutVariants: variants });
       setDirty(true);
     }
   };

   const removeSlotFromLayoutVariant = (variantIdx: number, slotId: string) => {
     if (!draft) return;
     const variants = [...(draft.layoutVariants ?? [])];
     const variant = variants[variantIdx];
     if (!variant) return;
     variant.slotIds = variant.slotIds.filter(id => id !== slotId);
     setDraft({ ...draft, layoutVariants: variants });
     setDirty(true);
   };

   const reorderLayoutVariantSlots = (variantIdx: number, fromIdx: number, toIdx: number) => {
     if (!draft || fromIdx === toIdx) return;
     const variants = [...(draft.layoutVariants ?? [])];
     const variant = variants[variantIdx];
     if (!variant) return;
     const slots = [...variant.slotIds];
     const [moved] = slots.splice(fromIdx, 1);
     slots.splice(toIdx, 0, moved);
     variant.slotIds = slots;
     setDraft({ ...draft, layoutVariants: variants });
     setDirty(true);
   };

   const addCommonSlot = (slotId: string) => {
     if (!draft || !slotId) return;
     const current = draft.commonSlotIds ?? [];
     if (current.includes(slotId)) return;
     setDraft({ ...draft, commonSlotIds: [...current, slotId] });
     setDirty(true);
   };

   const removeCommonSlot = (slotId: string) => {
     if (!draft) return;
     setDraft({ ...draft, commonSlotIds: (draft.commonSlotIds ?? []).filter(id => id !== slotId) });
     setDirty(true);
   };

   const reorderCommonSlots = (fromIdx: number, toIdx: number) => {
     if (!draft || fromIdx === toIdx) return;
     const items = [...(draft.commonSlotIds ?? [])];
     const [moved] = items.splice(fromIdx, 1);
     items.splice(toIdx, 0, moved);
     setDraft({ ...draft, commonSlotIds: items });
     setDirty(true);
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

  const reorderSlots = (fromIdx: number, toIdx: number) => {
    if (!draft || fromIdx === toIdx) return;
    const slots = [...draft.slots];
    const [moved] = slots.splice(fromIdx, 1);
    slots.splice(toIdx, 0, moved);
    setDraft({ ...draft, slots });
    setDirty(true);
    // Collapsed-Indices remappen
    setCollapsedSlots(prev => {
      const next = new Set<number>();
      prev.forEach(i => {
        if (i === fromIdx) {
          next.add(toIdx);
        } else {
          let newI = i;
          if (fromIdx < toIdx) {
            if (i > fromIdx && i <= toIdx) newI = i - 1;
          } else {
            if (i >= toIdx && i < fromIdx) newI = i + 1;
          }
          next.add(newI);
        }
      });
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

  const setCategoryWeight = (slotIdx: number, group: string, weight: number, clamp = true) => {
    if (!draft) return;
    const v = clamp ? Math.max(1, Math.min(10, weight)) : Math.max(1, weight);
    const cats = { ...draft.slots[slotIdx].allowedCategories, [group]: v };
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

  // ── Fallback-Regel Helpers ──
  const addFallbackRule = (slotIdx: number) => {
    if (!draft) return;
    const rules = [...(draft.slots[slotIdx].fallbackRules ?? []), defaultPlacementRules()];
    updateSlot(slotIdx, { fallbackRules: rules });
  };

  const removeFallbackRule = (slotIdx: number, fbIdx: number) => {
    if (!draft) return;
    const rules = (draft.slots[slotIdx].fallbackRules ?? []).filter((_, i) => i !== fbIdx);
    updateSlot(slotIdx, { fallbackRules: rules });
  };

  const updateFallbackRule = (slotIdx: number, fbIdx: number, patch: Partial<PlacementRules>) => {
    if (!draft) return;
    const rules = (draft.slots[slotIdx].fallbackRules ?? []).map((r, i) =>
      i === fbIdx ? { ...r, ...patch } : r
    );
    updateSlot(slotIdx, { fallbackRules: rules });
  };

  const duplicateSlot = (idx: number) => {    if (!draft) return;
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

  const copySlot = (idx: number) => {
    if (!draft) return;
    setCopiedSlot({ slot: { ...draft.slots[idx] }, fromRoom: draft.roomType });
  };

  const pasteSlot = () => {
    if (!draft || !copiedSlot) return;
    const copy: RoomTypeSlot = {
      ...copiedSlot.slot,
      id: copiedSlot.slot.id ? copiedSlot.slot.id + '_copy' : '',
    };
    const newIdx = draft.slots.length;
    setDraft({ ...draft, slots: [...draft.slots, copy] });
    setDirty(true);
    // Alle bestehenden einklappen, eingefügten aufklappen
    setCollapsedSlots(() => {
      const next = new Set<number>();
      for (let i = 0; i < newIdx; i++) next.add(i);
      return next;
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
        colorGroupId:  raw.colorGroupId  ?? '',
        colorPalettes: raw.colorPalettes ?? {},
        layoutVariants: raw.layoutVariants ?? [],
        commonSlotIds: raw.commonSlotIds ?? [],
        slots: raw.slots.map(sl => {
          const fp = sl.footprint ?? {};
          return {
            ...defaultSlot(),
            ...sl,
            footprint:         { width: fp.width ?? 1, height: fp.height ?? 1, canRotate: fp.canRotate ?? false },
            allowedCategories: { ...(sl.allowedCategories ?? {}) },
            placementRules:    { ...defaultPlacementRules(), ...(sl.placementRules ?? {}) },
            requiredProperties: [...(sl.requiredProperties ?? [])],
            anchorRules:       sl.anchorRules ?? [],
            blocksPlacement:   sl.blocksPlacement ?? true,
            softBlocks:        sl.softBlocks ?? false,
            colorGroupId:      sl.colorGroupId ?? '',
            materialGroupId:   sl.materialGroupId ?? '',
          };
        }),
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

  return (
    <div className={s.layout}>
      {/* ── Left: list ── */}
      <div className={s.listPanel}>
        <div className={s.panelHeader}>
          <span className={s.panelTitle}>🏠 Raumtypen</span>
        </div>
        <div className={s.list}>
          {knownRooms.map(rt => (
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

            {/* PathStyle-Selector */}
            <div className={s.pathStyleRow}>
              <label className={s.pathStyleLabel} title="Bestimmt welche Raumzellen als Laufweg markiert werden. Wandnah = Möbel können Pfad nicht blockieren. Raummitte = offener Bereich bleibt frei. Zufällig = maximale Variation.">
                {t('roomTypeEditor.pathStyle.label')}
              </label>
              <select
                className={s.pathStyleSelect}
                value={draft.pathStyle ?? 'wall'}
                onChange={e => {
                  setDraft({ ...draft, pathStyle: e.target.value as 'wall' | 'center' | 'random' | 'doorOnly' });
                  setDirty(true);
                }}>
                <option value="wall">{t('roomTypeEditor.pathStyle.wall')}</option>
                <option value="center">{t('roomTypeEditor.pathStyle.center')}</option>
                <option value="random">{t('roomTypeEditor.pathStyle.random')}</option>
                <option value="doorOnly">{t('roomTypeEditor.pathStyle.doorOnly')}</option>
              </select>
            </div>

            {/* Farbgruppe (Raum-Ebene) */}
            <div className={s.pathStyleRow}>
              <label className={s.pathStyleLabel}
                title="Standard-Farbgruppen-ID für alle Slots dieses Raumtyps. Slots mit leerer colorGroupId erben diesen Wert. Leer = kein Farbfilter als Standard.">
                🎨 Farbgruppe (Raum-Default)
              </label>
              <input
                className={s.slotSizeInput}
                style={{ flex: 1, minWidth: 0 }}
                placeholder="z.B. bedroom_main (leer = kein Default)"
                value={draft.colorGroupId ?? ''}
                onChange={e => { setDraft({ ...draft, colorGroupId: e.target.value }); setDirty(true); }}
              />
            </div>

            {/* Farbpalette (Raum-Ebene) – Multi-Select */}
            {draft.colorGroupId && (
              <div className={s.pathStyleRow} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                <label className={s.pathStyleLabel}
                  title={`Erlaubte Farben für Gruppe „${draft.colorGroupId}". Der Generator wählt vor dem Slot-Loop zufällig eine der ausgewählten Farben. Keine Auswahl = Farbe wird vom ersten platzierten Möbel übernommen.`}>
                  🎨 Farbpalette für „{draft.colorGroupId}"
                </label>
                <div className={s.chipGroup}>
                  {availColors.length === 0 && (
                    <span className={s.slotHint} style={{ fontStyle: 'italic' }}>
                      Keine Farben verfügbar – Möbel-Vorlagen mit Farb-Tags eintragen
                    </span>
                  )}
                  {availColors.map(color => {
                    const palette = draft.colorPalettes?.[draft.colorGroupId] ?? [];
                    const active  = palette.includes(color);
                    return (
                      <span key={color}
                        className={`${s.chip} ${active ? s.chipActive : ''}`}
                        title={active ? `„${color}" entfernen` : `„${color}" hinzufügen`}
                        onClick={() => {
                          const current = draft.colorPalettes?.[draft.colorGroupId] ?? [];
                          const next    = active
                            ? current.filter(c => c !== color)
                            : [...current, color];
                          setDraft({
                            ...draft,
                            colorPalettes: { ...(draft.colorPalettes ?? {}), [draft.colorGroupId]: next },
                          });
                          setDirty(true);
                        }}>
                        {color}
                      </span>
                    );
                  })}
                </div>
                {(() => {
                  const palette = draft.colorPalettes?.[draft.colorGroupId] ?? [];
                  if (palette.length === 0)
                    return <div className={s.slotHint} style={{ color: '#888' }}>Keine Auswahl → Farbe vom ersten platzierten Möbel</div>;
                  return <div className={s.slotHint} style={{ color: '#8c8' }}>✓ {palette.length} Farbe{palette.length !== 1 ? 'n' : ''} → zufällige Auswahl bei jedem Raum</div>;
                })()}
              </div>
            )}

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

            {/* ── Zwischenablage-Banner ── */}
            {copiedSlot && (
              <div className={s.pasteBar}>
                <span className={s.pasteBarIcon}>📋</span>
                <span className={s.pasteBarText}>
                  Zwischenablage:{' '}
                  <strong>{copiedSlot.slot.id || copiedSlot.slot.label || '(kein Name)'}</strong>
                  {copiedSlot.fromRoom !== draft?.roomType && (
                    <span className={s.pasteBarFrom}> aus „{copiedSlot.fromRoom}"</span>
                  )}
                </span>
                <button className={s.pasteSlotBtn} onClick={pasteSlot}
                  title={`Slot „${copiedSlot.slot.id || copiedSlot.slot.label || 'kopiert'}" am Ende einfügen`}>
                  ↓ Einfügen
                </button>
                <button className={s.pasteBarClearBtn} title="Zwischenablage leeren"
                  onClick={() => setCopiedSlot(null)}>✕</button>
              </div>
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
                className={`${s.slotCard} ${slot.required ? s.slotCardRequired : ''} ${slot.slotGroupId ? s.slotCardGrouped : ''} ${dragOverIdx === idx && dragIndexRef.current !== idx ? s.slotCardDragOver : ''}`}
                style={groupColor ? { '--group-color': groupColor } as React.CSSProperties : undefined}
                onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOverIdx !== idx) setDragOverIdx(idx); }}
                onDrop={e => { e.preventDefault(); if (dragIndexRef.current !== null) reorderSlots(dragIndexRef.current, idx); dragIndexRef.current = null; setDragOverIdx(null); }}
                onDragEnd={() => { dragIndexRef.current = null; setDragOverIdx(null); }}>

                 {/* ── Zusammengeklappte Zusammenfassung (immer sichtbar) ── */}
                 <div className={s.slotSummaryBar}
                   draggable
                   onDragStart={e => {
                     dragIndexRef.current = idx;
                     e.dataTransfer.effectAllowed = 'move';
                     e.dataTransfer.setData('text/plain', slot.id);
                   }}
                   onClick={toggleCollapse} style={{ cursor: 'pointer' }}>
                  <span className={s.dragHandle} title="Slot verschieben" onClick={e => e.stopPropagation()}>⠿</span>
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
                  <button className={s.copySlotBtn} title="Slot in Zwischenablage kopieren (auch in andere Raumkonfiguration einfügbar)"
                    onClick={e => { e.stopPropagation(); copySlot(idx); }}>📋</button>
                  <button className={s.removeSlotBtn}
                    onClick={e => { e.stopPropagation(); removeSlot(idx, slot.label || slot.id); }}>✕</button>
                </div>

                {/* ── Aufgeklappter Inhalt ── */}
                {!isCollapsed && (<>
                <div className={s.slotCardHeader}>
                  <span className={s.slotIndex} style={{ visibility: 'hidden' }}>#{idx + 1}</span>

                  {/* Footprint: Schnellauswahl + manuelle Eingabe */}
                  <span className={s.slotGroupLabel} style={{ whiteSpace: 'nowrap' }}>B×H</span>
                  <input type="number" min={1} max={20} className={s.slotNumInput}
                    title="Breite (Spalten)"
                    value={slot.footprint.width}
                    onChange={e => { const v = +e.target.value; if (v >= 1) updateSlot(idx, { footprint: { ...slot.footprint, width: v } }); }}
                    onBlur={e => updateSlot(idx, { footprint: { ...slot.footprint, width: Math.max(1, Math.min(20, +e.target.value)) } })} />
                  <span style={{ color: '#446' }}>×</span>
                  <input type="number" min={1} max={20} className={s.slotNumInput}
                    title="Höhe (Zeilen)"
                    value={slot.footprint.height}
                    onChange={e => { const v = +e.target.value; if (v >= 1) updateSlot(idx, { footprint: { ...slot.footprint, height: v } }); }}
                    onBlur={e => updateSlot(idx, { footprint: { ...slot.footprint, height: Math.max(1, Math.min(20, +e.target.value)) } })} />
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
                        onChange={e => setCategoryWeight(idx, cat, +e.target.value, false)}
                        onBlur={e => setCategoryWeight(idx, cat, +e.target.value, true)} />
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
                    <span className={s.slotGroupLabel}>
                      Platzierungsregeln
                      <span
                        title="Alle aktiven Regeln werden mit AND verknüpft – eine Zelle muss ALLE gesetzten Bedingungen gleichzeitig erfüllen.\n\nAusnahme: 'Raummitte' und 'An der Wand mit Orientierung' sind Soft-Präferenzen (bevorzugt, aber kein harter Ausschluss)."
                        style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem', marginLeft: 4 }}
                      >ℹ</span>
                    </span>
                  </div>
                  <div className={s.chipGroup}>
                    {(Object.keys(PLACEMENT_RULE_LABELS) as (keyof typeof PLACEMENT_RULE_LABELS)[]).map(key => (
                      <span key={key}
                        className={`${s.chip} ${slot.placementRules[key as keyof typeof slot.placementRules] ? s.chipActive : ''}`}
                        title={PLACEMENT_RULE_DESCRIPTIONS[key]}
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
                  {/* AND-Hinweis: nur wenn >1 harte Regel aktiv */}
                  {(['nearWall','nearDoor','nearWindow','cornerOnly'] as const)
                    .filter(k => slot.placementRules[k]).length > 1 && (
                    <div className={s.slotHint} style={{ marginTop: 3, color: '#f4a261' }}>
                      ⚠ AND-Verknüpfung: Zelle muss{' '}
                      {(['nearWall','nearDoor','nearWindow','cornerOnly'] as const)
                        .filter(k => slot.placementRules[k])
                        .map(k => PLACEMENT_RULE_LABELS[k])
                        .join(' UND ')}
                      {' '}gleichzeitig erfüllen. Falls keine Zelle passt → [WARN] im Log.
                    </div>
                  )}

                  {/* ── Pfad-Option ── */}
                  <div className={s.slotRow} style={{ marginTop: 6, alignItems: 'center', gap: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none', fontSize: '0.82rem', color: slot.placementRules.allowOnPath ? '#7fd3ff' : '#889' }}
                      title="Wenn aktiv: Möbel dieses Slots dürfen auch auf Laufwegen (Pfadzellen) platziert werden. Standard: Möbel mit Kollision werden von Pfaden ferngehalten.">
                      <input
                        type="checkbox"
                        checked={slot.placementRules.allowOnPath ?? false}
                        onChange={() => updateSlot(idx, {
                          placementRules: { ...slot.placementRules, allowOnPath: !(slot.placementRules.allowOnPath ?? false) }
                        })}
                        style={{ accentColor: '#4d9fcc' }}
                      />
                      🚶 Auf Laufweg erlaubt
                      <span style={{ fontSize: '0.72rem', color: '#667', marginLeft: 2 }}>(überschreibt Kollisions-Sperre)</span>
                    </label>
                  </div>

                  {/* ── Blockiert Zelle ── */}
                  <div className={s.slotRow} style={{ marginTop: 4, alignItems: 'center', gap: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none', fontSize: '0.82rem', color: (slot.blocksPlacement ?? true) ? '#889' : '#7fd3ff' }}
                      title={'Wenn aktiv (Standard): Die belegten Zellen werden nach Platzierung als „belegt" markiert – andere Slots können diese Zellen nicht mehr nutzen.\n\nWenn deaktiviert: Zellen bleiben frei, andere Slots können dieselbe Zelle belegen.\nBenötigt für Objekte die auf anderen Möbeln stehen:\n• Tischlampe auf Nachttisch → blocksPlacement: AUS\n• Radio auf Kommode → blocksPlacement: AUS\n• Waschbecken auf Unterschrank → blocksPlacement: AUS'}>
                      <input
                        type="checkbox"
                        checked={slot.blocksPlacement ?? true}
                        onChange={() => updateSlot(idx, { blocksPlacement: !(slot.blocksPlacement ?? true) })}
                        style={{ accentColor: '#4d9fcc' }}
                      />
                      📦 Blockiert Zelle
                      <span style={{ fontSize: '0.72rem', color: '#667', marginLeft: 2 }}>
                        {(slot.blocksPlacement ?? true) ? '(andere Slots können diese Zelle nicht belegen)' : '⚡ aus – Möbel können gestapelt werden'}
                      </span>
                    </label>
                  </div>

                  {/* ── Soft-Block (nur wenn blocksPlacement: false) ── */}
                  {!(slot.blocksPlacement ?? true) && (
                    <div className={s.slotRow} style={{ marginTop: 4, marginLeft: 16, alignItems: 'center', gap: 8 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none', fontSize: '0.82rem', color: (slot.softBlocks ?? false) ? '#f0c060' : '#667' }}
                        title={'Wenn aktiv: Zellen gehen in softOccupied.\nNormale Slots landen nicht darauf.\nSlots mit requiresSlot (z.B. Lampe via AnchorRules) ignorieren softOccupied und dürfen darauf platziert werden.\n\nTypischer Einsatz: Nachttisch\n  blocksPlacement: AUS + Soft-Block: EIN\n\nTeppich: blocksPlacement: AUS + Soft-Block: AUS (alles darf drauf)'}>
                        <input
                          type="checkbox"
                          checked={slot.softBlocks ?? false}
                          onChange={() => updateSlot(idx, { softBlocks: !(slot.softBlocks ?? false) })}
                          style={{ accentColor: '#f0c060' }}
                        />
                        🔒 Soft-Block
                        <span style={{ fontSize: '0.72rem', color: '#667', marginLeft: 2 }}>
                          {(slot.softBlocks ?? false) ? '(nur requiresSlot-Slots dürfen darauf)' : '(aus – alles darf auf dieser Zelle landen)'}
                        </span>
                      </label>
                    </div>
                  )}

                  {/* ── Wandausrichtung (nur bei nearWall) ── */}
                  {slot.placementRules.nearWall && (
                    <div style={{ marginTop: 6 }}>
                      <div className={s.slotRow} style={{ marginBottom: 3 }}>
                        <span className={s.slotGroupLabel}>
                          Wandausrichtung
                          <span
                            title={"Bestimmt, wie das Möbelstück relativ zur Wand ausgerichtet wird.\n\n• Automatisch: Generator wählt die beste passende Tile-Variante.\n• Senkrecht (⊥): Rücken an der Wand, Vorderseite zeigt in den Raum.\n  Für Möbel die in den Raum ragen (Bett, Schreibtisch, WC).\n  Bevorzugt Tile-Variante mit langer Achse senkrecht zur Wand.\n• Parallel (∥): Längsseite entlang der Wand.\n  Für Möbel die entlang der Wand stehen (Sofa, Regal, Kommode).\n  Bevorzugt Tile-Variante mit langer Achse parallel zur Wand.\n\nHinweis: Benötigt Tile-Varianten in der VariantGroup mit korrekten TileLayout-Dimensionen."}
                            style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem', marginLeft: 4 }}
                          >ℹ</span>
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {WALL_ALIGNMENT_OPTIONS.map(opt => {
                          const active = (slot.placementRules.wallAlignment ?? 'any') === opt.value;
                          return (
                            <button
                              key={opt.value}
                              title={opt.title}
                              onClick={() => updateSlot(idx, {
                                placementRules: { ...slot.placementRules, wallAlignment: opt.value }
                              })}
                              style={{
                                fontSize: '0.75rem', padding: '2px 10px', borderRadius: 4, cursor: 'pointer',
                                border: active ? '1.5px solid #6af' : '1px solid #445',
                                background: active ? '#1a2d3d' : '#1a1a1a',
                                color: active ? '#7fd3ff' : '#778',
                                fontWeight: active ? 600 : 400,
                              }}>
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

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
                              : 'Wertebereich: 1–10\n\nGewichtung bestimmt die Auswahlwahrscheinlichkeit innerhalb der Varianten-Gruppe.\n\nDieser Slot ist optional (☐) – der Generator entscheidet anhand von Priorität und Raumgröße, ob die Gruppe überhaupt gezogen wird. Wenn ja, bestimmt das Gewicht die Variante.'
                          }
                          style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem' }}
                        >ℹ</span>
                      </span>
                      <input type="number" min={1} max={10} className={s.slotNumInput}
                        value={slot.groupWeight}
                        onChange={e => { const v = +e.target.value; if (v >= 1) updateSlot(idx, { groupWeight: v }); }}
                        onBlur={e => updateSlot(idx, { groupWeight: Math.max(1, Math.min(10, +e.target.value)) })} />
                    </>)}
                  </div>
                  {slot.slotGroupId && (() => {
                    const groupSize = draft.slots.filter(sl => sl.slotGroupId === slot.slotGroupId).length;                    const allRequired = draft.slots
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

                  {/* ── Farbgruppe (Slot-Ebene) ── */}
                  <div className={s.slotRow} style={{ marginTop: 6, gap: 8 }}>
                    <span className={s.slotGroupLabel}
                      title={'Farbgruppen-ID für diesen Slot.\n\n• Leer = erbt den Raum-Default\n• "none" = kein Farbfilter (z.B. Stuhl, Spiegel)\n• Eigener Wert = eigene Gruppe (z.B. "accent" für Teppich)\n\nDer erste Slot einer Gruppe legt die Farbe fest. Alle Folge-Slots der gleichen Gruppe filtern ihre Tiles auf diese Farbe.'}>
                      🎨 Farbgruppe
                      <span style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem', marginLeft: 4 }}>ℹ</span>
                    </span>
                    <input
                      className={s.slotSizeInput}
                      style={{ flex: 2 }}
                      placeholder={`leer = erbt "${draft.colorGroupId || '—'}" | "none" = kein Filter`}
                      value={slot.colorGroupId ?? ''}
                      onChange={e => updateSlot(idx, { colorGroupId: e.target.value })}
                    />
                    {(() => {
                      const effectiveGroup = slot.colorGroupId === 'none' ? null
                        : slot.colorGroupId || draft.colorGroupId || null;
                      if (!effectiveGroup) return <span className={s.slotHint} style={{ color: '#556' }}>kein Filter</span>;
                      return <span className={s.slotHint} style={{ color: '#8c8' }}>→ Gruppe „{effectiveGroup}"</span>;
                    })()}
                  </div>

                  {/* ── Farbpalette für slot-spezifische Gruppe ── */}
                  {(() => {
                    const slotGroup = slot.colorGroupId;
                    if (!slotGroup || slotGroup === 'none' || slotGroup === draft.colorGroupId)
                      return null;
                    const palette = draft.colorPalettes?.[slotGroup] ?? [];
                    return (
                      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <label className={s.pathStyleLabel}
                          title={`Erlaubte Farben für Gruppe „${slotGroup}". Der Generator wählt vor dem Slot-Loop zufällig eine der ausgewählten Farben. Keine Auswahl = Farbe wird vom ersten platzierten Möbel übernommen.`}>
                          🎨 Palette für „{slotGroup}"
                        </label>
                        <div className={s.chipGroup}>
                          {availColors.length === 0 && (
                            <span className={s.slotHint} style={{ fontStyle: 'italic' }}>
                              Keine Farben verfügbar – Möbel-Vorlagen mit Farb-Tags eintragen
                            </span>
                          )}
                          {availColors.map(color => {
                            const active = palette.includes(color);
                            return (
                              <span key={color}
                                className={`${s.chip} ${active ? s.chipActive : ''}`}
                                title={active ? `„${color}" entfernen` : `„${color}" hinzufügen`}
                                onClick={() => {
                                  const next = active
                                    ? palette.filter(c => c !== color)
                                    : [...palette, color];
                                  setDraft({
                                    ...draft,
                                    colorPalettes: { ...(draft.colorPalettes ?? {}), [slotGroup]: next },
                                  });
                                  setDirty(true);
                                }}>
                                {color}
                              </span>
                            );
                          })}
                        </div>
                        {palette.length === 0
                          ? <div className={s.slotHint} style={{ color: '#888' }}>Keine Auswahl → Farbe vom ersten platzierten Möbel</div>
                          : <div className={s.slotHint} style={{ color: '#8c8' }}>✓ {palette.length} Farbe{palette.length !== 1 ? 'n' : ''} → zufällige Auswahl</div>
                        }
                      </div>
                    );
                  })()}

                  {/* ── Tile-Gruppe (gleicher Variantensatz) ── */}
                  <div className={s.slotRow} style={{ marginTop: 6, gap: 8 }}>
                    <span className={s.slotGroupLabel}
                      title={'Tile-Gruppen-ID für kohärente Modellwahl.\n\nAlle Slots mit gleicher tileGroupId stammen aus derselben VariantGroup (Tile-Ebene).\n\n• Leer = keine Bindung (jeder Slot wählt unabhängig)\n• Wert = z.B. "dining_chairs" – erster Slot friert VariantGroup ein, alle weiteren filtern darauf.\n\nBeispiel: 4 Stühle am Tisch → alle bekommen denselben Stuhltyp (chair_beige_01).'}>
                      🪑 Tile-Gruppe
                      <span style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem', marginLeft: 4 }}>ℹ</span>
                    </span>
                    <input
                      className={s.slotSizeInput}
                      style={{ flex: 2 }}
                      placeholder="z.B. dining_chairs (leer = kein Variantenzwang)"
                      value={slot.tileGroupId ?? ''}
                      onChange={e => updateSlot(idx, { tileGroupId: e.target.value })}
                    />
                    {slot.tileGroupId
                      ? <span className={s.slotHint} style={{ color: '#ac8' }}>→ Gruppe „{slot.tileGroupId}"</span>
                      : <span className={s.slotHint} style={{ color: '#556' }}>unabhängig</span>
                    }
                  </div>

                  {/* ── Material-Filter ── */}
                  <div className={s.slotRow} style={{ marginTop: 6, gap: 8 }}>
                    <span className={s.slotGroupLabel}
                      title={'Material-Filter: Nur Tiles deren Materials-Liste diesen Wert enthält kommen in Frage.\n\n• Leer = kein Materialfilter (Standard)\n• "none" = kein Filter für diesen Slot (explizit deaktiviert)\n• Wert = nur Tiles aus diesem Material\n\nAND-verknüpft mit dem Farbfilter.'}>
                      🪵 Materialfilter
                      <span style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem', marginLeft: 4 }}>ℹ</span>
                    </span>
                    {availMaterials.length > 0 ? (
                      <select
                        className={s.slotSizeInput}
                        style={{ flex: 2 }}
                        value={slot.materialGroupId ?? ''}
                        onChange={e => updateSlot(idx, { materialGroupId: e.target.value })}
                      >
                        <option value="">— kein Filter —</option>
                        <option value="none">none (explizit deaktiviert)</option>
                        {availMaterials.map(m => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className={s.slotSizeInput}
                        style={{ flex: 2 }}
                        placeholder='leer = kein Filter, "none" = deaktiviert'
                        value={slot.materialGroupId ?? ''}
                        onChange={e => updateSlot(idx, { materialGroupId: e.target.value })}
                      />
                    )}
                    {slot.materialGroupId && slot.materialGroupId !== 'none'
                      ? <span className={s.slotHint} style={{ color: '#c8a' }}>→ nur „{slot.materialGroupId}"</span>
                      : slot.materialGroupId === 'none'
                        ? <span className={s.slotHint} style={{ color: '#888' }}>deaktiviert</span>
                        : <span className={s.slotHint} style={{ color: '#556' }}>kein Filter</span>
                    }
                  </div>

                  {/* ── Benötigt Slot ── */}
                  <div className={s.slotRow} style={{ marginTop: 6, gap: 8 }}>
                    <span className={s.slotGroupLabel}
                      title={'Dieser Slot wird nur versucht wenn der genannte Slot (ID oder Gruppen-ID) zuvor erfolgreich platziert wurde.\n\nBeispiele:\n• Tischlampe → id des Schreibtisch-Slots\n• Waschbecken → id des Unterschrank-Slots\n• Mikrowelle → id des Küchenzeilen-Slots\n\nAnders als AnchorRules: bestimmt nur OB der Slot versucht wird, nicht wo er landet.'}>
                      🔗 Benötigt Slot
                      <span style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem', marginLeft: 4 }}>ℹ</span>
                    </span>
                    <input
                      className={s.slotSizeInput}
                      style={{ flex: 2 }}
                      list={`anchor-targets-${idx}`}
                      placeholder="Slot-ID oder Gruppen-ID (leer = unabhängig)"
                      value={slot.requiresSlot ?? ''}
                      onChange={e => updateSlot(idx, { requiresSlot: e.target.value })}
                    />
                    {slot.requiresSlot
                      ? <span className={s.slotHint} style={{ color: '#fa8' }}>⚠ nur wenn „{slot.requiresSlot}" platziert</span>
                      : <span className={s.slotHint} style={{ color: '#556' }}>unabhängig</span>
                    }
                  </div>

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
                            title={ANCHOR_POSITION_TOOLTIPS[pos]}
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
                      <div className={s.slotRow} style={{ gap: 6, marginTop: 4 }}>
                        <span className={s.slotGroupLabel} style={{ minWidth: 60 }}>
                          Ausrichtung
                          <span
                            title={rule.orient ? (ANCHOR_ORIENT_TOOLTIPS[rule.orient] ?? '') : ANCHOR_ORIENT_TOOLTIPS['']}
                            style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem', marginLeft: 4 }}
                          >ℹ</span>
                        </span>
                        <select
                          className={s.slotSizeInput}
                          value={rule.orient ?? ''}
                          onChange={e => updateAnchorRule(idx, rIdx, { orient: e.target.value as AnchorRule['orient'] })}
                        >
                          <option value="">— Tile-Standard —</option>
                          <option value="match">match (wie Anker)</option>
                          <option value="parallelToAnchor">parallelToAnchor (∥ parallel zum Anker)</option>
                          <option value="opposite">opposite (gegenüber)</option>
                          <option value="facingAnchor">facingAnchor (zum Anker zeigen)</option>
                          <option value="openSideFacing">openSideFacing (aus gewählter openSide abgeleitet)</option>
                          <option value="cwPerpendicular">cwPerpendicular (↻ senkrecht: S→E, E→N, …)</option>
                          <option value="ccwPerpendicular">ccwPerpendicular (↺ senkrecht: S→W, W→N, …)</option>
                          <option value="N">N (Nord)</option>
                          <option value="S">S (Süd)</option>
                          <option value="E">E (Ost)</option>
                          <option value="W">W (West)</option>
                        </select>
                      </div>
                      {/* Offset entlang der Kante – nur für LongSide/ShortSide sinnvoll */}
                      {rule.positions.some(p => ['LongSide0','LongSide1','ShortSide0','ShortSide1'].includes(p)) && (
                        <div className={s.slotRow} style={{ gap: 6, marginTop: 4 }}>
                          <span className={s.slotGroupLabel} style={{ minWidth: 60 }}
                            title="Versatz entlang der Ankerkante.\n0 = erste Zelle, 1 = zweite, -1 = letzte Zelle usw.">
                            Offset ℹ
                          </span>
                          <input
                            type="number"
                            className={s.slotSizeInput}
                            style={{ width: 60 }}
                            value={rule.offsetAlongAnchor ?? 0}
                            onChange={e => updateAnchorRule(idx, rIdx, { offsetAlongAnchor: parseInt(e.target.value) || 0 })}
                          />
                          <span className={s.slotHint} style={{ fontSize: '0.75rem', color: '#888' }}>
                            0=erste · 1=zweite · -1=letzte
                          </span>
                        </div>
                      )}
                      {rule.positions.includes('oppositeWall') && (
                        <div className={s.slotRow} style={{ gap: 6, marginTop: 4, alignItems: 'center' }}>
                          <span className={s.slotGroupLabel} style={{ minWidth: 60 }}
                            title="Distanzgrenzen fuer oppositeWall in Zellen. min=1 startet direkt vor dem Anchor.">
                            Distanz ℹ
                          </span>
                          <input
                            type="number"
                            min={1}
                            className={s.slotSizeInput}
                            style={{ width: 64 }}
                            value={rule.minOppositeWallDistance ?? 1}
                            onChange={e => updateAnchorRule(idx, rIdx, { minOppositeWallDistance: Math.max(1, parseInt(e.target.value) || 1) })}
                            title="Minimale Distanz zur gegenueberliegenden Wand"
                          />
                          <span className={s.slotHint}>bis</span>
                          <input
                            type="number"
                            min={1}
                            className={s.slotSizeInput}
                            style={{ width: 64 }}
                            value={rule.maxOppositeWallDistance ?? ''}
                            onChange={e => {
                              const raw = e.target.value.trim();
                              updateAnchorRule(idx, rIdx, {
                                maxOppositeWallDistance: raw === '' ? undefined : Math.max(1, parseInt(raw) || 1),
                              });
                            }}
                            title="Maximale Distanz (leer = ohne Limit)"
                            placeholder="∞"
                          />
                          <span className={s.slotHint} style={{ fontSize: '0.75rem', color: '#888' }}>
                            min..max (leer = bis zur Wand)
                          </span>
                        </div>
                      )}
                      {rule.anchorTarget && rule.positions.length > 0 && (
                        <div className={s.slotHint} style={{ marginTop: 2, color: '#8c8' }}>
                          📎 „{rule.anchorTarget}" → {rule.positions.join(' | ')}
                        </div>
                      )}
                    </div>
                  ))}

                  {/* ── Fallback-Platzierungsregeln ── */}
                  <div className={s.slotRow} style={{ marginTop: 8, justifyContent: 'space-between' }}>
                    <span className={s.slotGroupLabel}>
                      Fallback-Regeln
                      <span
                        title={"Wenn die primären Platzierungsregeln keine freie Zelle finden,\nversucht der Generator diese Regeln der Reihe nach als Alternative.\n\n• Jede Fallback-Regel ist ein vollständiger Satz Platzierungsregeln.\n• Nur relevant bei Pflicht-Slots – optionale Slots werden einfach weggelassen.\n• Beispiel: Primär an Wand → Fallback 1: freie Platzierung (keine Einschränkung)."}
                        style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem', marginLeft: 4 }}
                      >ℹ</span>
                    </span>
                    <button
                      className={s.addSlotBtn}
                      style={{ fontSize: '0.7rem', padding: '2px 8px' }}
                      onClick={() => addFallbackRule(idx)}>
                      + Fallback
                    </button>
                  </div>

                  {(!slot.fallbackRules || slot.fallbackRules.length === 0) && (
                    <div className={s.slotHint}>
                      Kein Fallback – schlägt Platzierung fehl, wird der Slot übersprungen
                      {slot.required && <span style={{ color: '#f4a261' }}> (⚠ Pflicht-Slot!)</span>}
                    </div>
                  )}

                  {(slot.fallbackRules ?? []).map((fbRule, fbIdx) => {
                    const activeFbKeys = (Object.keys(fbRule) as (keyof typeof fbRule)[])
                      .filter(k => k !== 'allowOnPath' && fbRule[k]);
                    return (
                      <div key={fbIdx} className={s.anchorRuleCard} style={{ borderColor: '#664' }}>
                        <div className={s.slotRow} style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                          <span className={s.slotGroupLabel} style={{ color: '#ca8' }}>
                            Fallback {fbIdx + 1}
                            {activeFbKeys.length > 0
                              ? `: ${activeFbKeys.map(k => PLACEMENT_RULE_LABELS[k] ?? k).join(', ')}`
                              : ': freie Platzierung'}
                          </span>
                          <button className={s.removeSlotBtn} onClick={() => removeFallbackRule(idx, fbIdx)}>✕</button>
                        </div>
                        <div className={s.chipGroup}>
                          {(Object.keys(PLACEMENT_RULE_LABELS) as Array<keyof PlacementRules & string>).map(key => (
                            <span key={key}
                              className={`${s.chip} ${fbRule[key] ? s.chipActive : ''}`}
                              title={PLACEMENT_RULE_DESCRIPTIONS[key]}
                              onClick={() => updateFallbackRule(idx, fbIdx, { [key]: !fbRule[key] } as Partial<PlacementRules>)}>
                              {PLACEMENT_RULE_LABELS[key]}
                            </span>
                          ))}
                          <span
                            className={`${s.chip} ${fbRule.allowOnPath ? s.chipActive : ''}`}
                            title="Darf auf Pfadzellen platziert werden (z.B. Teppiche)"
                            onClick={() => updateFallbackRule(idx, fbIdx, { allowOnPath: !fbRule.allowOnPath })}>
                            Auf Pfad
                          </span>
                        </div>
                        {fbRule.nearWall && (
                          <div style={{ display: 'flex', gap: 5, marginTop: 5, alignItems: 'center' }}>
                            <span style={{ fontSize: '0.72rem', color: '#778' }}>Wandausrichtung:</span>
                            {WALL_ALIGNMENT_OPTIONS.map(opt => {
                              const active = (fbRule.wallAlignment ?? 'any') === opt.value;
                              return (
                                <button key={opt.value} title={opt.title}
                                  onClick={() => updateFallbackRule(idx, fbIdx, { wallAlignment: opt.value })}
                                  style={{
                                    fontSize: '0.7rem', padding: '1px 8px', borderRadius: 3, cursor: 'pointer',
                                    border: active ? '1.5px solid #6af' : '1px solid #445',
                                    background: active ? '#1a2d3d' : '#1a1a1a',
                                    color: active ? '#7fd3ff' : '#778',
                                  }}>{opt.label}</button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                </>)} {/* end isCollapsed */}
              </div>
              ); // end return slot card
              }); // end map
            })()} {/* end IIFE */}

            {/* ── Layout-Varianten ── */}
            <div className={s.slotsHeader} style={{ marginTop: 12 }}>
              <span className={s.slotsLabel}>Layout-Varianten ({(draft.layoutVariants ?? []).length})</span>
              <button className={s.addSlotBtn} onClick={addLayoutVariant}>+ Variante</button>
            </div>

            <div className={s.anchorRuleCard}>
              <div className={s.slotRow} style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                <span className={s.slotGroupLabel}>
                  Common-Slots
                  <span style={{ color: '#446', fontSize: '0.68rem', marginLeft: 6 }}>
                    ({(draft.commonSlotIds ?? []).length})
                  </span>
                </span>
              </div>

              {(draft.commonSlotIds ?? []).length > 0 ? (
                <div className={s.chipGroup} style={{ marginBottom: 6 }}>
                  {(draft.commonSlotIds ?? []).map((slotId, slotIdx) => {
                    const slotObj = draft.slots.find(slt => slt.id === slotId);
                    return (
                      <div key={`${slotId}-${slotIdx}`} className={s.chip} title={slotObj ? `${slotId} (${slotObj.label})` : slotId}>
                        {slotId}
                        <span
                          style={{ marginLeft: 6, cursor: 'pointer', color: '#f88', fontSize: '0.8rem' }}
                          onClick={() => removeCommonSlot(slotId)}
                        >
                          ✕
                        </span>
                        <span
                          style={{ marginLeft: 6, cursor: slotIdx > 0 ? 'pointer' : 'default', color: slotIdx > 0 ? '#8ac' : '#556', fontSize: '0.8rem' }}
                          onClick={() => slotIdx > 0 && reorderCommonSlots(slotIdx, slotIdx - 1)}
                        >
                          ↑
                        </span>
                        <span
                          style={{ marginLeft: 4, cursor: slotIdx < (draft.commonSlotIds ?? []).length - 1 ? 'pointer' : 'default', color: slotIdx < (draft.commonSlotIds ?? []).length - 1 ? '#8ac' : '#556', fontSize: '0.8rem' }}
                          onClick={() => slotIdx < (draft.commonSlotIds ?? []).length - 1 && reorderCommonSlots(slotIdx, slotIdx + 1)}
                        >
                          ↓
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: '0.68rem', color: '#556', fontStyle: 'italic', marginBottom: 6 }}>
                  Keine Common-Slots definiert
                </div>
              )}

              <div style={{ fontSize: '0.68rem', color: '#778', marginBottom: 4 }}>Verfügbare Slots zum Hinzufügen:</div>
              <div className={s.chipGroup} style={{ gap: 3, maxHeight: 86, overflowY: 'auto' }}>
                {draft.slots.map((slot, slotIdx) => {
                  const isAdded = (draft.commonSlotIds ?? []).includes(slot.id);
                  return (
                    <span
                      key={`common-${slot.id}-${slotIdx}`}
                      className={`${s.chip} ${isAdded ? s.chipActive : ''}`}
                      style={{ cursor: isAdded ? 'default' : 'pointer', opacity: isAdded ? 0.5 : 1 }}
                      title={slot.label ? `${slot.id} - ${slot.label}` : slot.id}
                      onClick={() => !isAdded && addCommonSlot(slot.id)}
                    >
                      {slot.id || '(keine ID)'}
                    </span>
                  );
                })}
              </div>

              <div className={s.slotHint} style={{ marginTop: 4 }}>
                💡 Common-Slots laufen bei aktiver Layout-Variante immer zusätzlich zu den Variant-Core-Slots.
              </div>
            </div>

            {(draft.layoutVariants ?? []).length === 0 && (
              <div className={s.hint} style={{ padding: '10px 12px' }}>
                Keine Layout-Varianten definiert – der Generator behandelt die Slots dann normal.
              </div>
            )}

            {(draft.layoutVariants ?? []).map((variant, idx) => (
              <div key={idx} className={s.anchorRuleCard}>
                <div className={s.slotRow} style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                  <span className={s.slotGroupLabel}>Variante {idx + 1}</span>
                  <button className={s.removeSlotBtn} onClick={() => removeLayoutVariant(idx)}>✕</button>
                </div>

                <div className={s.slotRow} style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className={s.slotGroupLabel}>ID</span>
                  <input
                    className={s.slotSizeInput}
                    style={{ flex: 2, minWidth: 180 }}
                    placeholder="z.B. kitchen_l_shape"
                    value={variant.id}
                    onChange={e => updateLayoutVariant(idx, { id: e.target.value })}
                  />
                  <span className={s.slotGroupLabel}>Label</span>
                  <input
                    className={s.slotSizeInput}
                    style={{ flex: 3, minWidth: 220 }}
                    placeholder="z.B. L-Shape Küche"
                    value={variant.label}
                    onChange={e => updateLayoutVariant(idx, { label: e.target.value })}
                  />
                </div>

                <div className={s.slotRow} style={{ gap: 8, marginTop: 4, alignItems: 'center' }}>
                  <span className={s.slotGroupLabel}>Gewicht</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    className={s.slotNumInput}
                    value={variant.weight ?? 5}
                    onChange={e => updateLayoutVariant(idx, { weight: Math.max(1, parseInt(e.target.value) || 1) })}
                    onBlur={e => updateLayoutVariant(idx, { weight: Math.max(1, Math.min(10, parseInt(e.target.value) || 5)) })}
                  />
                  <span className={s.slotHint}>1–10</span>
                </div>

                 <div className={s.slotRow} style={{ gap: 8, marginTop: 4, alignItems: 'flex-start', flexDirection: 'column' }}>
                   <span className={s.slotGroupLabel}>
                     Slots{' '}
                     <span style={{ color: '#446', fontSize: '0.65rem' }}>
                       ({(variant.slotIds ?? []).length} von {draft.slots.length})
                     </span>
                   </span>
                   
                   {/* Drop-Zone für Slots */}
                   <div
                     className={`${s.slotDropZone} ${dragOverLayoutVariant === idx ? s.dragOver : ''}`}
                     onDragEnter={() => setDragOverLayoutVariant(idx)}
                     onDragLeave={() => setDragOverLayoutVariant(null)}
                     onDragOver={e => {
                       e.preventDefault();
                       e.dataTransfer.dropEffect = 'copy';
                       setDragOverLayoutVariant(idx);
                     }}
                     onDrop={e => {
                       e.preventDefault();
                       const slotData = e.dataTransfer.getData('text/plain');
                       if (slotData) addSlotToLayoutVariant(idx, slotData);
                       setDragOverLayoutVariant(null);
                     }}
                   >
                     <div style={{ fontSize: '0.7rem', color: '#668', marginBottom: 6 }}>
                       📌 Ziehe Slot-IDs hier rein oder verwende die Liste unten
                     </div>
                     
                     {/* Display existing slots as draggable chips */}
                     {(variant.slotIds ?? []).length > 0 ? (
                       <div className={s.chipGroup} style={{ marginBottom: 4 }}>
                         {(variant.slotIds ?? []).map((slotId, slotIdx) => {
                           const slotObj = draft.slots.find(s => s.id === slotId);
                           const isOver = dragOverLayoutSlot?.variantIdx === idx && dragOverLayoutSlot?.slotIdx === slotIdx;
                           return (
                             <div
                               key={slotId}
                               draggable
                               onDragStart={e => {
                                 dragLayoutVariantRef.current = { variantIdx: idx, slotIdx };
                                 e.dataTransfer.effectAllowed = 'move';
                               }}
                               onDragOver={e => {
                                 e.preventDefault();
                                 e.dataTransfer.dropEffect = 'move';
                                 setDragOverLayoutSlot({ variantIdx: idx, slotIdx });
                               }}
                               onDrop={e => {
                                 e.preventDefault();
                                 if (dragLayoutVariantRef.current?.variantIdx === idx) {
                                   reorderLayoutVariantSlots(idx, dragLayoutVariantRef.current.slotIdx, slotIdx);
                                 }
                                 dragLayoutVariantRef.current = null;
                                 setDragOverLayoutSlot(null);
                               }}
                               onDragEnd={() => {
                                 dragLayoutVariantRef.current = null;
                                 setDragOverLayoutSlot(null);
                               }}
                               className={`${s.chip} ${isOver ? s.chipDragOver : ''}`}
                               style={{ 
                                 cursor: 'grab',
                                 opacity: isOver ? 0.7 : 1,
                                 borderColor: isOver ? '#8866cc' : undefined,
                               }}
                               title={slotObj ? `${slotId} (${slotObj.label})` : slotId}
                             >
                               ⠿ {slotId}
                               <span
                                 style={{
                                   marginLeft: 4,
                                   cursor: 'pointer',
                                   color: '#f88',
                                   fontSize: '0.8rem',
                                 }}
                                 onClick={e => {
                                   e.stopPropagation();
                                   removeSlotFromLayoutVariant(idx, slotId);
                                 }}
                               >
                                 ✕
                               </span>
                             </div>
                           );
                         })}
                       </div>
                     ) : (
                       <div style={{ fontSize: '0.68rem', color: '#556', fontStyle: 'italic', textAlign: 'center', padding: '8px' }}>
                         Noch keine Slots hinzugefügt
                       </div>
                     )}
                   </div>
                   
                   {/* Verfügbare Slots zum Hinzufügen */}
                   <div style={{ marginTop: 6, width: '100%' }}>
                     <div style={{ fontSize: '0.68rem', color: '#778', marginBottom: 4 }}>Verfügbare Slots zum Hinzufügen:</div>
                     <div className={s.chipGroup} style={{ gap: 3, maxHeight: 100, overflowY: 'auto' }}>
                       {draft.slots.map(slot => {
                         const isAdded = (variant.slotIds ?? []).includes(slot.id);
                         return (
                           <span
                             key={slot.id}
                             draggable
                             onDragStart={e => {
                               e.dataTransfer.effectAllowed = 'copy';
                               e.dataTransfer.setData('text/plain', slot.id);
                             }}
                             title={slot.label ? `${slot.id} - ${slot.label}` : slot.id}
                             className={`${s.chip} ${isAdded ? s.chipActive : ''}`}
                             style={{ 
                               cursor: isAdded ? 'default' : 'grab',
                               opacity: isAdded ? 0.5 : 1,
                             }}
                             onClick={() => {
                               if (!isAdded) addSlotToLayoutVariant(idx, slot.id);
                             }}
                           >
                             {slot.id || '(keine ID)'}
                           </span>
                         );
                       })}
                     </div>
                   </div>
                 </div>

                   <div className={s.slotHint} style={{ marginTop: 4 }}>
                    💡 Variante = Core-Slots für das Shape. Common-Slots werden zusätzlich aus der globalen Common-Liste ergänzt.
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

      {/* ── Right: ref panel ── */}
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
  );
}

















































