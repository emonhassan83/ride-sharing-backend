import i18next from 'i18next';
import path from 'path';
import Backend from 'i18next-fs-backend';

// Initialize i18next
i18next
  .use(Backend) // Load translations from file system
  // .use(LanguageDetector) // Detect language
  .init({
    backend: {
      loadPath: path.join(__dirname, '/locales/{{lng}}/translation.json'), 
    },
    detection: {
      order: ['querystring', 'cookie', 'header', 'session'], 
      caches: ['cookie'],
    },
    fallbackLng: 'en', 
    preload: ['en', 'bn'], 
  });

export default i18next;
