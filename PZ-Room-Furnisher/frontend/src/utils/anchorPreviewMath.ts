import type { AnchorPosition, AnchorRule, SlotFootprint } from '../types/roomTypes';

/**
 * Pure-TS preview port of the anchor resolution logic in
 * backend/Services/FurnishingGeneratorService.cs (ResolveAnchoredOrient,
 * ResolveFacingAnchorOrient, ComputeAnchoredPosition, NormOffset).
 *
 * Used ONLY by the Room Type Editor's AnchorRulePreview to help authors verify
 * anchorRules visually. Does not affect runtime generation. Formulas are ported
 * verbatim from the C# source, including any asymmetries noted below — do not
 * "fix" them here without changing the backend first, or the preview will lie
 * about actual generator behavior.
 */

export type CardinalOrient = 'N' | 'S' | 'E' | 'W';
export type CornerOrient = 'NW' | 'NE' | 'SW' | 'SE';
export type ResolvedOrient = CardinalOrient | CornerOrient;

export interface AnchorPreviewResult {
  /** Top-left cell of the dependent footprint, relative to anchor top-left = (0,0). */
  depCol: number;
  depRow: number;
  /** Resolved orientation string for the dependent tile ('' if unresolvable). */
  resolvedOrient: ResolvedOrient | '';
  /** True if the position/orient combination could not be resolved (mirrors backend returning null). */
  unresolved: boolean;
}

function normOffset(offset: number, anchorLen: number, depLen: number): number {
  // Direct port of NormOffset (FurnishingGeneratorService.cs ~line 2788).
  if (offset >= 0) return offset;
  return anchorLen - depLen + offset + 1;
}

const half = (a: number, b: number) => Math.trunc((a - b) / 2);

/**
 * Direct port of ComputeAnchoredPosition (FurnishingGeneratorService.cs ~lines 2540-2645),
 * restricted to the positions relevant for corner/L-shape + directional preview verification.
 * Returns null when the position+anchorOrient combination is not defined upstream
 * (e.g. rightOfAnchor has no corner-orient branches, unlike leftOfAnchor — ported as-is).
 *
 * Out of scope for v1 (always null here): HeadLeft/HeadRight/FootLeft/FootRight, bare
 * Left/Right, openSidePlacement, oppositeWall, perpendicularSide (legacy alias that diverges
 * from leftPerpendicular for E/W anchor orientations in the backend — not safe to approximate).
 */
export function computeAnchoredOffset(
  position: AnchorPosition,
  anchorOrient: ResolvedOrient,
  anchorFootprint: SlotFootprint,
  depFootprint: SlotFootprint,
  offsetAlongAnchor = 0,
): { col: number; row: number } | null {
  const aw = anchorFootprint.width;
  const ah = anchorFootprint.height;
  const dw = depFootprint.width;
  const dh = depFootprint.height;

  switch (position) {
    case 'Above':
      return { col: half(aw, dw), row: -dh };
    case 'Below':
      return { col: half(aw, dw), row: ah };
    case 'Center':
      return { col: half(aw, dw), row: half(ah, dh) };

    case 'frontOfAnchor':
      switch (anchorOrient) {
        case 'N': return { col: half(aw, dw), row: -dh };
        case 'S': return { col: half(aw, dw), row: ah };
        case 'E': return { col: aw, row: half(ah, dh) };
        case 'W': return { col: -dw, row: half(ah, dh) };
        default: return null;
      }
    case 'behindAnchor':
      switch (anchorOrient) {
        case 'N': return { col: half(aw, dw), row: ah };
        case 'S': return { col: half(aw, dw), row: -dh };
        case 'E': return { col: -dw, row: half(ah, dh) };
        case 'W': return { col: aw, row: half(ah, dh) };
        default: return null;
      }

    case 'leftOfAnchor':
      // NOTE: leftOfAnchor uniquely supports corner anchorOrient values (NW/NE/SW/SE) in the
      // backend — this is the exact mapping cornerFromAnchor's orient table relies on.
      // rightOfAnchor (below) intentionally does NOT have corner branches. Ported verbatim.
      switch (anchorOrient) {
        case 'N': return { col: -dw, row: half(ah, dh) };
        case 'S': return { col: aw, row: half(ah, dh) };
        case 'E': return { col: half(aw, dw), row: -dh };
        case 'W': return { col: half(aw, dw), row: ah };
        case 'SE': return { col: half(aw, dw), row: ah };
        case 'SW': return { col: -dw, row: half(ah, dh) };
        case 'NW': return { col: half(aw, dw), row: -dh };
        case 'NE': return { col: aw, row: half(ah, dh) };
        default: return null;
      }
    case 'rightOfAnchor':
      switch (anchorOrient) {
        case 'N': return { col: aw, row: half(ah, dh) };
        case 'S': return { col: -dw, row: half(ah, dh) };
        case 'E': return { col: half(aw, dw), row: ah };
        case 'W': return { col: half(aw, dw), row: -dh };
        default: return null; // no corner-orient branches upstream
      }

    case 'LongSide0':
      return aw >= ah
        ? { col: normOffset(offsetAlongAnchor, aw, dw), row: -dh }
        : { col: -dw, row: normOffset(offsetAlongAnchor, ah, dh) };
    case 'LongSide1':
      return aw >= ah
        ? { col: normOffset(offsetAlongAnchor, aw, dw), row: ah }
        : { col: aw, row: normOffset(offsetAlongAnchor, ah, dh) };
    case 'ShortSide0':
      return aw >= ah
        ? { col: -dw, row: normOffset(offsetAlongAnchor, ah, dh) }
        : { col: normOffset(offsetAlongAnchor, aw, dw), row: -dh };
    case 'ShortSide1':
      return aw >= ah
        ? { col: aw, row: normOffset(offsetAlongAnchor, ah, dh) }
        : { col: normOffset(offsetAlongAnchor, aw, dw), row: ah };

    case 'leftPerpendicular':
      switch (anchorOrient) {
        case 'N': return { col: -dw, row: half(ah, dh) };
        case 'E': return { col: half(aw, dw), row: -dh };
        case 'S': return { col: aw, row: half(ah, dh) };
        case 'W': return { col: half(aw, dw), row: ah };
        default: return null;
      }
    case 'rightPerpendicular':
      switch (anchorOrient) {
        case 'N': return { col: aw, row: half(ah, dh) };
        case 'E': return { col: half(aw, dw), row: ah };
        case 'S': return { col: -dw, row: half(ah, dh) };
        case 'W': return { col: half(aw, dw), row: -dh };
        default: return null;
      }

    default:
      return null;
  }
}

/**
 * Direct port of ResolveFacingAnchorOrient (FurnishingGeneratorService.cs ~lines 2488-2508),
 * used by the 'facingAnchor' branch of resolveAnchoredOrient below.
 */
function resolveFacingAnchorOrient(
  position: AnchorPosition,
  aw: number,
  ah: number,
  anchorOrient: ResolvedOrient,
): ResolvedOrient | null {
  const wide = aw > ah;
  const tall = ah > aw;
  switch (position) {
    case 'LongSide0': return wide || !tall ? 'S' : 'E';
    case 'LongSide1': return wide || !tall ? 'N' : 'W';
    case 'ShortSide0': return wide ? 'E' : 'S';
    case 'ShortSide1': return wide ? 'W' : 'N';
    case 'Above': return 'S';
    case 'Below': return 'N';
    case 'Left': return 'E';
    case 'Right': return 'W';
    case 'frontOfAnchor':
      switch (anchorOrient) { case 'N': return 'S'; case 'S': return 'N'; case 'E': return 'W'; case 'W': return 'E'; default: return null; }
    case 'behindAnchor':
      switch (anchorOrient) { case 'N': return 'N'; case 'S': return 'S'; case 'E': return 'E'; case 'W': return 'W'; default: return null; }
    case 'leftOfAnchor':
      switch (anchorOrient) { case 'N': return 'E'; case 'S': return 'W'; case 'E': return 'S'; case 'W': return 'N'; default: return null; }
    case 'rightOfAnchor':
      switch (anchorOrient) { case 'N': return 'W'; case 'S': return 'E'; case 'E': return 'N'; case 'W': return 'S'; default: return null; }
    default:
      return null;
  }
}

/**
 * Direct port of ResolveAnchoredOrient (FurnishingGeneratorService.cs ~lines 1173-1254),
 * restricted to the orient values relevant for corner/L-shape + directional preview
 * verification: match/parallelToAnchor, opposite, facingAnchor, perpendicularCW/CCW,
 * cornerFromAnchor, fixed N/S/E/W.
 *
 * Out of scope for v1 (fall through to fallbackOrient): legacy cwPerpendicular/
 * ccwPerpendicular (N/S/E/W-only duplicates superseded by perpendicularCW/CCW),
 * openSideFacing (depends on generator-runtime chosenOpenSide, no static equivalent).
 *
 * NOTE: the editor dropdown also offers fixed "NW"/"NE"/"SW"/"SE" orient options, but the
 * backend switch has no case for those literal strings — they fall to its default branch
 * (baseTile.Orientation), i.e. picking "Fixed NW" currently has NO effect on generation.
 * Ported faithfully here (falls to fallbackOrient) rather than "fixing" it client-side.
 */
export function resolveAnchoredOrient(
  orientRule: AnchorRule['orient'],
  anchorOrient: ResolvedOrient,
  position: AnchorPosition,
  anchorFootprint: SlotFootprint,
  fallbackOrient: ResolvedOrient = 'S',
): ResolvedOrient {
  switch (orientRule) {
    case 'match':
    case 'parallelToAnchor':
      return anchorOrient;

    case 'opposite': {
      const flip: Partial<Record<ResolvedOrient, ResolvedOrient>> = { N: 'S', S: 'N', E: 'W', W: 'E' };
      return flip[anchorOrient] ?? fallbackOrient;
    }

    case 'perpendicularCW': {
      const table: Partial<Record<ResolvedOrient, ResolvedOrient>> = {
        SE: 'W', SW: 'N', NE: 'S', NW: 'E',
        N: 'E', E: 'S', S: 'W', W: 'N',
      };
      return table[anchorOrient] ?? fallbackOrient;
    }
    case 'perpendicularCCW': {
      // TODO-verify: backend's corner mappings (NW/SW/NE) look asymmetric vs. a clean
      // 90deg rotation table compared to perpendicularCW. Ported verbatim — do not "fix"
      // without confirming intent with the backend source.
      const table: Partial<Record<ResolvedOrient, ResolvedOrient>> = {
        SE: 'W', SW: 'E', NE: 'W', NW: 'E',
        N: 'W', E: 'N', S: 'E', W: 'S',
      };
      return table[anchorOrient] ?? fallbackOrient;
    }

    case 'cornerFromAnchor': {
      // This exact mapping is what proves a single anchor rule resolves to all 4 room
      // corners depending on which wall the anchor ends up against — the primary reason
      // this preview exists. Bit-for-bit faithful to FurnishingGeneratorService.cs ~1225-1238.
      const table: Partial<Record<string, ResolvedOrient>> = {
        'S|rightOfAnchor': 'NW', 'S|leftOfAnchor': 'NE',
        'N|rightOfAnchor': 'SE', 'N|leftOfAnchor': 'SW',
        'E|rightOfAnchor': 'SW', 'E|leftOfAnchor': 'NW',
        'W|rightOfAnchor': 'NE', 'W|leftOfAnchor': 'SE',
      };
      return table[`${anchorOrient}|${position}`] ?? fallbackOrient;
    }

    case 'facingAnchor': {
      if (position === 'oppositeWall') {
        const flip: Partial<Record<ResolvedOrient, ResolvedOrient>> = { N: 'S', S: 'N', E: 'W', W: 'E' };
        return flip[anchorOrient] ?? fallbackOrient;
      }
      return resolveFacingAnchorOrient(position, anchorFootprint.width, anchorFootprint.height, anchorOrient) ?? fallbackOrient;
    }

    case 'N':
    case 'S':
    case 'E':
    case 'W':
      return orientRule;

    default:
      return fallbackOrient;
  }
}

/** Convenience wrapper combining offset + orient resolution, used directly by the preview component. */
export function computeAnchorPreview(
  position: AnchorPosition,
  orientRule: AnchorRule['orient'],
  anchorOrient: ResolvedOrient,
  anchorFootprint: SlotFootprint,
  depFootprint: SlotFootprint,
  offsetAlongAnchor = 0,
): AnchorPreviewResult {
  const offset = computeAnchoredOffset(position, anchorOrient, anchorFootprint, depFootprint, offsetAlongAnchor);
  if (!offset) {
    return { depCol: 0, depRow: 0, resolvedOrient: '', unresolved: true };
  }
  const resolvedOrient = resolveAnchoredOrient(orientRule, anchorOrient, position, anchorFootprint);
  return { depCol: offset.col, depRow: offset.row, resolvedOrient, unresolved: false };
}
