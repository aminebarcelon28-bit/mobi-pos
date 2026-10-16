import React, { useSyncExternalStore } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { ar, AR_NEEDS_NATIVE_REVIEW, AR_SECTION_REVIEW_STATUS } from './ar';
import { fr } from './fr';
import { pseudo } from './pseudo';
import { LOCALE_METADATA } from './types';
import type {
  AnyTranslationKey,
  InterpolationParams,
  LocaleMetadata,
  SupportedLocale,
  TextDirection,
  TranslationDictionary,
  TranslationKey,
  TranslationSection,
} from './types';

export {
  ar,
  AR_NEEDS_NATIVE_REVIEW,
  AR_SECTION_REVIEW_STATUS,
  fr,
  LOCALE_METADATA,
  pseudo,
};
export type {
  AnyTranslationKey,
  InterpolationParams,
  LocaleMetadata,
  SupportedLocale,
  TextDirection,
  TranslationDictionary,
  TranslationKey,
  TranslationSection,
};

export const LOCALE_STORAGE_KEY = 'mobi_pos_locale';

const DICTIONARIES: Readonly<Record<SupportedLocale, TranslationDictionary>> = {
  fr,
  ar,
  pseudo,
};

declare global {
  interface Window {
    __setMobiLocale?: (locale: SupportedLocale) => void;
    __getMobiLocale?: () => SupportedLocale;
  }
}

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return value === 'fr' || value === 'ar' || value === 'pseudo';
}

function readInitialLocale(): SupportedLocale {
  if (typeof window === 'undefined') {
    return 'fr';
  }

  try {
    const searchParams = new URLSearchParams(window.location.search);
    const queryLang = searchParams.get('lang');
    if (isSupportedLocale(queryLang)) {
      return queryLang;
    }

    // Also support hash-router query strings if present (e.g. #/?lang=ar)
    const hash = window.location.hash;
    const qIdx = hash.indexOf('?');
    if (qIdx !== -1) {
      const hashParams = new URLSearchParams(hash.slice(qIdx));
      const hashLang = hashParams.get('lang');
      if (isSupportedLocale(hashLang)) {
        return hashLang;
      }
    }
  } catch {
    // Ignore URL parsing errors in non-standard environments
  }

  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isSupportedLocale(stored)) {
      return stored;
    }
  } catch {
    // Ignore storage access errors in restricted WebViews
  }

  return 'fr';
}

function syncDocumentLocaleAttributes(locale: SupportedLocale): void {
  if (typeof document === 'undefined' || !document.documentElement) {
    return;
  }
  const meta = LOCALE_METADATA[locale];
  document.documentElement.lang = meta.htmlLang;
  document.documentElement.dir = meta.dir;
  document.documentElement.dataset.locale = locale;
}

let currentLocale: SupportedLocale = readInitialLocale();
const listeners = new Set<() => void>();

// Synchronize <html lang="..." dir="..."> immediately on module initialization
syncDocumentLocaleAttributes(currentLocale);

export function getLocale(): SupportedLocale {
  return currentLocale;
}

export function getDirection(locale: SupportedLocale = currentLocale): TextDirection {
  return LOCALE_METADATA[locale].dir;
}

export function setLocale(nextLocale: SupportedLocale): void {
  if (!isSupportedLocale(nextLocale)) {
    return;
  }

  syncDocumentLocaleAttributes(nextLocale);

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    } catch {
      // Ignore storage quota / security errors
    }
  }

  if (currentLocale === nextLocale) {
    return;
  }

  currentLocale = nextLocale;
  for (const listener of listeners) {
    listener();
  }
}

export function toggleLocale(): SupportedLocale {
  const next: SupportedLocale = currentLocale === 'fr' ? 'ar' : 'fr';
  setLocale(next);
  return next;
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Expose Playwright visual matrix hook on window
if (typeof window !== 'undefined') {
  window.__setMobiLocale = setLocale;
  window.__getMobiLocale = getLocale;
}

function interpolateTemplate(template: string, params?: InterpolationParams): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{\{?\s*([a-zA-Z0-9_]+)\s*\}?\}?/g, (match, rawToken: string) => {
    const token = rawToken.toLowerCase();
    let val: string | number | undefined = undefined;
    for (const [k, v] of Object.entries(params)) {
      if (k.toLowerCase() === token) {
        val = v;
        break;
      }
    }
    if (val === undefined) {
      if ((token === 'range' || token === 'period') && (params.range !== undefined || params.period !== undefined)) {
        val = params.range ?? params.period;
      } else if ((token === 'count' || token === 'total') && (params.count !== undefined || params.total !== undefined)) {
        val = params.count ?? params.total;
      } else if (token === 'name' && params.name !== undefined) {
        val = params.name;
      }
    }
    return val !== undefined ? String(val) : match;
  });
}

function resolveKeyInDictionary(dict: TranslationDictionary, rawKey: string): string | undefined {
  // Support both canonical 'nav.activity' and 'mobile.nav.activity'
  const normalizedKey = rawKey.startsWith('mobile.') ? rawKey.slice('mobile.'.length) : rawKey;
  const dotIndex = normalizedKey.indexOf('.');
  if (dotIndex === -1) {
    return undefined;
  }
  const section = normalizedKey.slice(0, dotIndex) as TranslationSection;
  const field = normalizedKey.slice(dotIndex + 1);
  const sectionObj = dict[section] as Record<string, string> | undefined;
  if (!sectionObj) {
    return undefined;
  }
  return sectionObj[field];
}

export type TranslateFn = (
  key: AnyTranslationKey | (string & {}),
  fallbackOrParams?: string | InterpolationParams,
  maybeParams?: InterpolationParams,
) => string;

export type Translator = TranslateFn & TranslationDictionary;

function createTranslator(locale: SupportedLocale): Translator {
  const activeDict = DICTIONARIES[locale] ?? fr;

  const translateFn: TranslateFn = (key, fallbackOrParams, maybeParams) => {
    const fallback = typeof fallbackOrParams === 'string' ? fallbackOrParams : undefined;
    const params =
      typeof fallbackOrParams === 'object' && fallbackOrParams !== null
        ? fallbackOrParams
        : maybeParams;

    const resolved =
      resolveKeyInDictionary(activeDict, key) ??
      resolveKeyInDictionary(fr, key) ??
      fallback ??
      key;

    return interpolateTemplate(resolved, params);
  };

  return Object.assign(translateFn, activeDict);
}

const TRANSLATORS: Readonly<Record<SupportedLocale, Translator>> = {
  fr: createTranslator('fr'),
  ar: createTranslator('ar'),
  pseudo: createTranslator('pseudo'),
};

export interface UseTranslationResult {
  /**
   * Strongly-typed translator function & dictionary object:
   * - Call as `t('nav.activity')`, `t('mobile.nav.activity', 'Activité')`, or `t('header.pendingCount', { count: 3 })`
   * - Or access nested sections directly: `t.nav.activity`, `t.checkout.cash`
   */
  readonly t: Translator;
  readonly dict: TranslationDictionary;
  readonly locale: SupportedLocale;
  readonly dir: TextDirection;
  readonly isRtl: boolean;
  readonly needsNativeReview: boolean;
  readonly setLocale: (locale: SupportedLocale) => void;
  readonly toggleLocale: () => SupportedLocale;
  readonly formatDzdCurrency: typeof formatDzdCurrency;
  readonly formatDateTimeLocale: typeof formatDateTimeLocale;
}

export function useTranslation(): UseTranslationResult {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, () => 'fr' as SupportedLocale);
  const meta = LOCALE_METADATA[locale];
  const t = TRANSLATORS[locale];
  const dict = DICTIONARIES[locale];

  return {
    t,
    dict,
    locale,
    dir: meta.dir,
    isRtl: meta.dir === 'rtl',
    needsNativeReview: meta.needsNativeReview,
    setLocale,
    toggleLocale,
    formatDzdCurrency,
    formatDateTimeLocale,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// BiDi & Algerian Formatting Helpers (R-ERG-03, R-RTL-01)
// ═══════════════════════════════════════════════════════════════════════════

const dzdNumberFormatters: Readonly<Record<'int' | 'frac', Intl.NumberFormat>> = {
  int: new Intl.NumberFormat('fr-DZ-u-nu-latn', {
    style: 'currency',
    currency: 'DZD',
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }),
  frac: new Intl.NumberFormat('fr-DZ-u-nu-latn', {
    style: 'currency',
    currency: 'DZD',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }),
};

export interface FormatDzdOptions {
  /** When true, uses localized Arabic unit 'د.ج' when locale === 'ar'. Defaults to false ('DA' for locator parity). */
  readonly localizeUnit?: boolean;
  readonly locale?: SupportedLocale;
}

/**
 * Formats an Algerian Dinar (DZD / DA) amount using Western Arabic numerals (0-9)
 * for strict `tabular-nums` alignment across both LTR (`fr`) and RTL (`ar`) layouts (R-ERG-03).
 */
export function formatDzdCurrency(amount: number, options?: FormatDzdOptions): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return '—';
  }
  const isWhole = amount % 1 === 0;
  const formatted = dzdNumberFormatters[isWhole ? 'int' : 'frac']
    .format(amount)
    .replace('DZD', 'DA');

  const targetLocale = options?.locale ?? currentLocale;
  if (options?.localizeUnit && targetLocale === 'ar') {
    return formatted.replace('DA', 'د.ج');
  }
  return formatted;
}

const dateTimeFormatters: Readonly<Record<SupportedLocale, Intl.DateTimeFormat>> = {
  fr: new Intl.DateTimeFormat('fr-DZ-u-nu-latn', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }),
  ar: new Intl.DateTimeFormat('ar-DZ-u-nu-latn', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }),
  pseudo: new Intl.DateTimeFormat('fr-DZ-u-nu-latn', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }),
};

/**
 * Formats an ISO timestamp or date string using locale-aware Algerian formatting
 * while keeping Western numerals (`-u-nu-latn`) so timestamps remain `tabular-nums`-safe.
 */
export function formatDateTimeLocale(
  iso?: string | null,
  locale: SupportedLocale = currentLocale,
  customOptions?: Intl.DateTimeFormatOptions,
): string {
  if (!iso) {
    return '';
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  if (customOptions) {
    const tag = locale === 'ar' ? 'ar-DZ-u-nu-latn' : 'fr-DZ-u-nu-latn';
    return new Intl.DateTimeFormat(tag, customOptions).format(parsed);
  }
  const formatter = dateTimeFormatters[locale] ?? dateTimeFormatters.fr;
  return formatter.format(parsed);
}

export interface BdiProps extends HTMLAttributes<HTMLElement> {
  /** Content to isolate in left-to-right direction (DZD amounts, +213 phones, 15-digit IMEIs, SKUs, receipt #s). */
  readonly children?: ReactNode;
  /** Adds `font-mono` alongside `tabular-nums` (default: false). */
  readonly mono?: boolean;
}

/**
 * Lightweight BiDi isolation primitive (`<bdi dir="ltr" className="tabular-nums ...">`)
 * Mandated by R-ERG-03 and R-RTL-01 for all DZD monetary amounts, quantities,
 * percentages, timestamps, `+213` phone numbers, 15-digit IMEIs, SKUs, and receipt numbers.
 */
export const Bdi: React.FC<BdiProps> = ({ children, className, mono = false, ...rest }) => {
  const baseClass = mono ? 'font-mono tabular-nums' : 'tabular-nums';
  const mergedClassName = className ? `${baseClass} ${className}` : baseClass;
  return React.createElement(
    'bdi',
    {
      ...rest,
      dir: 'ltr',
      className: mergedClassName,
    },
    children,
  );
};

