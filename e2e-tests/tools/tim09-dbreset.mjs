/** Does the app replace a pushed DB at boot? (stat before/after + counts) */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as adb from '../mobile/lib/adb.mjs';
import { fileURLToPath } from 'node:url';

const { shell, sleep, startApp, stopApp } = adb;
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mobile', 'tmp', 'tim09');
const SRC = path.join(DIR, 'mobi_pos.db');

// Re-seed from the pristine copy so the test is repeatable.
const pristine = path.join(DIR, 'mobi_pos.orig.db');
fs.copyFileSync(pristine, SRC);
const db = new Database(SRC);
db.prepare('DELETE FROM products WHERE id = ?').run('T9-PROD-1');
db.prepare(
  `INSERT INTO products (id, sku, barcode, title, brand, category, price, cost_price, stock,
     json_payload, updated_at, idempotency_key, created_at, deleted, version)
   VALUES ('T9-PROD-1','T9-SKU-1','T9000001','T9 ARTICLE FRONTIERE','T9','T9',500,300,10,'{}',
     datetime('now','utc'),'t9-p',datetime('now','utc'),0,1)`,
).run();
console.log('local_products=' + db.prepare('SELECT COUNT(*) c FROM products').get().c);
db.close();

stopApp();
adb.pushDbFile(SRC, 't9stat.db');
const stat = () =>
  shell(
    `stat -c '%n size=%s uid=%u gid=%g ino=%i mtime=%Y' /data/data/com.mobi.pos/mobi_pos.db`,
  ).trim();
console.log('BEFORE_BOOT ' + stat());
console.log('DIRLIST ' + shell('ls -la /data/data/com.mobi.pos/ | head -30').replace(/\s+/g, ' '));
console.log('DBDIR ' + shell('ls -la /data/data/com.mobi.pos/databases 2>/dev/null | head -20').replace(/\s+/g, ' '));
console.log('FILESDIR ' + shell('ls -la /data/data/com.mobi.pos/files 2>/dev/null | head -20').replace(/\s+/g, ' '));

startApp();
sleep(9000);
console.log('AFTER_BOOT ' + stat());
console.log('DIRLIST2 ' + shell('ls -la /data/data/com.mobi.pos/ | head -30').replace(/\s+/g, ' '));

const pulled = adb.pullDb('tim09-stat-after');
console.log('after_products=' + pulled.db.prepare('SELECT COUNT(*) c FROM products').get().c);
console.log('after_settings=' + pulled.db.prepare('SELECT COUNT(*) c FROM app_settings').get().c);
console.log(
  'settings_rows=' +
    JSON.stringify(pulled.db.prepare('SELECT key FROM app_settings').all().map((r) => r.key)),
);
pulled.db.close();
