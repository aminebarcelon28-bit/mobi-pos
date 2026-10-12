import { chromium } from '@playwright/test';

async function main() {
  console.log('Connecting to desktop WebView2 over CDP on http://127.0.0.1:9222 ...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  console.log('Contexts count:', contexts.length);
  const context = contexts[0];
  const pages = context.pages();
  console.log('Pages count:', pages.length);
  const page = pages[0] || (await context.waitForEvent('page'));
  console.log('Target Page Title:', await page.title());
  console.log('Target Page URL:', page.url());

  // Test basic evaluate
  const result = await page.evaluate(() => {
    return {
      hasTauriInternals: Boolean(window.__TAURI_INTERNALS__),
      userAgent: navigator.userAgent,
    };
  });
  console.log('Evaluate result:', result);

  await browser.close();
  console.log('Probe finished successfully.');
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exit(1);
});

