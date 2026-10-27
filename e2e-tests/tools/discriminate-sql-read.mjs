/**
 * Discriminator: with a VALID restored profile (ensureMobileSession), does the
 * app see ANY SQLite data at all?
 *
 *   customers visible + products not -> product-specific read bug
 *   nothing visible                  -> whole WebView SQL read is dead
 */
import { ocrScreen, openCaisse, findLine, tap, sleep, pullDb } from '../mobile/lib/adb.mjs';
import { ensureMobileSession } from '../lib/session.mjs';

const flat = (l) => l.map((x) => x.text).join(' | ').slice(0, 700);
const log = (k, v) => console.log(`${k}=${v}`);

async function main() {
  const s = await ensureMobileSession();
  log('session_reachedTill', s.reachedTill);

  await openCaisse();
  let lines = ocrScreen('disc-caisse');
  log('caisse_ocr', flat(lines));

  // Open the customer picker ("Sélectionner" / client selector).
  const pick = findLine(lines, /S.lectionner|Client|client/i);
  if (pick) {
    tap(pick.cx, pick.cy);
    sleep(2500);
    lines = ocrScreen('disc-customers');
    log('customer_picker_ocr', flat(lines));
    const names = lines.map((l) => l.text).filter((t) => /^[A-Z][A-Za-z\u00c0-\u017f' -]{2,}$/.test(t));
    log('customer_name_like', JSON.stringify(names.slice(0, 12)));
  } else {
    log('customer_picker', 'selector not found');
  }

  // Kredy / debt screen also lists customers.
  const kredy = findLine(ocrScreen('disc-nav'), /^Kredy$/i);
  if (kredy) {
    tap(kredy.cx, kredy.cy);
    sleep(2500);
    log('kredy_ocr', flat(ocrScreen('disc-kredy')));
  }

  const { db } = pullDb('disc');
  log('db_customers', db.prepare('SELECT COUNT(*) n FROM customers').get().n);
  log('db_products_live', db.prepare('SELECT COUNT(*) n FROM products WHERE deleted=0').get().n);
  db.close();
}

main().catch((e) => {
  log('ERROR', String(e.message).slice(0, 400));
});
