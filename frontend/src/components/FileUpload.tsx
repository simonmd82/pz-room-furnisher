import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { uploadTbx } from '../api/buildingApi';
import type { Building } from '../types/building';
import { Spinner } from './Spinner/Spinner';
import styles from './FileUpload.module.css';

interface Props {
  onBuildingLoaded: (building: Building, fileName: string, file: File) => void;
  /** Slim one-line bar instead of the big drop zone (used once a building is loaded). */
  compact?: boolean;
  /** Name of the currently loaded building, e.g. after a repro replay that bypassed this upload. */
  currentName?: string | null;
}

export function FileUpload({ onBuildingLoaded, compact = false, currentName = null }: Props) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setError(null);
    setLoading(true);
    setFileName(file.name);
    try {
      const building = await uploadTbx(file);
      onBuildingLoaded(building, file.name, file);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  if (compact) {
    const name = fileName ?? currentName;
    return (
      <div
        className={`${styles.dropZone} ${styles.compact}`}
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => inputRef.current?.click()}
        title={t('upload.hint')}
      >
        <input ref={inputRef} type="file" accept=".tbx" className={styles.hidden} onChange={handleChange} />
        {loading ? (
          <span className={styles.compactText}><Spinner /> {t('upload.processing')}</span>
        ) : (
          <span className={styles.compactText}>
            📄 {name && <strong className={styles.compactName}>{name}</strong>}
            <span className={styles.compactAction}>{name ? '· ' : ''}{t('upload.loadOther')}</span>
          </span>
        )}
        {error && <span className={styles.error}>❌ {error}</span>}
      </div>
    );
  }

  return (
    <div
      className={styles.dropZone}
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      onClick={() => inputRef.current?.click()}
    >
      <input ref={inputRef} type="file" accept=".tbx" className={styles.hidden} onChange={handleChange} />
      {loading ? (
        <p className={styles.hint} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <Spinner /> {t('upload.processing')}
        </p>
      ) : (
        <>
          <p className={styles.icon}></p>
          <p className={styles.hint}>
            {fileName ? t('upload.loaded', { name: fileName }) : t('upload.hint')}
          </p>
        </>
      )}
      {error && <p className={styles.error}>❌ {error}</p>}
    </div>
  );
}