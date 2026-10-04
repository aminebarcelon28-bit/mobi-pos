/**
 * dzPhoneUtils — Algerian phone validation & operator detection engine.
 *
 * Zero-dependency, framework-agnostic. Single parsing authority for the
 * `DzPhoneInput` component and any headless (backend-submit) needs.
 *
 * DZ numbering reality (vs the simplified "10 / 12" spec shorthand):
 * - Mobile (Mobilis/Djezzy/Ooredoo): national 10 digits `0[567]XXXXXXXX`
 *   (9 national digits after the trunk `0`); international `213` + 9 = 12
 *   digits, `00213` + 9 = 14 digits, `+213…` = 12 digits + leading `+`.
 * - Fixed (Algérie Télécom): national 9 digits `0[234]XXXXXXX` (8 after the
 *   trunk); international `213` + 8 = 11 digits, `00213` + 8 = 13 digits.
 * The "exactly 10 / exactly 12" rule in the task spec is therefore the
 * MOBILE case; fixe 9 / 11 is equally valid and handled here. Maximums
 * enforced by `cleanPhone` are the mobile ones (10 national, 12 intl
 * digits, 14 with `00213`) so fixe input is never clipped.
 *
 * Consistent with the existing `utils/phoneUtils.ts` authority
 * (`normalizeAlgerianPhone` → Mobilis/Djezzy/Ooredoo/Fixe/Inconnu) — valid
 * numbers classify identically; only the AT zone split is finer here.
 */

export type DzOperatorId =
  | 'mobilis'
  | 'djezzy'
  | 'ooredoo'
  | 'at-algiers'
  | 'at-east'
  | 'at-west'
  | 'unknown';

export interface OperatorMeta {
  /** Stable identifier for logic / tests. */
  id: DzOperatorId;
  /** French display label (matches existing `normalizeAlgerianPhone` vocabulary). */
  label: 'Mobilis' | 'Djezzy' | 'Ooredoo' | 'Algérie Télécom' | 'Inconnu';
  /** Brand primary color (text / ring accent). */
  color: string;
  /** Translucent badge background. */
  badgeBg: string;
  /** Badge foreground (readable on `badgeBg`). */
  badgeText: string;
  /** Logo icon key consumed by `DzPhoneInput` (initial-based, no assets). */
  icon: 'mobilis' | 'djezzy' | 'ooredoo' | 'at' | 'unknown';
  /** AT zone detail (`02` Centre/Alger, `03` Est, `04` Ouest/Sud). */
  zone?: 'Centre (Alger)' | 'Est' | 'Ouest / Sud';
}

/** National mobile ceiling: `0` + 9 digits. Fixe (9 chars) always fits. */
export const DZ_NATIONAL_MAX_DIGITS = 10;
/** International ceiling excluding `+`: `213` + 9 mobile digits. */
export const DZ_INTL_MAX_DIGITS = 12;
/** `00213` ceiling: `00213` + 9 mobile digits. */
export const DZ_00213_MAX_DIGITS = 14;

const OPERATORS: Record<Exclude<DzOperatorId, 'unknown'>, OperatorMeta> = {
  mobilis: {
    id: 'mobilis',
    label: 'Mobilis',
    color: '#22c55e',
    badgeBg: 'rgba(34,197,94,0.14)',
    badgeText: '#4ade80',
    icon: 'mobilis',
  },
  djezzy: {
    id: 'djezzy',
    label: 'Djezzy',
    color: '#facc15',
    badgeBg: 'rgba(250,204,21,0.14)',
    badgeText: '#fde047',
    icon: 'djezzy',
  },
  ooredoo: {
    id: 'ooredoo',
    label: 'Ooredoo',
    color: '#f87171',
    badgeBg: 'rgba(248,113,113,0.14)',
    badgeText: '#fca5a5',
    icon: 'ooredoo',
  },
  'at-algiers': {
    id: 'at-algiers',
    label: 'Algérie Télécom',
    color: '#38bdf8',
    badgeBg: 'rgba(56,189,248,0.14)',
    badgeText: '#7dd3fc',
    icon: 'at',
    zone: 'Centre (Alger)',
  },
  'at-east': {
    id: 'at-east',
    label: 'Algérie Télécom',
    color: '#38bdf8',
    badgeBg: 'rgba(56,189,248,0.14)',
    badgeText: '#7dd3fc',
    icon: 'at',
    zone: 'Est',
  },
  'at-west': {
    id: 'at-west',
    label: 'Algérie Télécom',
    color: '#38bdf8',
    badgeBg: 'rgba(56,189,248,0.14)',
    badgeText: '#7dd3fc',
    icon: 'at',
    zone: 'Ouest / Sud',
  },
};

export const UNKNOWN_OPERATOR: OperatorMeta = {
  id: 'unknown',
  label: 'Inconnu',
  color: '#64748b',
  badgeBg: 'rgba(100,116,139,0.16)',
  badgeText: '#94a3b8',
  icon: 'unknown',
};

/**
 * Convert Arabic-Indic (٠-٩), Persian (۰-۹) and full-width (０-９) digits to
 * ASCII 0-9. Local copy (zero-dependency rule) of the `phoneUtils.ts` logic.
 */
export function convertDzDigits(input: string): string {
  return (input || '')
    .replace(/[٠-٩]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x0660 + 0x30))
    .replace(/[۰-۹]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x06f0 + 0x30))
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30));
}

/**
 * Strip everything but digits (keeping a single leading `+` when present)
 * and HARD-TRUNCATE to the longest legal shape so over-typing / over-paste
 * can never enter state:
 * - `00213…` → max 14 digits (`00213` + 9)
 * - `213…`   → max 12 digits (`213` + 9)
 * - else     → max 10 digits (national `0` + 9)
 */
export function cleanPhone(raw: string): string {
  const converted = convertDzDigits((raw ?? '').trim());
  if (!converted) return '';
  // A `+` counts as an international prefix only when it precedes the first
  // digit (pasted prose like `Appel: +213…` keeps its `+`; `12+34` does not
  // gain one).
  const hadPlus = /^\D*\+/.test(converted);
  const digits = converted.replace(/\D/g, '');
  // Lone `+` still being typed: never erase the prefix keystroke itself.
  if (!digits) return hadPlus ? '+' : '';
  let clamped = digits;
  if (clamped.startsWith('00213')) {
    clamped = clamped.slice(0, DZ_00213_MAX_DIGITS);
  } else if (clamped.startsWith('213') && clamped.length > 3) {
    clamped = clamped.slice(0, DZ_INTL_MAX_DIGITS);
  } else {
    clamped = clamped.slice(0, DZ_NATIONAL_MAX_DIGITS);
  }
  return hadPlus ? `+${clamped}` : clamped;
}

/** National significant digits (trunk `0` / `213` / `00213` / `+213` removed). */
export function toNationalSignificant(phone: string): string {
  const cleaned = cleanPhone(phone);
  const digits = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
  if (digits.startsWith('00213')) return digits.slice(5);
  if (digits.startsWith('213')) return digits.slice(3);
  if (digits.startsWith('0')) return digits.slice(1);
  return digits;
}

/**
 * Backend-normalized national form (`06XXXXXXXX` / `021XXXXXX`) when the
 * number is complete and valid, else `''`. Use for submissions / storage.
 */
export function toBackendNational(phone: string): string {
  const v = validateDzPhone(phone);
  if (!v.isValid) return '';
  return `0${toNationalSignificant(phone)}`;
}

/** Backend international form (`+213XXXXXXXXX`) when valid, else `''`. */
export function toBackendInternational(phone: string): string {
  const v = validateDzPhone(phone);
  if (!v.isValid) return '';
  return `+213${toNationalSignificant(phone)}`;
}

/**
 * Operator detection. Ignores spaces, dashes, dots, parentheses, leading
 * `+` / `213` / `00213`. Anything outside 05/06/07/02/03/04 → `unknown`.
 */
export function detectDzOperator(phone: string): OperatorMeta {
  const national = toNationalSignificant(phone);
  if (!national) return UNKNOWN_OPERATOR;
  const first = national[0];
  // Mobile heads classify at any partial length so the badge is live while
  // typing (`05` → Ooredoo immediately); validity still needs full length.
  if (first === '6') return OPERATORS.mobilis;
  if (first === '7') return OPERATORS.djezzy;
  if (first === '5') return OPERATORS.ooredoo;
  if (first === '2') return OPERATORS['at-algiers'];
  if (first === '3') return OPERATORS['at-east'];
  if (first === '4') return OPERATORS['at-west'];
  // Full-length numbers with a wrong prefix are unknown; partial input with
  // an as-yet-unclassifiable head (e.g. `0`, `08`, `09`) is also unknown so
  // the badge stays neutral instead of guessing.
  return UNKNOWN_OPERATOR;
}

function chunkPairs(digits: string): string {
  const parts: string[] = [];
  for (let i = 0; i < digits.length; i += 2) parts.push(digits.slice(i, i + 2));
  return parts.filter(Boolean).join(' ');
}

function chunkFixe(local: string): string {
  // `0XX XX XX XX` progressive: 3-2-2-2 (e.g. `021 12 34 56`).
  if (!local) return '';
  const parts = [local.slice(0, 3)];
  for (let i = 3; i < local.length; i += 2) parts.push(local.slice(i, i + 2));
  return parts.filter(Boolean).join(' ');
}

/**
 * Group significant digits for an INTERNATIONAL body (trunk already split
 * off): mobile heads 3-2-2-2 (`550 12 34 56`), fixe/unknown heads pairs
 * (`21 12 34 56`).
 */
function groupIntlBody(national: string): string {
  const head = national[0];
  if (head === '5' || head === '6' || head === '7') {
    const parts = [national.slice(0, 3)];
    for (let i = 3; i < national.length; i += 2) parts.push(national.slice(i, i + 2));
    return parts.filter(Boolean).join(' ');
  }
  return chunkPairs(national);
}

/** Display prefix for a complete-enough international number. */
function intlPrefix(hadPlus: boolean, typed00213: boolean): string {
  if (hadPlus) return '+213';
  return typed00213 ? '00213' : '213';
}

/**
 * Live display format. String-only throughout — no `parseInt`/`Number`, so a
 * leading `0` or `+` is never stripped mid-typing.
 *
 * Partial-safe by construction: prefix states shorter than a dialable number
 * echo back exactly as typed (`0`, `00`, `0021`, `213`, `+`, `+00213`) and
 * the typed international prefix shape is preserved (`213 …`, `00213 …`,
 * `+213 …`) instead of being rewritten under the caret. Trunk-less digits
 * echo ungrouped until they reach a complete length, at which point the
 * trunk `0` is prepended — the ONLY case where display carries one more
 * digit than typed (caret mapping in `DzPhoneInput` compensates).
 * - national mobile → `06 XX XX XX XX`
 * - national fixe   → `021 XX XX XX`
 * - intl mobile     → `+213 550 12 34 56` (or `213 …` / `00213 …` as typed)
 * - intl fixe       → `+213 21 12 34 56`
 *
 * Idempotent: `formatDzPhone(formatDzPhone(x)) === formatDzPhone(x)`, so
 * formatted-in-state and derived-display usages converge.
 */
export function formatDzPhone(phone: string): string {
  if (!phone) return '';
  const cleaned = cleanPhone(phone);
  if (!cleaned) return '';
  if (cleaned === '+') return '+';
  const hadPlus = cleaned.startsWith('+');
  const digits = hadPlus ? cleaned.slice(1) : cleaned;

  // Full international prefixes (typed shape preserved in display).
  if (digits.startsWith('00213')) {
    const national = digits.slice(5);
    if (!national) return cleaned; // `00213` / `+00213` still being typed
    return `${intlPrefix(hadPlus, true)} ${groupIntlBody(national)}`;
  }
  if (digits.startsWith('213') && digits.length > 3) {
    const national = digits.slice(3);
    return `${intlPrefix(hadPlus, false)} ${groupIntlBody(national)}`;
  }
  // Partial international prefixes: echo, never rewrite (`2`, `21`, `213`,
  // `00`, `002`, `0021` and their `+` forms).
  if (
    digits.length <= 5 &&
    ('00213'.startsWith(digits) || '213'.startsWith(digits))
  ) {
    return cleaned;
  }

  // National form (trunk `0` typed — always retained).
  if (digits.startsWith('0')) {
    const national = digits.slice(1);
    if (!national) return '0'; // lone trunk: the first keystroke stays visible
    const local = `0${national}`;
    const head = national[0];
    if (head === '2' || head === '3' || head === '4') return chunkFixe(local);
    return chunkPairs(local);
  }

  // Trunk-less digits: echo ungrouped until a complete length proves the
  // family, then prepend the trunk (mobile 9 / fixe 8 significant digits).
  const head = digits[0];
  if ((head === '5' || head === '6' || head === '7') && digits.length === 9) {
    return chunkPairs(`0${digits}`);
  }
  if ((head === '2' || head === '3' || head === '4') && digits.length === 8) {
    return chunkFixe(`0${digits}`);
  }
  return cleaned;
}

/**
 * Map a pre-format caret (digit-count based) through `formatDzPhone` so
 * live formatting never yanks the caret to the end on backspace / inline
 * edits. Display can carry one MORE digit than typed (trunk `0` prepended
 * to a complete trunk-less number) — that offset is added to the target so
 * the caret does not land mid-string (the `06|6` jump).
 */
export function formatDzPhoneWithCursor(
  value: string,
  cursor: number
): { text: string; cursor: number } {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const digitsBefore = convertDzDigits(value.slice(0, safeCursor)).replace(/\D/g, '').length;
  const cleaned = cleanPhone(value);
  const text = formatDzPhone(cleaned);
  if (!text) return { text, cursor: 0 };
  const cleanedDigits = cleaned.replace(/\D/g, '').length;
  const displayDigits = text.replace(/\D/g, '').length;
  const target =
    Math.min(digitsBefore, cleanedDigits) + Math.max(0, displayDigits - cleanedDigits);
  if (target <= 0) {
    return { text, cursor: text.startsWith('+') && /^\D*\+/.test(value) ? 1 : 0 };
  }
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\d/.test(text[i] ?? '')) {
      seen++;
      if (seen >= target) return { text, cursor: i + 1 };
    }
  }
  return { text, cursor: text.length };
}

export interface DzValidation {
  isValid: boolean;
  errorReason?: string;
}

/**
 * Complete-length + prefix validity. Partial input reports `incomplet`
 * (never valid); wrong prefixes report `inconnu`; over-long raw input
 * (bypassing `cleanPhone`, e.g. programmatic set) reports `trop long`.
 */
export function validateDzPhone(phone: string): DzValidation {
  const raw = convertDzDigits((phone ?? '').trim());
  if (!raw) return { isValid: false, errorReason: 'Numéro requis.' };
  const digits = raw.replace(/\D/g, '');
  if (!digits) return { isValid: false, errorReason: 'Numéro requis.' };
  const national = toNationalSignificant(raw);

  // Over-long detection on the RAW digits (cleanPhone would have swallowed
  // these — a programmatic value that long is a caller bug, fail loudly).
  if (digits.startsWith('00213')) {
    if (digits.length > DZ_00213_MAX_DIGITS) {
      return { isValid: false, errorReason: 'Numéro trop long (14 chiffres max avec 00213).' };
    }
  } else if (digits.startsWith('213') && digits.length > 3) {
    if (digits.length > DZ_INTL_MAX_DIGITS) {
      return { isValid: false, errorReason: 'Numéro trop long (12 chiffres max avec 213).' };
    }
  } else if (!raw.startsWith('+')) {
    if (digits.length > DZ_NATIONAL_MAX_DIGITS) {
      return { isValid: false, errorReason: 'Numéro trop long (10 chiffres max).' };
    }
  } else if (digits.length > DZ_INTL_MAX_DIGITS) {
    return { isValid: false, errorReason: 'Numéro trop long (12 chiffres max avec +213).' };
  }

  const first = national[0] ?? '';
  const isMobileHead = first === '5' || first === '6' || first === '7';
  const isFixeHead = first === '2' || first === '3' || first === '4';

  // Lone trunk (`0`) or bare prefix (`+`, `213`, `00213`) mid-typing: digits
  // exist, so this is an incomplete number — never "requis".
  if (!national) {
    return { isValid: false, errorReason: 'Numéro incomplet (1/10 chiffres).' };
  }

  if (!isMobileHead && !isFixeHead) {
    return {
      isValid: false,
      errorReason: 'Préfixe inconnu — mobiles 05/06/07, fixes 02/03/04.',
    };
  }
  const expected = isMobileHead ? 9 : 8;
  if (national.length < expected) {
    return {
      isValid: false,
      errorReason: `Numéro incomplet (${national.length + 1}/${expected + 1} chiffres).`,
    };
  }
  if (national.length > expected) {
    return { isValid: false, errorReason: 'Numéro trop long pour ce préfixe.' };
  }
  // national.length === expected, but guard the mobile/fixe length cross:
  // e.g. 9 digits starting with 2 is neither a mobile nor a fixe.
  if (isFixeHead && national.length === 9) {
    return { isValid: false, errorReason: 'Numéro trop long pour un fixe (9 chiffres max avec le 0).' };
  }
  return { isValid: true };
}
