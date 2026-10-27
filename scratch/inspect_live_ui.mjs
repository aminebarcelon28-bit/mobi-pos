import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err));

  console.log('Navigating to http://localhost:1420 ...');
  await page.goto('http://localhost:1420', { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.waitForTimeout(2000);

  // Get title
  const title = await page.title();
  console.log('Page Title:', title);

  // Check what is on screen
  const setupRoot = await page.locator('[data-testid="setup-pin-root"]').count();
  console.log('Setup PIN root visible count:', setupRoot);

  const lockPrompt = await page.getByText(/SÉLECTIONNEZ VOTRE COMPTE/i).count();
  console.log('Lock prompt count:', lockPrompt);

  const catalogSearch = await page.locator('#catalog-search').count();
  console.log('Catalog search bar count:', catalogSearch);

  // Search for Dexie databases
  const dexieData = await page.evaluate(async () => {
    return new Promise((resolve) => {
      const req = indexedDB.open('MobiPOSDatabase');
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('products')) {
          resolve({ error: 'no products store', stores: Array.from(db.objectStoreNames) });
          return;
        }
        const tx = db.transaction('products', 'readonly');
        const store = tx.objectStore('products');
        const countReq = store.count();
        countReq.onsuccess = () => {
          const getAllReq = store.getAll();
          getAllReq.onsuccess = () => {
            const prods = getAllReq.result;
            const targetProds = prods.filter(p => 
              p.title?.toLowerCase().includes('cable') ||
              p.title?.toLowerCase().includes('câble') ||
              p.title?.toLowerCase().includes('souris') ||
              p.title?.toLowerCase().includes('clé') ||
              p.title?.toLowerCase().includes('cle') ||
              p.id?.includes('batch')
            );
            resolve({
              count: countReq.result,
              targetFound: targetProds.length,
              samples: targetProds.slice(0, 10).map(p => ({ id: p.id, title: p.title, stock: p.stock, sku: p.sku, barcode: p.barcode }))
            });
          };
        };
      };
      req.onerror = (e) => resolve({ error: String(e) });
    });
  });
  console.log('IndexedDB Dexie products:', JSON.stringify(dexieData, null, 2));

  await browser.close();
}

main().catch(console.error);

