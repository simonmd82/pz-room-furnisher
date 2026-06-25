import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnchorRule, SlotFootprint } from '../../types/roomTypes';
import { computeAnchorPreview, type CardinalOrient, type ResolvedOrient } from '../../utils/anchorPreviewMath';
import s from './RoomTypeEditor.module.css';

export interface AnchorRulePreviewProps {
  rule: AnchorRule;
  /** Footprint of the slot that owns this anchor rule (the dependent slot). */
  dependentFootprint: SlotFootprint;
  /** Footprint of the anchor target slot, or undefined if not found (group anchor / typo). */
  anchorFootprint: SlotFootprint | undefined;
}

const ORIENT_ARROW: Record<ResolvedOrient, string> = {
  N: '↑', S: '↓', E: '→', W: '←', NW: '↖', NE: '↗', SW: '↙', SE: '↘',
};

const WALLS: CardinalOrient[] = ['N', 'S', 'E', 'W'];

/**
 * Authoring aid for the Room Type Editor: shows where a dependent slot lands relative to
 * its anchor for a simulated anchor wall orientation (N/S/E/W), so authors can confirm a
 * corner/L-shape anchor rule resolves correctly across all 4 walls without generating a
 * full layout. Read-only simulation via anchorPreviewMath — does not affect generation.
 */
export function AnchorRulePreview({ rule, dependentFootprint, anchorFootprint }: AnchorRulePreviewProps) {
  const { t } = useTranslation();
  const [simulatedWall, setSimulatedWall] = useState<CardinalOrient>('N');

  const resolvedAnchorFootprint = anchorFootprint ?? { width: 1, height: 1, canRotate: false };
  const position = rule.positions[0];
  const preview = position
    ? computeAnchorPreview(position, rule.orient, simulatedWall, resolvedAnchorFootprint, dependentFootprint, rule.offsetAlongAnchor)
    : null;

  const aw = resolvedAnchorFootprint.width;
  const ah = resolvedAnchorFootprint.height;
  const dw = dependentFootprint.width;
  const dh = dependentFootprint.height;

  let minCol = 0, minRow = 0, maxCol = aw, maxRow = ah;
  if (preview && !preview.unresolved) {
    minCol = Math.min(minCol, preview.depCol);
    minRow = Math.min(minRow, preview.depRow);
    maxCol = Math.max(maxCol, preview.depCol + dw);
    maxRow = Math.max(maxRow, preview.depRow + dh);
  }
  const spanCols = Math.max(maxCol - minCol, 1);
  const spanRows = Math.max(maxRow - minRow, 1);
  const cellSize = Math.max(10, Math.min(22, Math.floor(160 / Math.max(spanCols, spanRows))));

  const showRotationNote = !!dependentFootprint.canRotate || !!resolvedAnchorFootprint.canRotate;

  return (
    <div style={{ marginTop: 4, marginBottom: 2 }}>
      <div className={s.chipGroup} style={{ marginBottom: 4, alignItems: 'center' }}>
        <span className={s.slotHint} style={{ marginRight: 4 }}>
          {t('roomTypeEditor.slotCard.previewWallLabel')}
        </span>
        {WALLS.map(wall => (
          <span key={wall}
            className={`${s.chip} ${simulatedWall === wall ? s.chipActive : ''}`}
            onClick={() => setSimulatedWall(wall)}>
            {wall}
          </span>
        ))}
      </div>

      <div style={{
        position: 'relative',
        width: spanCols * cellSize,
        height: spanRows * cellSize,
        background: '#0a0a12',
        border: '1px solid #2a3a3a',
        borderRadius: 4,
      }}>
        <div title="anchor" style={{
          position: 'absolute',
          left: (0 - minCol) * cellSize,
          top: (0 - minRow) * cellSize,
          width: aw * cellSize,
          height: ah * cellSize,
          background: 'rgba(100,160,255,0.5)',
          border: '1px solid rgba(180,210,255,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <span style={{ fontSize: Math.max(10, cellSize * 0.6), color: '#fff', textShadow: '0 0 3px #000' }}>
            {ORIENT_ARROW[simulatedWall]}
          </span>
        </div>

        {preview && !preview.unresolved && (
          <div title="dependent" style={{
            position: 'absolute',
            left: (preview.depCol - minCol) * cellSize,
            top: (preview.depRow - minRow) * cellSize,
            width: dw * cellSize,
            height: dh * cellSize,
            background: 'rgba(255,140,60,0.55)',
            border: '1px solid rgba(255,200,150,0.8)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{ fontSize: Math.max(10, cellSize * 0.6), color: '#fff', textShadow: '0 0 3px #000' }}>
              {preview.resolvedOrient ? ORIENT_ARROW[preview.resolvedOrient] : '?'}
            </span>
          </div>
        )}
      </div>

      {!position && (
        <div className={s.slotHint} style={{ marginTop: 2 }}>{t('roomTypeEditor.slotCard.previewSelectPosition')}</div>
      )}
      {position && preview?.unresolved && (
        <div className={s.slotHint} style={{ marginTop: 2, color: '#f4a261' }}>
          {t('roomTypeEditor.slotCard.previewUnresolved', { wall: simulatedWall })}
        </div>
      )}
      {position && preview && !preview.unresolved && preview.resolvedOrient && (
        <div className={s.slotHint} style={{ marginTop: 2, color: '#8c8' }}>
          {t(
            preview.resolvedOrient.length === 2
              ? 'roomTypeEditor.slotCard.previewResolvedCorner'
              : 'roomTypeEditor.slotCard.previewResolved',
            { orient: preview.resolvedOrient },
          )}
        </div>
      )}
      {rule.positions.length > 1 && (
        <div className={s.slotHint} style={{ marginTop: 2 }}>
          {t('roomTypeEditor.slotCard.previewMultiPosition', { count: rule.positions.length })}
        </div>
      )}
      {!anchorFootprint && (
        <div className={s.slotHint} style={{ marginTop: 2, color: '#888' }}>
          {t('roomTypeEditor.slotCard.previewAnchorFallback')}
        </div>
      )}
      {showRotationNote && (
        <div className={s.slotHint} style={{ marginTop: 2, color: '#888' }}>
          {t('roomTypeEditor.slotCard.previewRotationNote')}
        </div>
      )}
    </div>
  );
}
