/**
 * TIM-09 — "Mobile in another timezone/VPN/roaming; warranty, quote and
 * loyalty expiry: evaluated in shop timezone, displayed consistently (WAR-03)".
 *
 * Method (no second physical device needed):
 *   1. Seed ONE sale into the APK's own DB at an instant whose SHOP day and
 *      DEVICE day differ: 2026-10-26T00:30:00Z
 *        shop   Africa/Algiers (UTC+1) -> 26 Oct 01:30
 *        device Pacific/Midway (UTC-11) -> 25 Oct 13:30
 *   2. Move the emulator to Pacific/Midway (root: cmd alarm set-timezone).
 *   3. Read the Activité tab:
 *        - the "Aujourd'hui" KPI is a SHOP-day bucket (dateUtils.ts:11-28), so
 *          it must include the sale (500 DA);
 *        - the feed row time is rendered with device-local Intl
 *          (LiveActivityTab.tsx:866-875), so it shows 13:30 while the shop
 *          time of the same sale is 01:30 (WAR-03: "same date shown on
 *          receipt, desktop, mobile").
 *   4. Restore the original DB + timezone.
 *
 * Prints PROOF lines and a final TIM09_RESULT=PASS|FAIL.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import * as adb from '../mobile/lib/adb.mjs';
import { dismissMobileOverlays, mobileLogin } from '../lib/session.mjs';

const SHOP_TZ = 'Africa/Algiers';
const DEVICE_TZ = 'Pacific/Midway';
const INSTANT = '2026-10-26T00:30:00.000Z';
const TOTAL = 500;

const { sleep, shell, ocrScreen, tap, screenshot, startApp, stopApp } = adb;
const log = (k, v) => console.log(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
const flat = (l) => l.map((x) => x.text).join(' | ');

function fmt(instant, tz) {
  const d = new Date(instant);
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const time = new Intl.DateTimeFormat('fr-FR', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
  return { day, time };
}

// ── 1. Seed ────────────────────────────────────────────────────────────────
const pulled = adb.pullDb('tim09');
const db = pulled.db;
const dir = pulled.dir;
const backup = path.join(dir, 'mobi_pos.orig.db');
fs.copyFileSync(path.join(dir, 'mobi_pos.db'), backup);

db.pragma('foreign_keys = OFF');
db.prepare('DELETE FROM transaction_items WHERE transaction_id = ?').run('T9-TX-1');
db.prepare('DELETE FROM transactions WHERE id = ?').run('T9-TX-1');
db.prepare('DELETE FROM products WHERE id = ?').run('T9-PROD-1');
db.prepare(
  `INSERT INTO products (id, sku, barcode, title, brand, category, price, cost_price, stock,
     json_payload, updated_at, idempotency_key, created_at, deleted, version)
   VALUES (?, ?, ?, ?, 'T9', 'T9', ?, 300, 10, '{}', datetime('now','utc'), 't9-p', datetime('now','utc'), 0, 1)`,
).run('T9-PROD-1', 'T9-SKU-1', 'T9000001', 'T9 ARTICLE FRONTIERE', TOTAL);
db.prepare(
  `INSERT INTO transactions (id, receipt_number, subtotal, discount_total, total, cost_total, profit,
     payment_method, status, created_at, json_payload, idempotency_key, updated_at, deleted, version)
   VALUES (?, ?, ?, 0, ?, 300, 200, 'Espèces', 'COMPLETED', ?, '{}', 't9-tx', datetime('now','utc'), 0, 1)`,
).run('T9-TX-1', 'T9-REC-1', TOTAL, TOTAL, INSTANT);
db.prepare(
  `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, discount,
     cost_price, json_payload, idempotency_key, created_at, updated_at, deleted, version)
   VALUES (?, ?, ?, 1, ?, 0, 300, '{}', 't9-item', ?, datetime('now','utc'), 0, 1)`,
).run('T9-ITEM-1', 'T9-TX-1', 'T9-PROD-1', TOTAL, INSTANT);
log('seeded_products', db.prepare('SELECT COUNT(*) c FROM products').get().c);
log('seeded_transactions', db.prepare('SELECT COUNT(*) c FROM transactions').get().c);
db.close();

adb.pushDbFile(path.join(dir, 'mobi_pos.db'), 'tim09.db');
log('db_pushed', path.join(dir, 'mobi_pos.db'));

// ── 2. Move the device ────────────────────────────────────────────────────
shell(`cmd alarm set-timezone ${DEVICE_TZ}`);
sleep(1500);
log('device_tz', shell('getprop persist.sys.timezone').trim());
log('device_date', shell('date').trim());

const shop = fmt(INSTANT, SHOP_TZ);
const dev = fmt(INSTANT, DEVICE_TZ);
log('sale_instant', INSTANT);
log('shop_day_time', `${shop.day} ${shop.time} (${SHOP_TZ})`);
log('device_day_time', `${dev.day} ${dev.time} (${DEVICE_TZ})`);
log('discriminating', shop.day !== dev.day);

// ── 3. Read the app ───────────────────────────────────────────────────────
stopApp();
startApp();
sleep(9000);
await dismissMobileOverlays(40000);
const login = await mobileLogin('2020');
log('login', { completed: login.completed, alreadyUnlocked: login.alreadyUnlocked, error: login.error });

let screen = ocrScreen('tim09-activity');
let text = flat(screen);
log('activity_screen', text.slice(0, 900));
const shot = screenshot('tim09-activity');
log('shot', shot);

const kpiHasSale = new RegExp(`\\b${TOTAL}\\b`).test(text);
const showsShopTime = text.includes(shop.time);
const showsDeviceTime = text.includes(dev.time);

// Catalogue probe (also the P1-67 check): does a seeded product render?
tapTextSafe(/^Articles$/);
sleep(2500);
const cat = flat(ocrScreen('tim09-catalog'));
log('catalog_screen', cat.slice(0, 700));
const productVisible = /T9 ARTICLE FRONTIERE/i.test(cat);
log('product_visible_after_db_push', productVisible);

// ── 4. Verdict ────────────────────────────────────────────────────────────
// Evaluated in shop TZ  -> KPI (today) must include the sale.
// Displayed consistently -> the feed time must be the SHOP time, not the
// device time (WAR-03 compares receipt/desktop/mobile for the same sale).
const evalOk = kpiHasSale;
const displayOk = showsShopTime && !showsDeviceTime;
log('kpi_includes_sale', kpiHasSale);
log('feed_shows_shop_time', showsShopTime);
log('feed_shows_device_time', showsDeviceTime);
log('TIM09_RESULT', evalOk && displayOk ? 'PASS' : 'FAIL');

// ── 5. Restore ────────────────────────────────────────────────────────────
shell('cmd alarm set-timezone Africa/Lagos');
adb.pushDbFile(backup, 'tim09-restore.db');
log('restored_tz', shell('getprop persist.sys.timezone').trim());
log('restored_db', 'original pull pushed back');

function tapTextSafe(re) {
  const hit = screen.find((l) => re.test(l.text.trim()));
  if (!hit) {
    log('tap_miss', String(re));
    return false;
  }
  tap(hit.cx, hit.cy);
  return true;
}
