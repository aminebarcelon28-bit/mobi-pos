/**
 * Arabic text for ESC/POS receipts (RCP-01 / RCP-12 / RCP-21).
 *
 * Receipt printers do not shape Arabic and have no bidi: they print the bytes
 * they are given, left to right. The app therefore must
 *   1. choose a code page that carries Arabic (CP864 — Epson `ESC t 37`),
 *   2. substitute the correct contextual form (isolated/final/initial/medial)
 *      and the LAM+ALEF ligatures,
 *   3. reorder the line into visual order for the printer's LTR head,
 *   4. emit only bytes that exist in the code page.
 *
 * The shaping data comes from the Unicode Character Database
 * (`arabicCp864Data.ts`), not from a hand-typed table.
 *
 * Deliberate simplifications (documented, not accidental):
 *  - No UAX#9 bidi beyond level 0/1: a line is reordered as a sequence of
 *    directional runs, Arabic runs reversed, Latin/digit runs kept. That covers
 *    "Arabic cashier name on a French ticket" and mixed item names; nested
 *    embeddings (RLE/LRE controls) are not modelled.
 *  - Harakat (combining marks) are dropped: CP864 has no reliable combining set
 *    and receipts print unvocalised Arabic.
 */
import { ARABIC_FORMS, ARABIC_LIGATURES, CP864_BYTES_FROM_0x20 } from './arabicCp864Data';

/** Epson code-page table: 37 = PC864 (Arabic) on TM-T20/TM-T88V class firmware. */
export const ARABIC_CODE_PAGE = 37;

const TATWEEL = 0x0640;

interface Forms {
  isolated: number;
  final: number;
  initial: number;
  medial: number;
}

const FORM_BY_BASE = new Map<number, Forms>();
const BASE_BY_FORM = new Map<number, number>();
for (const [base, isolated, final, initial, medial] of ARABIC_FORMS) {
  FORM_BY_BASE.set(base, { isolated, final, initial, medial });
  for (const f of [isolated, final, initial, medial]) if (f) BASE_BY_FORM.set(f, base);
}
const LIGATURE = new Map<string, { isolated: number; final: number }>();
for (const [seq, ch, isFinal] of ARABIC_LIGATURES) {
  const key = [...seq].map((c) => c.codePointAt(0)).join('+');
  const cur = LIGATURE.get(key) ?? { isolated: 0, final: 0 };
  if (isFinal) cur.final = ch;
  else cur.isolated = ch;
  LIGATURE.set(key, cur);
}

/** CP864 byte for each supported code point (built once, reverse of the table). */
const BYTE_BY_CODEPOINT = new Map<number, number>();
CP864_BYTES_FROM_0x20.forEach((cp, i) => {
  if (cp && !BYTE_BY_CODEPOINT.has(cp)) BYTE_BY_CODEPOINT.set(cp, i + 0x20);
});

const isArabicCodePoint = (cp: number): boolean =>
  (cp >= 0x0600 && cp <= 0x06ff) || // Arabic
  (cp >= 0x0750 && cp <= 0x077f) || // Arabic Supplement
  (cp >= 0x08a0 && cp <= 0x08ff) || // Arabic Extended-A
  (cp >= 0xfb50 && cp <= 0xfdff) || // Presentation Forms-A
  (cp >= 0xfe70 && cp <= 0xfeff); // Presentation Forms-B

const isCombiningMark = (cp: number): boolean =>
  (cp >= 0x064b && cp <= 0x065f) || // harakat
  cp === 0x0670 || // superscript alef
  (cp >= 0x06d6 && cp <= 0x06ed) || // Quranic marks
  (cp >= 0xfe70 && cp <= 0xfe7f); // spacing forms of the marks

/** True when the string has at least one Arabic code point. */
export function containsArabic(text: string): boolean {
  for (const ch of text) if (isArabicCodePoint(ch.codePointAt(0) as number)) return true;
  return false;
}

const ALEFS = new Set([0x0622, 0x0623, 0x0625, 0x0627]);
const LAM = 0x0644;

const canJoinNext = (cp: number): boolean =>
  cp === TATWEEL || Boolean(FORM_BY_BASE.get(cp)?.initial);
const canJoinPrev = (cp: number): boolean =>
  cp === TATWEEL || Boolean(FORM_BY_BASE.get(cp)?.final);

/**
 * Contextual shaping in logical order. Input marks are dropped; characters the
 * code page cannot express are preserved as-is (the encoder maps them to '?').
 */
export function shapeArabic(text: string): string {
  const chars = [...text].filter((c) => !isCombiningMark(c.codePointAt(0) as number));
  const cps = chars.map((c) => c.codePointAt(0) as number);
  const out: string[] = [];
  /** Last emitted code point that can still join forward. */
  let prev: number | null = null;
  for (let i = 0; i < chars.length; i += 1) {
    const cp = cps[i];
    // LAM + ALEF collapses to one ligature glyph and consumes the alef.
    if (cp === LAM && i + 1 < chars.length && ALEFS.has(cps[i + 1])) {
      const lig = LIGATURE.get(`${LAM}+${cps[i + 1]}`) ?? LIGATURE.get(`${LAM}+${0x0627}`);
      if (lig) {
        const joined = prev !== null && canJoinNext(prev);
        out.push(String.fromCodePoint(joined && lig.final ? lig.final : lig.isolated));
        prev = null; // a ligature never joins forward in CP864
        i += 1;
        continue;
      }
    }
    if (cp === TATWEEL) {
      out.push(String.fromCodePoint(cp));
      prev = cp;
      continue;
    }
    const forms = FORM_BY_BASE.get(cp);
    if (!forms) {
      out.push(chars[i]);
      prev = canJoinNext(cp) ? cp : null;
      continue;
    }
    const prevJoins = prev !== null && canJoinNext(prev);
    const nextJoins = i + 1 < chars.length && canJoinPrev(cps[i + 1]);
    // A LAM that will form a ligature does not take a medial form.
    const nextIsLigature = nextJoins && cps[i + 1] === LAM && ALEFS.has(cps[i + 2] ?? -1);
    let form = forms.isolated;
    if (prevJoins && nextJoins && !nextIsLigature) form = forms.medial || forms.final || form;
    else if (prevJoins) form = forms.final || form;
    else if (nextJoins && !nextIsLigature) form = forms.initial || form;
    out.push(String.fromCodePoint(form));
    prev = cp;
  }
  return out.join('');
}

/** CP864 bytes for already-shaped text; unmapped characters become '?'. */
export function encodeCp864(text: string): number[] {
  const bytes: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    const b = BYTE_BY_CODEPOINT.get(cp);
    bytes.push(b ?? 0x3f);
  }
  return bytes;
}

export interface DirectionalRun {
  rtl: boolean;
  text: string;
}

const isDigit = (cp: number): boolean =>
  (cp >= 0x30 && cp <= 0x39) || (cp >= 0x0660 && cp <= 0x0669) || (cp >= 0x06f0 && cp <= 0x06f9);

/**
 * Split a line into directional runs in VISUAL order for a left-to-right head:
 * an RTL base reverses the run order and each RTL run; an LTR base keeps the
 * run order and reverses only the RTL runs.
 */
export function visualRuns(line: string): DirectionalRun[] {
  const chars = [...line];
  const dirOf = (ch: string): 'rtl' | 'ltr' | 'neutral' => {
    const cp = ch.codePointAt(0) as number;
    if (isArabicCodePoint(cp) || (cp >= 0x0590 && cp <= 0x05ff)) return 'rtl';
    if (isDigit(cp)) return 'ltr';
    if (/[A-Za-z\u00C0-\u024F]/.test(ch)) return 'ltr';
    return 'neutral';
  };
  // Group; neutrals follow the preceding directional run (or lead the first).
  const groups: Array<{ dir: 'rtl' | 'ltr'; text: string }> = [];
  for (const ch of chars) {
    const d = dirOf(ch);
    if (d === 'neutral' && groups.length > 0) {
      groups[groups.length - 1].text += ch;
    } else if (d === 'neutral') {
      groups.push({ dir: 'ltr', text: ch });
    } else if (groups.length > 0 && groups[groups.length - 1].dir === d) {
      groups[groups.length - 1].text += ch;
    } else {
      groups.push({ dir: d, text: ch });
    }
  }
  const baseRtl = groups.find((g) => g.dir === 'rtl') ? groups[0].dir === 'rtl' : false;
  const ordered = baseRtl ? [...groups].reverse() : groups;
  return ordered.map((g) => ({
    rtl: g.dir === 'rtl',
    text: g.dir === 'rtl' ? [...shapeArabic(g.text)].reverse().join('') : g.text,
  }));
}

/**
 * Directional runs in LOGICAL order, text untouched. The raster lane uses this:
 * the canvas shapes and bidi-orders each run itself, so pre-shaping or
 * pre-reversing here would double-apply it.
 */
export function logicalRuns(line: string): DirectionalRun[] {
  const dirOf = (ch: string): 'rtl' | 'ltr' | 'neutral' => {
    const cp = ch.codePointAt(0) as number;
    if (isArabicCodePoint(cp) || (cp >= 0x0590 && cp <= 0x05ff)) return 'rtl';
    if (isDigit(cp)) return 'ltr';
    if (/[A-Za-z\u00C0-\u024F]/.test(ch)) return 'ltr';
    return 'neutral';
  };
  const groups: Array<{ dir: 'rtl' | 'ltr'; text: string }> = [];
  for (const ch of [...line]) {
    const d = dirOf(ch);
    if (d === 'neutral' && groups.length > 0) groups[groups.length - 1].text += ch;
    else if (d === 'neutral') groups.push({ dir: 'ltr', text: ch });
    else if (groups.length > 0 && groups[groups.length - 1].dir === d) groups[groups.length - 1].text += ch;
    else groups.push({ dir: d, text: ch });
  }
  return groups.map((g) => ({ rtl: g.dir === 'rtl', text: g.text }));
}

/** Display-width-independent logical text for diagnostics/tests. */
export function toLogicalArabic(visual: string): string {
  return [...visual]
    .map((c) => {
      const base = BASE_BY_FORM.get(c.codePointAt(0) as number);
      return base ? String.fromCodePoint(base) : c;
    })
    .join('');
}
