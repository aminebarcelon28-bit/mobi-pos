import type {
  MatchTier,
  ExtractedScanData,
  MatchScoreBreakdown,
  MatchCandidate,
  MatchOptions,
  MatchResultPayload,
} from '../types/intelligentScan';
import type { Product } from '../types/pos';

// Known accessory & mobile tech brands
export const KNOWN_BRANDS: string[] = [
  'apple',
  'samsung',
  'anker',
  'belkin',
  'baseus',
  'xiaomi',
  'redmi',
  'oraimo',
  'huawei',
  'oppo',
  'realme',
  'infinix',
  'tecno',
  'hoco',
  'borofone',
  'ldnio',
  'remax',
  'joyroom',
  'ugreen',
  'spigen',
  'torras',
  'nilkin',
];

export const BRAND_ALIASES: Record<string, string[]> = {
  apple: ['apple', 'appl', 'iphone', 'iph', 'ipad', 'airpods'],
  samsung: ['samsung', 'sams', 'galaxy'],
  belkin: ['belkin', 'belk'],
  anker: ['anker'],
  xiaomi: ['xiaomi', 'redmi', 'mi'],
  huawei: ['huawei', 'honor'],
  baseus: ['baseus'],
  oraimo: ['oraimo'],
  ugreen: ['ugreen'],
  spigen: ['spigen'],
  hoco: ['hoco'],
  borofone: ['borofone'],
  ldnio: ['ldnio'],
};

// Common mobile models with exact generation markers
export const KNOWN_MODELS: string[] = [
  'iphone 16 pro max',
  'iphone 16 pro',
  'iphone 16 plus',
  'iphone 16',
  'iphone 15 pro max',
  'iphone 15 pro',
  'iphone 15 plus',
  'iphone 15',
  'iphone 14 pro max',
  'iphone 14 pro',
  'iphone 14 plus',
  'iphone 14',
  'iphone 13 pro max',
  'iphone 13 pro',
  'iphone 13',
  'iphone 12 pro max',
  'iphone 12 pro',
  'iphone 12',
  'iphone 11 pro max',
  'iphone 11 pro',
  'iphone 11',
  's24 ultra',
  's24 plus',
  's24',
  's23 ultra',
  's23 plus',
  's23',
  's22 ultra',
  's22 plus',
  's22',
  'a55',
  'a54',
  'a35',
  'a34',
  'a15',
  'a14',
  'redmi note 13 pro',
  'redmi note 13',
  'redmi note 12',
];

/**
 * Validate GTIN-8, GTIN-12, GTIN-13, GTIN-14 modulo 10 checksum
 */
export function isValidGtinChecksum(code: string): boolean {
  const clean = code.replace(/\D/g, '');
  if (clean.length < 8 || clean.length > 14) return false;

  const digits = clean.split('').map(Number);
  const checkDigit = digits.pop()!;
  let sum = 0;
  const reversed = digits.reverse();

  for (let i = 0; i < reversed.length; i++) {
    sum += reversed[i] * (i % 2 === 0 ? 3 : 1);
  }

  const calculatedCheck = (10 - (sum % 10)) % 10;
  return calculatedCheck === checkDigit;
}

/**
 * OCR Alphanumeric character correction (correct common digit/char substitutions)
 */
export function correctOcrAlnum(input: string): string {
  return input
    .replace(/(?<=[a-zA-Z]{2,})0\b/g, 'O')
    .replace(/\b0(?=[a-zA-Z]{2,})/g, 'O')
    .replace(/(?<=[a-zA-Z])0(?=[a-zA-Z])/g, 'O')
    .replace(/(?<=[0-9])O(?=[0-9])/g, '0')
    .replace(/(?<=[0-9])O\b/g, '0')
    .replace(/\bO(?=[0-9])/g, '0')
    .replace(/(?<=[0-9])I(?=[0-9])/g, '1')
    .replace(/(?<=[0-9])I\b/g, '1')
    .replace(/(?<=[0-9])l(?=[0-9])/g, '1')
    .replace(/(?<=[0-9])S(?=[0-9])/g, '5')
    .replace(/(?<=[0-9])B(?=[0-9])/g, '8');
}

/**
 * Text normalization:
 * - lowercase, diacritics removal
 * - connector unification (usb-c, type-c -> typec to typec)
 * - punctuation cleaning
 */
export function normalizeText(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(usb[\s-]*c|type[\s-]*c)\b/g, 'typec')
    .replace(/\b(lightning|light)\b/g, 'lightning')
    .replace(/\b(usbc[\s-]*usbc|typec[\s-]*typec)\b/g, 'typec to typec')
    .replace(/[-_/]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(charger)\b/g, 'chargeur')
    .replace(/\b(case)\b/g, 'etui')
    .replace(/\b(screen)\b/g, 'ecran')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract clean tokens, removing meaningless noise words
 */
export function tokenizeText(text: string): string[] {
  const normalized = normalizeText(text);
  const stopWords = new Set([
    'de', 'du', 'la', 'le', 'les', 'des', 'un', 'une', 'en', 'pour', 'et', 'a', 'au', 'aux',
    'adapt', 'sect', 'orig', 'art', 'ref', 'sn', 'gtin', 'pn', 'etui', 'silic'
  ]);

  return normalized
    .split(/\s+/)
    .filter((tok) => tok.length > 1 && !stopWords.has(tok));
}

/**
 * Deterministically parse scanned product description into structured attributes
 */
export function extractScanAttributes(rawInput: string): ExtractedScanData {
  const normalized = normalizeText(rawInput);
  const tokens = tokenizeText(rawInput);

  // 1. Brand detection
  let detectedBrand: string | undefined;
  for (const [canonical, aliases] of Object.entries(BRAND_ALIASES)) {
    for (const alias of aliases) {
      const rx = new RegExp(`\\b${alias}\\b`, 'i');
      if (rx.test(rawInput) || rx.test(normalized)) {
        detectedBrand = canonical;
        break;
      }
    }
    if (detectedBrand) break;
  }

  // 2. Phone model detection
  let detectedModel: string | undefined;
  for (const m of KNOWN_MODELS) {
    const mNorm = normalizeText(m);
    if (normalized.includes(mNorm)) {
      detectedModel = m;
      break;
    }
  }

  // 3. Spec / Wattage / Dimensions / Features
  const specs: string[] = [];
  const wattMatch = rawInput.match(/\b(\d{1,3})\s*[wW]\b/);
  if (wattMatch) specs.push(`${wattMatch[1]}W`);

  const lengthMatch = rawInput.match(/\b(\d{1,3})\s*(?:cm|m|meter|metre)\b/i);
  if (lengthMatch) specs.push(lengthMatch[0].toUpperCase());

  if (/\b9h\b/i.test(rawInput)) specs.push('9H');
  if (/\bprivacy\b/i.test(rawInput)) specs.push('Privacy');
  if (/\bgan\b/i.test(rawInput)) specs.push('GaN');
  if (/\bbraided\b/i.test(rawInput)) specs.push('Braided');

  // 4. Barcode / SKU / Reference extraction
  let detectedBarcode: string | undefined;
  let detectedSku: string | undefined;

  const gtinMatch = rawInput.match(/(?:GTIN|EAN|BARCODE)[:\s]*([0-9]{8,14})/i);
  if (gtinMatch && isValidGtinChecksum(gtinMatch[1])) {
    detectedBarcode = gtinMatch[1];
  } else {
    const rawNumberMatch = rawInput.match(/\b([0-9]{8,14})\b/);
    if (rawNumberMatch && isValidGtinChecksum(rawNumberMatch[1])) {
      detectedBarcode = rawNumberMatch[1];
    }
  }

  const refMatch = rawInput.match(/(?:REF|P\/N|S\/N|CODE|SKU)[:\s]*([A-Z0-9_-]{3,20})/i);
  if (refMatch) {
    detectedSku = refMatch[1].trim();
  }

  // 5. Pack size
  let packSize: number | undefined;
  const packMatch = rawInput.match(/(?:pack|lot|boite|paquet)\s*(?:de)?\s*(\d+)/i);
  if (packMatch) packSize = parseInt(packMatch[1], 10);

  // Clean title: strip bracketed tags like [REF: ...], [GTIN: ...]
  const cleanTitle = rawInput
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    clean_title: cleanTitle,
    brand: detectedBrand,
    model: detectedModel,
    spec: specs.length > 0 ? specs.join(' ') : undefined,
    sku: detectedSku,
    barcode: detectedBarcode,
    pack_size: packSize,
    extracted_tokens: tokens,
  };
}

/**
 * Levenshtein distance between two strings
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    d[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    d[0][j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
    }
  }

  return d[a.length][b.length];
}

/**
 * Normalized Levenshtein ratio (0.0 to 1.0)
 */
export function levenshteinRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(a, b);
  return Math.max(0, 1.0 - dist / maxLen);
}

/**
 * Jaro-Winkler similarity (0.0 to 1.0)
 */
export function jaroWinklerSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  if (!s1.length || !s2.length) return 0.0;

  const matchDistance = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2.length);

    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro =
    (matches / s1.length +
      matches / s2.length +
      (matches - transpositions / 2) / matches) /
    3.0;

  let prefix = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }

  return Math.min(1.0, jaro + prefix * 0.1 * (1.0 - jaro));
}

/**
 * RapidFuzz-style Token Set Ratio with soft token matching:
 * Computes intersection of tokens, remainder differences, and scores intersection vs full sets.
 */
export function tokenSetRatio(str1: string, str2: string): number {
  const arr1 = tokenizeText(str1);
  const arr2 = tokenizeText(str2);
  const t1 = new Set(arr1);
  const t2 = new Set(arr2);

  if (t1.size === 0 || t2.size === 0) return 0.0;

  const matchedT1 = new Set<string>();
  const matchedT2 = new Set<string>();

  for (const tok1 of t1) {
    if (t2.has(tok1)) {
      matchedT1.add(tok1);
      matchedT2.add(tok1);
    } else {
      for (const tok2 of t2) {
        if (!matchedT2.has(tok2) && levenshteinRatio(tok1, tok2) >= 0.8) {
          matchedT1.add(tok1);
          matchedT2.add(tok2);
          break;
        }
      }
    }
  }

  const interSorted = Array.from(matchedT1).sort().join(' ');
  const s1Sorted = Array.from(t1).sort().join(' ');
  const s2Sorted = Array.from(t2).sort().join(' ');

  const r1 = levenshteinRatio(interSorted, s1Sorted);
  const r2 = levenshteinRatio(interSorted, s2Sorted);
  const r3 = levenshteinRatio(s1Sorted, s2Sorted);

  const overlapScore = (matchedT1.size * 2) / (t1.size + t2.size);

  return Math.max(r1, r2, r3, overlapScore);
}

/**
 * Check if two models conflict (e.g. "iphone 15 pro max" vs "iphone 15 pro" or "s24" vs "s24 ultra")
 */
function checkModelConflict(modelA?: string, modelB?: string): boolean {
  if (!modelA || !modelB) return false;
  const a = normalizeText(modelA);
  const b = normalizeText(modelB);
  if (a === b) return false;

  // Pro Max vs Pro
  if (a.includes('pro max') && !b.includes('pro max')) return true;
  if (!a.includes('pro max') && b.includes('pro max')) return true;

  // Plus vs non-plus
  if (a.includes('plus') && !b.includes('plus')) return true;
  if (!a.includes('plus') && b.includes('plus')) return true;

  // Ultra vs non-ultra
  if (a.includes('ultra') && !b.includes('ultra')) return true;
  if (!a.includes('ultra') && b.includes('ultra')) return true;

  return false;
}

/**
 * Compute multi-vector similarity score between an extracted scan and a catalog product
 */
export function computeProductSimilarity(
  extracted: ExtractedScanData,
  product: Product,
  scannedUnitCost?: number
): { score: number; tier: MatchTier; breakdown: MatchScoreBreakdown; reasoning: string } {
  const normTitle = normalizeText(product.title);
  const normSku = (product.sku || '').toLowerCase().trim();
  const normBarcode = (product.barcode || '').trim();

  // 1. Exact Key Match (Barcode / SKU / Ref)
  const isExactBarcode = Boolean(
    extracted.barcode &&
    normBarcode &&
    (extracted.barcode === normBarcode || normBarcode.endsWith(extracted.barcode))
  );

  const isExactSku = Boolean(
    extracted.sku &&
    normSku &&
    (normSku === extracted.sku.toLowerCase() || normSku.includes(extracted.sku.toLowerCase()))
  );

  if (isExactBarcode || isExactSku) {
    const keyType = isExactBarcode ? 'Code-barres / GTIN' : 'Référence SKU';
    return {
      score: 1.0,
      tier: 'exact_key',
      breakdown: {
        exact_key_hit: true,
        name_fuzzy_score: 1.0,
        token_set_ratio: 1.0,
        brand_match_score: 1.0,
        spec_match_score: 1.0,
        category_match_score: 1.0,
        brand_conflict_penalty: 0,
        model_conflict_penalty: 0,
        spec_conflict_penalty: 0,
        final_composite_score: 1.0,
      },
      reasoning: `100% : Correspondance exacte clé unique (${keyType})`,
    };
  }

  // 2. Fuzzy Text Matching
  const jwScore = jaroWinklerSimilarity(normalizeText(extracted.clean_title), normTitle);
  const tsRatio = tokenSetRatio(extracted.clean_title, product.title);
  const textScore = Math.max(jwScore * 0.4 + tsRatio * 0.6, tsRatio);

  // 3. Brand Matching & Conflict Guard
  let brandScore = 0.5;
  let brandConflict = 0.0;
  const prodBrand = KNOWN_BRANDS.find((b) => normTitle.includes(b));

  if (extracted.brand) {
    if (prodBrand) {
      if (extracted.brand === prodBrand) {
        brandScore = 1.0;
      } else {
        brandConflict = 0.40;
      }
    } else if (normTitle.includes(extracted.brand)) {
      brandScore = 1.0;
    }
  }

  // 4. Model Matching & Conflict Guard
  let modelConflict = 0.0;
  const prodModel = KNOWN_MODELS.find((m) => normTitle.includes(normalizeText(m)));
  if (extracted.model && prodModel) {
    if (checkModelConflict(extracted.model, prodModel)) {
      modelConflict = 0.35;
    }
  }

  // 5. Spec & Wattage Matching & Conflict Guard
  let specScore = 0.5;
  let specConflict = 0.0;
  if (extracted.spec) {
    const specTokens = extracted.spec.toLowerCase().split(/\s+/);
    let matchedCount = 0;
    for (const st of specTokens) {
      if (normTitle.includes(st)) matchedCount++;
    }
    if (specTokens.length > 0) {
      specScore = matchedCount / specTokens.length;
    }

    const scanWatt = extracted.spec.match(/\b(\d{1,3})W\b/i);
    const prodWatt = product.title.match(/\b(\d{1,3})\s*[wW]\b/i);
    if (scanWatt && prodWatt && scanWatt[1] !== prodWatt[1]) {
      specConflict = 0.30;
    }
  }

  // 6. Price Sanity Corroboration
  let priceSanityScore = 0.0;
  const refCost = product.costPrice || 0;
  if (scannedUnitCost && scannedUnitCost > 0 && refCost > 0) {
    const ratio = scannedUnitCost / refCost;
    if (ratio >= 0.75 && ratio <= 1.25) {
      priceSanityScore = 0.10;
    } else if (ratio < 0.35 || ratio > 2.8) {
      priceSanityScore = -0.25;
    }
  }

  // 7. Composite Weighting
  let composite =
    textScore * 0.50 +
    brandScore * 0.25 +
    specScore * 0.25 +
    priceSanityScore -
    brandConflict -
    modelConflict -
    specConflict;

  composite = Math.max(0.0, Math.min(0.99, composite));

  let tier: MatchTier = 'low_confidence';
  if (composite >= 0.85) {
    tier = 'high_confidence';
  } else if (composite >= 0.60) {
    tier = 'medium_confidence';
  }

  const reasons: string[] = [];
  const pct = Math.round(composite * 100);

  if (brandScore === 1.0 && extracted.brand) {
    reasons.push(`Marque exacte '${extracted.brand.toUpperCase()}'`);
  }
  if (brandConflict > 0 && prodBrand && extracted.brand) {
    reasons.push(`Conflit de marque (${extracted.brand} vs ${prodBrand})`);
  }
  if (modelConflict > 0 && prodModel && extracted.model) {
    reasons.push(`Conflit génération modèle (${extracted.model} vs ${prodModel})`);
  }
  if (specConflict > 0) {
    reasons.push('Conflit puissance/spécification');
  }
  if (tsRatio >= 0.8) {
    reasons.push(`Forte similarité textuelle (${Math.round(tsRatio * 100)}%)`);
  }
  if (priceSanityScore > 0) {
    reasons.push('Prix cohérent avec le coût catalogue');
  } else if (priceSanityScore < 0) {
    reasons.push('Écart de prix anormal avec le catalogue');
  }

  const reasoning = `${pct}% : ${reasons.length > 0 ? reasons.join(', ') : 'Correspondance partielle'}`;

  return {
    score: composite,
    tier,
    breakdown: {
      exact_key_hit: false,
      name_fuzzy_score: Math.round(jwScore * 100) / 100,
      token_set_ratio: Math.round(tsRatio * 100) / 100,
      brand_match_score: brandScore,
      spec_match_score: specScore,
      category_match_score: 0.5,
      price_sanity_score: priceSanityScore,
      brand_conflict_penalty: brandConflict,
      model_conflict_penalty: modelConflict,
      spec_conflict_penalty: specConflict,
      final_composite_score: Math.round(composite * 100) / 100,
    },
    reasoning,
  };
}

/**
 * Intelligent Scan Matching Engine:
 * Compares scanned input against product catalog and returns top-N ranked candidates.
 * Non-blocking cooperative async execution for large catalogs.
 */
export async function matchScannedLine(
  rawInput: string,
  catalog: Product[],
  options: MatchOptions = {}
): Promise<MatchResultPayload> {
  const startTime = Date.now();
  const topN = options.topN ?? 5;
  const scannedUnitCost = options.scannedUnitCost;

  const extracted = extractScanAttributes(rawInput);
  const candidates: MatchCandidate[] = [];

  const BATCH_SIZE = 150;
  for (let i = 0; i < catalog.length; i++) {
    if (i > 0 && i % BATCH_SIZE === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const prod = catalog[i];
    if (prod.isActive === false) continue;

    const { score, tier, breakdown, reasoning } = computeProductSimilarity(
      extracted,
      prod,
      scannedUnitCost
    );

    let price_delta: MatchCandidate['price_delta'];
    if (scannedUnitCost && scannedUnitCost > 0) {
      const catCost = prod.costPrice || 0;
      if (catCost > 0) {
        const diff = Math.round((scannedUnitCost - catCost) * 100) / 100;
        const percent = Math.round((diff / catCost) * 100);
        const trend =
          diff > 0.01 ? 'increased' : diff < -0.01 ? 'decreased' : 'unchanged';
        price_delta = { diff, percent, trend };
      } else {
        price_delta = { diff: 0, percent: 0, trend: 'new' };
      }
    }

    candidates.push({
      id: prod.id,
      name: prod.title,
      sku: prod.sku || '',
      barcode: prod.barcode,
      category: prod.category,
      current_cost: prod.costPrice || 0,
      selling_price: prod.price,
      similarity_score: score,
      tier,
      reasoning,
      breakdown,
      price_delta,
    });
  }

  candidates.sort((a, b) => b.similarity_score - a.similarity_score);
  const topCandidates = candidates.slice(0, topN);
  const bestMatch = topCandidates.length > 0 && topCandidates[0].similarity_score >= (options.thresholdMedium ?? 0.60)
    ? topCandidates[0]
    : null;

  return {
    input_raw: rawInput,
    extracted,
    best_match: bestMatch,
    candidates: topCandidates,
    processing_time_ms: Date.now() - startTime,
  };
}

