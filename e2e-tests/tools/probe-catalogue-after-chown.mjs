import { stopApp, startApp, sleep, ocrScreen, openCaisse, openCatalog } from '../mobile/lib/adb.mjs';
import { dismissMobileOverlays } from '../lib/session.mjs';

const flat = (l) => l.map((x) => x.text).join(' | ').slice(0, 700);

async function main() {
  stopApp();
  sleep(1200);
  startApp();
  sleep(8000);
  const ov = await dismissMobileOverlays(60000);
  console.log('overlays=' + JSON.stringify({ reachedTill: ov.reachedTill, denials: ov.denials, closes: ov.closes }));
  console.log('after_overlay_ocr=' + ov.screen);
  try {
    await openCaisse();
    const cat = await openCatalog();
    const lines = Array.isArray(cat) ? cat : (cat?.lines ?? []);
    const txt = flat(lines);
    console.log('catalogue_ocr=' + txt);
    const m = txt.match(/(\d[\d\s.,]*)\s*(?:articles?|r[ée]sultats?)/i);
    console.log('visible_count=' + (m ? m[1].trim() : 'null'));
  } catch (e) {
    console.log('NAV_ERROR=' + String(e.message).slice(0, 300));
  }
}
main();
