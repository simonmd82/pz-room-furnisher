import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SIZE_KEYS, ANCHOR_POSITIONS, ANCHOR_POSITION_TOOLTIPS, ANCHOR_ORIENT_TOOLTIPS,
  REQUIRED_PROPERTIES, FURNITURE_LAYERS,
  COMMON_FOOTPRINTS, defaultSlot, defaultRoomTypeConfig, defaultPlacementRules,
  defaultLayoutPool, defaultLayoutPoolRequiredSlot, defaultLayoutPoolCompanion, defaultReservedZone,
  defaultRugSlotConfig, EMPTY_CATEGORY, normalizeGridLayout, DEFAULT_SIZE_LIMITS,
} from '../../types/roomTypes';
import type { AnchorRule, GridLayout, PlacementRules, RoomTypeConfig, RoomTypeConfigMap, RoomTypeSlot, LayoutPool, LayoutPoolRequiredSlot, LayoutPoolCompanion, ReservedZoneRule } from '../../types/roomTypes';
import { getRoomTypes, saveRoomType, deleteRoomType } from '../../api/roomTypesApi';
import { getRoomTypeNames, saveRoomTypeNames, getCategories, getMaterials } from '../../api/settingsApi';
import { getGroups, getColors } from '../../api/tilesApi';
import { SHADES, shadeColor } from '../../types/tiles';

/** A color is a "base" (shade-combinable) color unless it's already a "X Light"/"X Dark" compound. */
const isBaseColor = (color: string): boolean => !SHADES.some(sh => color.endsWith(` ${sh}`));
import { AnchorRulePreview } from './AnchorRulePreview';
import { FurniturePickerModal } from './FurniturePickerModal';
import { GridLayoutEditor, gridSaveErrors } from './GridLayoutEditor';
import { ThemeSelector } from './ThemeSelector';
import { Spinner } from '../Spinner/Spinner';
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

/** Beispiel-Grundrisse für die Layout-Referenz im rechten Panel (true = belegte Zelle). */
const LAYOUT_SHAPE_EXAMPLES: { id: 'line' | 'lShape' | 'uShape'; grid: boolean[][] }[] = [
  { id: 'line',   grid: [[true, true, true, true]] },
  { id: 'lShape', grid: [
    [true, true, true, true],
    [true, false, false, false],
    [true, false, false, false],
  ] },
  { id: 'uShape', grid: [
    [true, false, false, false, true],
    [true, false, false, false, true],
    [true, true, true, true, true],
  ] },
];

function getGroupColor(groupId: string, allGroupIds: string[]): string {
  const idx = allGroupIds.indexOf(groupId);
  return GROUP_COLORS[idx % GROUP_COLORS.length];
}

const PLACEMENT_RULE_KEYS = ['nearWall', 'nearDoor', 'nearWindow', 'centerRoom', 'cornerOnly', 'mainSubRoom'] as const;

const WALL_ALIGNMENT_KEYS: { value: PlacementRules['wallAlignment'] }[] = [
  { value: 'any' },
  { value: 'perpendicular' },
  { value: 'parallel' },
];

/**
 * Erklärung der Anker-Positionen.
 * Bezugspunkt: Perspektive vom Fußende zum Kopfende.
 * Beispiel Bett (Orient S = Kopf oben/Norden, Füße unten/Süden):
 *   HeadLeft  = links vom Kopfende  (West-Seite oben)
 *   HeadRight = rechts vom Kopfende (Ost-Seite oben)
 *   FootLeft  = links vom Fußende   (West-Seite unten)
 *   FootRight = rechts vom Fußende  (Ost-Seite unten)
 */

/** Palette entry meaning "all colours" — the generator picks among colours every group member can match. */
const ALL_COLORS = '*';

/** Colour palette multi-select (chips + shades) with an "All" toggle, plus a summary line. */
function ColorPaletteChips({ palette, availColors, onChange, short = false }: {
  palette: string[];
  availColors: string[];
  onChange: (next: string[]) => void;
  short?: boolean;
}) {
  const { t } = useTranslation();
  const all = palette.includes(ALL_COLORS);
  // While "All" is on, picking a colour switches to an explicit palette with just that colour.
  const toggle = (val: string) => onChange(all
    ? [val]
    : palette.includes(val) ? palette.filter(c => c !== val) : [...palette, val]);

  return (
    <>
      <div className={s.chipGroup}>
        {availColors.length === 0 && (
          <span className={s.slotHint} style={{ fontStyle: 'italic' }}>{t('roomTypeEditor.colorPalette.noColors')}</span>
        )}
        {availColors.length > 0 && (
          <span className={`${s.chip} ${all ? s.chipActive : ''}`} style={{ fontWeight: 600 }}
            title={t('roomTypeEditor.colorPalette.allTitle')}
            onClick={() => onChange(all ? [] : [ALL_COLORS])}>
            {t('roomTypeEditor.colorPalette.all')}
          </span>
        )}
        {availColors.map(color => {
          const active = !all && palette.includes(color);
          const showShades = !all && isBaseColor(color) && (active || SHADES.some(sh => palette.includes(shadeColor(color, sh))));
          return (
            <span key={color} className={s.colorSwatch} style={all ? { opacity: 0.45 } : undefined}>
              <span
                className={`${s.chip} ${active ? s.chipActive : ''}`}
                title={active ? t('roomTypeEditor.colorPalette.removeColor', { color }) : t('roomTypeEditor.colorPalette.addColor', { color })}
                onClick={() => toggle(color)}>
                {color}
              </span>
              {showShades && SHADES.map(sh => {
                const val = shadeColor(color, sh);
                const shActive = palette.includes(val);
                return (
                  <span key={sh}
                    className={`${s.chip} ${s.chipShade} ${shActive ? s.chipActive : ''}`}
                    title={shActive ? t('roomTypeEditor.colorPalette.removeColor', { color: val }) : t('roomTypeEditor.colorPalette.addColor', { color: val })}
                    onClick={() => toggle(val)}>
                    {t(`common.shade${sh}`)}
                  </span>
                );
              })}
            </span>
          );
        })}
      </div>
      {all
        ? <div className={s.slotHint} style={{ color: '#8c8' }}>{t('roomTypeEditor.colorPalette.allSelected')}</div>
        : palette.length === 0
          ? <div className={s.slotHint} style={{ color: '#888' }}>{t('roomTypeEditor.colorPalette.noneSelected')}</div>
          : <div className={s.slotHint} style={{ color: '#8c8' }}>
              {t(short ? 'roomTypeEditor.colorPalette.selectedCountShort' : 'roomTypeEditor.colorPalette.selectedCount', { count: palette.length })}
            </div>}
    </>
  );
}

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
  const [initLoading, setInitLoading] = useState(true);
  const [status, setStatus]           = useState<string | null>(null);
  const [newRoomName, setNewRoomName] = useState('');
  const [infoOpen, setInfoOpen]       = useState(false);
  /** Slot index the furniture picker is open for (null = closed) */
  const [pickerSlotIdx, setPickerSlotIdx] = useState<number | null>(null);
  /** Indices der eingeklappten Slot-Karten */
  const [collapsedSlots, setCollapsedSlots] = useState<Set<number>>(new Set());
  /** Indices der eingeklappten Layout-Varianten */
  const [collapsedLayoutVariants, setCollapsedLayoutVariants] = useState<Set<number>>(new Set());
  /** Drag & Drop: Index des aktuell gezogenen Slots */
  const dragIndexRef = useRef<number | null>(null);
  /** Index des Slots über dem der Cursor gerade schwebt */
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
   /** Zwischenablage: kopierter Slot + Quellenraum */
   const [copiedSlot, setCopiedSlot] = useState<{ slot: RoomTypeSlot; fromRoom: string } | null>(null);
   const [copiedGrid, setCopiedGrid] = useState<{ grid: GridLayout; fromRoom: string } | null>(null);
   /** Drag & Drop für Layout-Varianten: welche Variante/Slot wird gerade gezogen */
   const dragLayoutVariantRef = useRef<{ variantIdx: number; slotIdx: number } | null>(null);
   const [dragOverLayoutSlot, setDragOverLayoutSlot] = useState<{ variantIdx: number; slotIdx: number } | null>(null);
   /** Welche Varianten-Drop-Zone ist gerade im Hover-Modus */
   const [dragOverLayoutVariant, setDragOverLayoutVariant] = useState<number | null>(null);

  useEffect(() => {
    getRoomTypes().then(cfgs => setConfigs(cfgs)).catch(console.error).finally(() => setInitLoading(false));
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
          reservedZones: configs[rt].reservedZones ?? [],
          grids: (configs[rt].grids ?? []).map(normalizeGridLayout),
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
     if (!window.confirm(t('roomTypeEditor.removeVariantConfirm', { n: idx + 1 }))) return;
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

  // ── Pool segment management ────────────────────────────────────────────────

  const addPool = (variantIdx: number) => {
    if (!draft) return;
    const variants = [...(draft.layoutVariants ?? [])];
    const v = variants[variantIdx];
    if (!v) return;
    variants[variantIdx] = { ...v, pools: [...(v.pools ?? []), defaultLayoutPool()] };
    setDraft({ ...draft, layoutVariants: variants });
    setDirty(true);
  };

  const removePool = (variantIdx: number, poolIdx: number) => {
    if (!draft) return;
    const variants = [...(draft.layoutVariants ?? [])];
    const v = variants[variantIdx];
    if (!v) return;
    const pools = [...(v.pools ?? [])];
    pools.splice(poolIdx, 1);
    variants[variantIdx] = { ...v, pools };
    setDraft({ ...draft, layoutVariants: variants });
    setDirty(true);
  };

  const updatePool = (variantIdx: number, poolIdx: number, patch: Partial<LayoutPool>) => {
    if (!draft) return;
    const variants = [...(draft.layoutVariants ?? [])];
    const v = variants[variantIdx];
    if (!v) return;
    const pools = [...(v.pools ?? [])];
    pools[poolIdx] = { ...pools[poolIdx], ...patch };
    variants[variantIdx] = { ...v, pools };
    setDraft({ ...draft, layoutVariants: variants });
    setDirty(true);
  };

  const addRequiredSlot = (variantIdx: number, poolIdx: number) => {
    if (!draft) return;
    const variants = [...(draft.layoutVariants ?? [])];
    const v = variants[variantIdx];
    if (!v) return;
    const pools = [...(v.pools ?? [])];
    const pool = pools[poolIdx];
    if (!pool) return;
    pools[poolIdx] = { ...pool, requiredSlots: [...pool.requiredSlots, defaultLayoutPoolRequiredSlot()] };
    variants[variantIdx] = { ...v, pools };
    setDraft({ ...draft, layoutVariants: variants });
    setDirty(true);
  };

  const removeRequiredSlot = (variantIdx: number, poolIdx: number, rsIdx: number) => {
    if (!draft) return;
    const variants = [...(draft.layoutVariants ?? [])];
    const v = variants[variantIdx];
    if (!v) return;
    const pools = [...(v.pools ?? [])];
    const pool = pools[poolIdx];
    if (!pool) return;
    const rs = [...pool.requiredSlots];
    rs.splice(rsIdx, 1);
    pools[poolIdx] = { ...pool, requiredSlots: rs };
    variants[variantIdx] = { ...v, pools };
    setDraft({ ...draft, layoutVariants: variants });
    setDirty(true);
  };

  const updateRequiredSlot = (variantIdx: number, poolIdx: number, rsIdx: number, patch: Partial<LayoutPoolRequiredSlot>) => {
    if (!draft) return;
    const variants = [...(draft.layoutVariants ?? [])];
    const v = variants[variantIdx];
    if (!v) return;
    const pools = [...(v.pools ?? [])];
    const pool = pools[poolIdx];
    if (!pool) return;
    const rs = [...pool.requiredSlots];
    rs[rsIdx] = { ...rs[rsIdx], ...patch };
    pools[poolIdx] = { ...pool, requiredSlots: rs };
    variants[variantIdx] = { ...v, pools };
    setDraft({ ...draft, layoutVariants: variants });
    setDirty(true);
  };

  const addCompanion = (variantIdx: number, poolIdx: number, rsIdx: number) => {
    if (!draft) return;
    const variants = [...(draft.layoutVariants ?? [])];
    const v = variants[variantIdx];
    if (!v) return;
    const pools = [...(v.pools ?? [])];
    const pool = pools[poolIdx];
    if (!pool) return;
    const rs = [...pool.requiredSlots];
    rs[rsIdx] = { ...rs[rsIdx], companions: [...(rs[rsIdx].companions ?? []), defaultLayoutPoolCompanion()] };
    pools[poolIdx] = { ...pool, requiredSlots: rs };
    variants[variantIdx] = { ...v, pools };
    setDraft({ ...draft, layoutVariants: variants });
    setDirty(true);
  };

  const removeCompanion = (variantIdx: number, poolIdx: number, rsIdx: number, ci: number) => {
    if (!draft) return;
    const variants = [...(draft.layoutVariants ?? [])];
    const v = variants[variantIdx];
    if (!v) return;
    const pools = [...(v.pools ?? [])];
    const pool = pools[poolIdx];
    if (!pool) return;
    const rs = [...pool.requiredSlots];
    const companions = [...(rs[rsIdx].companions ?? [])];
    companions.splice(ci, 1);
    rs[rsIdx] = { ...rs[rsIdx], companions };
    pools[poolIdx] = { ...pool, requiredSlots: rs };
    variants[variantIdx] = { ...v, pools };
    setDraft({ ...draft, layoutVariants: variants });
    setDirty(true);
  };

  const updateCompanion = (variantIdx: number, poolIdx: number, rsIdx: number, ci: number, patch: Partial<LayoutPoolCompanion>) => {
    if (!draft) return;
    const variants = [...(draft.layoutVariants ?? [])];
    const v = variants[variantIdx];
    if (!v) return;
    const pools = [...(v.pools ?? [])];
    const pool = pools[poolIdx];
    if (!pool) return;
    const rs = [...pool.requiredSlots];
    const companions = [...(rs[rsIdx].companions ?? [])];
    companions[ci] = { ...companions[ci], ...patch };
    rs[rsIdx] = { ...rs[rsIdx], companions };
    pools[poolIdx] = { ...pool, requiredSlots: rs };
    variants[variantIdx] = { ...v, pools };
    setDraft({ ...draft, layoutVariants: variants });
    setDirty(true);
  };

  /** Toggles a value in a string[] field (used for cellRequiredProperties pills). */
  const toggleInArray = (arr: string[], val: string) =>
    arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val];

  const togglePoolCategory = (variantIdx: number, poolIdx: number, cat: string) => {
    if (!draft) return;
    const variants = [...(draft.layoutVariants ?? [])];
    const v = variants[variantIdx];
    if (!v) return;
    const pools = [...(v.pools ?? [])];
    const pool = pools[poolIdx];
    if (!pool) return;
    const cats = { ...pool.defaultCategories };
    if (cats[cat] !== undefined) delete cats[cat]; else cats[cat] = 5;
    updatePool(variantIdx, poolIdx, { defaultCategories: cats });
  };

  const setPoolCategoryWeight = (variantIdx: number, poolIdx: number, cat: string, w: number) => {
    if (!draft) return;
    const variants = [...(draft.layoutVariants ?? [])];
    const v = variants[variantIdx];
    if (!v) return;
    const pools = [...(v.pools ?? [])];
    const pool = pools[poolIdx];
    if (!pool) return;
    const clamped = Math.max(1, Math.min(10, w || 1));
    updatePool(variantIdx, poolIdx, { defaultCategories: { ...pool.defaultCategories, [cat]: clamped } });
  };

  const toggleCompanionCategory = (variantIdx: number, poolIdx: number, rsIdx: number, ci: number, cat: string) => {
    if (!draft) return;
    const v = (draft.layoutVariants ?? [])[variantIdx];
    if (!v) return;
    const companion = (v.pools ?? [])[poolIdx]?.requiredSlots[rsIdx]?.companions?.[ci];
    if (!companion) return;
    const cats = { ...companion.allowedCategories };
    if (cats[cat] !== undefined) delete cats[cat]; else cats[cat] = 5;
    updateCompanion(variantIdx, poolIdx, rsIdx, ci, { allowedCategories: cats });
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

  const addReservedZone = () => {
    if (!draft) return;
    setDraft({ ...draft, reservedZones: [...(draft.reservedZones ?? []), defaultReservedZone()] });
    setDirty(true);
  };

  const updateReservedZone = (idx: number, patch: Partial<ReservedZoneRule>) => {
    if (!draft) return;
    setDraft({
      ...draft,
      reservedZones: (draft.reservedZones ?? []).map((z, i) => i === idx ? { ...z, ...patch } : z),
    });
    setDirty(true);
  };

  const removeReservedZone = (idx: number) => {
    if (!draft) return;
    setDraft({ ...draft, reservedZones: (draft.reservedZones ?? []).filter((_, i) => i !== idx) });
    setDirty(true);
  };

  const removeSlot = (idx: number, slotLabel: string) => {
    if (!draft) return;
    const name = slotLabel.trim() || `#${idx + 1}`;
    if (!window.confirm(t('roomTypeEditor.removeSlotConfirm', { name }))) return;
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

  const toggleCellRequiredProperty = (slotIdx: number, prop: string) => {
    if (!draft) return;
    const slot = draft.slots[slotIdx];
    const props = slot.cellRequiredProperties.includes(prop)
      ? slot.cellRequiredProperties.filter(p => p !== prop)
      : [...slot.cellRequiredProperties, prop];
    updateSlot(slotIdx, { cellRequiredProperties: props });
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
      setStatus(t('roomTypeEditor.missingLayer', { name }));
      // Slot aufklappen damit der Nutzer ihn sieht
        setCollapsedSlots(prev => { const next = new Set(prev); next.delete(missingLayer); return next; });
      return;
    }
    const gridErrors = gridSaveErrors(draft.grids ?? [], draft.slots.map(sl => sl.id));
    if (gridErrors.length > 0) {
      setStatus(t('roomTypeEditor.grids.saveBlocked', { ids: gridErrors.map(e => e.gridId).join(', ') }));
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
        reservedZones: raw.reservedZones ?? [],
        grids: (raw.grids ?? []).map(normalizeGridLayout),
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
      setDraft(saved); setDirty(false); setStatus(t('roomTypeEditor.saved'));
      // Nach Speichern alle Slots einklappen
      setCollapsedSlots(new Set(saved.slots.map((_, i) => i)));
    } catch (e) { setStatus(t('roomTypeEditor.error', { error: String(e) })); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!selected || !window.confirm(t('roomTypeEditor.deleteRoomConfirm', { room: selected }))) return;
    await deleteRoomType(selected);
    setConfigs(prev => { const n = { ...prev }; delete n[selected]; return n; });
    // also remove from knownRooms
    const updated = knownRooms.filter(r => r !== selected);
    setKnownRooms(updated);
    await saveRoomTypeNames(updated);
    setSelected(null); setDraft(null);
  };

  const handleRemoveRoom = async (rt: string) => {
    if (!window.confirm(t('roomTypeEditor.removeRoomConfirm', {
      room: rt,
      suffix: configs[rt] ? t('roomTypeEditor.removeRoomConfirmSuffix') : '',
    }))) return;
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

  if (initLoading) {
    return (
      <div className={s.layout}>
        <div className={s.initLoading}><Spinner size={18} /> {t('roomTypeEditor.loading')}</div>
      </div>
    );
  }

  return (
    <div className={s.layout}>
      {/* ── Left: list ── */}
      <div className={s.listPanel}>
        <div className={s.panelHeader}>
          <span className={s.panelTitle}>{t('roomTypeEditor.header.title')}</span>
        </div>
        <div className={s.list}>
          {knownRooms.map(rt => (
            <div key={rt} className={`${s.listItem} ${selected === rt ? s.listItemActive : ''}`}
              onClick={() => selectRoom(rt)}>
              <span className={s.listItemName}>{rt}</span>
              {configs[rt] && <span className={s.listItemBadge}>{configs[rt].slots.length}</span>}
              <span className={s.listItemRemove} title={t('roomTypeEditor.removeRoomFromList', { room: rt })}
                onClick={e => { e.stopPropagation(); handleRemoveRoom(rt); }}>✕</span>
            </div>
          ))}
        </div>

        {/* Add custom room */}
        <div style={{ padding: '8px 10px', borderTop: '1px solid #2a2a3a', display: 'flex', gap: 4 }}>
          <input
            className={s.slotSizeInput} style={{ flex: 1, width: 'auto' }}
            placeholder={t('roomTypeEditor.header.newTypePlaceholder')} value={newRoomName}
            onChange={e => setNewRoomName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAddNew()}
          />
          <button className={s.slotSizeBtn} style={{ width: 'auto', margin: 0, padding: '3px 10px' }} onClick={handleAddNew}>+</button>
        </div>
      </div>

      {/* ── Center: editor ── */}
      <div className={s.editorPanel}>
          {!draft ? (
            <div className={s.hint}>{t('roomTypeEditor.selectRoomHint')}</div>
          ) : (<>
            <div className={s.editorHeader}>
              <span className={s.editorTitle}>{draft.roomType}</span>
              {configs[draft.roomType] && (
                <button className={s.deleteBtn} onClick={handleDelete}>{t('roomTypeEditor.header.delete')}</button>
              )}
            </div>

            {/* ── Sticky save bar: stays visible while scrolling through slots below ── */}
            <div className={s.stickySaveBar}>
              <button className={s.saveBtn} disabled={!dirty || saving} onClick={handleSave}>
                {saving ? <><Spinner /> {t('roomTypeEditor.saving')}</> : t('roomTypeEditor.save', { room: draft.roomType })}
              </button>
              {status && (
                <div style={{ fontSize: '0.76rem', color: status.startsWith('✓') ? '#6c6' : '#f88', textAlign: 'center' }}>
                  {status}
                </div>
              )}
            </div>

            {/* PathStyle-Selector */}
            <div className={s.pathStyleRow}>
              <label className={s.pathStyleLabel} title={t('roomTypeEditor.pathStyleTitle')}>
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

            {/* Room size limits (max cells per size class; empty = default) */}
            <div className={s.pathStyleRow} style={{ flexWrap: 'wrap', gap: 6 }}>
              <label className={s.pathStyleLabel} title={t('roomTypeEditor.sizeLimits.title')}>
                {t('roomTypeEditor.sizeLimits.label')}
              </label>
              {(['XS', 'S', 'M', 'L'] as const).map(k => (
                <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: '0.72rem' }}
                  title={t('roomTypeEditor.sizeLimits.fieldTitle', { size: k, def: DEFAULT_SIZE_LIMITS[k] })}>
                  {k} ≤
                  <input type="number" min={1} className={s.slotSizeInput} style={{ width: 46 }}
                    placeholder={String(DEFAULT_SIZE_LIMITS[k])}
                    value={draft.sizeLimits?.[k] ?? ''}
                    onChange={e => {
                      const { [k]: _, ...rest } = draft.sizeLimits ?? {};
                      const v = parseInt(e.target.value, 10);
                      setDraft({ ...draft, sizeLimits: v > 0 ? { ...rest, [k]: v } : rest });
                      setDirty(true);
                    }} />
                </label>
              ))}
            </div>

            {/* Farbgruppe (Raum-Ebene) */}
            <div className={s.pathStyleRow}>
              <label className={s.pathStyleLabel}
                title={t('roomTypeEditor.colorGroupRoom.title')}>
                {t('roomTypeEditor.colorGroupRoom.label')}
              </label>
              <input
                className={s.slotSizeInput}
                style={{ flex: 1, minWidth: 0 }}
                placeholder={t('roomTypeEditor.colorGroupRoom.placeholder')}
                value={draft.colorGroupId ?? ''}
                onChange={e => { setDraft({ ...draft, colorGroupId: e.target.value }); setDirty(true); }}
              />
              <label className={s.slotCheck} title={t('roomTypeEditor.colorHarmony.roomTitle')}>
                <input type="checkbox" checked={draft.useColorHarmony !== false}
                  onChange={e => { setDraft({ ...draft, useColorHarmony: e.target.checked }); setDirty(true); }} />
                {t('roomTypeEditor.colorHarmony.label')}
              </label>
            </div>

            {/* Farbpalette (Raum-Ebene) – Multi-Select */}
            {draft.colorGroupId && (
              <div className={s.pathStyleRow} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                <label className={s.pathStyleLabel}
                  title={t('roomTypeEditor.colorPalette.title', { group: draft.colorGroupId })}>
                  {t('roomTypeEditor.colorPalette.labelRoom', { group: draft.colorGroupId })}
                </label>
                <ColorPaletteChips palette={draft.colorPalettes?.[draft.colorGroupId] ?? []} availColors={availColors}
                  onChange={next => { setDraft({ ...draft, colorPalettes: { ...(draft.colorPalettes ?? {}), [draft.colorGroupId]: next } }); setDirty(true); }} />
              </div>
            )}

            {/* Sperrzonen (z.B. "Car"-Stellplatz vor Garagentor) */}
            <div className={s.slotsHeader}>
              <span className={s.slotsLabel}>{t('roomTypeEditor.reservedZones.header', { count: (draft.reservedZones ?? []).length })}</span>
              <button className={s.addSlotBtn} onClick={addReservedZone}>{t('roomTypeEditor.reservedZones.addZone')}</button>
            </div>
            {(draft.reservedZones ?? []).map((zone, idx) => (
              <div key={idx} className={s.slotCard}>
                <div className={s.slotCardHeader}>
                  <input
                    className={s.slotSizeInput}
                    style={{ flex: 1, minWidth: 0 }}
                    placeholder={t('roomTypeEditor.reservedZones.labelPlaceholder')}
                    value={zone.label}
                    onChange={e => updateReservedZone(idx, { label: e.target.value, id: zone.id || e.target.value.toLowerCase().replace(/\s+/g, '_') })}
                  />
                  <label className={s.pathStyleLabel} title={t('roomTypeEditor.reservedZones.depthTitle')}>
                    {t('roomTypeEditor.reservedZones.depth')}
                  </label>
                  <input
                    type="number" min={1} className={s.slotSizeInput} style={{ width: 56 }}
                    value={zone.depth}
                    onChange={e => updateReservedZone(idx, { depth: Math.max(1, Number(e.target.value) || 1) })}
                  />
                  <label className={s.pathStyleLabel} title={t('roomTypeEditor.reservedZones.minOpeningWidthTitle')}>
                    {t('roomTypeEditor.reservedZones.minOpeningWidth')}
                  </label>
                  <input
                    type="number" min={1} className={s.slotSizeInput} style={{ width: 56 }}
                    value={zone.minOpeningWidth}
                    onChange={e => updateReservedZone(idx, { minOpeningWidth: Math.max(1, Number(e.target.value) || 1) })}
                  />
                  <label className={s.pathStyleLabel} title={t('roomTypeEditor.reservedZones.maxWidthTitle')}>
                    {t('roomTypeEditor.reservedZones.maxWidth')}
                  </label>
                  <input
                    type="number" min={1} className={s.slotSizeInput} style={{ width: 56 }}
                    placeholder="—"
                    value={zone.maxWidth ?? ''}
                    onChange={e => updateReservedZone(idx, { maxWidth: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value) || 1) })}
                  />
                  <button className={s.removeSlotBtn} onClick={() => removeReservedZone(idx)}>✕</button>
                </div>
              </div>
            ))}

            <div className={s.slotsHeader}>
              <span className={s.slotsLabel}>{t('roomTypeEditor.slots.header', { count: draft.slots.length })}</span>
              <button
                className={`${s.infoBtn} ${infoOpen ? s.infoBtnActive : ''}`}
                onClick={() => setInfoOpen(v => !v)}
                title={t('roomTypeEditor.slots.infoToggleTitle')}>
                ℹ
              </button>
              <button className={s.addSlotBtn} onClick={addSlot}>{t('roomTypeEditor.slots.addSlot')}</button>
            </div>

            {infoOpen && (
              <pre className={s.infoPanel}>{t('roomTypeEditor.slotInfoText')}</pre>
            )}

            {/* ── Zwischenablage-Banner ── */}
            {copiedSlot && (
              <div className={s.pasteBar}>
                <span className={s.pasteBarIcon}>📋</span>
                <span className={s.pasteBarText}>
                  {t('roomTypeEditor.pasteBar.clipboard')}{' '}
                  <strong>{copiedSlot.slot.id || copiedSlot.slot.label || t('roomTypeEditor.pasteBar.noName')}</strong>
                  {copiedSlot.fromRoom !== draft?.roomType && (
                    <span className={s.pasteBarFrom}>{t('roomTypeEditor.pasteBar.from', { room: copiedSlot.fromRoom })}</span>
                  )}
                </span>
                <button className={s.pasteSlotBtn} onClick={pasteSlot}
                  title={t('roomTypeEditor.pasteBar.insertTitle', { name: copiedSlot.slot.id || copiedSlot.slot.label || t('roomTypeEditor.pasteBar.insertTitleFallback') })}>
                  {t('roomTypeEditor.pasteBar.insert')}
                </button>
                <button className={s.pasteBarClearBtn} title={t('roomTypeEditor.pasteBar.clearTitle')}
                  onClick={() => setCopiedSlot(null)}>✕</button>
              </div>
            )}

            {draft.slots.length === 0 && (
              <div className={s.hint} style={{ padding: '12px' }}>{t('roomTypeEditor.slots.noSlots')}</div>
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
                style={{
                  ...(groupColor ? { '--group-color': groupColor } as React.CSSProperties : {}),
                  ...(slot.enabled === false ? { opacity: 0.5 } : {}),
                }}
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
                  <span className={s.dragHandle} title={t('roomTypeEditor.slotCard.dragHandle')} onClick={e => e.stopPropagation()}>⠿</span>
                  <input type="checkbox" checked={slot.enabled !== false}
                    title={t('roomTypeEditor.slotCard.enabledTitle')}
                    onClick={e => e.stopPropagation()}
                    onChange={e => updateSlot(idx, { enabled: e.target.checked })} />
                  <span className={s.slotIndex}>#{idx + 1}</span>
                  <span className={s.collapseToggleIcon}>{isCollapsed ? '▶' : '▼'}</span>
                  <span className={s.slotSummaryId} style={{ color: slot.id ? '#aac' : '#446', fontStyle: slot.id ? 'normal' : 'italic' }}>
                    {slot.id || t('roomTypeEditor.slotCard.noId')}
                  </span>
                  {slot.label && <span className={s.slotSummaryLabel}>{slot.label}</span>}
                  <span className={s.slotSummaryBadge} style={{ background: slot.required ? '#2a4a2a' : '#2a2a4a', color: slot.required ? '#6c6' : '#88a' }}>
                    {slot.required ? t('roomTypeEditor.slotCard.required') : t('roomTypeEditor.slotCard.optional')}
                  </span>
                  <span className={s.slotSummaryBadge} style={{ background: '#1a2a3a', color: '#68a' }}>
                    {slot.footprint.width}×{slot.footprint.height}
                  </span>
                  {!slot.slotGroupId && !slot.required && (
                    <span className={s.slotSummaryBadge} style={{ background: '#1a1a2a', color: '#778' }}
                      title={t('roomTypeEditor.slotCard.priorityTitle')}>
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
                        : t('roomTypeEditor.slotCard.anchorBadge', { count: slot.anchorRules.length })}
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  <button className={s.duplicateSlotBtn} title={t('roomTypeEditor.slotCard.duplicate')}
                    onClick={e => { e.stopPropagation(); duplicateSlot(idx); }}>⎘</button>
                  <button className={s.copySlotBtn} title={t('roomTypeEditor.slotCard.copyToClipboard')}
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
                    title={t('roomTypeEditor.slotCard.widthTitle')}
                    value={slot.footprint.width}
                    onChange={e => { const v = +e.target.value; if (v >= 1) updateSlot(idx, { footprint: { ...slot.footprint, width: v } }); }}
                    onBlur={e => updateSlot(idx, { footprint: { ...slot.footprint, width: Math.max(1, Math.min(20, +e.target.value)) } })} />
                  <span style={{ color: '#446' }}>×</span>
                  <input type="number" min={1} max={20} className={s.slotNumInput}
                    title={t('roomTypeEditor.slotCard.heightTitle')}
                    value={slot.footprint.height}
                    onChange={e => { const v = +e.target.value; if (v >= 1) updateSlot(idx, { footprint: { ...slot.footprint, height: v } }); }}
                    onBlur={e => updateSlot(idx, { footprint: { ...slot.footprint, height: Math.max(1, Math.min(20, +e.target.value)) } })} />
                  {/* canRotate toggle – nur sinnvoll bei nicht-quadratischen Footprints */}
                  {slot.footprint.width !== slot.footprint.height && (
                    <span
                      className={`${s.chip} ${slot.footprint.canRotate ? s.chipActive : ''}`}
                      title={t('roomTypeEditor.slotCard.canRotateTitle')}
                      onClick={() => updateSlot(idx, { footprint: { ...slot.footprint, canRotate: !slot.footprint.canRotate } })}>
                      {t('roomTypeEditor.slotCard.canRotate')}
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
                    {t('roomTypeEditor.slotCard.requiredCheck')}
                  </label>

                  <span className={s.slotFieldSmall}>
                    {t('roomTypeEditor.slotCard.priority')}
                    <input type="number" min={0} max={99} className={s.slotNumInput}
                      title={slot.required ? t('roomTypeEditor.slotCard.priorityInputTitleRequired') : t('roomTypeEditor.slotCard.priorityInputTitleOptional')}
                      value={slot.priority} onChange={e => updateSlot(idx, { priority: +e.target.value })}
                      style={slot.required ? { opacity: 0.4 } : {}} />
                  </span>

                  <button className={s.duplicateSlotBtn} title={t('roomTypeEditor.slotCard.duplicate')} onClick={() => duplicateSlot(idx)}>⎘</button>
                  <button className={s.removeSlotBtn} onClick={() => removeSlot(idx, slot.label || slot.id)}>✕</button>
                </div>

                <div className={s.slotCardBody}>
                  {/* ID & Label */}
                  <div className={s.slotRow} style={{ gap: 8 }}>
                    <span className={s.slotGroupLabel}>{t('roomTypeEditor.slotCard.idLabel')}</span>
                    <input className={s.slotSizeInput} style={{ flex: 1 }}
                      placeholder={t('roomTypeEditor.slotCard.idPlaceholder')}
                      value={slot.id}
                      onChange={e => updateSlot(idx, { id: e.target.value })} />
                    <span className={s.slotGroupLabel}>{t('roomTypeEditor.slotCard.labelLabel')}</span>
                    <input className={s.slotSizeInput} style={{ flex: 2 }}
                      placeholder={t('roomTypeEditor.slotCard.labelPlaceholder')}
                      value={slot.label}
                      onChange={e => updateSlot(idx, { label: e.target.value })} />
                  </div>

                  {/* Min/Max per room size table */}
                  <div className={s.sizeTableWrap}>
                  <table className={s.sizeTable}>
                    <thead>
                      <tr>
                        <th className={s.sizeTableLead} style={{ color: '#778', fontSize: '0.68rem', fontWeight: 400, textAlign: 'right', paddingRight: 4 }}>
                          {t('roomTypeEditor.slotCard.roomSizeHeader')}
                        </th>
                        {SIZE_KEYS.map(sz => (
                          <th key={sz} className={s.sizeTableHead}
                            title={`${sz}: ${t(`roomTypeEditor.sizeLabels.${sz}`)} (${t(`roomTypeEditor.sizeExamples.${sz}`)})`}>
                            {sz}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className={s.sizeTableLead}>{t('roomTypeEditor.slotCard.min')}</td>
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
                        <td className={s.sizeTableLead}>{t('roomTypeEditor.slotCard.max')}</td>
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
                  <div className={s.slotHint} style={{ marginTop: 2 }}>{t('roomTypeEditor.slotCard.maxUnlimitedHint')}</div>
                  {Object.values(slot.countBySize).some(c => c.max >= 2 || c.max < 0) && (
                    <label className={s.slotCheck} style={{ marginTop: 4 }} title={t('roomTypeEditor.slotCard.sameTileForAllInstancesHint')}>
                      <input type="checkbox" checked={slot.sameTileForAllInstances ?? false}
                        onChange={e => updateSlot(idx, { sameTileForAllInstances: e.target.checked })} />
                      {t('roomTypeEditor.slotCard.sameTileForAllInstances')}
                    </label>
                  )}

                  {/* ── Erlaubte Kategorien mit Gewichtung ── */}
                  <div className={s.slotRow} style={{ marginTop: 6 }}>
                    <span className={s.slotGroupLabel}>
                      {t('roomTypeEditor.slotCard.allowedCategories')}{' '}
                      <span style={{ color: '#446', fontStyle: 'italic' }}>
                        {(() => {
                          const realCount = Object.keys(slot.allowedCategories).filter(c => c !== EMPTY_CATEGORY).length;
                          return realCount === 0
                            ? t('roomTypeEditor.slotCard.allowedCategoriesAll')
                            : t('roomTypeEditor.slotCard.allowedCategoriesSelected', { count: realCount });
                        })()}
                      </span>
                    </span>
                  </div>
                  {/* Selected categories with weight inputs */}
                  {Object.entries(slot.allowedCategories).map(([cat, w]) => (
                    <div key={cat} className={s.slotRow} style={{ gap: 6, marginTop: 2 }}>
                      <span
                        className={`${s.chip} ${s.chipActive}`}
                        title={cat === EMPTY_CATEGORY
                          ? `${t('roomTypeEditor.slotCard.emptyCategoryTitle')}\n\n${t('roomTypeEditor.slotCard.removeCategory')}`
                          : t('roomTypeEditor.slotCard.removeCategory')}
                        style={cat === EMPTY_CATEGORY ? { borderStyle: 'dashed', fontStyle: 'italic' } : undefined}
                        onClick={() => toggleGroup(idx, cat)}
                      >
                        {cat === EMPTY_CATEGORY ? t('roomTypeEditor.slotCard.emptyCategory') : cat} ✕
                      </span>
                      <input type="number" min={1} max={10} className={s.slotNumInput}
                        value={w}
                        onChange={e => setCategoryWeight(idx, cat, +e.target.value, false)}
                        onBlur={e => setCategoryWeight(idx, cat, +e.target.value, true)} />
                      <span className={s.slotHint} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        {t('roomTypeEditor.slotCard.weight')} <span style={{ color: '#446', fontSize: '0.68rem' }}>{t('roomTypeEditor.slotCard.weightRange')}</span>
                        <span
                          title={t('roomTypeEditor.slotCard.weightInfoTitle')}
                          style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem' }}
                        >ℹ</span>
                      </span>
                    </div>
                  ))}
                  {/* Add category chips */}
                  <div className={s.chipGroup} style={{ marginTop: 4 }}>
                    {availGroups.filter(g => slot.allowedCategories[g] === undefined).map(g => (
                      <span key={g} className={s.chip} title={t('roomTypeEditor.slotCard.addCategory')} onClick={() => toggleGroup(idx, g)}>{g}</span>
                    ))}
                    {slot.allowedCategories[EMPTY_CATEGORY] === undefined && (
                      <span className={s.chip} style={{ borderStyle: 'dashed', fontStyle: 'italic' }}
                        title={t('roomTypeEditor.slotCard.emptyCategoryTitle')}
                        onClick={() => toggleGroup(idx, EMPTY_CATEGORY)}>
                        {t('roomTypeEditor.slotCard.emptyCategory')}
                      </span>
                    )}
                  </div>
                  <ThemeSelector categories={Object.keys(slot.allowedCategories)} value={slot.allowedThemes}
                    onChange={allowedThemes => updateSlot(idx, { allowedThemes })} />

                  {/* ── Platzierungsregeln ── */}
                  <div className={s.slotRow} style={{ marginTop: 6 }}>
                    <span className={s.slotGroupLabel}>
                      {t('roomTypeEditor.slotCard.placementRulesLabel')}
                      <span
                        title={t('roomTypeEditor.slotCard.placementRulesInfoTitle')}
                        style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem', marginLeft: 4 }}
                      >ℹ</span>
                    </span>
                  </div>
                  <div className={s.chipGroup}>
                    {PLACEMENT_RULE_KEYS.map(key => (
                      <span key={key}
                        className={`${s.chip} ${slot.placementRules[key as keyof typeof slot.placementRules] ? s.chipActive : ''}`}
                        title={t(`roomTypeEditor.placementRules.${key}.description`)}
                        onClick={() => updateSlot(idx, {
                          placementRules: {
                            ...slot.placementRules,
                            [key]: !slot.placementRules[key as keyof typeof slot.placementRules],
                          }
                        })}>
                        {t(`roomTypeEditor.placementRules.${key}.label`)}
                      </span>
                    ))}
                  </div>
                  {/* AND-Hinweis: nur wenn >1 harte Regel aktiv */}
                  {(['nearWall','nearDoor','nearWindow','cornerOnly'] as const)
                    .filter(k => slot.placementRules[k]).length > 1 && (
                    <div className={s.slotHint} style={{ marginTop: 3, color: '#f4a261' }}>
                      ⚠ {t('roomTypeEditor.slotCard.andWarning', {
                        rules: (['nearWall','nearDoor','nearWindow','cornerOnly'] as const)
                          .filter(k => slot.placementRules[k])
                          .map(k => t(`roomTypeEditor.placementRules.${k}.label`))
                          .join(t('roomTypeEditor.slotCard.andSeparator')),
                      })}
                    </div>
                  )}

                  {/* ── Pfad-Option ── */}
                  <div className={s.slotRow} style={{ marginTop: 6, alignItems: 'center', gap: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none', fontSize: '0.82rem', color: slot.placementRules.allowOnPath ? '#7fd3ff' : '#889' }}
                      title={t('roomTypeEditor.slotCard.allowOnPathTitle')}>
                      <input
                        type="checkbox"
                        checked={slot.placementRules.allowOnPath ?? false}
                        onChange={() => updateSlot(idx, {
                          placementRules: { ...slot.placementRules, allowOnPath: !(slot.placementRules.allowOnPath ?? false) }
                        })}
                        style={{ accentColor: '#4d9fcc' }}
                      />
                      {t('roomTypeEditor.slotCard.allowOnPath')}
                      <span style={{ fontSize: '0.72rem', color: '#667', marginLeft: 2 }}>{t('roomTypeEditor.slotCard.allowOnPathSuffix')}</span>
                    </label>
                  </div>

                  {/* ── Blockiert Zelle ── */}
                  <div className={s.slotRow} style={{ marginTop: 4, alignItems: 'center', gap: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none', fontSize: '0.82rem', color: (slot.blocksPlacement ?? true) ? '#889' : '#7fd3ff' }}
                      title={t('roomTypeEditor.slotCard.blocksPlacementTitle')}>
                      <input
                        type="checkbox"
                        checked={slot.blocksPlacement ?? true}
                        onChange={() => updateSlot(idx, { blocksPlacement: !(slot.blocksPlacement ?? true) })}
                        style={{ accentColor: '#4d9fcc' }}
                      />
                      {t('roomTypeEditor.slotCard.blocksPlacement')}
                      <span style={{ fontSize: '0.72rem', color: '#667', marginLeft: 2 }}>
                        {(slot.blocksPlacement ?? true) ? t('roomTypeEditor.slotCard.blocksPlacementOn') : t('roomTypeEditor.slotCard.blocksPlacementOff')}
                      </span>
                    </label>
                  </div>

                  {/* ── Soft-Block + erlaubte Eigenschaften (nur wenn blocksPlacement: false) ── */}
                  {!(slot.blocksPlacement ?? true) && (
                    <>
                      <div className={s.slotRow} style={{ marginTop: 4, marginLeft: 16, alignItems: 'center', gap: 8 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none', fontSize: '0.82rem', color: (slot.softBlocks ?? false) ? '#f0c060' : '#667' }}
                          title={t('roomTypeEditor.slotCard.softBlockTitle')}>
                          <input
                            type="checkbox"
                            checked={slot.softBlocks ?? false}
                            onChange={() => updateSlot(idx, { softBlocks: !(slot.softBlocks ?? false) })}
                            style={{ accentColor: '#f0c060' }}
                          />
                          {t('roomTypeEditor.slotCard.softBlock')}
                          <span style={{ fontSize: '0.72rem', color: '#667', marginLeft: 2 }}>
                            {(slot.softBlocks ?? false) ? t('roomTypeEditor.slotCard.softBlockOn') : t('roomTypeEditor.slotCard.softBlockOff')}
                          </span>
                        </label>
                      </div>

                      <div className={s.slotRow} style={{ marginTop: 6, marginLeft: 16 }}>
                        <span className={s.slotGroupLabel} title={t('roomTypeEditor.slotCard.cellRequiredPropertiesTitle')}>
                          {t('roomTypeEditor.slotCard.cellRequiredPropertiesLabel')}
                        </span>
                      </div>
                      <div className={s.chipGroup} style={{ marginLeft: 16 }}>
                        {REQUIRED_PROPERTIES.map(prop => (
                          <span key={prop}
                            className={`${s.chip} ${slot.cellRequiredProperties.includes(prop) ? s.chipActive : ''}`}
                            onClick={() => toggleCellRequiredProperty(idx, prop)}>
                            {t(`tileBrowser.properties.${prop}`)}
                          </span>
                        ))}
                      </div>
                    </>
                  )}

                  {/* ── Zelle davor freihalten ── */}
                  <div className={s.slotRow} style={{ marginTop: 4, alignItems: 'center', gap: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none', fontSize: '0.82rem', color: (slot.blocksFrontCell ?? false) ? '#7fd3ff' : '#889' }}
                      title={t('roomTypeEditor.slotCard.blocksFrontCellTitle')}>
                      <input
                        type="checkbox"
                        checked={slot.blocksFrontCell ?? false}
                        onChange={() => updateSlot(idx, { blocksFrontCell: !(slot.blocksFrontCell ?? false) })}
                        style={{ accentColor: '#4d9fcc' }}
                      />
                      {t('roomTypeEditor.slotCard.blocksFrontCell')}
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', color: (slot.clearance ?? 0) > 0 ? '#7fd3ff' : '#889' }}
                      title={t('roomTypeEditor.slotCard.clearanceTitle')}>
                      {t('roomTypeEditor.slotCard.clearanceLabel')}
                      <input
                        type="number"
                        min={0}
                        max={3}
                        className={s.slotSizeInput}
                        style={{ width: 48 }}
                        value={slot.clearance ?? 0}
                        onChange={e => {
                          const v = Math.max(0, Math.min(3, parseInt(e.target.value) || 0));
                          updateSlot(idx, { clearance: v > 0 ? v : undefined });
                        }}
                      />
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none', fontSize: '0.82rem', color: (slot.placeLast ?? false) ? '#7fd3ff' : '#889' }}
                      title={t('roomTypeEditor.slotCard.placeLastTitle')}>
                      <input
                        type="checkbox"
                        checked={slot.placeLast ?? false}
                        onChange={() => updateSlot(idx, { placeLast: !(slot.placeLast ?? false) })}
                        style={{ accentColor: '#4d9fcc' }}
                      />
                      {t('roomTypeEditor.slotCard.placeLast')}
                    </label>
                  </div>

                  {/* ── Wandausrichtung (nur bei nearWall) ── */}
                  {slot.placementRules.nearWall && (
                    <div style={{ marginTop: 6 }}>
                      <div className={s.slotRow} style={{ marginBottom: 3 }}>
                        <span className={s.slotGroupLabel}>
                          {t('roomTypeEditor.slotCard.wallAlignmentLabel')}
                          <span
                            title={t('roomTypeEditor.slotCard.wallAlignmentInfoTitle')}
                            style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem', marginLeft: 4 }}
                          >ℹ</span>
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {WALL_ALIGNMENT_KEYS.map(opt => {
                          const active = (slot.placementRules.wallAlignment ?? 'any') === opt.value;
                          return (
                            <button
                              key={opt.value}
                              title={t(`roomTypeEditor.wallAlignment.${opt.value}.title`)}
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
                              {t(`roomTypeEditor.wallAlignment.${opt.value}.label`)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* ── Erlaubter Layer & Erforderliche Eigenschaften ── */}
                  <div className={s.slotRow} style={{ marginTop: 6, gap: 8 }}>
                    <span className={s.slotGroupLabel}>
                      {t('roomTypeEditor.slotCard.layerLabel')} <span style={{ color: '#f66' }}>*</span>
                    </span>
                    <select className={s.slotSelect}
                      value={slot.requiredLayer}
                      style={!slot.requiredLayer ? { borderColor: '#8a3a3a', color: '#a66' } : {}}
                      onChange={e => updateSlot(idx, { requiredLayer: e.target.value })}>
                      <option value="" disabled>{t('roomTypeEditor.slotCard.layerPlaceholder')}</option>
                      {FURNITURE_LAYERS.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                    {!slot.requiredLayer && (
                      <span style={{ fontSize: '0.68rem', color: '#f66' }}>{t('roomTypeEditor.slotCard.layerRequired')}</span>
                    )}
                  </div>
                  <div className={s.slotRow} style={{ marginTop: 4 }}>
                    <span className={s.slotGroupLabel}>{t('roomTypeEditor.slotCard.requiredPropertiesLabel')}</span>
                    <button className={s.fromFurnitureBtn}
                      title={t('roomTypeEditor.furniturePicker.openTitle')}
                      onClick={() => setPickerSlotIdx(idx)}>
                      🔍 {t('roomTypeEditor.furniturePicker.open')}
                    </button>
                  </div>
                  <div className={s.chipGroup}>
                    {REQUIRED_PROPERTIES.map(prop => (
                      <span key={prop}
                        className={`${s.chip} ${slot.requiredProperties.includes(prop) ? s.chipActive : ''}`}
                        onClick={() => toggleRequiredProperty(idx, prop)}>
                        {t(`tileBrowser.properties.${prop}`)}
                      </span>
                    ))}
                  </div>

                  {/* ── Varianten-Gruppe ── */}
                  <div className={s.slotRow} style={{ marginTop: 6, gap: 8, flexWrap: 'wrap' }}>
                    <span className={s.slotGroupLabel}>{t('roomTypeEditor.slotCard.variantGroupLabel')}</span>
                    <datalist id={`group-ids-${idx}`}>
                      {uniqueGroupIds.map(gid => (
                        <option key={gid} value={gid} />
                      ))}
                    </datalist>
                    <input className={s.slotSizeInput} style={{ flex: 2 }}
                      list={`group-ids-${idx}`}
                      placeholder={t('roomTypeEditor.slotCard.variantGroupPlaceholder')}
                      value={slot.slotGroupId}
                      onChange={e => updateSlot(idx, {
                        slotGroupId: e.target.value,
                        slotGroupMode: e.target.value ? 'one-of' : '',
                      })} />
                    {slot.slotGroupId && (<>
                      <span className={s.slotGroupLabel} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        {t('roomTypeEditor.slotCard.groupWeightLabel')} <span style={{ color: '#446', fontSize: '0.68rem' }}>{t('roomTypeEditor.slotCard.groupWeightRange')}</span>
                        <span
                          title={
                            slot.required
                              ? t('roomTypeEditor.slotCard.groupWeightInfoRequired')
                              : t('roomTypeEditor.slotCard.groupWeightInfoOptional')
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
                            ? t('roomTypeEditor.slotCard.groupRequiredHint', { group: slot.slotGroupId, count: groupSize, weight: slot.groupWeight })
                            : t('roomTypeEditor.slotCard.groupOptionalHint', { group: slot.slotGroupId, count: groupSize, weight: slot.groupWeight })
                          }
                        </div>
                        {mixedRequired && (
                          <div className={s.slotHint} style={{ marginTop: 2, color: '#f4a261' }}>
                            {t('roomTypeEditor.slotCard.groupMixedWarning', { group: slot.slotGroupId })}
                          </div>
                        )}
                      </>
                    );
                  })()}

                  {/* ── Farbgruppe (Slot-Ebene) ── */}
                  <div className={s.slotRow} style={{ marginTop: 6, gap: 8 }}>
                    <span className={s.slotGroupLabel}
                      title={t('roomTypeEditor.slotCard.colorGroupTitle')}>
                      {t('roomTypeEditor.slotCard.colorGroupLabel')}
                      <span style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem', marginLeft: 4 }}>ℹ</span>
                    </span>
                    <input
                      className={s.slotSizeInput}
                      style={{ flex: 2 }}
                      placeholder={t('roomTypeEditor.slotCard.colorGroupPlaceholder', { group: draft.colorGroupId || '—' })}
                      value={slot.colorGroupId ?? ''}
                      onChange={e => updateSlot(idx, { colorGroupId: e.target.value })}
                    />
                    {(() => {
                      const effectiveGroup = slot.colorGroupId === 'none' ? null
                        : slot.colorGroupId || draft.colorGroupId || null;
                      if (!effectiveGroup) return <span className={s.slotHint} style={{ color: '#556' }}>{t('roomTypeEditor.slotCard.colorGroupNoFilter')}</span>;
                      return <span className={s.slotHint} style={{ color: '#8c8' }}>{t('roomTypeEditor.slotCard.colorGroupEffective', { group: effectiveGroup })}</span>;
                    })()}
                    <label className={s.slotCheck} title={t('roomTypeEditor.colorHarmony.title')}>
                      <input type="checkbox" checked={slot.useColorHarmony !== false}
                        disabled={draft.useColorHarmony === false}
                        onChange={e => updateSlot(idx, { useColorHarmony: e.target.checked })} />
                      {t('roomTypeEditor.colorHarmony.label')}
                    </label>
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
                          title={t('roomTypeEditor.colorPalette.title', { group: slotGroup })}>
                          {t('roomTypeEditor.colorPalette.labelSlot', { group: slotGroup })}
                        </label>
                        <ColorPaletteChips palette={palette} availColors={availColors} short
                          onChange={next => { setDraft({ ...draft, colorPalettes: { ...(draft.colorPalettes ?? {}), [slotGroup]: next } }); setDirty(true); }} />
                      </div>
                    );
                  })()}

                  {/* ── Tile-Gruppe (gleicher Variantensatz) ── */}
                  <div className={s.slotRow} style={{ marginTop: 6, gap: 8 }}>
                    <span className={s.slotGroupLabel}
                      title={t('roomTypeEditor.slotCard.tileGroupTitle')}>
                      {t('roomTypeEditor.slotCard.tileGroupLabel')}
                      <span style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem', marginLeft: 4 }}>ℹ</span>
                    </span>
                    <input
                      className={s.slotSizeInput}
                      style={{ flex: 2 }}
                      placeholder={t('roomTypeEditor.slotCard.tileGroupPlaceholder')}
                      value={slot.tileGroupId ?? ''}
                      onChange={e => updateSlot(idx, { tileGroupId: e.target.value })}
                    />
                    {slot.tileGroupId
                      ? <span className={s.slotHint} style={{ color: '#ac8' }}>{t('roomTypeEditor.slotCard.tileGroupEffective', { group: slot.tileGroupId })}</span>
                      : <span className={s.slotHint} style={{ color: '#556' }}>{t('roomTypeEditor.slotCard.tileGroupIndependent')}</span>
                    }
                  </div>

                  {/* ── Material-Filter ── */}
                  <div className={s.slotRow} style={{ marginTop: 6, gap: 8 }}>
                    <span className={s.slotGroupLabel}
                      title={t('roomTypeEditor.slotCard.materialFilterTitle')}>
                      {t('roomTypeEditor.slotCard.materialFilterLabel')}
                      <span style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem', marginLeft: 4 }}>ℹ</span>
                    </span>
                    {availMaterials.length > 0 ? (
                      <select
                        className={s.slotSizeInput}
                        style={{ flex: 2 }}
                        value={slot.materialGroupId ?? ''}
                        onChange={e => updateSlot(idx, { materialGroupId: e.target.value })}
                      >
                        <option value="">{t('roomTypeEditor.slotCard.materialFilterNone')}</option>
                        <option value="none">{t('roomTypeEditor.slotCard.materialFilterDisabledOption')}</option>
                        {availMaterials.map(m => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className={s.slotSizeInput}
                        style={{ flex: 2 }}
                        placeholder={t('roomTypeEditor.slotCard.materialFilterPlaceholder')}
                        value={slot.materialGroupId ?? ''}
                        onChange={e => updateSlot(idx, { materialGroupId: e.target.value })}
                      />
                    )}
                    {slot.materialGroupId && slot.materialGroupId !== 'none'
                      ? <span className={s.slotHint} style={{ color: '#c8a' }}>{t('roomTypeEditor.slotCard.materialFilterActive', { material: slot.materialGroupId })}</span>
                      : slot.materialGroupId === 'none'
                        ? <span className={s.slotHint} style={{ color: '#888' }}>{t('roomTypeEditor.slotCard.materialFilterDisabled')}</span>
                        : <span className={s.slotHint} style={{ color: '#556' }}>{t('roomTypeEditor.slotCard.materialFilterEmpty')}</span>
                    }
                  </div>

                  {/* ── Rug Slot ── */}
                  <div className={s.slotRow} style={{ marginTop: 6, gap: 8, flexWrap: 'wrap' }}>
                    <label className={s.slotCheck}>
                      <input type="checkbox" checked={!!slot.rugSlot}
                        onChange={e => updateSlot(idx, { rugSlot: e.target.checked ? defaultRugSlotConfig() : null })} />
                      {t('roomTypeEditor.slotCard.rugSlotCheck')}
                    </label>
                    {slot.rugSlot && (<>
                      <span className={s.slotGroupLabel}>{t('roomTypeEditor.slotCard.rugSizingMode')}</span>
                      <select className={s.slotSizeInput} style={{ flex: '0 0 auto' }}
                        value={slot.rugSlot.sizing.mode}
                        onChange={e => updateSlot(idx, { rugSlot: { ...slot.rugSlot!, sizing: { ...slot.rugSlot!.sizing, mode: e.target.value as 'fixed' | 'fill' | 'matchAnchorCluster' } } })}>
                        <option value="fixed">{t('roomTypeEditor.slotCard.rugSizingFixed')}</option>
                        <option value="fill">{t('roomTypeEditor.slotCard.rugSizingFill')}</option>
                        <option value="matchAnchorCluster">{t('roomTypeEditor.slotCard.rugSizingMatchAnchorCluster')}</option>
                      </select>
                      {slot.rugSlot.sizing.mode === 'matchAnchorCluster' && !slot.requiresSlot && (
                        <span className={s.slotHint} style={{ color: '#c8a020' }}>
                          {t('roomTypeEditor.slotCard.rugSizingMatchAnchorClusterNeedsRequiresSlot')}
                        </span>
                      )}
                      {slot.rugSlot.sizing.mode === 'matchAnchorCluster' && (
                        <label className={s.slotCheck} title={t('roomTypeEditor.slotCard.rugClusterGridOnlyHint')}>
                          <input type="checkbox" checked={!!slot.rugSlot.sizing.clusterGridPiecesOnly}
                            onChange={e => updateSlot(idx, { rugSlot: { ...slot.rugSlot!, sizing: { ...slot.rugSlot!.sizing, clusterGridPiecesOnly: e.target.checked } } })} />
                          {t('roomTypeEditor.slotCard.rugClusterGridOnly')}
                        </label>
                      )}
                      {slot.rugSlot.sizing.mode === 'matchAnchorCluster' && (
                        <label className={s.slotCheck} title={t('roomTypeEditor.slotCard.rugClusterGridFrameHint')}>
                          <input type="checkbox" checked={!!slot.rugSlot.sizing.clusterUseGridFrame}
                            onChange={e => updateSlot(idx, { rugSlot: { ...slot.rugSlot!, sizing: { ...slot.rugSlot!.sizing, clusterUseGridFrame: e.target.checked } } })} />
                          {t('roomTypeEditor.slotCard.rugClusterGridFrame')}
                        </label>
                      )}
                      {slot.rugSlot.sizing.mode === 'fill' && (<>
                        <span className={s.slotGroupLabel}>{t('roomTypeEditor.slotCard.rugFillShortAxis')}</span>
                        <input type="number" min={1} max={20} className={s.slotNumInput}
                          value={slot.rugSlot.sizing.fillShortAxis}
                          onChange={e => updateSlot(idx, { rugSlot: { ...slot.rugSlot!, sizing: { ...slot.rugSlot!.sizing, fillShortAxis: Math.max(1, +e.target.value) } } })} />
                        <span className={s.slotGroupLabel}>{t('roomTypeEditor.slotCard.rugFillMargin')}</span>
                        <input type="number" min={0} max={10} className={s.slotNumInput}
                          value={slot.rugSlot.sizing.fillMarginEachEnd}
                          onChange={e => updateSlot(idx, { rugSlot: { ...slot.rugSlot!, sizing: { ...slot.rugSlot!.sizing, fillMarginEachEnd: Math.max(0, +e.target.value) } } })} />
                        <span className={s.slotGroupLabel}>{t('roomTypeEditor.slotCard.rugFillMaxLong')}</span>
                        <input type="number" min={0} className={s.slotNumInput}
                          placeholder={t('roomTypeEditor.slotCard.rugFillMaxLongPlaceholder')}
                          value={slot.rugSlot.sizing.fillMaxLongAxis ?? ''}
                          onChange={e => updateSlot(idx, { rugSlot: { ...slot.rugSlot!, sizing: { ...slot.rugSlot!.sizing, fillMaxLongAxis: e.target.value ? +e.target.value : null } } })} />
                      </>)}
                      <span className={s.slotGroupLabel}>{t('roomTypeEditor.slotCard.rugModeFilter')}</span>
                      <div className={s.chipGroup}>
                        {(['any', 'modular', 'preassembled'] as const).map(mf => (
                          <span key={mf}
                            className={`${s.chip} ${slot.rugSlot!.modeFilter === mf ? s.chipActive : ''}`}
                            onClick={() => updateSlot(idx, { rugSlot: { ...slot.rugSlot!, modeFilter: mf } })}>
                            {mf}
                          </span>
                        ))}
                      </div>
                    </>)}
                  </div>

                  {/* ── Benötigt Slot ── */}
                  <div className={s.slotRow} style={{ marginTop: 6, gap: 8 }}>
                    <span className={s.slotGroupLabel}
                      title={t('roomTypeEditor.slotCard.requiresSlotTitle')}>
                      {t('roomTypeEditor.slotCard.requiresSlotLabel')}
                      <span style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem', marginLeft: 4 }}>ℹ</span>
                    </span>
                    <input
                      className={s.slotSizeInput}
                      style={{ flex: 2 }}
                      list={`anchor-targets-${idx}`}
                      placeholder={t('roomTypeEditor.slotCard.requiresSlotPlaceholder')}
                      value={slot.requiresSlot ?? ''}
                      onChange={e => updateSlot(idx, { requiresSlot: e.target.value })}
                    />
                    {slot.requiresSlot
                      ? <span className={s.slotHint} style={{ color: '#fa8' }}>{t('roomTypeEditor.slotCard.requiresSlotActive', { slot: slot.requiresSlot })}</span>
                      : <span className={s.slotHint} style={{ color: '#556' }}>{t('roomTypeEditor.slotCard.requiresSlotIndependent')}</span>
                    }
                  </div>

                  {/* ── Anker-Regeln ── */}
                  <div className={s.slotRow} style={{ marginTop: 6, justifyContent: 'space-between' }}>
                    <span className={s.slotGroupLabel}>
                      {t('roomTypeEditor.slotCard.anchorRulesLabel')}
                      <span
                        title={t('roomTypeEditor.slotCard.anchorRulesInfoTitle')}
                        style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem', marginLeft: 4 }}
                      >ℹ</span>
                    </span>
                    <button
                      className={s.addSlotBtn}
                      style={{ fontSize: '0.7rem', padding: '2px 8px' }}
                      onClick={() => addAnchorRule(idx)}>
                      {t('roomTypeEditor.slotCard.addRule')}
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
                      <option key={`grp_${gid}`} value={gid}>{t('roomTypeEditor.slotCard.groupOption', { group: gid })}</option>
                    ))}
                    {Array.from(new Set((draft.grids ?? []).map(g => g.slotGroupId).filter(Boolean)))
                      .filter(gid => !uniqueGroupIds.includes(gid))
                      .map(gid => (
                        <option key={`gridgrp_${gid}`} value={gid}>{t('roomTypeEditor.grids.gridGroupOption', { group: gid })}</option>
                      ))}
                    {Array.from(new Set((draft.grids ?? []).flatMap(g => g.cells.map(c => c.anchorGroup)).filter(Boolean)))
                      .map(ag => (
                        <option key={`gridanchorgrp_${ag}`} value={ag}>{t('roomTypeEditor.grids.anchorGroupOption', { group: ag })}</option>
                      ))}
                    {(draft.grids ?? []).filter(g => g.id).flatMap(g => [
                      <option key={`grid_${g.id}`} value={g.id}>{t('roomTypeEditor.grids.gridOption', { grid: g.label || g.id })}</option>,
                      ...g.cells.map(c => (
                        <option key={`grid_${g.id}_${c.id}`} value={`${g.id}_${c.id}`}>
                          {t('roomTypeEditor.grids.gridCellOption', { grid: g.label || g.id, cell: c.label || c.id })}
                        </option>
                      )),
                    ])}
                  </datalist>

                  {slot.anchorRules.length === 0 && (
                    <div className={s.slotHint}>{t('roomTypeEditor.slotCard.noAnchor')}</div>
                  )}

                  {slot.anchorRules.map((rule, rIdx) => (
                    <div key={rIdx} className={s.anchorRuleCard}>
                      <div className={s.slotRow} style={{ gap: 6 }}>
                        <span className={s.slotGroupLabel} style={{ minWidth: 44 }}>{t('roomTypeEditor.slotCard.rule', { n: rIdx + 1 })}</span>
                        <span className={s.slotGroupLabel}>{t('roomTypeEditor.slotCard.anchor')}</span>
                        <input className={s.slotSizeInput} style={{ flex: 2 }}
                          list={`anchor-targets-${idx}`}
                          placeholder={t('roomTypeEditor.slotCard.anchorTargetPlaceholder')}
                          value={rule.anchorTarget}
                          onChange={e => updateAnchorRule(idx, rIdx, { anchorTarget: e.target.value })} />
                        <button className={s.removeSlotBtn} title={t('roomTypeEditor.slotCard.removeRule')}
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
                          {t('roomTypeEditor.slotCard.orPositions', { count: rule.positions.length })}
                        </div>
                      )}
                      <div className={s.slotRow} style={{ gap: 6, marginTop: 4 }}>
                        <span className={s.slotGroupLabel} style={{ minWidth: 60 }}>
                          {t('roomTypeEditor.slotCard.orientationLabel')}
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
                          <option value="">{t('roomTypeEditor.slotCard.orientTileDefault')}</option>
                          <option value="match">{t('roomTypeEditor.slotCard.orientMatch')}</option>
                          <option value="parallelToAnchor">{t('roomTypeEditor.slotCard.orientParallelToAnchor')}</option>
                          <option value="opposite">{t('roomTypeEditor.slotCard.orientOpposite')}</option>
                          <option value="facingAnchor">{t('roomTypeEditor.slotCard.orientFacingAnchor')}</option>
                          <option value="openSideFacing">{t('roomTypeEditor.slotCard.orientOpenSideFacing')}</option>
                          <option value="cwPerpendicular">{t('roomTypeEditor.slotCard.orientCwPerpendicular')}</option>
                          <option value="ccwPerpendicular">{t('roomTypeEditor.slotCard.orientCcwPerpendicular')}</option>
                          <option value="perpendicularCW">{t('roomTypeEditor.slotCard.orientPerpendicularCW')}</option>
                          <option value="perpendicularCCW">{t('roomTypeEditor.slotCard.orientPerpendicularCCW')}</option>
                          <option value="cornerFromAnchor">{t('roomTypeEditor.slotCard.orientCornerFromAnchor')}</option>
                          <option value="NW">{t('roomTypeEditor.slotCard.orientNW')}</option>
                          <option value="NE">{t('roomTypeEditor.slotCard.orientNE')}</option>
                          <option value="SW">{t('roomTypeEditor.slotCard.orientSW')}</option>
                          <option value="SE">{t('roomTypeEditor.slotCard.orientSE')}</option>
                          <option value="N">{t('roomTypeEditor.slotCard.orientN')}</option>
                          <option value="S">{t('roomTypeEditor.slotCard.orientS')}</option>
                          <option value="E">{t('roomTypeEditor.slotCard.orientE')}</option>
                          <option value="W">{t('roomTypeEditor.slotCard.orientW')}</option>
                        </select>
                      </div>
                      {/* Offset entlang der Kante – nur für LongSide/ShortSide sinnvoll */}
                      {rule.positions.some(p => ['LongSide0','LongSide1','ShortSide0','ShortSide1'].includes(p)) && (
                        <div className={s.slotRow} style={{ gap: 6, marginTop: 4 }}>
                          <span className={s.slotGroupLabel} style={{ minWidth: 60 }}
                            title={t('roomTypeEditor.slotCard.offsetTitle')}>
                            {t('roomTypeEditor.slotCard.offsetLabel')}
                          </span>
                          <input
                            type="number"
                            className={s.slotSizeInput}
                            style={{ width: 60 }}
                            value={rule.offsetAlongAnchor ?? 0}
                            onChange={e => updateAnchorRule(idx, rIdx, { offsetAlongAnchor: parseInt(e.target.value) || 0 })}
                          />
                          <span className={s.slotHint} style={{ fontSize: '0.75rem', color: '#888' }}>
                            {t('roomTypeEditor.slotCard.offsetHint')}
                          </span>
                        </div>
                      )}
                      {rule.positions.includes('oppositeWall') && (
                        <div className={s.slotRow} style={{ gap: 6, marginTop: 4, alignItems: 'center' }}>
                          <span className={s.slotGroupLabel} style={{ minWidth: 60 }}
                            title={t('roomTypeEditor.slotCard.distanceTitle')}>
                            {t('roomTypeEditor.slotCard.distanceLabel')}
                          </span>
                          <input
                            type="number"
                            min={1}
                            className={s.slotSizeInput}
                            style={{ width: 64 }}
                            value={rule.minOppositeWallDistance ?? 1}
                            onChange={e => updateAnchorRule(idx, rIdx, { minOppositeWallDistance: Math.max(1, parseInt(e.target.value) || 1) })}
                            title={t('roomTypeEditor.slotCard.distanceMinTitle')}
                          />
                          <span className={s.slotHint}>{t('roomTypeEditor.slotCard.distanceTo')}</span>
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
                            title={t('roomTypeEditor.slotCard.distanceMaxTitle')}
                            placeholder="∞"
                          />
                          <span className={s.slotHint} style={{ fontSize: '0.75rem', color: '#888' }}>
                            {t('roomTypeEditor.slotCard.distanceHint')}
                          </span>
                          <label className={s.slotHint} title={t('roomTypeEditor.slotCard.allowInsideTitle')}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <input
                              type="checkbox"
                              checked={rule.oppositeWallAllowInside ?? false}
                              onChange={e => updateAnchorRule(idx, rIdx, { oppositeWallAllowInside: e.target.checked || undefined })}
                            />
                            {t('roomTypeEditor.slotCard.allowInsideLabel')}
                          </label>
                          <label className={s.slotHint} title={t('roomTypeEditor.slotCard.keepSightClearTitle')}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <input
                              type="checkbox"
                              checked={rule.keepSightClear ?? false}
                              onChange={e => updateAnchorRule(idx, rIdx, { keepSightClear: e.target.checked || undefined })}
                            />
                            {t('roomTypeEditor.slotCard.keepSightClearLabel')}
                          </label>
                        </div>
                      )}
                      {rule.anchorTarget && rule.positions.length > 0 && (
                        <AnchorRulePreview
                          rule={rule}
                          dependentFootprint={slot.footprint}
                          anchorFootprint={draft.slots.find(sl => sl.id === rule.anchorTarget)?.footprint}
                        />
                      )}
                      {rule.anchorTarget && rule.positions.length > 0 && (
                        <div className={s.slotHint} style={{ marginTop: 2, color: '#8c8' }}>
                          {t('roomTypeEditor.slotCard.anchorSummary', { target: rule.anchorTarget, positions: rule.positions.join(' | ') })}
                        </div>
                      )}
                    </div>
                  ))}

                  {/* ── Fallback-Platzierungsregeln ── */}
                  <div className={s.slotRow} style={{ marginTop: 8, justifyContent: 'space-between' }}>
                    <span className={s.slotGroupLabel}>
                      {t('roomTypeEditor.slotCard.fallbackRulesLabel')}
                      <span
                        title={t('roomTypeEditor.slotCard.fallbackRulesInfoTitle')}
                        style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem', marginLeft: 4 }}
                      >ℹ</span>
                    </span>
                    <button
                      className={s.addSlotBtn}
                      style={{ fontSize: '0.7rem', padding: '2px 8px' }}
                      onClick={() => addFallbackRule(idx)}>
                      {t('roomTypeEditor.slotCard.addFallback')}
                    </button>
                  </div>

                  {(!slot.fallbackRules || slot.fallbackRules.length === 0) && (
                    <div className={s.slotHint}>
                      {t('roomTypeEditor.slotCard.noFallback')}
                      {slot.required && <span style={{ color: '#f4a261' }}>{t('roomTypeEditor.slotCard.noFallbackRequiredWarning')}</span>}
                    </div>
                  )}

                  {(slot.fallbackRules ?? []).map((fbRule, fbIdx) => {
                    const activeFbKeys = (Object.keys(fbRule) as (keyof typeof fbRule)[])
                      .filter(k => k !== 'allowOnPath' && fbRule[k]);
                    return (
                      <div key={fbIdx} className={s.anchorRuleCard} style={{ borderColor: '#664' }}>
                        <div className={s.slotRow} style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                          <span className={s.slotGroupLabel} style={{ color: '#ca8' }}>
                            {t('roomTypeEditor.slotCard.fallback', { n: fbIdx + 1 })}
                            {activeFbKeys.length > 0
                              ? `: ${activeFbKeys.map(k => t(`roomTypeEditor.placementRules.${k}.label`)).join(', ')}`
                              : t('roomTypeEditor.slotCard.fallbackFreePlacement')}
                          </span>
                          <button className={s.removeSlotBtn} onClick={() => removeFallbackRule(idx, fbIdx)}>✕</button>
                        </div>
                        <div className={s.chipGroup}>
                          {PLACEMENT_RULE_KEYS.map(key => (
                            <span key={key}
                              className={`${s.chip} ${fbRule[key] ? s.chipActive : ''}`}
                              title={t(`roomTypeEditor.placementRules.${key}.description`)}
                              onClick={() => updateFallbackRule(idx, fbIdx, { [key]: !fbRule[key] } as Partial<PlacementRules>)}>
                              {t(`roomTypeEditor.placementRules.${key}.label`)}
                            </span>
                          ))}
                          <span
                            className={`${s.chip} ${fbRule.allowOnPath ? s.chipActive : ''}`}
                            title={t('roomTypeEditor.slotCard.fallbackOnPathTitle')}
                            onClick={() => updateFallbackRule(idx, fbIdx, { allowOnPath: !fbRule.allowOnPath })}>
                            {t('roomTypeEditor.slotCard.fallbackOnPath')}
                          </span>
                        </div>
                        {fbRule.nearWall && (
                          <div style={{ display: 'flex', gap: 5, marginTop: 5, alignItems: 'center' }}>
                            <span style={{ fontSize: '0.72rem', color: '#778' }}>{t('roomTypeEditor.slotCard.wallAlignmentShort')}</span>
                            {WALL_ALIGNMENT_KEYS.map(opt => {
                              const active = (fbRule.wallAlignment ?? 'any') === opt.value;
                              return (
                                <button key={opt.value} title={t(`roomTypeEditor.wallAlignment.${opt.value}.title`)}
                                  onClick={() => updateFallbackRule(idx, fbIdx, { wallAlignment: opt.value })}
                                  style={{
                                    fontSize: '0.7rem', padding: '1px 8px', borderRadius: 3, cursor: 'pointer',
                                    border: active ? '1.5px solid #6af' : '1px solid #445',
                                    background: active ? '#1a2d3d' : '#1a1a1a',
                                    color: active ? '#7fd3ff' : '#778',
                                  }}>{t(`roomTypeEditor.wallAlignment.${opt.value}.label`)}</button>
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

            {/* ── Grid-Layouts ── */}
            <GridLayoutEditor
              grids={draft.grids ?? []}
              onChange={grids => { setDraft({ ...draft, grids }); setDirty(true); }}
              availGroups={availGroups}
              slotIds={draft.slots.map(sl => sl.id)}
              clipboard={copiedGrid}
              roomType={draft.roomType}
              onCopy={g => setCopiedGrid({ grid: structuredClone(g), fromRoom: draft.roomType })}
              onClearClipboard={() => setCopiedGrid(null)} />

            {/* ── Layout-Varianten ── */}
            <div className={s.slotsHeader} style={{ marginTop: 12 }}>
              <span className={s.slotsLabel}>{t('roomTypeEditor.layoutVariants.header', { count: (draft.layoutVariants ?? []).length })}</span>
              <button className={s.addSlotBtn} onClick={addLayoutVariant}>{t('roomTypeEditor.layoutVariants.addVariant')}</button>
            </div>

            <div className={s.anchorRuleCard}>
              <div className={s.slotRow} style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                <span className={s.slotGroupLabel}>
                  {t('roomTypeEditor.layoutVariants.commonSlots')}
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
                  {t('roomTypeEditor.layoutVariants.noCommonSlots')}
                </div>
              )}

              <div style={{ fontSize: '0.68rem', color: '#778', marginBottom: 4 }}>{t('roomTypeEditor.layoutVariants.availableSlots')}</div>
              <div className={s.chipGroup} style={{ gap: 3, maxHeight: 86, overflowY: 'auto' }}>
                {[...draft.slots, ...(draft.grids ?? []).map(g => ({ id: g.id, label: `▦ ${g.label || g.id}` }))].map((slot, slotIdx) => {
                  const isAdded = (draft.commonSlotIds ?? []).includes(slot.id);
                  return (
                    <span
                      key={`common-${slot.id}-${slotIdx}`}
                      className={`${s.chip} ${isAdded ? s.chipActive : ''}`}
                      style={{ cursor: isAdded ? 'default' : 'pointer', opacity: isAdded ? 0.5 : 1 }}
                      title={slot.label ? `${slot.id} - ${slot.label}` : slot.id}
                      onClick={() => !isAdded && addCommonSlot(slot.id)}
                    >
                      {slot.id || t('roomTypeEditor.layoutVariants.noId')}
                    </span>
                  );
                })}
              </div>

              <div className={s.slotHint} style={{ marginTop: 4 }}>
                {t('roomTypeEditor.layoutVariants.commonSlotsHint')}
              </div>
            </div>

            {(draft.layoutVariants ?? []).length === 0 && (
              <div className={s.hint} style={{ padding: '10px 12px' }}>
                {t('roomTypeEditor.layoutVariants.noVariants')}
              </div>
            )}

            {(draft.layoutVariants ?? []).map((variant, idx) => {
              const isCollapsed = collapsedLayoutVariants.has(idx);
              const toggleCollapse = () => setCollapsedLayoutVariants(prev => {
                const next = new Set(prev);
                next.has(idx) ? next.delete(idx) : next.add(idx);
                return next;
              });
              return (
              <div key={idx} className={s.anchorRuleCard}>

                {/* ── Zusammengeklappte Zusammenfassung (immer sichtbar) ── */}
                <div className={s.slotSummaryBar} onClick={toggleCollapse} style={{ cursor: 'pointer' }}>
                  <span className={s.collapseToggleIcon}>{isCollapsed ? '▶' : '▼'}</span>
                  <span className={s.slotIndex}>#{idx + 1}</span>
                  <span className={s.slotSummaryId}
                    style={{ color: variant.id ? '#aac' : '#446', fontStyle: variant.id ? 'normal' : 'italic', opacity: variant.disabled ? 0.45 : 1 }}>
                    {variant.id || t('roomTypeEditor.layoutVariants.noId')}
                  </span>
                  {variant.label && (
                    <span className={s.slotSummaryLabel} style={{ opacity: variant.disabled ? 0.45 : 1 }}>{variant.label}</span>
                  )}
                  <span className={s.slotSummaryBadge} style={{ background: '#1a1a2a', color: '#778' }}
                    title={t('roomTypeEditor.layoutVariants.weightLabel')}>
                    W{variant.weight ?? 5}
                  </span>
                  {variant.disabled && (
                    <span className={s.slotSummaryBadge} style={{ background: '#2a1a1a', color: '#a66' }}
                      title={t('roomTypeEditor.layoutVariants.disabledTooltip')}>
                      {t('roomTypeEditor.layoutVariants.disabledBadge')}
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  <label className={s.slotCheck} style={{ gap: 6 }} onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={!variant.disabled}
                      onChange={e => updateLayoutVariant(idx, { disabled: !e.target.checked })}
                    />
                    <span className={s.slotGroupLabel}>
                      {t('roomTypeEditor.layoutVariants.variant', { n: idx + 1 })}
                    </span>
                    <span
                      style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem', marginLeft: 2 }}
                      title={t('roomTypeEditor.layoutVariants.disabledTooltip')}
                    >ℹ</span>
                  </label>
                  <button className={s.removeSlotBtn} title={t('roomTypeEditor.layoutVariants.removeVariant')}
                    onClick={e => { e.stopPropagation(); removeLayoutVariant(idx); }}>✕</button>
                </div>

                {!isCollapsed && (<>

                <div className={s.slotRow} style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.idLabel')}</span>
                  <input
                    className={s.slotSizeInput}
                    style={{ flex: 2, minWidth: 180 }}
                    placeholder={t('roomTypeEditor.layoutVariants.idPlaceholder')}
                    value={variant.id}
                    onChange={e => updateLayoutVariant(idx, { id: e.target.value })}
                  />
                  <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.labelLabel')}</span>
                  <input
                    className={s.slotSizeInput}
                    style={{ flex: 3, minWidth: 220 }}
                    placeholder={t('roomTypeEditor.layoutVariants.labelPlaceholder')}
                    value={variant.label}
                    onChange={e => updateLayoutVariant(idx, { label: e.target.value })}
                  />
                </div>

                <div className={s.slotRow} style={{ gap: 8, marginTop: 4, alignItems: 'center' }}>
                  <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.weightLabel')}</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    className={s.slotNumInput}
                    value={variant.weight ?? 5}
                    onChange={e => updateLayoutVariant(idx, { weight: Math.max(1, parseInt(e.target.value) || 1) })}
                    onBlur={e => updateLayoutVariant(idx, { weight: Math.max(1, Math.min(10, parseInt(e.target.value) || 5)) })}
                  />
                  <span className={s.slotHint}>{t('roomTypeEditor.layoutVariants.weightRange')}</span>
                </div>

                 <div className={s.slotRow} style={{ gap: 8, marginTop: 4, alignItems: 'flex-start', flexDirection: 'column' }}>
                   <span className={s.slotGroupLabel}>
                     {t('roomTypeEditor.layoutVariants.slotsLabel')}{' '}
                     <span style={{ color: '#446', fontSize: '0.65rem' }}>
                       {t('roomTypeEditor.layoutVariants.slotsCount', { count: (variant.slotIds ?? []).length, total: draft.slots.length })}
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
                       {t('roomTypeEditor.layoutVariants.dropZoneHint')}
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
                         {t('roomTypeEditor.layoutVariants.noSlotsAdded')}
                       </div>
                     )}
                   </div>

                   {/* Verfügbare Slots zum Hinzufügen */}
                   <div style={{ marginTop: 6, width: '100%' }}>
                     <div style={{ fontSize: '0.68rem', color: '#778', marginBottom: 4 }}>{t('roomTypeEditor.layoutVariants.availableSlots')}</div>
                     <div className={s.chipGroup} style={{ gap: 3, maxHeight: 100, overflowY: 'auto' }}>
                       {[...draft.slots, ...(draft.grids ?? []).map(g => ({ id: g.id, label: `▦ ${g.label || g.id}` }))].map(slot => {
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
                             {slot.id || t('roomTypeEditor.layoutVariants.noId')}
                           </span>
                         );
                       })}
                     </div>
                   </div>
                 </div>

                   {/* ── Pool segments ── */}
                   <div className={s.slotRow} style={{ justifyContent: 'space-between', marginTop: 8 }}>
                     <span className={s.slotGroupLabel}>
                       {t('roomTypeEditor.layoutVariants.pools.header', { count: (variant.pools ?? []).length })}
                     </span>
                     <button className={s.addSlotBtn} onClick={() => addPool(idx)}>
                       {t('roomTypeEditor.layoutVariants.pools.addPool')}
                     </button>
                   </div>

                   {(variant.pools ?? []).length === 0 && (
                     <div style={{ fontSize: '0.68rem', color: '#556', fontStyle: 'italic', padding: '4px 0' }}>
                       {t('roomTypeEditor.layoutVariants.pools.noPoolsHint')}
                     </div>
                   )}

                   {(variant.pools ?? []).map((pool, poolIdx) => (
                     <div key={poolIdx} className={s.anchorRuleCard} style={{ marginTop: 4 }}>
                       {/* Pool header */}
                       <div className={s.slotRow} style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                         <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.pool', { n: poolIdx + 1 })}: {pool.id || t('roomTypeEditor.layoutVariants.pools.noId')}</span>
                         <button className={s.removeSlotBtn} onClick={() => removePool(idx, poolIdx)}>✕</button>
                       </div>

                       {/* id / label */}
                       <div className={s.slotRow} style={{ gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                         <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.idLabel')}</span>
                         <input className={s.slotSizeInput} style={{ flex: 2, minWidth: 120 }} value={pool.id}
                           onChange={e => updatePool(idx, poolIdx, { id: e.target.value })} />
                         <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.labelLabel')}</span>
                         <input className={s.slotSizeInput} style={{ flex: 3, minWidth: 140 }} value={pool.label}
                           onChange={e => updatePool(idx, poolIdx, { label: e.target.value })} />
                       </div>

                       {/* totalCountBySize */}
                       <div className={s.slotRow} style={{ gap: 5, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                         <span className={s.slotGroupLabel} title={t('roomTypeEditor.layoutVariants.pools.countBySizeTooltip')}>
                           {t('roomTypeEditor.layoutVariants.pools.countBySizeLabel')}:
                           <span style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem', marginLeft: 4 }}>ℹ</span>
                         </span>
                         {SIZE_KEYS.map(sz => (
                           <label key={sz} style={{ fontSize: '0.72rem', display: 'flex', gap: 3, alignItems: 'center' }}>
                             {sz}
                             <input type="number" min={0} max={20} className={s.slotNumInput}
                               value={pool.totalCountBySize[sz]?.min ?? 0}
                               onChange={e => updatePool(idx, poolIdx, {
                                 totalCountBySize: { ...pool.totalCountBySize, [sz]: { ...pool.totalCountBySize[sz], min: Math.max(0, parseInt(e.target.value) || 0) } }
                               })} />
                             <span style={{ color: '#888' }}>–</span>
                             <input type="number" min={0} max={20} className={s.slotNumInput}
                               value={pool.totalCountBySize[sz]?.max ?? 0}
                               onChange={e => updatePool(idx, poolIdx, {
                                 totalCountBySize: { ...pool.totalCountBySize, [sz]: { ...pool.totalCountBySize[sz], max: Math.max(0, parseInt(e.target.value) || 0) } }
                               })} />
                           </label>
                         ))}
                       </div>

                       {/* anchorTarget / firstAnchorPosition / firstOrient */}
                       <div className={s.slotRow} style={{ gap: 6, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                         <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.anchorTargetLabel')}</span>
                         <input className={s.slotSizeInput} style={{ flex: 2, minWidth: 140 }} value={pool.anchorTarget}
                           onChange={e => updatePool(idx, poolIdx, { anchorTarget: e.target.value })} />
                         <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.firstAnchorPos')}</span>
                         <select className={s.slotSizeInput} style={{ minWidth: 150, width: 'auto' }} value={pool.firstAnchorPosition}
                           onChange={e => updatePool(idx, poolIdx, { firstAnchorPosition: e.target.value as typeof ANCHOR_POSITIONS[number] })}>
                           {ANCHOR_POSITIONS.map(p => <option key={p} value={p}>{p}</option>)}
                         </select>
                         <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.firstOrient')}</span>
                         <select className={s.slotSizeInput} style={{ minWidth: 140, width: 'auto' }} value={pool.firstOrient ?? 'match'}
                           onChange={e => updatePool(idx, poolIdx, { firstOrient: e.target.value as LayoutPool['firstOrient'] })}>
                           {Object.keys(ANCHOR_ORIENT_TOOLTIPS).map(o => <option key={o} value={o}>{o}</option>)}
                         </select>
                       </div>

                       {/* chainAnchorPosition / chainOrient */}
                       <div className={s.slotRow} style={{ gap: 6, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                         <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.chainAnchorPos')}</span>
                         <select className={s.slotSizeInput} style={{ minWidth: 150, width: 'auto' }} value={pool.chainAnchorPosition}
                           onChange={e => updatePool(idx, poolIdx, { chainAnchorPosition: e.target.value as typeof ANCHOR_POSITIONS[number] })}>
                           {ANCHOR_POSITIONS.map(p => <option key={p} value={p}>{p}</option>)}
                         </select>
                         <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.chainOrient')}</span>
                         <select className={s.slotSizeInput} style={{ minWidth: 140, width: 'auto' }} value={pool.chainOrient ?? 'match'}
                           onChange={e => updatePool(idx, poolIdx, { chainOrient: e.target.value as LayoutPool['chainOrient'] })}>
                           {Object.keys(ANCHOR_ORIENT_TOOLTIPS).map(o => <option key={o} value={o}>{o}</option>)}
                         </select>
                       </div>

                       {/* requiredLayer / tileGroupId / colorGroupId */}
                       <div className={s.slotRow} style={{ gap: 6, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                         <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.layerLabel')}</span>
                         <select className={s.slotSizeInput} style={{ minWidth: 120, width: 'auto' }} value={pool.requiredLayer}
                           onChange={e => updatePool(idx, poolIdx, { requiredLayer: e.target.value })}>
                           <option value="">(any)</option>
                           {FURNITURE_LAYERS.map(l => <option key={l} value={l}>{l}</option>)}
                         </select>
                         <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.tileGroupLabel')}</span>
                         <input className={s.slotSizeInput} style={{ flex: 1, minWidth: 100 }} value={pool.tileGroupId}
                           onChange={e => updatePool(idx, poolIdx, { tileGroupId: e.target.value })} />
                         <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.colorGroupLabel')}</span>
                         <input className={s.slotSizeInput} style={{ flex: 1, minWidth: 80 }} value={pool.colorGroupId}
                           onChange={e => updatePool(idx, poolIdx, { colorGroupId: e.target.value })} />
                         <label className={s.slotCheck} title={t('roomTypeEditor.colorHarmony.title')}>
                           <input type="checkbox" checked={pool.useColorHarmony !== false}
                             disabled={draft.useColorHarmony === false}
                             onChange={e => updatePool(idx, poolIdx, { useColorHarmony: e.target.checked })} />
                           {t('roomTypeEditor.colorHarmony.label')}
                         </label>
                       </div>

                       {/* blocksFrontCell / blocksPlacement / softBlocks */}
                       <div className={s.slotRow} style={{ gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                         {(['blocksFrontCell', 'blocksPlacement', 'softBlocks'] as const).map(key => (
                           <label key={key} className={s.slotCheck}>
                             <input type="checkbox" checked={pool[key]}
                               onChange={e => updatePool(idx, poolIdx, { [key]: e.target.checked })} />
                             {key}
                           </label>
                         ))}
                       </div>
                       {!pool.blocksPlacement && (
                         <div className={s.chipGroup} style={{ marginTop: 4 }} title={t('roomTypeEditor.slotCard.cellRequiredPropertiesTitle')}>
                           {REQUIRED_PROPERTIES.map(prop => (
                             <span key={prop}
                               className={`${s.chip} ${pool.cellRequiredProperties.includes(prop) ? s.chipActive : ''}`}
                               onClick={() => updatePool(idx, poolIdx, { cellRequiredProperties: toggleInArray(pool.cellRequiredProperties, prop) })}>
                               {t(`tileBrowser.properties.${prop}`)}
                             </span>
                           ))}
                         </div>
                       )}

                       {/* defaultCategories */}
                       <div className={s.slotRow} style={{ marginTop: 6 }}>
                         <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.defaultCategoriesLabel')}</span>
                       </div>
                       {Object.entries(pool.defaultCategories).map(([cat, w]) => (
                         <div key={cat} className={s.slotRow} style={{ gap: 6, marginTop: 2 }}>
                           <span className={`${s.chip} ${s.chipActive}`} onClick={() => togglePoolCategory(idx, poolIdx, cat)}>{cat} ✕</span>
                           <input type="number" min={1} max={10} className={s.slotNumInput} value={w}
                             onChange={e => setPoolCategoryWeight(idx, poolIdx, cat, +e.target.value)} />
                         </div>
                       ))}
                       <div className={s.chipGroup} style={{ marginTop: 4 }}>
                         {availGroups.filter(g => pool.defaultCategories[g] === undefined).map(g => (
                           <span key={g} className={s.chip} onClick={() => togglePoolCategory(idx, poolIdx, g)}>{g}</span>
                         ))}
                       </div>
                       <ThemeSelector
                         categories={[...Object.keys(pool.defaultCategories), ...pool.requiredSlots.map(r => r.category)]}
                         value={pool.allowedThemes}
                         onChange={allowedThemes => updatePool(idx, poolIdx, { allowedThemes })} />

                       {/* Required slots */}
                       <div className={s.slotRow} style={{ justifyContent: 'space-between', marginTop: 8 }}>
                         <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.requiredSlots.header', { count: pool.requiredSlots.length })}</span>
                         <button className={s.addSlotBtn} onClick={() => addRequiredSlot(idx, poolIdx)}>
                           {t('roomTypeEditor.layoutVariants.pools.requiredSlots.add')}
                         </button>
                       </div>

                       {pool.requiredSlots.map((rs, rsIdx) => (
                         <div key={rsIdx} className={s.anchorRuleCard} style={{ marginTop: 4, background: '#1a2233' }}>
                           <div className={s.slotRow} style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                             <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.requiredSlots.slot', { n: rsIdx + 1 })}</span>
                             <button className={s.removeSlotBtn} onClick={() => removeRequiredSlot(idx, poolIdx, rsIdx)}>✕</button>
                           </div>

                           {/* category / count / weight / label */}
                           <div className={s.slotRow} style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 2 }}>
                             <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.requiredSlots.category')}</span>
                             <select className={s.slotSizeInput} style={{ minWidth: 160, width: 'auto' }} value={rs.category}
                               onChange={e => updateRequiredSlot(idx, poolIdx, rsIdx, { category: e.target.value })}>
                               <option value="">—</option>
                               {availGroups.map(g => <option key={g} value={g}>{g}</option>)}
                             </select>
                             <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.requiredSlots.count')}</span>
                             <input type="number" min={1} max={10} className={s.slotNumInput} value={rs.count}
                               onChange={e => updateRequiredSlot(idx, poolIdx, rsIdx, { count: Math.max(1, parseInt(e.target.value) || 1) })} />
                             <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.requiredSlots.weight')}</span>
                             <input type="number" min={1} max={10} className={s.slotNumInput} value={rs.weight}
                               onChange={e => updateRequiredSlot(idx, poolIdx, rsIdx, { weight: Math.max(1, parseInt(e.target.value) || 1) })} />
                           </div>
                           <div className={s.slotRow} style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 2 }}>
                             <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.requiredSlots.label')}</span>
                             <input className={s.slotSizeInput} style={{ flex: 2, minWidth: 120 }} value={rs.label}
                               onChange={e => updateRequiredSlot(idx, poolIdx, rsIdx, { label: e.target.value })} />
                             <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.layerLabel')}</span>
                             <select className={s.slotSizeInput} style={{ minWidth: 120, width: 'auto' }} value={rs.requiredLayer}
                               onChange={e => updateRequiredSlot(idx, poolIdx, rsIdx, { requiredLayer: e.target.value })}>
                               <option value="">(inherit pool)</option>
                               {FURNITURE_LAYERS.map(l => <option key={l} value={l}>{l}</option>)}
                             </select>
                           </div>
                           <div className={s.slotRow} style={{ gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                             {(['blocksFrontCell', 'blocksPlacement', 'softBlocks'] as const).map(key => (
                               <label key={key} className={s.slotCheck}>
                                 <input type="checkbox" checked={rs[key]}
                                   onChange={e => updateRequiredSlot(idx, poolIdx, rsIdx, { [key]: e.target.checked })} />
                                 {key}
                               </label>
                             ))}
                           </div>
                           {!rs.blocksPlacement && (
                             <div className={s.chipGroup} style={{ marginTop: 4 }} title={t('roomTypeEditor.slotCard.cellRequiredPropertiesTitle')}>
                               {REQUIRED_PROPERTIES.map(prop => (
                                 <span key={prop}
                                   className={`${s.chip} ${rs.cellRequiredProperties.includes(prop) ? s.chipActive : ''}`}
                                   onClick={() => updateRequiredSlot(idx, poolIdx, rsIdx, { cellRequiredProperties: toggleInArray(rs.cellRequiredProperties, prop) })}>
                                   {t(`tileBrowser.properties.${prop}`)}
                                 </span>
                               ))}
                             </div>
                           )}

                           {/* Companions */}
                           <div className={s.slotRow} style={{ justifyContent: 'space-between', marginTop: 6 }}>
                             <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.requiredSlots.companions.header', { count: (rs.companions ?? []).length })}</span>
                             <button className={s.addSlotBtn} onClick={() => addCompanion(idx, poolIdx, rsIdx)}>
                               {t('roomTypeEditor.layoutVariants.pools.requiredSlots.companions.add')}
                             </button>
                           </div>

                           {(() => {
                             const companionGroupIds = Array.from(new Set(
                               (rs.companions ?? []).map(cc => cc.slotGroupId).filter(g => g)
                             ));
                             return (rs.companions ?? []).map((c, ci) => {
                             const groupColor = c.slotGroupId ? getGroupColor(c.slotGroupId, companionGroupIds) : undefined;
                             return (
                             <div key={ci} className={`${s.anchorRuleCard} ${groupColor ? s.slotCardGrouped : ''}`}
                               style={{ marginTop: 3, background: '#141c2c', ...(groupColor ? { '--group-color': groupColor } as React.CSSProperties : {}) }}>
                               <div className={s.slotRow} style={{ justifyContent: 'space-between', marginBottom: 3 }}>
                                 <span className={s.slotGroupLabel}>
                                   {groupColor && <span style={{
                                     display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                                     background: groupColor, marginRight: 5,
                                   }} title={c.slotGroupId} />}
                                   {t('roomTypeEditor.layoutVariants.pools.requiredSlots.companions.companion', { n: ci + 1 })}: {c.label || '—'}
                                 </span>
                                 <button className={s.removeSlotBtn} onClick={() => removeCompanion(idx, poolIdx, rsIdx, ci)}>✕</button>
                               </div>
                               <div className={s.slotRow} style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 2 }}>
                                 <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.requiredSlots.companions.label')}</span>
                                 <input className={s.slotSizeInput} style={{ flex: 2, minWidth: 120 }} value={c.label}
                                   onChange={e => updateCompanion(idx, poolIdx, rsIdx, ci, { label: e.target.value })} />
                                 <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.layerLabel')}</span>
                                 <select className={s.slotSizeInput} style={{ minWidth: 120, width: 'auto' }} value={c.requiredLayer}
                                   onChange={e => updateCompanion(idx, poolIdx, rsIdx, ci, { requiredLayer: e.target.value })}>
                                   <option value="">—</option>
                                   {FURNITURE_LAYERS.map(l => <option key={l} value={l}>{l}</option>)}
                                 </select>
                               </div>
                               <div className={s.slotRow} style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 2 }}>
                                 <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.requiredSlots.companions.anchorPosition')}</span>
                                 <select className={s.slotSizeInput} style={{ minWidth: 150, width: 'auto' }} value={c.anchorPosition}
                                   onChange={e => updateCompanion(idx, poolIdx, rsIdx, ci, { anchorPosition: e.target.value as typeof ANCHOR_POSITIONS[number] })}>
                                   {ANCHOR_POSITIONS.map(p => <option key={p} value={p}>{p}</option>)}
                                 </select>
                                 <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.requiredSlots.companions.orient')}</span>
                                 <select className={s.slotSizeInput} style={{ minWidth: 140, width: 'auto' }} value={c.orient ?? 'match'}
                                   onChange={e => updateCompanion(idx, poolIdx, rsIdx, ci, { orient: e.target.value as LayoutPoolCompanion['orient'] })}>
                                   {Object.keys(ANCHOR_ORIENT_TOOLTIPS).map(o => <option key={o} value={o}>{o}</option>)}
                                 </select>
                               </div>
                               <div className={s.slotRow} style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 2 }}
                                 title={t('roomTypeEditor.layoutVariants.pools.requiredSlots.companions.groupHint')}>
                                 <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.requiredSlots.companions.groupId')}</span>
                                 <input className={s.slotSizeInput} style={{ flex: 1, minWidth: 100 }} value={c.slotGroupId}
                                   onChange={e => updateCompanion(idx, poolIdx, rsIdx, ci, { slotGroupId: e.target.value })} />
                                 {c.slotGroupId && (<>
                                   <span className={s.slotGroupLabel}>{t('roomTypeEditor.slotCard.groupWeightLabel')}</span>
                                   <input type="number" min={1} max={10} className={s.slotNumInput} value={c.groupWeight}
                                     onChange={e => { const v = +e.target.value; if (v >= 1) updateCompanion(idx, poolIdx, rsIdx, ci, { groupWeight: v }); }}
                                     onBlur={e => updateCompanion(idx, poolIdx, rsIdx, ci, { groupWeight: Math.max(1, Math.min(10, +e.target.value)) })} />
                                 </>)}
                               </div>
                               <div className={s.slotRow} style={{ gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                                 {(['blocksFrontCell', 'blocksPlacement', 'softBlocks'] as const).map(key => (
                                   <label key={key} className={s.slotCheck}>
                                     <input type="checkbox" checked={c[key]}
                                       onChange={e => updateCompanion(idx, poolIdx, rsIdx, ci, { [key]: e.target.checked })} />
                                     {key}
                                   </label>
                                 ))}
                               </div>
                               {!c.blocksPlacement && (
                                 <div className={s.chipGroup} style={{ marginTop: 4 }} title={t('roomTypeEditor.slotCard.cellRequiredPropertiesTitle')}>
                                   {REQUIRED_PROPERTIES.map(prop => (
                                     <span key={prop}
                                       className={`${s.chip} ${c.cellRequiredProperties.includes(prop) ? s.chipActive : ''}`}
                                       onClick={() => updateCompanion(idx, poolIdx, rsIdx, ci, { cellRequiredProperties: toggleInArray(c.cellRequiredProperties, prop) })}>
                                       {t(`tileBrowser.properties.${prop}`)}
                                     </span>
                                   ))}
                                 </div>
                               )}
                               {/* Companion categories */}
                               <div className={s.slotRow} style={{ marginTop: 4 }}>
                                 <span className={s.slotGroupLabel}>{t('roomTypeEditor.layoutVariants.pools.defaultCategoriesLabel')}</span>
                               </div>
                               {Object.entries(c.allowedCategories).map(([cat, w]) => (
                                 <div key={cat} className={s.slotRow} style={{ gap: 6, marginTop: 2 }}>
                                   <span className={`${s.chip} ${s.chipActive}`} onClick={() => toggleCompanionCategory(idx, poolIdx, rsIdx, ci, cat)}>{cat} ✕</span>
                                   <input type="number" min={1} max={10} className={s.slotNumInput} value={w}
                                     onChange={e => updateCompanion(idx, poolIdx, rsIdx, ci, { allowedCategories: { ...c.allowedCategories, [cat]: Math.max(1, +e.target.value || 1) } })} />
                                 </div>
                               ))}
                               <div className={s.chipGroup} style={{ marginTop: 3 }}>
                                 {availGroups.filter(g => c.allowedCategories[g] === undefined).map(g => (
                                   <span key={g} className={s.chip} onClick={() => toggleCompanionCategory(idx, poolIdx, rsIdx, ci, g)}>{g}</span>
                                 ))}
                               </div>
                               <ThemeSelector categories={Object.keys(c.allowedCategories)} value={c.allowedThemes}
                                 onChange={allowedThemes => updateCompanion(idx, poolIdx, rsIdx, ci, { allowedThemes })} />
                             </div>
                             );});
                           })()}
                         </div>
                       ))}
                     </div>
                   ))}

                   <div className={s.slotHint} style={{ marginTop: 4 }}>
                    {t('roomTypeEditor.layoutVariants.variantHint')}
                 </div>

                </>)}
              </div>
              );
            })}

          </>)}
        </div>

      {/* ── Right: ref panel ── */}
      <div className={s.refPanel}>
          {/* Footprint-Kacheln */}
          <div style={{ flexShrink: 0 }}>
            <div style={{ fontSize: '0.68rem', color: '#778', marginBottom: 6 }}>{t('roomTypeEditor.refPanel.commonFootprints')}</div>
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

          {/* Layout-Formen */}
          <div style={{ flexShrink: 0 }}>
            <div style={{ fontSize: '0.68rem', color: '#778', marginBottom: 6 }}>{t('roomTypeEditor.refPanel.layoutShapes.title')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
              {LAYOUT_SHAPE_EXAMPLES.map(shape => (
                <div key={shape.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, maxWidth: 92 }}>
                  <div style={{
                    display: 'inline-grid', gap: 2,
                    gridTemplateColumns: `repeat(${shape.grid[0].length}, 12px)`,
                  }}>
                    {shape.grid.flatMap((row, r) => row.map((filled, c) => (
                      <div key={`${r}_${c}`} style={{
                        width: 12, height: 12, borderRadius: 2,
                        background: filled ? '#3a5aaa' : 'transparent',
                        border: filled ? 'none' : '1px dashed #2a3a3a',
                      }} />
                    )))}
                  </div>
                  <span style={{ fontSize: '0.65rem', color: '#9ab', fontWeight: 600 }}>
                    {t(`roomTypeEditor.refPanel.layoutShapes.${shape.id}.label`)}
                  </span>
                  <span style={{ fontSize: '0.6rem', color: '#778', textAlign: 'center', lineHeight: 1.25 }}>
                    {t(`roomTypeEditor.refPanel.layoutShapes.${shape.id}.desc`)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Raumgrößen */}
          <div style={{ flexShrink: 0 }}>
            <div style={{ fontSize: '0.68rem', color: '#778', marginBottom: 2 }}>{t('roomTypeEditor.refPanel.roomSizes')}</div>
            <div className={s.refTable}>
              {SIZE_KEYS.map(size => (
                <div key={size} className={s.refRow}>
                  <span className={s.refSize}>{size}</span>
                  <span className={s.refRange}>{t(`roomTypeEditor.sizeLabels.${size}`)}</span>
                  <span className={s.refEx}>{t(`roomTypeEditor.sizeExamples.${size}`)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Hinweise */}
          <p className={s.refNote}>
            <strong>{t('roomTypeEditor.refPanel.notes.required')}</strong>{t('roomTypeEditor.refPanel.notes.requiredDesc')}<br />
            <strong>{t('roomTypeEditor.refPanel.notes.optional')}</strong>{t('roomTypeEditor.refPanel.notes.optionalDesc')}<br />
            <strong>{t('roomTypeEditor.refPanel.notes.maxUnlimited')}</strong>{t('roomTypeEditor.refPanel.notes.maxUnlimitedDesc')}<br />
            <strong>{t('roomTypeEditor.refPanel.notes.emptyCategories')}</strong>{t('roomTypeEditor.refPanel.notes.emptyCategoriesDesc')}
          </p>
        </div>

      {draft && pickerSlotIdx !== null && draft.slots[pickerSlotIdx] && (
        <FurniturePickerModal
          slot={draft.slots[pickerSlotIdx]}
          onClose={() => setPickerSlotIdx(null)}
          onApply={(patch, count) => {
            updateSlot(pickerSlotIdx, patch);
            setPickerSlotIdx(null);
            setStatus(t('roomTypeEditor.furniturePicker.applied', { count }));
          }} />
      )}
    </div>
  );
}

















































