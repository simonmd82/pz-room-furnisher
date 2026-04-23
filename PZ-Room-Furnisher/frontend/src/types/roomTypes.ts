export const SLOT_TYPES = ['small', 'medium', 'large', 'extralarge'] as const;
export type SlotType = typeof SLOT_TYPES[number];

export const SIZE_KEYS = ['XS', 'S', 'M', 'L', 'XL'] as const;
export type SizeKey = typeof SIZE_KEYS[number];

export interface SlotCount {
  min: number;
  /** -1 = unbegrenzt (nur durch freie Felder begrenzt) */
  max: number;
}

export interface SlotSizeConfig {
  /** max. Felder für small-Slot (inkl.). Default 1 */
  smallMax:  number;
  /** max. Felder für medium-Slot (inkl.). Default 2 */
  mediumMax: number;
  /** max. Felder für large-Slot (inkl.). Default 4 */
  largeMax:  number;
  // extralarge = alles darüber
}

export interface RoomTypeSlot {
  slotType: SlotType;
  required: boolean;
  /** Priorität beim Ziehen optionaler Slots (niedrig = zuerst) */
  priority: number;
  /** Min/Max-Anzahl je Raumgröße */
  countBySize: Record<SizeKey, SlotCount>;
  /** Erlaubte Möbelgruppen. Leer = alle passenden */
  groups: string[];
}

export interface RoomTypeConfig {
  roomType: string;
  slots:    RoomTypeSlot[];
}

export type RoomTypeConfigMap = Record<string, RoomTypeConfig>;

export function defaultCountBySize(): Record<SizeKey, SlotCount> {
  return {
    XS: { min: 0, max: 0 },
    S:  { min: 0, max: 1 },
    M:  { min: 0, max: 2 },
    L:  { min: 0, max: 3 },
    XL: { min: 0, max: 4 },
  };
}

export function defaultSlot(): RoomTypeSlot {
  return { slotType: 'medium', required: false, priority: 0, countBySize: defaultCountBySize(), groups: [] };
}

export function defaultRoomTypeConfig(roomType: string): RoomTypeConfig {
  return { roomType, slots: [] };
}


