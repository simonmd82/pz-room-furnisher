import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WallFurnitureCandidate, WallFurnitureClassification } from '../../types/building';
import { setWallFurnitureClassification } from '../../api/wallFurnitureApi';
import { getSheets, sheetImageUrl } from '../../api/tilesApi';
import { parseTileId } from '../../types/tiles';
import s from './WallFurniturePanel.module.css';

const SPRITE_W = 128;
const SPRITE_H = 256;
const PREVIEW_ZOOM = 0.35;

const CLASSIFICATIONS: WallFurnitureClassification[] = ['WindowHigh', 'WindowHighLow', 'Door', 'Ignore'];

interface Props {
  candidates: WallFurnitureCandidate[];
  /** Called after a classification is saved so the caller can re-resolve the current building. */
  onClassified: () => void;
}

export function WallFurniturePanel({ candidates, onClassified }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [sheetCols, setSheetCols] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    getSheets().then(r => {
      if (!r.configured) return;
      const map: Record<string, number> = {};
      r.sheets.forEach(sh => { map[sh.name] = sh.columns; });
      setSheetCols(map);
    }).catch(() => {});
  }, []);

  const spriteStyle = (tileId: string): React.CSSProperties | null => {
    const p = parseTileId(tileId);
    if (!p) return null;
    const cols = sheetCols[p.sheet] ?? 8;
    const col  = p.index % cols;
    const row  = Math.floor(p.index / cols);
    return {
      width:  Math.round(SPRITE_W * PREVIEW_ZOOM),
      height: Math.round(SPRITE_H * PREVIEW_ZOOM),
      backgroundImage:    `url(${sheetImageUrl(p.sheet)})`,
      backgroundRepeat:   'no-repeat',
      backgroundSize:     `${Math.round(SPRITE_W * cols * PREVIEW_ZOOM)}px auto`,
      backgroundPosition: `${-Math.round(col * SPRITE_W * PREVIEW_ZOOM)}px ${-Math.round(row * SPRITE_H * PREVIEW_ZOOM)}px`,
      imageRendering:     'pixelated',
    };
  };

  const handleChange = async (tileName: string, value: WallFurnitureClassification) => {
    setSaving(tileName);
    try {
      await setWallFurnitureClassification(tileName, value);
      onClassified();
    } finally {
      setSaving(null);
    }
  };

  const handleApplyAll = async (candidate: WallFurnitureCandidate, value: WallFurnitureClassification) => {
    const groupKey = `__group__${candidate.signature}`;
    setSaving(groupKey);
    try {
      await Promise.all(candidate.tiles.map(tile => setWallFurnitureClassification(tile.name, value)));
      onClassified();
    } finally {
      setSaving(null);
    }
  };

  if (candidates.length === 0) return null;

  const unclassifiedCount = candidates
    .flatMap(c => c.tiles)
    .filter(t => !t.classification).length;

  return (
    <div className={s.panel}>
      <button className={s.toggle} onClick={() => setOpen(v => !v)}>
        {open ? '▼' : '▶'} {t('wallFurniture.toggle', { count: candidates.length })}
        {unclassifiedCount > 0 && (
          <span className={s.badge}>{t('wallFurniture.unclassifiedBadge', { count: unclassifiedCount })}</span>
        )}
      </button>
      {open && (
        <div className={s.list}>
          <p className={s.hint}>{t('wallFurniture.hint')}</p>
          {candidates.map(c => (
            <div key={c.signature} className={s.row}>
              <div className={s.rowHeader}>
                <span className={s.count}>{t('wallFurniture.count', { count: c.count })}</span>
                {c.tiles.length > 1 && (
                  <div className={s.applyAll}>
                    <span className={s.applyAllLabel}>{t('wallFurniture.applyAll')}</span>
                    <select
                      className={s.select}
                      value=""
                      disabled={saving === `__group__${c.signature}`}
                      onChange={e => {
                        const value = e.target.value as WallFurnitureClassification;
                        if (value) handleApplyAll(c, value);
                        e.target.value = '';
                      }}
                    >
                      <option value="">{t('wallFurniture.applyAllPlaceholder')}</option>
                      {CLASSIFICATIONS.map(cl => (
                        <option key={cl} value={cl}>{t(`wallFurniture.classification.${cl}`)}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <div className={s.tileList}>
                {c.tiles.map(tile => {
                  const css = spriteStyle(tile.name);
                  return (
                    <div key={tile.name} className={s.tileRow}>
                      <div className={s.previewCell} title={tile.name}>
                        {css ? <div style={css} /> : <span className={s.previewMissing}>—</span>}
                      </div>
                      <span className={s.tileName} title={tile.name}>{tile.name}</span>
                      <select
                        className={s.select}
                        value={tile.classification ?? 'Ignore'}
                        disabled={saving === tile.name}
                        onChange={e => handleChange(tile.name, e.target.value as WallFurnitureClassification)}
                      >
                        {CLASSIFICATIONS.map(cl => (
                          <option key={cl} value={cl}>{t(`wallFurniture.classification.${cl}`)}</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
