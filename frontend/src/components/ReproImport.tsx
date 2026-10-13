import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { replayReproBundle } from '../api/furnishApi';
import type { ReproBundle } from '../api/furnishApi';
import type { FurnishResult } from '../types/building';
import { Spinner } from './Spinner/Spinner';
import styles from './FileUpload.module.css';

interface Props {
  onReplayed: (bundle: ReproBundle, result: FurnishResult, localVersion: string) => void;
}

/** Load a .pzrf-repro.json bundle and replay it against its own bundled config. */
export function ReproImport({ onReplayed }: Props) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-importing the same file
    if (!file) return;
    setError(null);
    setLoading(true);
    try {
      const bundle = JSON.parse(await file.text()) as ReproBundle;
      if (!bundle.request?.building || !bundle.expected) throw new Error(t('repro.invalidFile'));
      const { result, appVersion } = await replayReproBundle(bundle);
      onReplayed(bundle, result, appVersion);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <input ref={inputRef} type="file" accept=".json" className={styles.hidden} onChange={handleChange} />
      <button type="button" disabled={loading} onClick={() => inputRef.current?.click()} title={t('repro.importHint')}>
        {loading ? <><Spinner /> {t('repro.replaying')}</> : t('repro.importButton')}
      </button>
      {error && <p className={styles.error}>❌ {error}</p>}
    </div>
  );
}
