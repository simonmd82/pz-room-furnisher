import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import de from './locales/de.json';
import en from './locales/en.json';

const savedLang = localStorage.getItem('pz-lang') ?? 'de';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      de: { translation: de },
      en: { translation: en },
    },
    lng: savedLang,
    fallbackLng: 'de',
    interpolation: {
      escapeValue: false, // React already escapes
    },
  });

i18n.on('languageChanged', (lng) => localStorage.setItem('pz-lang', lng));

export default i18n;

