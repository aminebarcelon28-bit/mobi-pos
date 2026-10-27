/**
 * DECISIVE TEST for P1-67 (v2 — uses the fixed first-run helper).
 *
 *   A_PRODUCT_BUG      -> catalogue stays 0 even with a valid, app-created profile
 *   B_HARNESS_ARTIFACT -> catalogue shows products once the profile is valid;
 *                         the earlier 0 came from a restored/stale WebView mirror
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import {
  shell, adb, stopApp, startApp, sleep, ocrScreen, openCaisse, openCatalog,
  findLine, tap, PACKAGE, pullDb,
} from '../mobile/lib/adb.mjs';
import { dismissMobileOverlays, mobileFirstRunSetup, ensureAdbRoot, MANAGER_PIN } from '../lib/session.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const flat = (l) => l.map((x) => x.text).join(' | ').slice(0, 500);
const log = (k, v) => console.log(`${k}=${v}`);
const countFromOcr = (txt) => {
  const m = txt.match(/(\d[\d\s.,]*)\s*(?:articles?|r[ée]sultats?)/i);
  return m ? m[1].replace(/[^\d]/g, '') : null;
};

async function catalogue(tag) {
  const c = await openCaisse();
  const cat = await openCatalog();
  const lines = Array.isArray(cat) ? cat : (cat?.lines ?? []);
  const txt = flat(lines);
  log(`${tag}_ocr`, txt);
  const n = countFromOcr(txt);
  log(`${tag}_count`, n);
  return { txt, n };
}

async function main() {
  await ensureAdbRoot();

  // 1. Fresh install
  stopApp();
  shell(`pm clear ${PACKAGE}`);
  sleep(1500);
  log('step1', 'pm clear done');

  // 2. First-run setup (helper now dismisses overlays first)
  const setup = await mobileFirstRunSetup(MANAGER_PIN);
  log('setup_alreadyProvisioned', setup.alreadyProvisioned);
  log('setup_completed', setup.completed);
  log('setup_screen', setup.screen);

  // 3. Catalogue on the fresh, empty DB
  let fresh = { n: null, txt: '' };
  try {
    fresh = await catalogue('fresh');
  } catch (e) {
    log('fresh_NAV_ERROR', String(e.message).slice(0, 200));
  }

  // 4. Seed the 1307-product DB onto the valid profile
  const src = 'mobile/tmp/proof-session/mobi_pos.db';
  const check = new Database(src, { readonly: true });
  const nSrc = check.prepare('SELECT COUNT(*) n FROM products WHERE deleted=0').get().n;
  check.close();
  log('seed_source_products', nSrc);

  stopApp();
  adb(['push', src, '/data/local/tmp/seed-1307.db']);
  shell(`rm -f /data/data/${PACKAGE}/mobi_pos.db /data/data/${PACKAGE}/mobi_pos.db-wal /data/data/${PACKAGE}/mobi_pos.db-shm`);
  shell(`cp /data/local/tmp/seed-1307.db /data/data/${PACKAGE}/mobi_pos.db`);
  const uid = shell(`stat -c %u:%g /data/data/${PACKAGE}`).trim();
  shell(`chown ${uid} /data/data/${PACKAGE}/mobi_pos.db`);
  shell(`chmod 600 /data/data/${PACKAGE}/mobi_pos.db`);
  try { shell(`restorecon /data/data/${PACKAGE}/mobi_pos.db`); } catch { /* best effort */ }
  log('seed_pushed', `uid=${uid}`);

  // 5. Restart and look again
  startApp();
  sleep(10000);
  const ov = await dismissMobileOverlays(60000);
  log('after_seed_overlays', JSON.stringify({ reachedTill: ov.reachedTill, denials: ov.denials, closes: ov.closes }));

  let seeded = { n: null, txt: '' };
  try {
    seeded = await catalogue('seeded');
  } catch (e) {
    log('seeded_NAV_ERROR', String(e.message).slice(0, 200));
  }

  // 6. DB truth
  const { db } = pullDb('p167-v2');
  const live = db.prepare('SELECT COUNT(*) n FROM products WHERE deleted=0').get().n;
  db.close();
  log('db_live_products', live);

  log('FRESH_CATALOGUE_COUNT', fresh.n);
  log('SEEDED_CATALOGUE_COUNT', seeded.n);
  log('P167_VERDICT', seeded.n !== null && Number(seeded.n) > 0 ? 'B_HARNESS_ARTIFACT' : 'A_PRODUCT_BUG');
}

main().catch((e) => {
  console.log('P167_VERDICT=ERROR');
  console.log('error=' + String(e.message).slice(0, 500));
});
