import { AsyncLocalStorage } from 'async_hooks';
import { NextFunction, Request, Response } from 'express';
import i18next from 'i18next';
import enTranslation from './locales/en/translation.json';
import elTranslation from './locales/el/translation.json';
import heTranslation from './locales/he/translation.json';
import ruTranslation from './locales/ru/translation.json';
import ukTranslation from './locales/uk/translation.json';
import { User } from '../modules/user/user.model';

export type SupportedLanguage = 'en' | 'el' | 'he' | 'ru' | 'uk';

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  'en',
  'el',
  'he',
  'ru',
  'uk',
];

type TranslationBundle = {
  messages: Record<string, string>;
  patterns: Record<string, string>;
};

const resources: Record<SupportedLanguage, { translation: TranslationBundle }> = {
  en: { translation: enTranslation as TranslationBundle },
  el: { translation: elTranslation as TranslationBundle },
  he: { translation: heTranslation as TranslationBundle },
  ru: { translation: ruTranslation as TranslationBundle },
  uk: { translation: ukTranslation as TranslationBundle },
};

// Build case-insensitive lookup maps per language for fast fallback matching
const lowerCaseMessageMap: Record<SupportedLanguage, Map<string, string>> = {
  en: new Map(),
  el: new Map(),
  he: new Map(),
  ru: new Map(),
  uk: new Map(),
};

for (const lang of SUPPORTED_LANGUAGES) {
  const bundle = resources[lang].translation.messages || {};
  for (const [k, v] of Object.entries(bundle)) {
    lowerCaseMessageMap[lang].set(k.trim().toLowerCase(), v);
  }
}

if (!i18next.isInitialized) {
  i18next.init({
    lng: 'en',
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES,
    initAsync: false,
    keySeparator: false,
    nsSeparator: false,
    interpolation: {
      escapeValue: false,
    },
    resources,
  });
}

const languageStorage = new AsyncLocalStorage<{
  lang: SupportedLanguage;
  explicitHeader: boolean;
}>();

/**
  * Clean corrupted/unwanted symbols (SPLIT-067):
  * Fixes mojibake sequences like `€`, `◆€`, `Â€`, `â‚¬`, `ï¿½`, and replacement chars.
  */
export function sanitizeText(input?: string | null): string {
  if (input === undefined || input === null) return '';
  let text = String(input);

  // Replace corrupted Euro prefixes before € or numbers
  text = text
    .replace(/(?:\uFFFD+|◆+|ï¿½+|Â+|â‚¬)+(?=\s*€)/g, '')
    .replace(/(?:\uFFFD\\u20AC|ï¿½\\u20AC|â‚¬|Â€|◆€|\uFFFD€)/g, '€')
    .replace(/\\u20AC/g, '€')
    .replace(/(?:\uFFFD|ï¿½)+(?=\s*\d)/g, '€')
    .replace(/\s+(?:\uFFFD|ï¿½)+\s+/g, ' - ')
    .replace(/(?:\uFFFD|ï¿½)+/g, '')
    .replace(/â€”|â€“/g, '-');

  return text.trim();
}

/**
  * Normalize any header/query/DB language string to one of: 'en' | 'el' | 'he' | 'ru' | 'uk'
  */
export function normalizeLanguage(
  raw?: string | string[] | null,
): SupportedLanguage {
  if (!raw) return 'en';
  const str = Array.isArray(raw) ? raw[0] : String(raw);
  if (!str) return 'en';

  // Parse Accept-Language style lists e.g. "el-GR,el;q=0.9,en;q=0.8"
  const candidates = str
    .split(',')
    .map((part) => part.split(';')[0].trim().toLowerCase())
    .filter(Boolean);

  for (const token of candidates) {
    if (
      token === 'en' ||
      token.startsWith('en-') ||
      token.startsWith('en_') ||
      token === 'english'
    ) {
      return 'en';
    }
    if (
      token === 'el' ||
      token.startsWith('el-') ||
      token.startsWith('el_') ||
      token === 'gr' ||
      token === 'greek' ||
      token === 'ελληνικά'
    ) {
      return 'el';
    }
    if (
      token === 'he' ||
      token.startsWith('he-') ||
      token.startsWith('he_') ||
      token === 'iw' ||
      token === 'il' ||
      token === 'hebrew' ||
      token === 'עברית'
    ) {
      return 'he';
    }
    if (
      token === 'ru' ||
      token.startsWith('ru-') ||
      token.startsWith('ru_') ||
      token === 'russian' ||
      token === 'русский'
    ) {
      return 'ru';
    }
    if (
      token === 'uk' ||
      token.startsWith('uk-') ||
      token.startsWith('uk_') ||
      token === 'ua' ||
      token === 'ukrainian' ||
      token === 'українська'
    ) {
      return 'uk';
    }
  }

  return 'en';
}

export function extractLanguageFromHeaders(
  headers?: Record<string, any> | null,
  query?: Record<string, any> | null,
): {
  lang: SupportedLanguage;
  explicitHeader: boolean;
} {
  const headerVal =
    headers?.['language'] ||
    headers?.['x-language'] ||
    headers?.['x-lang'] ||
    headers?.['lang'] ||
    query?.['lang'] ||
    query?.['language'] ||
    headers?.['accept-language'];

  if (headerVal) {
    return {
      lang: normalizeLanguage(headerVal as string),
      explicitHeader: true,
    };
  }

  return { lang: 'en', explicitHeader: false };
}

export function extractLanguageFromRequest(req: Request): {
  lang: SupportedLanguage;
  explicitHeader: boolean;
} {
  return extractLanguageFromHeaders(req.headers, req.query as Record<string, any>);
}

export function getCurrentLanguage(): SupportedLanguage {
  return languageStorage.getStore()?.lang || 'en';
}

export function hasExplicitRequestLanguage(): boolean {
  return Boolean(languageStorage.getStore()?.explicitHeader);
}

export function setCurrentContextLanguage(lang: SupportedLanguage): void {
  const store = languageStorage.getStore();
  if (store) {
    store.lang = lang;
  }
}

export function runWithLanguage<T>(
  lang: string | SupportedLanguage | undefined | null,
  fn: () => T,
  explicitHeader = false,
): T {
  const resolved = normalizeLanguage(lang);
  return languageStorage.run({ lang: resolved, explicitHeader }, fn);
}

type PatternRule = {
  regex: RegExp;
  patternKey: string;
  extract: (match: RegExpExecArray) => Record<string, string>;
};

const PATTERN_RULES: PatternRule[] = [
  {
    regex: /^Total fare:\s*€?([0-9.]+)\s*\(Base:\s*€?([0-9.]+)\s*\+\s*Waiting:\s*€?([0-9.]+)\)$/i,
    patternKey: 'dropoff_fare',
    extract: (m) => ({
      totalFare: m[1],
      baseFare: m[2],
      waitingCharge: m[3],
    }),
  },
  {
    regex: /^Total fare:\s*€?([0-9.]+)\.\s*Thank you for riding with us!$/i,
    patternKey: 'trip_completed_fare',
    extract: (m) => ({ totalFare: m[1] }),
  },
  {
    regex: /^Your ride start OTP is\s*(\d+)\.\s*Share this code with your driver to start the trip\.$/i,
    patternKey: 'ride_start_otp',
    extract: (m) => ({ otp: m[1] }),
  },
  {
    regex: /^Your verification code to start the ride is\s*(\d+)\.\s*Share this OTP with your driver when boarding\.$/i,
    patternKey: 'ride_start_verification_code',
    extract: (m) => ({ otp: m[1] }),
  },
  {
    regex: /^We're still trying to find a driver for your ride\.\s*(\d+)\s*driver\(s\)\s*have been notified\.$/i,
    patternKey: 'still_searching_drivers',
    extract: (m) => ({ count: m[1] }),
  },
  {
    regex: /^We're still looking for a driver\.\s*(\d+)\s*driver\(s\)\s*notified\.$/i,
    patternKey: 'still_looking_drivers',
    extract: (m) => ({ count: m[1] }),
  },
  {
    regex: /^OTP verified for\s*(.+)$/i,
    patternKey: 'otp_verified_for',
    extract: (m) => ({ type: m[1] }),
  },
  {
    regex: /^Cannot drop off\s*[-—]\s*status:\s*(.+)$/i,
    patternKey: 'cannot_dropoff_status',
    extract: (m) => ({ status: m[1] }),
  },
  {
    regex: /^Cannot complete\s*[-—]\s*status:\s*(.+)$/i,
    patternKey: 'cannot_complete_status',
    extract: (m) => ({ status: m[1] }),
  },
  {
    regex: /^Cannot trigger arrived\s*[-—]\s*status:\s*(.+)$/i,
    patternKey: 'cannot_trigger_arrived_status',
    extract: (m) => ({ status: m[1] }),
  },
  {
    regex: /^Ride cannot be started\.\s*Current status:\s*(.+)$/i,
    patternKey: 'ride_cannot_start_status',
    extract: (m) => ({ status: m[1] }),
  },
  {
    regex: /^The requested\s+(.+?)\s+endpoint not found!$/i,
    patternKey: 'endpoint_not_found',
    extract: (m) => ({ url: m[1] }),
  },
  {
    regex: /^Your KYC verification has been rejected\.\s*Reason:\s*(.+)$/i,
    patternKey: 'kyc_rejected_reason',
    extract: (m) => ({ reason: m[1] }),
  },
  {
    regex: /^💬\s*(.+?)\s*\((\d+)\s*unread messages?\)$/i,
    patternKey: 'chat_unread_title',
    extract: (m) => ({ senderName: m[1], count: m[2] }),
  },
  {
    regex: /^Entire split ride cancelled\.\s*(\d+)\s*passenger\(s\)\s*affected\.$/i,
    patternKey: 'entire_split_cancelled',
    extract: (m) => ({ count: m[1] }),
  },
  {
    regex: /^Entire ride cancelled\.\s*(\d+)\s*passenger\(s\)\s*notified and refunded\.$/i,
    patternKey: 'entire_ride_cancelled_refunded',
    extract: (m) => ({ count: m[1] }),
  },
  {
    regex: /^A passenger cancelled\.\s*(\d+)\s*passenger\(s\)\s*remaining\.$/i,
    patternKey: 'passenger_cancelled_remaining',
    extract: (m) => ({ count: m[1] }),
  },
  {
    regex: /^(\d+)\s*passenger\(s\)\s*remaining\.$/i,
    patternKey: 'remaining_passengers',
    extract: (m) => ({ count: m[1] }),
  },
  {
    regex: /^€?([0-9.]+)\s*refunded to your wallet\.$/i,
    patternKey: 'wallet_refunded',
    extract: (m) => ({ amount: m[1] }),
  },
  {
    regex: /^Your payment of\s*€?([0-9.]+)\s*has been successfully processed$/i,
    patternKey: 'payment_processed',
    extract: (m) => ({ amount: m[1] }),
  },
  {
    regex: /^A refund of\s*€?([0-9.]+)\s*has been issued to your account$/i,
    patternKey: 'refund_issued',
    extract: (m) => ({ amount: m[1] }),
  },
  {
    regex: /^Your withdrawal request of\s*€?([0-9.]+)\s*has been cancelled\.$/i,
    patternKey: 'withdrawal_cancelled',
    extract: (m) => ({ amount: m[1] }),
  },
  {
    regex: /^Your withdrawal of\s*€?([0-9.]+)\s*has been successfully completed!\s*Check your bank account\.$/i,
    patternKey: 'withdrawal_completed',
    extract: (m) => ({ amount: m[1] }),
  },
  {
    regex: /^Your fare increased by\s*€?([0-9.]+)\.$/i,
    patternKey: 'fare_increased',
    extract: (m) => ({ amount: m[1] }),
  },
  {
    regex: /^You saved\s*€?([0-9.]+)!$/i,
    patternKey: 'fare_saved',
    extract: (m) => ({ amount: m[1] }),
  },
  {
    regex: /^Your driver is on the way\.\s*ETA:\s*(\d+)\s*minutes\.$/i,
    patternKey: 'driver_eta_on_way',
    extract: (m) => ({ eta: m[1] }),
  },
  {
    regex: /^Your booking is confirmed\.\s*ETA:\s*(\d+)\s*minutes\.$/i,
    patternKey: 'booking_confirmed_eta',
    extract: (m) => ({ eta: m[1] }),
  },
  {
    regex: /^(\d+)\s*matching split ride\(s\)\s*found$/i,
    patternKey: 'matching_split_rides_found',
    extract: (m) => ({ count: m[1] }),
  },
  {
    regex: /^(\d+)\s*passenger\(s\)\s*found$/i,
    patternKey: 'passengers_found',
    extract: (m) => ({ count: m[1] }),
  },
  {
    regex: /^Insufficient balance\.\s*Your current balance is\s*€?([0-9.]+),\s*but you requested\s*€?([0-9.]+)\.$/i,
    patternKey: 'insufficient_balance_withdraw',
    extract: (m) => ({ balance: m[1], requested: m[2] }),
  },
  {
    regex: /^Insufficient wallet balance\.\s*Required:\s*([0-9.]+),\s*Available:\s*([0-9.]+)$/i,
    patternKey: 'insufficient_wallet_balance',
    extract: (m) => ({ required: m[1], available: m[2] }),
  },
  {
    regex: /^Not enough seats\.\s*(\d+)\s*available,\s*(\d+)\s*requested\.$/i,
    patternKey: 'not_enough_seats',
    extract: (m) => ({ available: m[1], requested: m[2] }),
  },
  {
    regex: /^Split ride allows a maximum of\s*(\d+)\s*matched riders\.$/i,
    patternKey: 'split_max_matched_riders',
    extract: (m) => ({ max: m[1] }),
  },
  {
    regex: /^Split ride requires a minimum route distance of\s*([0-9.]+)\s*km\.$/i,
    patternKey: 'split_min_distance',
    extract: (m) => ({ min: m[1] }),
  },
  {
    regex: /^([a-zA-Z0-9_]+)\s+already exists$/i,
    patternKey: 'already_exists',
    extract: (m) => ({ field: m[1] }),
  },
  {
    regex: /^You are not at the pickup location yet\.\s*You are\s*(\d+)m away\.\s*Please be within\s*(\d+)m to mark arrival\.$/i,
    patternKey: 'not_at_pickup_distance',
    extract: (m) => ({ distance: m[1], threshold: m[2] }),
  },
  {
    regex: /^You are not at passenger's pickup\.\s*You are\s*(\d+)m away\.\s*Please be within\s*(\d+)m\.$/i,
    patternKey: 'not_at_passenger_pickup_distance',
    extract: (m) => ({ distance: m[1], threshold: m[2] }),
  },
  {
    regex: /^This account is registered with\s*(.+?),\s*please use that method\.$/i,
    patternKey: 'account_registered_with',
    extract: (m) => ({ method: m[1] }),
  },
  {
    regex: /^The status of your refund request for order has been updated to\s*"(.+)"\.$/i,
    patternKey: 'refund_status_updated',
    extract: (m) => ({ status: m[1] }),
  },
  {
    regex: /^A refund request has been initiated by\s*(.+?)\s*for order\.$/i,
    patternKey: 'refund_initiated_by',
    extract: (m) => ({ name: m[1] }),
  },
];

function interpolateTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] !== undefined ? vars[key] : `{{${key}}}`,
  );
}

function translateSingleMessage(
  cleanText: string,
  lang: SupportedLanguage,
): string {
  if (!cleanText) return cleanText;

  const bundle = resources[lang]?.translation;
  if (!bundle) return cleanText;

  // 1. Direct match in messages
  if (bundle.messages[cleanText]) {
    return sanitizeText(bundle.messages[cleanText]);
  }

  // 2. Case-insensitive match in messages
  const lowerHit = lowerCaseMessageMap[lang]?.get(cleanText.toLowerCase());
  if (lowerHit) {
    return sanitizeText(lowerHit);
  }

  // 2b. Leading emoji prefix match (e.g., "🔴 You have been dropped off" -> "🔴 " + translate("You have been dropped off"))
  const emojiMatch = /^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]+\s+)(.+)$/u.exec(
    cleanText,
  );
  if (emojiMatch) {
    const [, emojiPrefix, remainder] = emojiMatch;
    const translatedRemainder = translateSingleMessage(remainder.trim(), lang);
    if (translatedRemainder !== remainder.trim()) {
      return sanitizeText(`${emojiPrefix}${translatedRemainder}`);
    }
  }

  // 3. Dynamic pattern rules
  for (const rule of PATTERN_RULES) {
    const match = rule.regex.exec(cleanText);
    if (match) {
      const patternTemplate =
        bundle.patterns[rule.patternKey] ||
        resources.en.translation.patterns[rule.patternKey];
      if (patternTemplate) {
        return sanitizeText(
          interpolateTemplate(patternTemplate, rule.extract(match)),
        );
      }
    }
  }

  return cleanText;
}

/**
  * Translates & sanitizes any static or dynamic message into the requested language
  * (defaults to the active request/socket language or 'en').
  */
export function translateText(
  text?: string | null,
  lang?: string | SupportedLanguage | null,
): string {
  if (text === undefined || text === null) return '';
  const clean = sanitizeText(text);
  if (!clean) return '';

  const resolvedLang = lang ? normalizeLanguage(lang) : getCurrentLanguage();

  // First try translating the whole string
  const directTranslated = translateSingleMessage(clean, resolvedLang);
  if (directTranslated !== clean) {
    return directTranslated;
  }

  // If it's a comma-separated list of validation errors (from globalErrorHandler),
  // translate each part individually if not matched as a whole sentence
  if (clean.includes(', ')) {
    const parts = clean.split(', ');
    if (parts.length > 1) {
      const translatedParts = parts.map((p) =>
        translateSingleMessage(p.trim(), resolvedLang),
      );
      return translatedParts.join(', ');
    }
  }

  return directTranslated;
}

/**
  * Resolves a user's preferred language from MongoDB (with fallback to current request language or 'en').
  */
export async function resolveUserLanguage(
  userId?: string | null,
  fallbackLang?: string | null,
): Promise<SupportedLanguage> {
  if (userId) {
    try {
      const user = await User.findById(userId).select('language').lean();
      if (user?.language) {
        return normalizeLanguage(user.language);
      }
    } catch {
      /* ignore DB lookup error and use fallback */
    }
  }
  if (fallbackLang) {
    return normalizeLanguage(fallbackLang);
  }
  return getCurrentLanguage();
}

/**
  * Express middleware to detect language from request headers/query,
  * attach it to AsyncLocalStorage and response headers.
  */
export const i18nMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const { lang, explicitHeader } = extractLanguageFromRequest(req);
  (req as any).language = lang;
  res.locals.language = lang;
  res.setHeader('Content-Language', lang);

  runWithLanguage(lang, () => next(), explicitHeader);
};

export default i18next;
