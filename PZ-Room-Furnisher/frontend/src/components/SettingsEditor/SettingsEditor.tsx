import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getRoomTypeNames, saveRoomTypeNames,
  getCategories,    saveCategories,
  getMaterials,     saveMaterials,
} from '../../api/settingsApi';
import s from './SettingsEditor.module.css';

// ── Wiederverwendbare editierbare Liste ──────────────────────────────────────

function EditableList({
  title, description, items, placeholder, onSave,
}: {
  title:       string;
  description: string;
  items:       string[];
  placeholder: string;
  onSave:      (updated: string[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [newValue, setNewValue] = useState('');
  const [saving,   setSaving]   = useState(false);

  const add = async () => {
    const v = newValue.trim();
    if (!v || items.includes(v)) return;
    setSaving(true);
    await onSave([...items, v].sort((a, b) => a.localeCompare(b)));
    setNewValue('');
    setSaving(false);
  };

  const remove = async (item: string) => {
    if (!window.confirm(t('settingsEditor.confirmRemove', { item }))) return;
    setSaving(true);
    await onSave(items.filter(x => x !== item));
    setSaving(false);
  };

  return (
    <div className={s.section}>
      <div className={s.sectionHeader}>
        <span className={s.sectionTitle}>{title}</span>
        <span className={s.sectionDesc}>{description}</span>
      </div>

      <div className={s.addRow}>
        <input
          className={s.addInput}
          placeholder={placeholder}
          value={newValue}
          onChange={e => setNewValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
          disabled={saving}
        />
        <button className={s.addBtn} onClick={add} disabled={saving || !newValue.trim()}>
          {t('settingsEditor.add')}
        </button>
      </div>

      <div className={s.itemList}>
        {items.length === 0 && (
          <span className={s.emptyHint}>{t('settingsEditor.noItems')}</span>
        )}
        {items.map(item => (
          <div key={item} className={s.item}>
            <span className={s.itemLabel}>{item}</span>
            <button className={s.removeBtn} onClick={() => remove(item)} disabled={saving}>✕</button>
          </div>
        ))}
      </div>

      <div className={s.sectionFooter}>{t('settingsEditor.itemCount', { count: items.length })}</div>
    </div>
  );
}

// ── Haupt-Komponente ─────────────────────────────────────────────────────────

export function SettingsEditor() {
  const { t } = useTranslation();
  const [roomTypes,  setRoomTypes]  = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [materials,  setMaterials]  = useState<string[]>([]);
  const [loading,    setLoading]    = useState(true);

  useEffect(() => {
    Promise.all([getRoomTypeNames(), getCategories(), getMaterials()])
      .then(([rt, cats, mats]) => { setRoomTypes(rt); setCategories(cats); setMaterials(mats); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className={s.loading}>{t('settingsEditor.loading')}</div>;

  return (
    <div className={s.layout}>
      <div className={s.pageHeader}>
        <h2 className={s.pageTitle}>{t('settingsEditor.pageTitle')}</h2>
        <p className={s.pageSubtitle}>{t('settingsEditor.pageSubtitle')}</p>
      </div>

      <div className={s.columns}>
        <EditableList
          title={t('settingsEditor.roomTypes.title')}
          description={t('settingsEditor.roomTypes.description')}
          items={roomTypes}
          placeholder={t('settingsEditor.roomTypes.placeholder')}
          onSave={async updated => {
            const saved = await saveRoomTypeNames(updated);
            setRoomTypes(saved);
          }}
        />

        <EditableList
          title={t('settingsEditor.categories.title')}
          description={t('settingsEditor.categories.description')}
          items={categories}
          placeholder={t('settingsEditor.categories.placeholder')}
          onSave={async updated => {
            const saved = await saveCategories(updated);
            setCategories(saved);
          }}
        />

        <EditableList
          title={t('settingsEditor.materials.title')}
          description={t('settingsEditor.materials.description')}
          items={materials}
          placeholder={t('settingsEditor.materials.placeholder')}
          onSave={async updated => {
            const saved = await saveMaterials(updated);
            setMaterials(saved);
          }}
        />
      </div>
    </div>
  );
}
