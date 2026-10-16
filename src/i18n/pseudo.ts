import { fr } from './fr';
import type { TranslationDictionary } from './types';

const PSEUDO_CHAR_MAP: Readonly<Record<string, string>> = {
  a: 'àá',
  e: 'éê',
  i: 'îï',
  o: 'ôö',
  u: 'ùû',
  c: 'ç',
  n: 'ñ',
  s: 'š',
  y: 'ÿ',
  A: 'ÀÁ',
  E: 'ÉÊ',
  I: 'ÎÏ',
  O: 'ÔÖ',
  U: 'ÙÛ',
  C: 'Ç',
  N: 'Ñ',
  S: 'Š',
};

/**
 * Deterministic pseudo-localization transformer:
 * - Expands visible text by ~30-35% via vowel doubling and brackets `[⟦ ... ⟧]`
 *   to expose horizontal overflow, fixed-width truncation, and hardcoded strings
 *   at 360px-412px mobile viewports (R-POS-B).
 * - Preserves `{placeholder}` interpolation tokens untouched.
 */
export function toPseudoString(source: string): string {
  // Split around {placeholder} tokens so interpolation variables remain intact
  const segments = source.split(/(\{[a-zA-Z0-9_]+\})/g);
  const transformed = segments
    .map((segment) => {
      if (segment.startsWith('{') && segment.endsWith('}')) {
        return segment;
      }
      let out = '';
      let vowelIndex = 0;
      for (const ch of segment) {
        const mapped = PSEUDO_CHAR_MAP[ch];
        if (mapped) {
          // Alternate between 1-char accented and 2-char expanded to hit ~35% length growth
          out += vowelIndex % 2 === 0 ? mapped : mapped[0];
          vowelIndex += 1;
        } else {
          out += ch;
        }
      }
      return out;
    })
    .join('');

  return `[⟦ ${transformed} ⟧]`;
}

function buildPseudoDictionary(sourceDict: TranslationDictionary): TranslationDictionary {
  const result: Record<string, Record<string, string>> = {};

  for (const [sectionKey, sectionObj] of Object.entries(sourceDict)) {
    const pseudoSection: Record<string, string> = {};
    for (const [entryKey, entryVal] of Object.entries(sectionObj as Record<string, string>)) {
      pseudoSection[entryKey] = toPseudoString(entryVal);
    }
    result[sectionKey] = pseudoSection;
  }

  return result as unknown as TranslationDictionary;
}

export const pseudo: TranslationDictionary = buildPseudoDictionary(fr);

