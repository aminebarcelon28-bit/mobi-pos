import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';

const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'com.mobi.pos', 'mobi_pos.db');
console.log('Opening DB at:', dbPath);

const db = new Database(dbPath);
const rows = db.prepare('SELECT * FROM products WHERE deleted = 0').all();
console.log('Total non-deleted rows in SQLite:', rows.length);

function mapSqlRowToProduct(r) {
  let base = {};
  try {
    base = JSON.parse(String(r.json_payload ?? '{}'));
  } catch {
    // keep base empty
  }
  return {
    ...base,
    id: String(r.id),
    sku: String(r.sku ?? base.sku ?? ''),
    barcode: String(r.barcode ?? base.barcode ?? ''),
    title: String(r.title ?? base.title ?? r.id),
    brand: ((r.brand && String(r.brand).trim()) || (base.brand && String(base.brand).trim()) || 'Autre'),
    category: ((r.category && String(r.category).trim()) || (base.category && String(base.category).trim()) || 'Tous les produits'),
    price: Number(r.price ?? base.price ?? 0),
    wholesalePrice: Number(r.wholesale_price ?? base.wholesalePrice ?? 0),
    semiWholesalePrice: typeof base.semiWholesalePrice === 'number' ? base.semiWholesalePrice : undefined,
    costPrice: Number(r.cost_price ?? base.costPrice ?? 0),
    stock: Number(r.stock ?? base.stock ?? 0),
    imageUrl: String(r.image_url ?? base.imageUrl ?? ''),
    isSerialized: Boolean(r.is_serialized ?? base.isSerialized),
    imeiNumber: r.imei_number ?? base.imeiNumber,
    vendorName: String(r.vendor_name ?? base.vendorName ?? 'Fournisseur Général'),
    leadTimeDays: Number(r.lead_time_days ?? base.leadTimeDays ?? 7),
    dailySalesVelocity: Number(r.daily_sales_velocity ?? base.dailySalesVelocity ?? 0),
    reorderPoint: Number(r.reorder_point ?? base.reorderPoint ?? 5),
    compatibleModel: String(r.compatible_model ?? base.compatibleModel ?? ''),
  };
}

const products = rows.map(mapSqlRowToProduct);
console.log('Mapped products count:', products.length);

const targets = products.filter(p => p.id.includes('batch_0c514277_1792601581432'));
console.log('Found targets in mapped list:', targets.length);
for (const t of targets) {
  console.log(`- [${t.id}] ${t.title} | ${t.sku} | ${t.barcode} | stock:${t.stock} | cat:${t.category}`);
}

