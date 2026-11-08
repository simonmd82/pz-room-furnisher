import { createContext, useContext, useState, type ReactNode } from 'react';
import type { TileDefinition } from '../types/tiles';

/**
 * Fields considered "settings" for copy/paste — everything except per-tile
 * identity/geometry (id, tileId, tileLayout) and label, which is usually
 * specific to the exact tile being edited, not shared behaviour. `orientation`
 * is included so copying/pasting a full row (positional, per source tile)
 * carries each tile's own orientation along with its other settings.
 */
export const COPYABLE_FIELDS = [
  'group', 'layer', 'notes', 'orientation',
  'isHigh', 'isMedium', 'isLow', 'isWallMounted', 'hasSurface', 'hasCollision',
  'canStack', 'isTableTop', 'isLootContainer',
  'colors', 'materials', 'roomTypes', 'variantGroup',
  'allowedOrients', 'windowBlockedEdge', 'styleTags', 'themes', 'useFacingOrientation',
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
  /** Ordered by source position (sprite index / entry order) — index 0 pastes to the 1st
   *  selected target, etc. Length 1 means "broadcast to every selected target" instead. */
  clipboard: CopyableTileSettings[] | null;
  /** tileIds the clipboard was copied from, parallel to `clipboard`, for display only */
  copiedFrom: string[] | null;
  copy: (defs: TileDefinition[]) => void;
  clear: () => void;
}

const TileSettingsClipboardContext = createContext<TileSettingsClipboardContextValue | undefined>(undefined);

export function TileSettingsClipboardProvider({ children }: { children: ReactNode }) {
  const [clipboard, setClipboard] = useState<CopyableTileSettings[] | null>(null);
  const [copiedFrom, setCopiedFrom] = useState<string[] | null>(null);

  return (
    <TileSettingsClipboardContext.Provider
      value={{
        clipboard,
        copiedFrom,
        copy: defs => {
          if (defs.length === 0) return;
          setClipboard(defs.map(extractCopyableSettings));
          setCopiedFrom(defs.map(d => d.tileId));
        },
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
