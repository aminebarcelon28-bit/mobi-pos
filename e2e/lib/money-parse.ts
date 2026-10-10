/**
 * Displayed-text → integer minor units (BigInt).
 *
 * Deterministic path uses the SINGLE locale's separators (R-20): fr-DZ
 * renders `130.50 DA` with ASCII-space thousands grouping
 * (`src/utils/money.ts: groupAscii`, `money.rs: format`). The parser ALSO
 * accepts Arabic-Indic digits, NBSP/U+202F/bidi marks and `,` decimals so
 * pasted/normalized values never mis-parse — but the deterministic path is
 * preferred and the heuristic fallback must be flagged in reports.
 */

export interface Seps {
  decimal: string;
  group: string;
}

/** fr-DZ as rendered by the app. */
export const FR_DZ_SEPS: Seps = { decimal: '.', group: ' ' };

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXT_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';
const BIDI_AND_SPACES = /[‎‏‪-‮⁦-⁩   \s]/g;

function latinize(raw: string): string {
  let s = [...raw]
    .map((ch) => {
      const i = ARABIC_INDIC.indexOf(ch);
      const j = EXT_ARABIC_INDIC.indexOf(ch);
      return i >= 0 ? String(i) : j >= 0 ? String(j) : ch;
    })
    .join('');
  s = s.replace(/٬/g, ',').replace(/٫/g, '.').replace(/[−−]/g, '-');
  s = s.replace(BIDI_AND_SPACES, '');
  // Drop currency label (DA / د.ج / DZD) and anything non-numeric.
  s = s.replace(/[^\d.,\-]/g, '');
  return s;
}

export function displayedToMinor(raw: string, seps: Seps = FR_DZ_SEPS): bigint {
  let s = latinize(raw);
  const neg = s.startsWith('-') || s.endsWith('-');
  s = s.replace(/-/g, '');
  const [i, f = ''] = s.split(seps.decimal);
  const intPart = i.split(seps.group).join('');
  if (!/^\d*$/.test(intPart) || !/^\d{0,2}$/.test(f)) {
    throw new Error(`Cannot parse money text: "${raw}"`);
  }
  const v = BigInt(intPart || '0') * 100n + BigInt(f.padEnd(2, '0') || '0');
  return neg ? -v : v;
}
