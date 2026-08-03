import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createTileConfigSet, deleteTileConfigSet } from '../../api/tilesApi';
import { useActiveConfigSet } from '../../context/ActiveConfigSetContext';
import s from './ConfigSetSelector.module.css';

export function ConfigSetSelector() {
  const { t } = useTranslation();
  const { sets, selectedSetId, setSelectedSetId, reloadSets } = useActiveConfigSet();
  const [newSetName, setNewSetName] = useState('');
  const [newSetDesc, setNewSetDesc] = useState('');
  const [addingSet, setAddingSet] = useState(false);

  const handleCreateSet = async () => {
    if (!newSetName.trim()) return;
    const created = await createTileConfigSet(newSetName.trim(), newSetDesc.trim());
    setSelectedSetId(created.id);
    setNewSetName(''); setNewSetDesc(''); setAddingSet(false);
    reloadSets();
  };

  const handleDeleteSet = async () => {
    if (!window.confirm(t('tileBrowser.configSets.deleteConfirm', { name: sets.find(set => set.id === selectedSetId)?.name ?? selectedSetId }))) return;
    await deleteTileConfigSet(selectedSetId);
    setSelectedSetId('vanilla');
    reloadSets();
  };

  return (
    <div className={s.configSetBar}>
      <span>{t('tileBrowser.configSets.selectorLabel')}:</span>
      <select
        className={s.configSetSelect}
        value={selectedSetId}
        onChange={e => setSelectedSetId(e.target.value)}
      >
        {sets.map(set => (
          <option key={set.id} value={set.id}>{set.name}</option>
        ))}
      </select>
      {sets.find(set => set.id === selectedSetId)?.description && (
        <span className={s.configSetDesc}>{sets.find(set => set.id === selectedSetId)?.description}</span>
      )}
      {selectedSetId !== 'vanilla' && (
        <button className={s.configSetDeleteBtn} onClick={handleDeleteSet}>
          {t('tileBrowser.configSets.deleteSet')}
        </button>
      )}
      {addingSet ? (
        <>
          <input
            className={s.configSetInput}
            placeholder={t('tileBrowser.configSets.newSetName')}
            value={newSetName}
            onChange={e => setNewSetName(e.target.value)}
            autoFocus
          />
          <input
            className={s.configSetInput}
            placeholder={t('tileBrowser.configSets.newSetDescription')}
            value={newSetDesc}
            onChange={e => setNewSetDesc(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreateSet(); }}
          />
          <button
            className={s.configSetAddBtn}
            disabled={!newSetName.trim()}
            onClick={handleCreateSet}
          >
            {t('tileBrowser.configSets.confirmAdd')}
          </button>
          <button className={s.configSetDeleteBtn} onClick={() => { setAddingSet(false); setNewSetName(''); setNewSetDesc(''); }}>
            {t('tileBrowser.configSets.cancel')}
          </button>
        </>
      ) : (
        <button className={s.configSetAddBtn} onClick={() => setAddingSet(true)}>
          + {t('tileBrowser.configSets.addSet')}
        </button>
      )}
    </div>
  );
}
