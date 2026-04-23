import { useState, useEffect } from 'react';
import { browseDirectory } from '../../api/tilesApi';
import type { BrowseResult } from '../../api/tilesApi';
import s from './DirPicker.module.css';

interface Props {
  onSelect: (path: string) => void;
  onClose:  () => void;
}

export function DirPicker({ onSelect, onClose }: Props) {
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
      setError(e instanceof Error ? e.message : 'Verbindung zum Server fehlgeschlagen – läuft das Backend?');
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
          <span> Ordner auswählen</span>
          <button className={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={s.breadcrumb}>
          {result?.current ?? 'Laufwerke'}
        </div>

        <div className={s.list}>
          {loading && <p className={s.loading}>Lade…</p>}
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
                  <span>{result.parent ? '.. (zurück)' : ' Laufwerke'}</span>
                </div>
              )}

              {result.entries.length === 0 && (
                <p className={s.empty}>Keine Unterordner vorhanden</p>
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
            placeholder="Pfad direkt eingeben, z.B. C:\Games\..."
            value={manualPath}
            onChange={e => setManualPath(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleManualSelect()}
          />
          <button
            className={s.selectBtn}
            disabled={!manualPath.trim()}
            onClick={handleManualSelect}
            title="Diesen Pfad direkt verwenden"
          >
            Direkt setzen
          </button>
        </div>

        <div className={s.footer}>
          <span className={s.currentPath}>{result?.current ?? '—'}</span>
          <button
            className={s.selectBtn}
            disabled={!result?.current}
            onClick={handleSelect}
          >
            Diesen Ordner wählen
          </button>
        </div>
      </div>
    </div>
  );
}