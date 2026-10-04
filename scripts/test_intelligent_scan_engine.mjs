import assert from 'node:assert/strict';
import {
  isValidGtinChecksum,
  correctOcrAlnum,
  normalizeText,
  tokenizeText,
  extractScanAttributes,
  levenshteinDistance,
  levenshteinRatio,
  jaroWinklerSimilarity,
  tokenSetRatio,
  computeProductSimilarity,
  matchScannedLine,
} from '../src/utils/intelligentScanEngine.ts';

console.log('========================================================================');
console.log('INTELLIGENT SCAN ENGINE VERIFICATION SUITE');
console.log('========================================================================');

// Test 1: GTIN-13 Modulo-10 Checksum
console.log('--- 1. Barcode & GTIN Checksums ---');
assert.strictEqual(isValidGtinChecksum('0745883815234'), true, 'Valid Belkin GTIN-13 should pass');
assert.strictEqual(isValidGtinChecksum('019425208421'), false, '12-digit Apple serial with bad check should fail');
assert.strictEqual(isValidGtinChecksum('1234567890128'), true, 'Valid EAN-13 should pass');
assert.strictEqual(isValidGtinChecksum('1234567890129'), false, 'Corrupted EAN-13 check digit should fail');
console.log('  ✅ [PASS] GTIN-13 Checksum validations passed');

// Test 2: OCR Alphanumeric Correction
console.log('--- 2. OCR Alphanumeric Character Correction ---');
assert.strictEqual(correctOcrAlnum('A23O5'), 'A2305', 'Inner O surrounded by digits should become 0');
assert.strictEqual(correctOcrAlnum('APPL0'), 'APPLO', 'O preceded by uppercase letters should become letter O');
assert.strictEqual(correctOcrAlnum('A2667G1I'), 'A2667G11', 'Trailing I after digit should become 1');
console.log('  ✅ [PASS] OCR alphanumeric corrections passed');

// Test 3: Text Normalization and Connector Unification
console.log('--- 3. Text Normalization & Connector Unification ---');
assert.strictEqual(
  normalizeText('BELKIN BRAIDED CABLE USBC-USBC 200CM / 2M'),
  'belkin braided cable typec to typec 200cm 2m',
  'USBC-USBC should unify to typec to typec'
);
assert.strictEqual(
  normalizeText('ADAPT. SECT. 20W TYPE-C A2305 ORIG APPL'),
  'adapt sect 20w typec a2305 orig appl',
  'TYPE-C should unify to typec'
);
console.log('  ✅ [PASS] Text normalization & connector unification passed');

// Test 4: Deterministic Attribute Extraction
console.log('--- 4. Deterministic Attribute Extraction ---');
const ext1 = extractScanAttributes('ADAPT. SECT. 20W TYPE-C A2305 ORIG APPL [S/N: 019425208421]');
assert.strictEqual(ext1.brand, 'apple');
assert.ok(ext1.spec?.includes('20W'), 'Should extract 20W');
assert.strictEqual(ext1.sku, '019425208421');

const ext2 = extractScanAttributes('ETUI SILIC. NOIR IPH 15 PROMAX [REF: APC-15PM-B]');
assert.strictEqual(ext2.sku, 'APC-15PM-B');

const ext3 = extractScanAttributes('BELKIN BRAIDED CABLE USBC-USBC 200CM / 2M [GTIN: 0745883815234]');
assert.strictEqual(ext3.brand, 'belkin');
assert.ok(ext3.spec?.includes('200CM') || ext3.spec?.includes('2M'));
assert.strictEqual(ext3.barcode, '0745883815234');

const ext4 = extractScanAttributes('FILM VERRE TREMPE PRIVACY S24 ULTRA 9H [ACC-SCR-S24U]');
assert.strictEqual(ext4.model, 's24 ultra');
assert.ok(ext4.spec?.includes('9H'));
assert.ok(ext4.spec?.includes('Privacy'));
console.log('  ✅ [PASS] Attribute extraction correctly isolated brand, model, specs, codes');

// Test 5: RapidFuzz Token Set Ratio
console.log('--- 5. RapidFuzz Token Set Ratio & Jaro-Winkler ---');
const ts1 = tokenSetRatio('ANKER 735 CHARGER GAN 3 65W', 'Chargeur GaN Anker 735 65W 3-Ports');
assert.ok(ts1 >= 0.85, `Token set ratio should be >= 0.85 for scrambled tokens, got ${ts1}`);

const jw1 = jaroWinklerSimilarity('A2305', 'A2305');
assert.strictEqual(jw1, 1.0);
console.log('  ✅ [PASS] Fuzzy string metrics perform accurately on disordered product names');

// Test 6: Model Generation Conflict & Brand Conflict Penalties
console.log('--- 6. Conflict Guards (Brand & Model Generation) ---');
const mockCatalog = [
  {
    id: 'prod_ip15_pm',
    title: 'Étui Silicone iPhone 15 Pro Max Noir',
    sku: 'APC-15PM-B',
    barcode: '',
    category: 'Coques iPhone',
    costPrice: 1850,
    price: 2500,
  },
  {
    id: 'prod_ip15_p',
    title: 'Étui Silicone iPhone 15 Pro Noir',
    sku: 'APC-15P-B',
    barcode: '',
    category: 'Coques iPhone',
    costPrice: 1800,
    price: 2400,
  },
  {
    id: 'prod_ip14_pm',
    title: 'Étui Silicone iPhone 14 Pro Max Noir',
    sku: 'APC-14PM-B',
    barcode: '',
    category: 'Coques iPhone',
    costPrice: 1750,
    price: 2300,
  },
];

const scanIphone15PM = 'ETUI SILIC. NOIR IPH 15 PROMAX [REF: APC-15PM-B]';
const matchResult = await matchScannedLine(scanIphone15PM, mockCatalog, { scannedUnitCost: 1850 });

assert.strictEqual(matchResult.best_match?.id, 'prod_ip15_pm', 'Exact SKU match must win immediately');
assert.strictEqual(matchResult.best_match?.tier, 'exact_key');

const scanFuzzy15PM = 'ETUI SILICONE IPHONE 15 PRO MAX NOIR';
const extFuzzy = extractScanAttributes(scanFuzzy15PM);
const score15PM = computeProductSimilarity(extFuzzy, mockCatalog[0], 1850);
const score15P = computeProductSimilarity(extFuzzy, mockCatalog[1], 1850);

assert.ok(score15PM.score > score15P.score + 0.25, 'iPhone 15 Pro Max must strongly score higher than iPhone 15 Pro due to conflict guard');
console.log('  ✅ [PASS] Model generation conflict guard prevents false positive match');

// Test 7: Benchmark on 1,000 Catalog Items
console.log('--- 7. Benchmark on 1,000 Catalog Items (Async Yielding) ---');
const bigCatalog = [];
for (let i = 0; i < 1000; i++) {
  bigCatalog.push({
    id: `prod_${i}`,
    title: `Câble Type-C vers Lightning ${i % 2 === 0 ? 'Anker' : 'Aukey'} ${i}W`,
    sku: `SKU-${10000 + i}`,
    barcode: `690000000${i}`,
    category: 'Câbles',
    costPrice: 800 + (i % 20) * 50,
    price: 1200 + (i % 20) * 50,
  });
}
bigCatalog[542] = {
  id: 'prod_target_anker_735',
  title: 'Chargeur Anker 735 GaN 65W 3 Ports',
  sku: 'A2667G11',
  barcode: '0848061001234',
  category: 'Chargeurs',
  costPrice: 4200,
  price: 6000,
};

const benchStart = Date.now();
const resBench = await matchScannedLine('ANKER 735 CHARGER GAN 3 65W [P/N: A2667G11]', bigCatalog, {
  scannedUnitCost: 4200,
});
const benchDuration = Date.now() - benchStart;

assert.strictEqual(resBench.best_match?.id, 'prod_target_anker_735', 'Target item must be found');
assert.strictEqual(resBench.best_match?.tier, 'exact_key');
console.log(`  ✅ [PASS] 1,000 items scanned and resolved in ${benchDuration}ms with async yielding`);

console.log('========================================================================');
console.log('ALL INTELLIGENT SCAN ENGINE TESTS PASSED (7/7)');
console.log('========================================================================');

