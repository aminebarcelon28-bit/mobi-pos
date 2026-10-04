/**
 * Shared search-text normalization for the Réapprovisionnement module
 * (Directive #014 §2.3): searches are accent- and case-insensitive, so
 * "ecran" matches "Écran". Matching is always a literal substring scan —
 * never RegExp construction, so metacharacter payloads (§2.1: `*`, `(`,
 * `[`, …) cannot compile, crash, or hang the thread.
 */

/** Strip combining diacritics (NFD) and lowercase. */
export const stripAccents = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();/**
 * Strip diacritics while keeping a map from stripped-string index to the
 * matching index in the ORIGINAL string, so highlight ranges can be mapped
 * back onto the un-normalized display text.
 */
export const stripAccentsWithMap = (
  value: string
): { stripped: string; origin: number[] } => {
  let stripped = '';
  const origin: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    for (const ch of value[i].normalize('NFD')) {
      const code = ch.codePointAt(0) ?? 0;
      // U+0300..U+036F: combining diacritical marks — dropped from the
      // search key but still present in the display text.
      if (code >= 0x0300 && code <= 0x036f) continue;
      stripped += ch;
      origin.push(i);
    }
  }
  return { stripped: stripped.toLowerCase(), origin };
};
