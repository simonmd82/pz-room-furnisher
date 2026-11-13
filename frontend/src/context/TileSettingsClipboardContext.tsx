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
  'canStack', 'isTableTop', 'isLootContainer', 'allowAboveWindow',
  'colors', 'materials', 'roomTypes', 'variantGroup',
  'allowedOrients', 'windowBlockedEdge', 'windowExactSide', 'styleTags', 'themes', 'useFacingOrientation',
] as const satisfies readonly (keyof TileDefinition)[];

export type CopyableField = typeof COPYABLE_FIELDS[number];
/** A clipboard entry; fields left out on copy are simply absent, so pasting keeps the target's own value. */
export type CopyableTileSettings = Partial<Pick<TileDefinition, CopyableField>>;

/** Fields that describe one exact sprite rather than shared behaviour — left out by default when
 *  copying from another tile set (a vanilla variantGroup would link the new sprites into vanilla's
 *  N/E/S/W group; colours/notes describe the vanilla sprite). */
export const CROSS_SET_DEFAULT_OMIT: readonly CopyableField[] = ['variantGroup', 'colors', 'notes'];

export function extractCopyableSettings(def: TileDefinition, omit?: ReadonlySet<CopyableField>): CopyableTileSettings {
  const out: CopyableTileSettings = {};
  for (const field of COPYABLE_FIELDS) {
    if (omit?.has(field)) continue;
    (out[field] as unknown) = def[field];
  }
  return out;
}

export interface CopyOptions {
  /** Fields not to copy (pasting keeps the target's value for these). */
  omit?: ReadonlySet<CopyableField>;
  /** Set the defs came from, when copied via "Copy from set…" (display only). */
  sourceSetId?: string;
}

interface TileSettingsClipboardContextValue {
  /** Ordered by source position (sprite index / entry order) — index 0 pastes to the 1st
   *  selected target, etc. Length 1 means "broadcast to every selected target" instead. */
  clipboard: CopyableTileSettings[] | null;
  /** tileIds the clipboard was copied from, parallel to `clipboard`, for display only */
  copiedFrom: string[] | null;
  /** Source set when copied from another set via the picker; null for a normal copy. */
  sourceSetId: string | null;
  /** Fields left out of the clipboard entries. */
  omitted: CopyableField[];
  copy: (defs: TileDefinition[], opts?: CopyOptions) => void;
  clear: () => void;
}

const TileSettingsClipboardContext = createContext<TileSettingsClipboardContextValue | undefined>(undefined);

export function TileSettingsClipboardProvider({ children }: { children: ReactNode }) {
  const [clipboard, setClipboard] = useState<CopyableTileSettings[] | null>(null);
  const [copiedFrom, setCopiedFrom] = useState<string[] | null>(null);
  const [sourceSetId, setSourceSetId] = useState<string | null>(null);
  const [omitted, setOmitted] = useState<CopyableField[]>([]);

  return (
    <TileSettingsClipboardContext.Provider
      value={{
        clipboard,
        copiedFrom,
        sourceSetId,
        omitted,
        copy: (defs, opts) => {
          if (defs.length === 0) return;
          setClipboard(defs.map(d => extractCopyableSettings(d, opts?.omit)));
          setCopiedFrom(defs.map(d => d.tileId));
          setSourceSetId(opts?.sourceSetId ?? null);
          setOmitted(COPYABLE_FIELDS.filter(f => opts?.omit?.has(f)));
        },
        clear: () => { setClipboard(null); setCopiedFrom(null); setSourceSetId(null); setOmitted([]); },
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
