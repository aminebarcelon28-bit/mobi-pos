#!/usr/bin/env node
/**
 * Generate `src/utils/arabicCp864Data.ts` (dev-only; run by hand when the
 * Unicode data changes — never at build time, never at runtime).
 *
 * Sources (factual mapping data, fetched from the publishers):
 *   - https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/PC/CP864.TXT
 *     CP864 (DOS Arabic) byte -> Unicode code point. Used for the printer's
 *     Arabic code page (Epson-class `ESC t 37`).
 *   - https://www.unicode.org/Public/UCD/latest/ucd/UnicodeData.txt
 *     Arabic Presentation Forms-B (U+FE70..U+FEFF) decompositions of the shape
 *     `<isolated|final|initial|medial> <base>`, plus the LAM-ALEF ligatures
 *     (U+FEF5..U+FEFC). This is how the shaper learns which form belongs to
 *     which letter without a hand-typed table.
 *
 * Unicode data files are covered by the Unicode, Inc. License Agreement for
 * Data Files and Software (permissive; attribution kept in the generated head).
 *
 * Usage:
 *   node scripts/gen-arabic-cp864.mjs <CP864.TXT> <UnicodeData.txt>
 */
import fs from 'node:fs';

const [, , cp864Path, unicodeDataPath] = process.argv;
if (!cp864Path || !unicodeDataPath) {
  console.error('usage: node scripts/gen-arabic-cp864.mjs <CP864.TXT> <UnicodeData.txt>');
  process.exit(2);
}

// ── 1. CP864: bytes 0x20..0xFF → code points ────────────────────────────────
const map = new Map();
for (const line of fs.readFileSync(cp864Path, 'utf8').split(/\r?\n/)) {
  const m = /^0x([0-9a-f]{2})\s+0x([0-9a-f]{4,6})/i.exec(line);
  if (!m) continue;
  map.set(parseInt(m[1], 16), parseInt(m[2], 16));
}
const high = [];
for (let b = 0x20; b <= 0xff; b += 1) {
  const cp = map.get(b);
  // CP864 leaves a few bytes undefined (0x9B, 0x9C, 0xA6, 0xF8, 0xF9, 0xFB,
  // 0xFC, 0xFE, 0xFF in the Microsoft table). 0 marks "not encodable", never a
  // character: the encoder refuses to emit an undefined byte.
  high.push(cp ?? 0);
}

// ── 2. Arabic presentation forms: base letter → { isolated, final, initial, medial }
const forms = new Map(); // baseCodePoint → { isolated?, final?, initial?, medial? }
const ligatures = []; // [sequence, formChar, isFinal]
for (const line of fs.readFileSync(unicodeDataPath, 'utf8').split(/\r?\n/)) {
  const f = line.split(';');
  if (f.length < 6) continue;
  const cp = parseInt(f[0], 16);
  if (!(cp >= 0xfe70 && cp <= 0xfeff)) continue;
  const decomp = f[5];
  const m = /^<(isolated|final|initial|medial)>\s+([0-9A-F ]+)$/.exec(decomp);
  if (!m) continue;
  const base = m[2].trim().split(/\s+/).map((h) => parseInt(h, 16));
  const form = m[1];
  if (base.length > 1) {
    // LAM + ALEF variants: only isolated/final ligatures exist.
    if (form === 'isolated' || form === 'final') {
      ligatures.push([base.map((c) => String.fromCodePoint(c)).join(''), cp, form === 'final']);
    }
    continue;
  }
  const b = base[0];
  if (!forms.has(b)) forms.set(b, {});
  forms.get(b)[form] = cp;
}

const letters = [...forms.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([base, f]) => [base, f.isolated ?? 0, f.final ?? 0, f.initial ?? 0, f.medial ?? 0]);

// ── 3. Emit the module ─────────────────────────────────────────────────────
const hex = (n) => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`;
const rows = [];
for (let i = 0; i < high.length; i += 8) {
  rows.push('  ' + high.slice(i, i + 8).map(hex).join(', ') + ',');
}
const letterRows = letters.map(
  ([base, iso, fin, ini, med]) => `  [${hex(base)}, ${hex(iso)}, ${hex(fin)}, ${hex(ini)}, ${hex(med)}],`,
);
const ligRows = ligatures.map((l) => `  [${JSON.stringify(l[0])}, ${hex(l[1])}, ${l[2] ? 'true' : 'false'}],`);

const out = `/**
 * GENERATED — do not edit by hand. Regenerate with
 * \`node scripts/gen-arabic-cp864.mjs CP864.TXT UnicodeData.txt\`.
 *
 * Data: CP864 (DOS Arabic) code page used by Epson-class receipt printers for
 * Arabic (\`ESC t 37\`, TM-T20/TM-T88V code-page table: "37 PC864: Arabic"), and
 * the Arabic Presentation Forms-B shaping data from the Unicode Character
 * Database. Unicode data files: Unicode, Inc. License Agreement for Data Files
 * and Software.
 */

/**
 * Unicode code point for CP864 bytes 0x20..0xFF (index = byte - 0x20).
 * 0x25 is U+066A ARABIC PERCENT SIGN — the only ASCII-range byte that differs
 * from Latin-1, which is why the builder switches pages only for Arabic runs.
 */
export const CP864_BYTES_FROM_0x20: readonly number[] = [
${rows.join('\n')}
];

/**
 * [base, isolated, final, initial, medial] in Unicode order. A zero means the
 * form does not exist (final-only letters have no initial/medial; initial-only
 * forms do not occur in Arabic). Presence of an initial form is also the
 * joining-type signal: a letter with an initial form joins to the following
 * letter (dual-joining); one with only final joins to the preceding only.
 */
export const ARABIC_FORMS: ReadonlyArray<
  readonly [base: number, isolated: number, final: number, initial: number, medial: number]
> = [
${letterRows.join('\n')}
];

/** LAM + ALEF variants: [two-char sequence, presentation char, isFinal]. */
export const ARABIC_LIGATURES: ReadonlyArray<readonly [string, number, boolean]> = [
${ligRows.join('\n')}
];
`;

fs.writeFileSync('src/utils/arabicCp864Data.ts', out);
console.log(
  `wrote src/utils/arabicCp864Data.ts (${high.length} code-page entries, ${letters.length} letters, ${ligatures.length} ligatures)`,
);
