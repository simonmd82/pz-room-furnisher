import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getThemes, getThemedCategories } from '../../api/settingsApi';
import { isThemedCategory } from '../../types/tiles';
import s from './RoomTypeEditor.module.css';

interface ThemeSettings { themes: string[]; themedCategories: string[] }

// Shared across every slot/cell/pool card; fetched once until the Settings tab changes them.
let settingsPromise: Promise<ThemeSettings> | null = null;
function loadThemeSettings(): Promise<ThemeSettings> {
  settingsPromise ??= Promise.all([getThemes(), getThemedCategories()])
    .then(([themes, themedCategories]) => ({ themes, themedCategories }))
    .catch(e => { settingsPromise = null; console.error(e); return { themes: [], themedCategories: [] }; });
  return settingsPromise;
}

/** Drop the cached settings so the next mount re-fetches (settings may have changed meanwhile). */
export function invalidateThemeSettings() { settingsPromise = null; }

interface Props {
  /** The slot's category keys — the selector only shows when one of them is themed (settings). */
  categories: string[];
  value: string[] | undefined;
  onChange: (themes: string[]) => void;
}

/**
 * Theme filter chips for slots, grid cells and layout pools. Hidden unless the slot allows a
 * themed category (or still carries themes, so stale ones can be cleared).
 */
export function ThemeSelector({ categories, value, onChange }: Props) {
  const { t } = useTranslation();
  const [{ themes, themedCategories }, setSettings] = useState<ThemeSettings>({ themes: [], themedCategories: [] });
  useEffect(() => { loadThemeSettings().then(setSettings); }, []);

  const selected = value ?? [];
  if (!categories.some(c => isThemedCategory(c, themedCategories)) && selected.length === 0) return null;

  // Selected themes that were since deleted from settings stay visible so they can be removed.
  const shown = [...themes, ...selected.filter(th => !themes.includes(th))];
  const toggle = (th: string) =>
    onChange(selected.includes(th) ? selected.filter(x => x !== th) : [...selected, th]);

  return (
    <div style={{ marginTop: 4 }}>
      <span className={s.slotGroupLabel} title={t('common.allowedThemesHint')}>
        {t('common.allowedThemes')}{' '}
        <span style={{ cursor: 'help', color: '#6af', fontSize: '0.85rem' }}>ℹ</span>
      </span>
      <div className={s.chipGroup} style={{ marginTop: 2, gap: 4 }}>
        {shown.map(th => (
          <span key={th} className={`${s.chip} ${selected.includes(th) ? s.chipActive : ''}`}
            onClick={() => toggle(th)}>{th}</span>
        ))}
        {shown.length === 0 && <span className={s.slotHint}>{t('common.noThemesConfigured')}</span>}
      </div>
    </div>
  );
}
