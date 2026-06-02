import { useState, useEffect } from 'react';
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
    if (!window.confirm(`„${item}" entfernen?`)) return;
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
          + Hinzufügen
        </button>
      </div>

      <div className={s.itemList}>
        {items.length === 0 && (
          <span className={s.emptyHint}>Keine Einträge</span>
        )}
        {items.map(item => (
          <div key={item} className={s.item}>
            <span className={s.itemLabel}>{item}</span>
            <button className={s.removeBtn} onClick={() => remove(item)} disabled={saving}>✕</button>
          </div>
        ))}
      </div>

      <div className={s.sectionFooter}>{items.length} Einträge</div>
    </div>
  );
}

// ── Haupt-Komponente ─────────────────────────────────────────────────────────

export function SettingsEditor() {
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

  if (loading) return <div className={s.loading}>Lade Einstellungen…</div>;

  return (
    <div className={s.layout}>
      <div className={s.pageHeader}>
        <h2 className={s.pageTitle}>⚙ Einstellungen</h2>
        <p className={s.pageSubtitle}>
          Globale Listen, die in allen Tabs verwendet werden.
          Änderungen werden sofort in der <code>settings.json</code> gespeichert.
        </p>
      </div>

      <div className={s.columns}>
        <EditableList
          title="🏠 Raumtypen"
          description="Werden im Raumtyp-Editor, Tile-Browser und Möbel-Browser als Raumtyp-Chips angeboten."
          items={roomTypes}
          placeholder="z.B. GuestRoom"
          onSave={async updated => {
            const saved = await saveRoomTypeNames(updated);
            setRoomTypes(saved);
          }}
        />

        <EditableList
          title="📦 Möbel-Kategorien"
          description="Werden in den Slot-Konfigurationen als wählbare Kategorien für Möbel angeboten."
          items={categories}
          placeholder="z.B. Carpet"
          onSave={async updated => {
            const saved = await saveCategories(updated);
            setCategories(saved);
          }}
        />

        <EditableList
          title="🪵 Materialien"
          description="Werden im Tile-Browser als Material-Tags und im Slot-Editor als Materialfilter angeboten."
          items={materials}
          placeholder="z.B. Holz"
          onSave={async updated => {
            const saved = await saveMaterials(updated);
            setMaterials(saved);
          }}
        />
      </div>
    </div>
  );
}

