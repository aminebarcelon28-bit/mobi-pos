const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(process.env.APPDATA, 'com.mobi.pos', 'mobi_pos.db');
const db = new Database(dbPath, { readonly: true });

// Query non-deleted products excluding test ghosts
const rows = db.prepare("SELECT * FROM products WHERE deleted = 0 AND id NOT LIKE 'prod-test-%'").all();
console.log('Total live products loaded from SQLite:', rows.length);

function mapSqlRowToProduct(r) {
  let base = {};
  try {
    base = JSON.parse(String(r.json_payload || '{}'));
  } catch {}
  return {
    ...base,
    id: String(r.id),
    sku: String(r.sku || base.sku || ''),
    barcode: String(r.barcode || base.barcode || ''),
    title: String(r.title || base.title || r.id),
    brand: (r.brand && String(r.brand).trim()) || (base.brand && String(base.brand).trim()) || 'Autre',
    category: (r.category && String(r.category).trim()) || (base.category && String(base.category).trim()) || 'Tous les produits',
    price: Number(r.price ?? base.price ?? 0),
    costPrice: Number(r.cost_price ?? base.costPrice ?? 0),
    stock: Number(r.stock ?? base.stock ?? 0),
    isSerialized: Boolean(r.is_serialized ?? base.isSerialized),
    imeiNumber: r.imei_number || base.imeiNumber || undefined,
    vendorName: String(r.vendor_name || base.vendorName || 'Fournisseur Général'),
    compatibleModel: String(r.compatible_model || base.compatibleModel || ''),
  };
}

const products = rows.map(mapSqlRowToProduct);

// Omnisearch implementation
const SYNONYM_CLUSTERS = [
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
  ['support', 'stand', 'trepied', 'holder'],
];

function normalizeForSearch(s) {
  if (s == null) return '';
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanAlphanumeric(s) {
  return normalizeForSearch(s).replace(/[^a-z0-9]/g, '');
}

function getSynonymVariants(token) {
  const variants = new Set([token]);
  for (const group of SYNONYM_CLUSTERS) {
    if (group.some((w) => token === w || token.startsWith(w) || w.startsWith(token))) {
      group.forEach((w) => variants.add(w));
    }
  }
  return Array.from(variants);
}

function matchProductSearch(product, query) {
  if (!query || !query.trim()) return true;

  const normQ = normalizeForSearch(query);
  if (!normQ) return true;

  const normTitle = normalizeForSearch(product.title || product.name);
  const normSku = normalizeForSearch(product.sku);
  const normBarcode = normalizeForSearch(product.barcode);
  const normBrand = normalizeForSearch(product.brand);
  const normCat = normalizeForSearch(product.category);
  const normModel = normalizeForSearch(product.compatibleModel);
  const normImei = product.imeiNumber ? normalizeForSearch(product.imeiNumber) : '';
  const normVendor = product.vendorName ? normalizeForSearch(product.vendorName) : '';

  const haystack = `${normTitle} ${normSku} ${normBarcode} ${normBrand} ${normCat} ${normModel} ${normImei} ${normVendor}`;

  if (haystack.includes(normQ)) return true;

  const tokens = normQ.split(' ').filter(Boolean);
  if (tokens.length > 0) {
    const allTokensMatch = tokens.every((tok) => {
      if (haystack.includes(tok)) return true;
      const variants = getSynonymVariants(tok);
      return variants.some((v) => haystack.includes(v));
    });
    if (allTokensMatch) return true;
  }

  const cleanQ = cleanAlphanumeric(normQ);
  if (cleanQ.length >= 2) {
    const cleanHaystack = cleanAlphanumeric(haystack);
    if (cleanHaystack.includes(cleanQ)) return true;

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

// 10 TARGET IMPORTED PRODUCTS
const expectedTitles = [
  'Câble de charge USB-C',
  'Souris sans fil',
  'Clé USB 32 Go',
  'Chargeur de téléphone 20 W',
  'Écouteurs filaires',
  'Câble HDMI 2 m',
  'Batterie externe 10 000 mAh',
  'Enceinte Bluetooth',
  'Support de refroidissement pour ordinateur portable',
  'Clavier sans fil'
];

console.log('\n--- VERIFYING PRESENCE OF 10 TARGET PRODUCTS ---');
let allFound = true;
expectedTitles.forEach(t => {
  const p = products.find(p => p.title.toLowerCase().trim() === t.toLowerCase().trim());
  if (p) {
    console.log(`[FOUND] "${p.title}" | SKU: ${p.sku} | Barcode: ${p.barcode} | Cat: ${p.category} | Stock: ${p.stock}`);
  } else {
    console.error(`[MISSING] "${t}" not found in database!`);
    allFound = false;
  }
});

if (!allFound) {
  process.exit(1);
}

console.log('\n--- VERIFYING SEARCH QUERIES ACROSS ALL 10 PRODUCTS ---');
const testQueries = [
  { q: 'cable charge', target: 'Câble de charge USB-C' },
  { q: 'cable usb', target: 'Câble de charge USB-C' },
  { q: 'souris sans fil', target: 'Souris sans fil' },
  { q: 'souris', target: 'Souris sans fil' },
  { q: 'mouse', target: 'Souris sans fil' },
  { q: 'cle usb 32', target: 'Clé USB 32 Go' },
  { q: 'cle 32go', target: 'Clé USB 32 Go' },
  { q: 'flash 32', target: 'Clé USB 32 Go' },
  { q: 'chargeur 20w', target: 'Chargeur de téléphone 20 W' },
  { q: 'chargeur telephone', target: 'Chargeur de téléphone 20 W' },
  { q: 'chargeur 20', target: 'Chargeur de téléphone 20 W' },
  { q: 'ecouteurs filaires', target: 'Écouteurs filaires' },
  { q: 'ecouteur', target: 'Écouteurs filaires' },
  { q: 'casque audio', target: 'Écouteurs filaires' },
  { q: 'cable hdmi 2m', target: 'Câble HDMI 2 m' },
  { q: 'hdmi 2m', target: 'Câble HDMI 2 m' },
  { q: 'batterie 10000', target: 'Batterie externe 10 000 mAh' },
  { q: 'batterie 10 000', target: 'Batterie externe 10 000 mAh' },
  { q: 'powerbank 10000', target: 'Batterie externe 10 000 mAh' },
  { q: 'enceinte bluetooth', target: 'Enceinte Bluetooth' },
  { q: 'speaker bluetooth', target: 'Enceinte Bluetooth' },
  { q: 'support pc', target: 'Support de refroidissement pour ordinateur portable' },
  { q: 'support ordinateur', target: 'Support de refroidissement pour ordinateur portable' },
  { q: 'support laptop', target: 'Support de refroidissement pour ordinateur portable' },
  { q: 'clavier sans fil', target: 'Clavier sans fil' },
  { q: 'clavier', target: 'Clavier sans fil' },
  { q: 'keyboard', target: 'Clavier sans fil' },
  { q: 'CABAUT1001', target: 'Câble de charge USB-C' },
  { q: '6130000000015', target: 'Câble de charge USB-C' },
  { q: '6130000000046', target: 'Chargeur de téléphone 20 W' },
  { q: '6130000000077', target: 'Batterie externe 10 000 mAh' },
];

let queryFailed = 0;
testQueries.forEach(({ q, target }) => {
  const matches = products.filter(p => matchProductSearch(p, q));
  const hasTarget = matches.some(m => m.title === target);
  if (hasTarget) {
    console.log(`[PASS] Query: "${q}" -> matched target "${target}" (${matches.length} total matches)`);
  } else {
    console.error(`[FAIL] Query: "${q}" did NOT match target "${target}"! Matches found: ${matches.map(m => m.title).join(', ')}`);
    queryFailed++;
  }
});

console.log(`\n========================================`);
console.log(`VERIFICATION RESULT: ${testQueries.length - queryFailed}/${testQueries.length} QUERIES PASSED.`);
console.log(`========================================`);
if (queryFailed > 0) process.exit(1);

