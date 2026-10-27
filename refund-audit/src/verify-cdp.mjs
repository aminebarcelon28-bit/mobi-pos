/**
 * Quick CDP connectivity verification script
 * Tests that Playwright can connect to the Tauri WebView2 via CDP
 */

import { chromium } from '@playwright/test';

async function main() {
  const wsUrl = 'ws://localhost:9222/devtools/page/173ADE09AB83CDCDA145B08CF8FA648C';
  
  console.log('[VERIFY] Connecting to CDP at', wsUrl);
  const browser = await chromium.connectOverCDP(wsUrl);
  console.log('[VERIFY] Connected to browser');
  
  const contexts = browser.contexts();
  console.log('[VERIFY] Contexts:', contexts.length);
  
  const context = contexts[0];
  const pages = context.pages();
  console.log('[VERIFY] Pages:', pages.length);
  
  if (pages.length > 0) {
    const page = pages[0];
    console.log('[VERIFY] Page title:', await page.title());
    console.log('[VERIFY] Page URL:', page.url());
    
    // Try to interact with the page
    const bodyText = await page.locator('body').textContent().catch(() => '(empty)');
    console.log('[VERIFY] Body text (first 200 chars):', bodyText.substring(0, 200));
    
    // Check if app shell is loaded
    const appReady = await page.locator('body').isVisible();
    console.log('[VERIFY] Body visible:', appReady);
  }
  
  await browser.close();
  console.log('[VERIFY] Disconnected');
  console.log('[VERIFY] CDP connectivity verified OK');
}

main().catch((e) => {
  console.error('[VERIFY] FAILED:', e.message);
  process.exit(1);
});