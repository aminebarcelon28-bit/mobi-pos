import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';

const db = path.join(
  os.tmpdir(),
  'opencode',
  'pos-wdio-sandbox',
  'home',
  'AppData',
  'Roaming',
  'com.mobi.pos.e2e',
  'mobi_pos.db',
);
const d = new Database(db, { readonly: true });
const rows = d.prepare('SELECT id, created_at, json_payload FROM transactions ORDER BY rowid ASC').all();
console.log('total tx', rows.length);
for (const r of rows) {
  let p = {};
  try {
    p = JSON.parse(r.json_payload || '{}');
  } catch {
    continue;
  }
  const items = (p.items || p.cart || []).map((i) => i.name || i.product?.title || '').join('|');
  if (!/Cable USB-C/i.test(items)) continue;
  console.log(
    r.id,
    r.created_at,
    'customer=',
    JSON.stringify(p.customer?.name ?? null),
    'items=',
    JSON.stringify(items.slice(0, 60)),
    'total=',
    p.total,
  );
}
d.close();
