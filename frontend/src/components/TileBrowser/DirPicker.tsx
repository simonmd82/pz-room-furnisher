import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { browseDirectory } from '../../api/tilesApi';
import type { BrowseResult } from '../../api/tilesApi';
import s from './DirPicker.module.css';

interface Props {
  onSelect: (path: string) => void;
  onClose:  () => void;
}

export function DirPicker({ onSelect, onClose }: Props) {
  const { t } = useTranslation();
  const [result, setResult]     = useState<BrowseResult | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [manualPath, setManualPath] = useState('');

  const navigate = async (path?: string) => {
    setLoading(true);
    setError('');
    try {
      const r = await browseDirectory(path);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('dirPicker.connectionError'));
    } finally {
      setLoading(false);
    }
  };

  // Start at drive list on open
  useEffect(() => { navigate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelect = () => {
    if (result?.current) onSelect(result.current);
  };

  const handleManualSelect = () => {
    const p = manualPath.trim();
    if (p) onSelect(p);
  };

  return (
    <div className={s.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={s.dialog}>
        <div className={s.titleBar}>
          <span>{t('dirPicker.title')}</span>
          <button className={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={s.breadcrumb}>
          {result?.current ?? t('dirPicker.drives')}
        </div>

        <div className={s.list}>
          {loading && <p className={s.loading}>{t('dirPicker.loading')}</p>}
          {error   && <p className={s.errMsg}>{error}</p>}
          {!loading && !error && result && (
            <>
              {/* Back / Up */}
              {result.current !== null && (
                <div
                  className={`${s.entry} ${s.backEntry}`}
                  onClick={() => navigate(result.parent ?? undefined)}
                >
                  <span className={s.entryIcon}>↩</span>
                  <span>{result.parent ? t('dirPicker.back') : t('dirPicker.drives')}</span>
                </div>
              )}

              {result.entries.length === 0 && (
                <p className={s.empty}>{t('dirPicker.noSubfolders')}</p>
              )}

              {result.entries.map(e => (
                <div
                  key={e.fullPath}
                  className={s.entry}
                  onClick={() => navigate(e.fullPath)}
                >
                  <span className={s.entryIcon}>{e.isDrive ? '' : ''}</span>
                  <span>{e.name || e.fullPath}</span>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Manual path input */}
        <div className={s.manualRow}>
          <input
            className={s.manualInput}
            placeholder={t('dirPicker.manualPlaceholder')}
            value={manualPath}
            onChange={e => setManualPath(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleManualSelect()}
          />
          <button
            className={s.selectBtn}
            disabled={!manualPath.trim()}
            onClick={handleManualSelect}
            title={t('dirPicker.useDirectlyHint')}
          >
            {t('dirPicker.useDirectly')}
          </button>
        </div>

        <div className={s.footer}>
          <span className={s.currentPath}>{result?.current ?? '—'}</span>
          <button
            className={s.selectBtn}
            disabled={!result?.current}
            onClick={handleSelect}
          >
            {t('dirPicker.selectFolder')}
          </button>
        </div>
      </div>
    </div>
  );
}
