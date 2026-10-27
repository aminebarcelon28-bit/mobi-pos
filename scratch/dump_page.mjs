import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('http://localhost:1420', { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.waitForTimeout(3000);

  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log('=== BODY TEXT ===');
  console.log(bodyText.slice(0, 500));

  await page.screenshot({ path: 'scratch/live_page.png' });
  console.log('Screenshot saved to scratch/live_page.png');

  await browser.close();
}

main().catch(console.error);

