import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const dbPath = path.join(process.env.APPDATA || '', 'com.mobi.pos', 'mobi_pos.db');
const db = new DatabaseSync(dbPath);
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

function searchCatalog(searchQuery, selectedCategory = 'Tous les produits', selectedBrand = 'Tous', stockAlertOnly = false, magsafeOnly = false) {
  const q = normalizeForSearch(searchQuery.trim());
  const cleanQ = q.replace(/[^a-z0-9]/g, '');

  return rows.filter((product) => {
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
    const normImei = product.imeiNumber ? normalizeForSearch(product.imeiNumber) : '';

    if (
      normTitle.includes(q) ||
      normSku.includes(q) ||
      normBarcode.includes(q) ||
      (normImei && normImei.includes(q)) ||
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
  'Cable',
  'Câble',
  'Souris',
  'USB',
  'Chargeur',
  'Ecouteurs',
  'Écouteurs',
  'HDMI',
  'Batterie',
  'Enceinte',
  'Support',
  'Clavier'
];

for (const query of testQueries) {
  const hits = searchCatalog(query);
  console.log(`Query "${query}" matched ${hits.length} items. Target hits:`, hits.filter(h => h.id.startsWith('prod_batch_0c514277')).map(h => h.title));
}

