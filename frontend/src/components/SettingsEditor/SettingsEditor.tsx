import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getRoomTypeNames, saveRoomTypeNames,
  getCategories,    saveCategories,
  getMaterials,     saveMaterials,
  getColorNames,    saveColorNames,
} from '../../api/settingsApi';
import {
  getRoomTypesStatus, restoreRoomTypesDefault,
  saveRoomTypesSnapshot, restoreRoomTypesSnapshot,
  type RoomTypesStatus,
} from '../../api/roomTypesApi';
import { getTilesPath, setTilesPath } from '../../api/tilesApi';
import { getBfPath, setBfPath } from '../../api/bfApi';
import { DirPicker } from '../TileBrowser/DirPicker';
import { Spinner } from '../Spinner/Spinner';
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
          {saving ? <Spinner /> : t('settingsEditor.add')}
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

// ── File Paths Section (machine-local, not shipped) ──────────────────────────

function FilePathRow({
  label, path, ok, err, placeholder, onPathChange, onSet, onBrowse,
}: {
  label:        string;
  path:         string;
  ok:           boolean;
  err:          string;
  placeholder:  string;
  onPathChange: (v: string) => void;
  onSet:        () => void;
  onBrowse:     () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={s.configRow}>
      <span className={s.configRowLabel}>{label}</span>
      <div className={s.pathRowActions}>
        <input
          className={s.pathInput}
          value={path}
          onChange={e => onPathChange(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onSet()}
          placeholder={placeholder}
        />
        <button className={s.configBtn} onClick={onBrowse}>{t('settingsEditor.filePaths.browse')}</button>
        <button className={s.configBtn} onClick={onSet}>{t('settingsEditor.filePaths.setPath')}</button>
        {ok
          ? <span className={s.configFeedbackOk}>✓ {t('settingsEditor.filePaths.pathOk')}</span>
          : <span className={s.configFeedbackErr}>✗ {err || t('settingsEditor.filePaths.pathNotFound')}</span>}
      </div>
    </div>
  );
}

function FilePathsSection() {
  const { t } = useTranslation();

  const [tilesPath, setTilesPathInput] = useState('');
  const [tilesOk,   setTilesOk]        = useState(false);
  const [tilesErr,  setTilesErr]       = useState('');
  const [tilesPicking, setTilesPicking] = useState(false);

  const [bfPath, setBfPathInput] = useState('');
  const [bfOk,   setBfOk]        = useState(false);
  const [bfErr,  setBfErr]       = useState('');
  const [bfPicking, setBfPicking] = useState(false);

  useEffect(() => {
    getTilesPath().then(r => { setTilesPathInput(r.path); setTilesOk(r.isValid); }).catch(() => {});
    getBfPath().then(r => { setBfPathInput(r.path); setBfOk(r.isValid); }).catch(() => {});
  }, []);

  const applyTilesPath = async (p: string) => {
    setTilesErr('');
    try {
      const r = await setTilesPath(p);
      setTilesPathInput(r.path);
      setTilesOk(r.isValid);
    } catch (e) {
      setTilesOk(false);
      setTilesErr(e instanceof Error ? e.message : t('settingsEditor.filePaths.setPathError'));
    }
  };

  const applyBfPath = async (p: string) => {
    setBfErr('');
    try {
      const r = await setBfPath(p);
      setBfPathInput(r.path);
      setBfOk(r.isValid);
    } catch (e) {
      setBfOk(false);
      setBfErr(e instanceof Error ? e.message : t('settingsEditor.filePaths.setPathError'));
    }
  };

  return (
    <div className={`${s.section} ${s.fullWidth}`}>
      <div className={s.sectionHeader}>
        <span className={s.sectionTitle}>{t('settingsEditor.filePaths.title')}</span>
        <span className={s.sectionDesc}>{t('settingsEditor.filePaths.description')}</span>
      </div>
      <div className={s.configTable}>
        <FilePathRow
          label={t('settingsEditor.filePaths.tilesFolder')}
          path={tilesPath} ok={tilesOk} err={tilesErr}
          placeholder={t('settingsEditor.filePaths.tilesFolderPlaceholder')}
          onPathChange={setTilesPathInput}
          onSet={() => applyTilesPath(tilesPath)}
          onBrowse={() => setTilesPicking(true)}
        />
        <FilePathRow
          label={t('settingsEditor.filePaths.bfFile')}
          path={bfPath} ok={bfOk} err={bfErr}
          placeholder={t('settingsEditor.filePaths.bfFilePlaceholder')}
          onPathChange={setBfPathInput}
          onSet={() => applyBfPath(bfPath)}
          onBrowse={() => setBfPicking(true)}
        />
      </div>

      {tilesPicking && (
        <DirPicker
          onSelect={p => { setTilesPicking(false); applyTilesPath(p); }}
          onClose={() => setTilesPicking(false)}
        />
      )}
      {bfPicking && (
        <DirPicker
          onSelect={p => { setBfPicking(false); applyBfPath(p); }}
          onClose={() => setBfPicking(false)}
        />
      )}
    </div>
  );
}

// ── Config Management Section ────────────────────────────────────────────────

function ConfigManagementSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RoomTypesStatus | null>(null);
  const [busy,   setBusy]   = useState<string | null>(null);
  const [msg,    setMsg]    = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    getRoomTypesStatus().then(setStatus).catch(console.error);
  }, []);

  const flash = (text: string, ok: boolean) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 3000);
  };

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try {
      await action();
      const updated = await getRoomTypesStatus();
      setStatus(updated);
      flash(t('settingsEditor.configManagement.ok'), true);
    } catch (e) {
      flash(t('settingsEditor.configManagement.error', { msg: String(e) }), false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={`${s.section} ${s.fullWidth}`}>
      <div className={s.sectionHeader}>
        <span className={s.sectionTitle}>{t('settingsEditor.configManagement.title')}</span>
        <span className={s.sectionDesc}>{t('settingsEditor.configManagement.description')}</span>
      </div>
      <div className={s.configTable}>
        <div className={s.configRow}>
          <span className={s.configRowLabel}>{t('settingsEditor.configManagement.roomTypes')}</span>
          <div className={s.configRowActions}>
            <button
              className={s.configBtn}
              disabled={!!busy || !status?.hasDefault}
              title={status?.hasDefault ? undefined : t('settingsEditor.configManagement.noDefault')}
              onClick={() => {
                if (!window.confirm(t('settingsEditor.configManagement.confirmRestoreDefault', { file: 'room-types.json' }))) return;
                run('restore-default', restoreRoomTypesDefault);
              }}
            >
              {busy === 'restore-default' ? <Spinner /> : t('settingsEditor.configManagement.restoreDefault')}
            </button>
            <button
              className={s.configBtn}
              disabled={!!busy}
              onClick={() => run('save-snapshot', saveRoomTypesSnapshot)}
            >
              {busy === 'save-snapshot' ? <Spinner /> : t('settingsEditor.configManagement.saveSnapshot')}
            </button>
            <button
              className={s.configBtn}
              disabled={!!busy || !status?.hasSnapshot}
              title={status?.hasSnapshot ? undefined : t('settingsEditor.configManagement.noSnapshot')}
              onClick={() => {
                if (!window.confirm(t('settingsEditor.configManagement.confirmRestoreSnapshot', { file: 'room-types.json' }))) return;
                run('restore-snapshot', restoreRoomTypesSnapshot);
              }}
            >
              {busy === 'restore-snapshot' ? <Spinner /> : t('settingsEditor.configManagement.restoreSnapshot')}
            </button>
            {msg && (
              <span className={msg.ok ? s.configFeedbackOk : s.configFeedbackErr}>
                {msg.text}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Haupt-Komponente ─────────────────────────────────────────────────────────

interface SettingsEditorProps {
  showGeneratorLog: boolean;
  onShowGeneratorLogChange: (v: boolean) => void;
  furnishingConfigEnabled: boolean;
  onFurnishingConfigEnabledChange: (v: boolean) => void;
}

export function SettingsEditor({ showGeneratorLog, onShowGeneratorLogChange, furnishingConfigEnabled, onFurnishingConfigEnabledChange }: SettingsEditorProps) {
  const { t } = useTranslation();
  const [roomTypes,  setRoomTypes]  = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [materials,  setMaterials]  = useState<string[]>([]);
  const [colors,     setColors]     = useState<string[]>([]);
  const [loading,    setLoading]    = useState(true);

  useEffect(() => {
    Promise.all([getRoomTypeNames(), getCategories(), getMaterials(), getColorNames()])
      .then(([rt, cats, mats, cols]) => { setRoomTypes(rt); setCategories(cats); setMaterials(mats); setColors(cols); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className={s.loading}><Spinner size={18} /> {t('settingsEditor.loading')}</div>;

  return (
    <div className={s.layout}>
      <div className={s.pageHeader}>
        <h2 className={s.pageTitle}>{t('settingsEditor.pageTitle')}</h2>
        <p className={s.pageSubtitle}>{t('settingsEditor.pageSubtitle')}</p>
      </div>

      <div className={s.columns}>
        <FilePathsSection />

        {furnishingConfigEnabled && (
          <>
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

            <EditableList
              title={t('settingsEditor.colors.title')}
              description={t('settingsEditor.colors.description')}
              items={colors}
              placeholder={t('settingsEditor.colors.placeholder')}
              onSave={async updated => {
                const saved = await saveColorNames(updated);
                setColors(saved);
              }}
            />
          </>
        )}

        <div className={s.section}>
          <div className={s.sectionHeader}>
            <span className={s.sectionTitle}>{t('settingsEditor.uiPreferences.title')}</span>
            <span className={s.sectionDesc}>{t('settingsEditor.uiPreferences.description')}</span>
          </div>
          <div className={s.prefsList}>
            <label className={s.prefRow}>
              <input
                type="checkbox"
                checked={showGeneratorLog}
                onChange={e => onShowGeneratorLogChange(e.target.checked)}
              />
              <span className={s.prefLabel}>{t('settingsEditor.uiPreferences.showGeneratorLog.label')}</span>
              <span className={s.prefDesc}>{t('settingsEditor.uiPreferences.showGeneratorLog.description')}</span>
            </label>
            <label className={s.prefRow}>
              <input
                type="checkbox"
                checked={furnishingConfigEnabled}
                onChange={e => {
                  if (e.target.checked) {
                    if (window.confirm(t('settingsEditor.uiPreferences.furnishingConfig.confirmEnable'))) {
                      onFurnishingConfigEnabledChange(true);
                    }
                  } else {
                    onFurnishingConfigEnabledChange(false);
                  }
                }}
              />
              <span className={s.prefLabel}>{t('settingsEditor.uiPreferences.furnishingConfig.label')}</span>
              <span className={s.prefDesc}>{t('settingsEditor.uiPreferences.furnishingConfig.description')}</span>
            </label>
          </div>
        </div>

        <ConfigManagementSection />
      </div>
    </div>
  );
}
