import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAppVersion } from '../../api/furnishApi';
import { REPO_URL } from '../../utils/reportLinks';
import s from './AboutDialog.module.css';

interface Props {
  onClose: () => void;
}

/** Modal with version, author, license, links and credits. Closes on backdrop click, Esc or the Close button. */
export function AboutDialog({ onClose }: Props) {
  const { t } = useTranslation();
  const [version, setVersion] = useState('');

  useEffect(() => { getAppVersion().then(setVersion).catch(console.error); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const link = (href: string, label: string) => (
    <a className={s.link} href={href} target="_blank" rel="noopener noreferrer">{label}</a>
  );

  return (
    <div className={s.backdrop} onClick={onClose}>
      <div
        className={s.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        onClick={e => e.stopPropagation()}
      >
        <div className={s.titleRow}>
          <span id="about-title" className={s.title}>{t('app.title')}</span>
          <span className={s.version}>{t('about.version', { version: version || '…' })}</span>
        </div>

        <div className={s.rows}>
          <div><span className={s.label}>{t('about.createdBy')}</span>Simon_MD</div>
          <div><span className={s.label}>{t('about.license')}</span>{link(`${REPO_URL}/blob/main/LICENSE`, 'MIT')}</div>
          <div>
            <span className={s.label}>{t('about.links')}</span>
            {link(REPO_URL, t('about.repo'))}
            {' · '}
            {link(`${REPO_URL}/releases`, t('about.releases'))}
          </div>
        </div>

        <div className={s.block}>
          <div className={s.blockTitle}>{t('about.credits')}</div>
          <div>{t('about.tileSets')}</div>
        </div>

        <div className={s.notes}>
          <p>{t('about.aiNotice')}</p>
          <p>{t('about.disclaimer')}</p>
        </div>

        <div className={s.actions}>
          <button className={s.closeBtn} onClick={onClose} autoFocus>{t('about.close')}</button>
        </div>
      </div>
    </div>
  );
}
