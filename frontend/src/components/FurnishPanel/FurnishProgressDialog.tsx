import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Spinner } from '../Spinner/Spinner';
import s from './FurnishProgressDialog.module.css';

export interface FurnishProgress {
  total: number;
  /** Rooms finished so far (furnished + skipped). */
  done: number;
  furnished: number;
  skipped: number;
  tiles: number;
  /** Room currently being furnished; null before the first one starts. */
  current: { floorIndex: number; roomName: string; roomType: string | null } | null;
  /** Most recent generator log lines. */
  logTail: string[];
  stopping: boolean;
}

interface Props {
  progress: FurnishProgress;
  onStop: () => void;
}

/**
 * Modal shown while furnishing runs. The full-screen backdrop blocks every other
 * interaction with the app; the only way out is finishing or the Stop button.
 */
export function FurnishProgressDialog({ progress, onStop }: Props) {
  const { t } = useTranslation();
  const { total, done, furnished, skipped, tiles, current, logTail, stopping } = progress;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logTail]);

  const floorLabel = (i: number) => (i === 0 ? t('floor.ground') : t('floor.upper', { n: i }));

  return (
    <div className={s.backdrop} role="dialog" aria-modal="true" aria-labelledby="furnish-progress-title">
      <div className={s.card}>
        <div className={s.titleRow}>
          <Spinner />
          <span id="furnish-progress-title" className={s.title}>{t('furnishPanel.progress.title')}</span>
          <span className={s.counter}>{t('furnishPanel.progress.of', { done, total })}</span>
        </div>

        <div className={s.bar}><div className={s.barFill} style={{ width: `${pct}%` }} /></div>

        <div className={s.current}>
          {current ? (
            <>
              <div><span className={s.label}>{t('furnishPanel.progress.floor')}</span>{floorLabel(current.floorIndex)}</div>
              <div>
                <span className={s.label}>{t('furnishPanel.progress.room')}</span>
                {current.roomName}
                {current.roomType && <span className={s.roomType}> · {current.roomType}</span>}
              </div>
            </>
          ) : (
            <div className={s.label}>{t('furnishPanel.progress.starting')}</div>
          )}
        </div>

        <div className={s.stats}>
          <span>{t('furnishPanel.progress.furnished', { count: furnished })}</span>
          <span>{t('furnishPanel.progress.skipped', { count: skipped })}</span>
          <span>{t('furnishPanel.progress.tiles', { count: tiles })}</span>
        </div>

        <div ref={logRef} className={s.log}>
          {logTail.map((line, i) => <div key={i} className={s.logLine}>{line}</div>)}
        </div>

        <button className={s.stopBtn} onClick={onStop} disabled={stopping}>
          {stopping ? t('furnishPanel.progress.stopping') : `■ ${t('furnishPanel.progress.stop')}`}
        </button>
      </div>
    </div>
  );
}