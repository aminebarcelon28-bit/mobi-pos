/**
 * Test the raw CDP client against the running Tauri WebView2 app.
 */

import { CdpClient, discoverCdpUrl } from './cdp-client.mjs';

async function main() {
  const info = await discoverCdpUrl(9222);
  console.log('[TEST] Discovered CDP:', info.url, info.title);

  const client = new CdpClient(info.webSocketDebuggerUrl);
  await client.connect();
  console.log('[TEST] Connected to CDP');

  await client.enableDomains();
  console.log('[TEST] CDP domains enabled');

  // Evaluate some JavaScript in the page context
  const title = await client.evaluate('document.title');
  console.log('[TEST] Document title:', title);

  const url = await client.evaluate('window.location.href');
  console.log('[TEST] Document URL:', url);

  // Check if the app shell is loaded
  const bodyText = await client.evaluate('document.body.innerText.substring(0, 200)');
  console.log('[TEST] Body text (first 200 chars):', bodyText);

  // Check for the refund button
  const refundBtnCount = await client.evaluate(`
    Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('Remboursement')).length
  `);
  console.log('[TEST] Refund buttons found:', refundBtnCount);

  // Get console events
  await new Promise((r) => setTimeout(r, 1000));
  const consoleEvents = client.getConsoleEvents();
  console.log('[TEST] Console events:', consoleEvents.length);

  await client.close();
  console.log('[TEST] Disconnected');
  console.log('[TEST] CDP client test PASSED');
}

main().catch((e) => {
  console.error('[TEST] FAILED:', e.message);
  process.exit(1);
});