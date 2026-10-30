/**
 * catalogSearch.ts
 *
 * Universal High-Precision Omnisearch & Normalization Engine for MobiPOS.
 *
 * Capabilities:
 * 1. Diacritic-insensitive French & Latin folding (NFD unicode decomposition).
 * 2. Arabic normalization: Tashkeel / Harakat stripping, Alef normalization (إ/أ/آ -> ا),
 *    Teh Marbuta (ة -> ه), and Yeh (ى -> ي).
 * 3. Multi-word token conjunction (every word in query matches anywhere in the target).
 * 4. Spaceless / Punctuation-free alphanumeric matching (e.g. "chargeur20w" matches "Chargeur 20 W",
 *    "batterie10000" matches "Batterie externe 10 000 mAh", "CABAUT1001" matches "CAB-AUT-1001").
 * 5. Category, Brand, Compatible Model, IMEI, and Vendor inclusion in product search haystack.
 * 6. Mobile & Retail hardware domain synonym expansion (e.g. pc <-> ordinateur, cordon <-> câble,
 *    adaptateur <-> chargeur, ecouteurs <-> casque).
 */

import type { Product } from '../types/pos';

// Domain-specific retail synonyms for electronics and mobile accessories
const SYNONYM_CLUSTERS: string[][] = [
  ['pc', 'ordinateur', 'laptop', 'portable', 'ordi'],
  ['chargeur', 'adaptateur', 'charger', 'secteur', 'charge'],
  ['cable', 'cordon', 'fil'],
  ['ecouteur', 'ecouteurs', 'casque', 'audio', 'airpods', 'oreillette', 'oreillettes'],
  ['batterie', 'powerbank', 'power bank', 'accus'],
  ['telephone', 'smartphone', 'mobile', 'tel', 'gsm', 'phone'],
  ['verre', 'film', 'hydrogel', 'vitre', 'protection', 'protege'],
  ['coque', 'etui', 'cover', 'silicone', 'bumper', 'pochette'],
  ['souris', 'mouse'],
  ['clavier', 'keyboard'],
  ['enceinte', 'speaker', 'baffle', 'son'],
  ['cle', 'flash', 'pendrive', 'clef'],
  ['disque', 'ssd', 'hdd'],
  ['support', 'stand', 'trepied', 'holder'],
];

/**
 * Normalizes a string for diacritic, Arabic, and case-insensitive search.
 *
 * This is THE fold for every search box in the app. It used to exist as a
 * private two-line NFD+lowercase copy in eight components, so the same typed
 * name matched in the product grid and missed in the customer directory
 * (`27c-i18-checks` [I18-04], `27a-scl-batch` [SCL-61]). Import it; never
 * re-implement it.
 *
 * Handles: Latin diacritics, Arabic harakat/tashkeel, tatweel, alef/hamza
 * variants, teh marbuta, alef maqsura, Persian yeh/kaf, Arabic-Indic and
 * Persian digits, invisible bidi marks and NBSP.
 */
export function normalizeForSearch(s: string | undefined | null | number): string {
  if (s == null) return '';
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Strip combining diacritical marks
    .replace(/[\u064B-\u065F\u0670]/g, '') // Strip Arabic harakat / tashkeel
    .replace(/\u0640/g, '') // Strip tatweel (kashida) - a purely cosmetic glyph
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '') // bidi / zero-width marks
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F]/g, ' ') // Unicode spaces -> space
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)) // ٠-٩
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0)) // ۰-۹
    .replace(/[\u0622\u0623\u0625\u0627\u0671]/g, '\u0627') // Alef variants -> alef
    .replace(/\u0629/g, '\u0647') // Teh Marbuta -> heh
    .replace(/\u0649/g, '\u064A') // Alef maqsura -> yeh
    .replace(/\u06CC/g, '\u064A') // Persian yeh -> yeh
    .replace(/\u06A9/g, '\u0643') // Persian kaf -> kaf
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Alias for normalizeForSearch for drop-in component compatibility.
 */
export const foldForSearch = normalizeForSearch;

/**
 * Strips all non-alphanumeric characters for compact identifier and spaced number matching.
 */
export function cleanAlphanumeric(s: string | undefined | null | number): string {
  return normalizeForSearch(s).replace(/[^a-z0-9]/g, '');
}

/**
 * Returns synonym expansions for a given search token.
 */
function getSynonymVariants(token: string): string[] {
  const variants = new Set<string>([token]);
  for (const group of SYNONYM_CLUSTERS) {
    if (group.some((w) => token === w || token.startsWith(w) || w.startsWith(token))) {
      group.forEach((w) => variants.add(w));
    }
  }
  return Array.from(variants);
}

/**
 * Omnisearch matcher for Product entities.
 * Searches across: title, sku, barcode, category, brand, compatibleModel, imeiNumber, vendorName.
 */
export function matchProductSearch(product: Product, query: string): boolean {
  if (!query || !query.trim()) return true;

  const normQ = normalizeForSearch(query);
  if (!normQ) return true;

  const normTitle = normalizeForSearch(product.title || (product as any).name);
  const normSku = normalizeForSearch(product.sku);
  const normBarcode = normalizeForSearch(product.barcode);
  const normBrand = normalizeForSearch(product.brand);
  const normCat = normalizeForSearch(product.category);
  const normModel = normalizeForSearch(product.compatibleModel);
  const normImei = product.imeiNumber ? normalizeForSearch(product.imeiNumber) : '';
  const normVendor = product.vendorName ? normalizeForSearch(product.vendorName) : '';

  // 1. Assembled standard text haystack
  const haystack = `${normTitle} ${normSku} ${normBarcode} ${normBrand} ${normCat} ${normModel} ${normImei} ${normVendor}`;

  // Direct full substring match
  if (haystack.includes(normQ)) return true;

  // 2. Multi-word tokenized match with domain synonyms
  const tokens = normQ.split(' ').filter(Boolean);
  if (tokens.length > 0) {
    const allTokensMatch = tokens.every((tok) => {
      if (haystack.includes(tok)) return true;
      const variants = getSynonymVariants(tok);
      return variants.some((v) => haystack.includes(v));
    });
    if (allTokensMatch) return true;
  }

  // 3. Compact alphanumeric match (removes spaces, hyphens, slashes)
  const cleanQ = cleanAlphanumeric(normQ);
  if (cleanQ.length >= 2) {
    const cleanHaystack = cleanAlphanumeric(haystack);
    if (cleanHaystack.includes(cleanQ)) return true;

    // Tokenized match on compact representations (e.g. "chargeur 20w" -> ["chargeur", "20w"])
    const cleanTokens = tokens.map(cleanAlphanumeric).filter((t) => t.length > 0);
    if (cleanTokens.length > 0) {
      const allCleanTokensMatch = cleanTokens.every((ct) => {
        if (cleanHaystack.includes(ct)) return true;
        const variants = getSynonymVariants(ct).map(cleanAlphanumeric);
        return variants.some((v) => cleanHaystack.includes(v));
      });
      if (allCleanTokensMatch) return true;
    }
  }

  return false;
}

/**
 * Filter an array of products using the Omnisearch engine.
 */
export function filterProductsBySearch(products: Product[], query: string): Product[] {
  if (!query || !query.trim()) return products;
  return products.filter((p) => matchProductSearch(p, query));
}

/**
 * Generic search matcher for arbitrary entities (Customers, Suppliers, Transactions, Audit Logs).
 */
export function matchEntitySearch(item: Record<string, any>, fields: string[], query: string): boolean {
  if (!query || !query.trim()) return true;
  const normQ = normalizeForSearch(query);
  if (!normQ) return true;

  const rawValues = fields.map((f) => item[f]).filter((v) => v != null);
  const normalizedValues = rawValues.map((v) => normalizeForSearch(v));
  const haystack = normalizedValues.join(' ');

  if (haystack.includes(normQ)) return true;

  const tokens = normQ.split(' ').filter(Boolean);
  if (tokens.length > 0 && tokens.every((t) => haystack.includes(t))) {
    return true;
  }

  const cleanQ = cleanAlphanumeric(normQ);
  if (cleanQ.length >= 2) {
    const cleanHaystack = cleanAlphanumeric(haystack);
    if (cleanHaystack.includes(cleanQ)) return true;
  }

  return false;
}

