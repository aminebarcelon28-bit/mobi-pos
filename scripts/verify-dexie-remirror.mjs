/**
 * Live proof that the boot remirror re-pulled SQLite truth into Dexie.
 * Attaches to the running Tauri WebView via CDP (:9222) and reads IndexedDB
 * (MobiPosDB/products) directly — no app cooperation needed beyond boot.
 * Run AFTER: reconcile --apply (flag reset) + app relaunch.
 * Expects exactly the 5 reconciled OCC ids at stock 1.
 */
import { chromium } from '@playwright/test';

const IDS = [
  'prod-444e3e47-e6c7-4628-bdb7-2b5187054914', // pixel 8 pro test
  'prod-5c59751b-5c37-45d7-92c0-a541db3660bc', // iphone 12 test
  'prod-f3eca518-b947-4c92-8ee7-944889dc918f', // iphone x
  'prod-fe7dac62-c720-4f89-a183-d48654654dd9', // samsung test
  'prod-dfcd6698-0b11-40e9-b3f6-3845295d0a01', // ipad
];

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => (p.url() || '').includes('localhost:1420')) ?? ctx.pages()[0];
console.log('attached:', page.url());
if (!(page.url() || '').includes('localhost:1420')) {
  console.log('error page — reloading into the live frontend…');
  await page.goto('http://localhost:1420/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
}
await page.waitForTimeout(15000); // boot + idle-deferred remirror + refresh
console.log('now at:', page.url());

const rows = await page.evaluate((ids) => new Promise((resolve) => {
  const out = {};
  let open;
  try {
    open = indexedDB.open('MobiPosDB');
  } catch (e) {
    resolve({ error: String(e) });
    return;
  }
  open.onerror = () => resolve({ error: 'idb-open-failed' });
  open.onsuccess = () => {
    let db;
    try {
      db = open.result;
      const tx = db.transaction('products', 'readonly');
      const store = tx.objectStore('products');
      let pending = ids.length;
      const done = () => { if (--pending === 0) { try { db.close(); } catch {} resolve(out); } };
      ids.forEach((id) => {
        try {
          const req = store.get(id);
          req.onsuccess = () => { out[id] = req.result ? req.result.stock : null; done(); };
          req.onerror = () => { out[id] = 'ERR'; done(); };
        } catch { out[id] = 'EXC'; done(); }
      });
    } catch (e) {
      try {
        if (db) db.close();
      } catch {
        // Best-effort close only.
      }
      resolve({ error: String(e && e.message || e) });
    }
  };
  setTimeout(() => resolve({ error: 'idb-timeout', partial: out }), 15000);
}), IDS);

console.log(JSON.stringify(rows, null, 2));
await page.screenshot({ path: 'artifacts/smoke/dexie_proof.png' });
const fails = IDS.filter((id) => rows[id] !== 1);
if (fails.length === 0 && IDS.every((id) => rows[id] === 1)) {
  console.log('DEXIE PROOF: all 5 reconciled products read stock=1 from the live mirror.');
} else {
  console.log(`DEXIE MISMATCH on: ${fails.join(', ') || 'none'} — full dump above.`);
  process.exitCode = 1;
}
await browser.close();
