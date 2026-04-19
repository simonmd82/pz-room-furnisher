import { useTranslation } from 'react-i18next';
import type { Floor } from '../types/building';
import styles from './FloorSelector.module.css';

interface Props {
  floors: Floor[];
  selected: number;
  onSelect: (index: number) => void;
}

export function FloorSelector({ floors, selected, onSelect }: Props) {
  const { t } = useTranslation();
  if (floors.length <= 1) return null;

  return (
    <div className={styles.wrapper}>
      {floors.map((floor) => (
        <button
          key={floor.index}
          className={`${styles.btn} ${floor.index === selected ? styles.active : ''}`}
          onClick={() => onSelect(floor.index)}
        >
          {floor.index === 0 ? t('floor.ground') : t('floor.upper', { n: floor.index })}
        </button>
      ))}
    </div>
  );
}
