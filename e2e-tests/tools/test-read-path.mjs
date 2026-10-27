/**
 * Read-path test: type a real SKU from the DB into the till and see whether
 * the app can resolve it into the cart. If it can, the SQLite read path works
 * and the empty catalogue is a list/hydration problem. If not, reads are dead.
 */
import { ocrScreen, openCaisse, findLine, tap, sleep, text, key } from '../mobile/lib/adb.mjs';
import { ensureMobileSession } from '../lib/session.mjs';

const flat = (l) => l.map((x) => x.text).join(' | ').slice(0, 600);
const log = (k, v) => console.log(`${k}=${v}`);

async function main() {
  await ensureMobileSession();
  await openCaisse();
  let lines = ocrScreen('scan-1');
  log('caisse_before', flat(lines));

  // Tap the scan input/button, then type a real SKU and press Enter.
  const scan = findLine(lines, /Scanner un Code-Barres|Scanner/i);
  if (scan) {
    tap(scan.cx, scan.cy);
    sleep(1500);
    lines = ocrScreen('scan-2');
    log('after_tap_scan', flat(lines));
  }
  text('SRV-CABLE');
  sleep(800);
  key(66); // Enter
  sleep(2500);
  log('after_sku_enter', flat(ocrScreen('scan-3')));

  // Try the catalogue search box instead, with the exact product title word.
  const cat = findLine(ocrScreen('scan-4'), /Catalogue Articles/i);
  if (cat) {
    tap(cat.cx, cat.cy);
    sleep(2000);
    const s = findLine(ocrScreen('scan-5'), /Nom, code-barres|Recherche|r.f.rence/i);
    if (s) {
      tap(s.cx, s.cy);
      sleep(700);
      text('Cable');
      sleep(2500);
      log('catalogue_search_cable', flat(ocrScreen('scan-6')));
    }
  }
}

main().catch((e) => log('ERROR', String(e.message).slice(0, 300)));
