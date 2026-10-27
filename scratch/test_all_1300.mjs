import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';

const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'com.mobi.pos', 'mobi_pos.db');
const db = new Database(dbPath);
const rows = db.prepare('SELECT * FROM products WHERE deleted = 0').all();

function normalizeForSearch(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase();
}

function mapSqlRowToProduct(r) {
  let base = {};
  try {
    base = JSON.parse(String(r.json_payload ?? '{}'));
  } catch {}
  return {
    ...base,
    id: String(r.id),
    sku: String(r.sku ?? base.sku ?? ''),
    barcode: String(r.barcode ?? base.barcode ?? ''),
    title: String(r.title ?? base.title ?? r.id),
    brand: ((r.brand && String(r.brand).trim()) || (base.brand && String(base.brand).trim()) || 'Autre'),
    category: ((r.category && String(r.category).trim()) || (base.category && String(base.category).trim()) || 'Tous les produits'),
    price: Number(r.price ?? base.price ?? 0),
    stock: Number(r.stock ?? base.stock ?? 0),
  };
}

const products = rows.map(mapSqlRowToProduct);

function filterProducts(searchQuery, selectedCategory = 'Tous les produits', selectedBrand = 'Tous', stockAlertOnly = false, magsafeOnly = false) {
  const q = normalizeForSearch(searchQuery.trim());
  const cleanQ = q.replace(/[^a-z0-9]/g, '');
  return products.filter((product) => {
    const matchesCategory = !q
      ? selectedCategory === 'Tous les produits' || (product.category?.trim() || 'Tous les produits') === selectedCategory
      : true;
    const matchesBrand = !q
      ? selectedBrand === 'Tous' || product.brand === selectedBrand
      : true;
    const matchesStockAlert = !q ? (!stockAlertOnly || product.stock <= (product.reorderPoint || 10)) : true;
    const matchesMagsafe = !q ? (!magsafeOnly || product.isMagSafe === true) : true;

    if (!matchesCategory || !matchesStockAlert || !matchesBrand || !matchesMagsafe) return false;
    if (!q) return true;

    const normTitle = normalizeForSearch(product.title);
    const normSku = normalizeForSearch(product.sku);
    const normBarcode = normalizeForSearch(product.barcode);
    const normBrand = normalizeForSearch(product.brand);
    const normModel = normalizeForSearch(product.compatibleModel);

    if (
      normTitle.includes(q) ||
      normSku.includes(q) ||
      normBarcode.includes(q) ||
      normBrand.includes(q) ||
      normModel.includes(q)
    ) {
      return true;
    }

    if (cleanQ.length >= 3) {
      const cleanSku = normSku.replace(/[^a-z0-9]/g, '');
      const cleanBarcode = normBarcode.replace(/[^a-z0-9]/g, '');
      if (cleanSku.includes(cleanQ) || cleanBarcode.includes(cleanQ)) {
        return true;
      }
    }

    return false;
  });
}

const testQueries = [
  'cable',
  'souris',
  'cle',
  'chargeur',
  'ecouteur',
  'hdmi',
  'batterie',
  'enceinte',
  'support',
  'clavier',
  '6130000000015',
  'CAB-AUT-1001',
];

for (const t of testQueries) {
  const matches = filterProducts(t);
  const targetMatches = matches.filter(p => p.id.includes('batch_0c514277_1792601581432'));
  console.log(`Query '${t}': total matches = ${matches.length}, target matches = ${targetMatches.length}`);
  for (const tm of targetMatches) {
    console.log(`   -> [${tm.id}] ${tm.title} (${tm.sku}, ${tm.barcode})`);
  }
}

