import { resetApp, openCaisse, openCatalog, addFirstProduct, checkoutCash, pullDb, ocrScreen, requireBaseline } from './lib/adb.mjs';

// Fixtures are local-only (see .gitignore). Refuse to start rather than fail
// mid-suite with an ENOENT stack trace.
requireBaseline();

describe('mobile smoke', function () {
  this.timeout(300000);
  it('resets, starts, adds a product and checks out', async () => {
    const start = await resetApp();
    console.log('[SMOKE] start=' + start.hit.text);
    await openCaisse();
    await openCatalog();
    await addFirstProduct();
    const cart = ocrScreen('smoke-cart');
    console.log('[SMOKE] cart=' + cart.map((l) => l.text).join(' | ').slice(0, 300));
    const receipt = await checkoutCash();
    console.log('[SMOKE] receipt=' + receipt.hit.text);
    const { db, dir } = pullDb('smoke');
    const tx = db.prepare('SELECT id, receipt_number, total, status FROM transactions ORDER BY rowid DESC LIMIT 1').get();
    console.log('[SMOKE] db=' + JSON.stringify(tx) + ' dir=' + dir);
    db.close();
  });
});
