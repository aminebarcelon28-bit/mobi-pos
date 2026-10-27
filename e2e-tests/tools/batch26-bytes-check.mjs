import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { buildReceiptBytes, buildReceiptBytesInTZ } from './escpos-bytes.mjs';

const dbPath = path.join(
  process.env.TEMP || os.tmpdir(),
  'opencode',
  'pos-wdio-sandbox',
  'home',
  'AppData',
  'Roaming',
  'com.mobi.pos.e2e',
  'mobi_pos.db',
);
const db = new Database(dbPath, { readonly: true });
const row = db.prepare('SELECT json_payload FROM transactions ORDER BY rowid DESC LIMIT 1').get();
const settingsRow = db
  .prepare("SELECT value_json FROM app_settings WHERE key = 'mobi_pos_receipt_settings'")
  .get();
db.close();

const tx = JSON.parse(row.json_payload);
const settings = settingsRow ? JSON.parse(settingsRow.value_json) : {};

const textOf = (bytes) =>
  bytes.map((b) => (b === 0x0a ? '\n' : b >= 32 && b < 127 ? String.fromCharCode(b) : '')).join('');

const base = await buildReceiptBytes(tx, settings);
const lagos = await buildReceiptBytesInTZ(tx, settings, 'Africa/Lagos');
const paris = await buildReceiptBytesInTZ(tx, settings, 'Asia/Tokyo');
const pick = (t) => t.split('\n').filter((l) => l.includes('Date:')).join(' | ');
console.log('base  ', pick(textOf(base)));
console.log('lagos ', pick(textOf(lagos)));
console.log('paris ', pick(textOf(paris)));
console.log('bytes', base.length, lagos.length, paris.length);
