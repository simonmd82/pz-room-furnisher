import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { uploadTbx } from '../api/buildingApi';
import type { Building } from '../types/building';
import { Spinner } from './Spinner/Spinner';
import styles from './FileUpload.module.css';

interface Props {
  onBuildingLoaded: (building: Building, fileName: string, file: File) => void;
}

export function FileUpload({ onBuildingLoaded }: Props) {
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