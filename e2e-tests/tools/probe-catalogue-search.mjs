import { stopApp, startApp, sleep, ocrScreen, openCaisse, openCatalog, tap, findLine, text } from '../mobile/lib/adb.mjs';
import { dismissMobileOverlays } from '../lib/session.mjs';

const flat = (l) => l.map((x) => x.text).join(' | ').slice(0, 700);

async function main() {
  stopApp(); sleep(1000); startApp(); sleep(8000);
  await dismissMobileOverlays(60000);
  await openCaisse();
  let cat = await openCatalog();
  let lines = Array.isArray(cat) ? cat : (cat?.lines ?? []);
  console.log('before_search=' + flat(lines));

  // Tap the search box and type a broad token.
  const search = findLine(lines, /Nom, code-barres|Recherche|r.f.rence/i);
  if (search) {
    tap(search.cx, search.cy);
    sleep(800);
    text('a');
    sleep(2500);
    lines = ocrScreen('catalogue-search-a');
    console.log('after_search=' + flat(lines));
  } else {
    console.log('search_box=not_found');
  }

  // Also try a very common product word if present in the DB.
  const clear = findLine(lines, /Effacer la recherche/i);
  if (clear) { tap(clear.cx, clear.cy); sleep(1200); }
  const search2 = findLine(ocrScreen('catalogue-re'), /Nom, code-barres|Recherche|r.f.rence/i);
  if (search2) {
    tap(search2.cx, search2.cy); sleep(600); text('phone'); sleep(2500);
    console.log('after_search_phone=' + flat(ocrScreen('catalogue-search-phone')));
  }
}
main();
