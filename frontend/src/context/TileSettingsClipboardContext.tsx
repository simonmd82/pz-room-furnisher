import { createContext, useContext, useState, type ReactNode } from 'react';
import type { TileDefinition } from '../types/tiles';

/**
 * Fields considered "settings" for copy/paste — everything except per-tile
 * identity/geometry (id, tileId, tileLayout) and label/orientation, which are
 * usually specific to the exact tile being edited, not shared behaviour.
 */
export const COPYABLE_FIELDS = [
  'group', 'layer', 'notes',
  'isHigh', 'isMedium', 'isLow', 'isWallMounted', 'hasSurface', 'hasCollision',
  'canStack', 'isTableTop', 'isLootContainer',
  'colors', 'materials', 'roomTypes', 'variantGroup',
  'allowedOrients', 'windowBlockedEdge', 'styleTags',
] as const satisfies readonly (keyof TileDefinition)[];

export type CopyableTileSettings = Pick<TileDefinition, typeof COPYABLE_FIELDS[number]>;

export function extractCopyableSettings(def: TileDefinition): CopyableTileSettings {
  const out = {} as CopyableTileSettings;
  for (const field of COPYABLE_FIELDS) {
    (out[field] as unknown) = def[field];
  }
  return out;
}

interface TileSettingsClipboardContextValue {
  clipboard: CopyableTileSettings | null;
  /** tileId the clipboard was copied from, for display purposes only (not itself pasted) */
  copiedFrom: string | null;
  copy: (def: TileDefinition) => void;
  clear: () => void;
}

const TileSettingsClipboardContext = createContext<TileSettingsClipboardContextValue | undefined>(undefined);

export function TileSettingsClipboardProvider({ children }: { children: ReactNode }) {
  const [clipboard, setClipboard] = useState<CopyableTileSettings | null>(null);
  const [copiedFrom, setCopiedFrom] = useState<string | null>(null);

  return (
    <TileSettingsClipboardContext.Provider
      value={{
        clipboard,
        copiedFrom,
        copy: def => { setClipboard(extractCopyableSettings(def)); setCopiedFrom(def.tileId); },
        clear: () => { setClipboard(null); setCopiedFrom(null); },
      }}
    >
      {children}
    </TileSettingsClipboardContext.Provider>
  );
}

export function useTileSettingsClipboard(): TileSettingsClipboardContextValue {
  const ctx = useContext(TileSettingsClipboardContext);
  if (!ctx) throw new Error('useTileSettingsClipboard must be used within a TileSettingsClipboardProvider');
  return ctx;
}
