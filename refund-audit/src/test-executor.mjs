/**
 * Refund Test Execution Engine — Full Implementation
 *
 * Two execution modes:
 *   1. UI-driven (E2E): Drive the actual refund UI through CDP — dispatches events on DOM elements
 *   2. IPC-driven: Call `refund_sale_atomic` directly via CDP evaluate — real backend, no UI
 *
 * Both modes go through the actual application code. Results are reported separately.
 */

import { CdpClient, discoverCdpUrl } from './cdp-client.mjs';
import {
  checkCumulativeRefundBound,
  checkNoDuplicateRefunds,
  RefundOracle,
} from './test-runner.mjs';
import { writeFileSync, appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = 'refund-audit';
const RESULTS_DIR = join(ROOT, 'results');
const EVIDENCE_DIR = join(ROOT, 'evidence');
const SCREENSHOTS_DIR = join(EVIDENCE_DIR, 'screenshots');
const LOGS_DIR = join(ROOT, 'evidence', 'logs');
const SCENARIOS_FILE = join(ROOT, 'scenarios', 'scenarios.jsonl');

for (const d of [RESULTS_DIR, EVIDENCE_DIR, SCREENSHOTS_DIR, LOGS_DIR, join(ROOT, 'reports')]) {
  mkdirSync(d, { recursive: true });
}

// ---------------------------------------------------------------------------
// Scenario loading
// ---------------------------------------------------------------------------
export function loadScenarios(limit = null, offset = 0, onlyExecutable = false, mode = null) {
  const scenarios = [];
  if (!existsSync(SCENARIOS_FILE)) return scenarios;
  const lines = readFileSync(SCENARIOS_FILE, 'utf8').split('\n').filter((l) => l.trim());
  for (const line of lines) {
    try {
      const s = JSON.parse(line);
      if (onlyExecutable && !s.executable) continue;
      if (mode && s.dimensions.mode !== mode) continue;
      scenarios.push(s);
    } catch { /* skip */ }
  }
  if (offset > 0) scenarios.splice(0, offset);
  if (limit !== null) scenarios.splice(limit);
  return scenarios;
}

// ---------------------------------------------------------------------------
// CDP UI App Helpers
// ---------------------------------------------------------------------------

const APP_READY_CHECK = `
  () => {
    const t = document.body.innerText;
    return t.includes('VENTE EN COURS') || t.includes('Tableau de bord') || t.includes('MobiPOS');
  }
`;

export class CdpApp {
  constructor(client) {
    this.client = client;
    this.evidenceCounter = 0;
  }

  async waitForAppReady(timeoutMs = 60000) {
    return await this.client.waitForFunction(APP_READY_CHECK, timeoutMs);
  }

  async unlockIfNeeded(managerPin = '789012') {
    const lockVisible = await this.client.evaluate(`
      () => document.body.innerText.includes('SÉLECTIONNEZ VOTRE COMPTE CAISSIER')
    `);
    if (lockVisible) {
      console.log('[UI] Lock screen detected, unlocking...');
      await this.client.fill('input[type="password"]', managerPin);
      await this.client.clickByText('button', 'Valider', false);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async openShiftIfNeeded(openingFloat = 20000) {
    const openBtnVisible = await this.client.evaluate(`
      () => Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('Ouvrir Caisse'))
    `);
    if (openBtnVisible) {
      console.log('[UI] Opening shift...');
      await this.client.clickByText('button', 'Ouvrir Caisse', false);
      await new Promise((r) => setTimeout(r, 1000));
      await this.client.clickByText('button', 'Montant Direct', false);
      await new Promise((r) => setTimeout(r, 500));
      await this.client.fill('input[placeholder*="20 000 DA"]', String(openingFloat));
      await this.client.clickByText('button', 'Valider & Ouvrir', false);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async openRefundModal() {
    await this.client.clickByText('button', 'Remboursement', false);
    await new Promise((r) => setTimeout(r, 1000));
    await this.client.waitForFunction(
      `() => document.body.innerText.includes('RETOURS & AVOIRS')`,
      15000
    );
    console.log('[UI] Refund modal opened');
  }

  async searchTransaction(receiptNumber) {
    try {
      await this.client.fill('input[placeholder*="Rechercher N° Ticket"]', receiptNumber);
      await new Promise((r) => setTimeout(r, 800));
    } catch (e) {
      console.warn(`[UI] Search failed: ${e.message}`);
    }
  }

  async selectSaleRow() {
    // Try clicking the first refund-sale-row
    try {
      await this.client.clickTestId('refund-sale-row');
      await new Promise((r) => setTimeout(r, 500));
      return true;
    } catch (e) {
      console.warn(`[UI] Could not select sale row: ${e.message}`);
      return false;
    }
  }

  async enterManagerPin(pin = '789012') {
    try {
      await this.client.fill('input[type="password"]', pin);
    } catch (e) {
      console.warn(`[UI] PIN input failed: ${e.message}`);
    }
  }

  async submitRefund() {
    try {
      await this.client.clickTestId('refund-submit');
      await new Promise((r) => setTimeout(r, 3000));
      return true;
    } catch (e) {
      console.warn(`[UI] Submit failed: ${e.message}`);
      return false;
    }
  }

  async checkResult() {
    const bodyText = await this.client.evaluate('() => document.body.innerText');
    const success = bodyText.includes('validé') || bodyText.includes('succès');
    const error = bodyText.includes('Erreur') || bodyText.includes('erreur') || bodyText.includes('échou');
    return { success, error, bodyText: bodyText.substring(0, 500) };
  }

  async captureScreenshot(label) {
    this.evidenceCounter++;
    try {
      const screenshot = await this.client.send('Page.captureScreenshot', { format: 'png' });
      const fs = await import('fs');
      const path = await import('path');
      const fileName = `EV-${label}-${this.evidenceCounter}.png`;
      const filePath = path.join(SCREENSHOTS_DIR, fileName);
      fs.writeFileSync(filePath, Buffer.from(screenshot.data, 'base64'));
      console.log(`[EVIDENCE] Screenshot: ${filePath}`);
      return filePath;
    } catch (e) {
      console.warn(`[EVIDENCE] Screenshot failed: ${e.message}`);
      return null;
    }
  }

  async closeModal() {
    try {
      await this.client.clickByText('button', 'Annuler', false);
    } catch {
      await this.client.pressKey('Escape');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---------------------------------------------------------------------------
// IPC-driven refund execution (direct Tauri command via CDP)
// ---------------------------------------------------------------------------

/**
 * Call `refund_sale_atomic` directly through the Tauri IPC bridge using window.__TAURI__.
 * This goes through the real backend native command.
 */
export async function invokeRefundSaleAtomic(client, req) {
  const js = `
    (async (req) => {
      try {
        const result = await window.__TAURI__.core.invoke('refund_sale_atomic', { req });
        return { ok: true, value: result };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    })(${JSON.stringify(req)})
  `;
  return await client.evaluate(js);
}

// ---------------------------------------------------------------------------
// Test result recording
// ---------------------------------------------------------------------------

const results = [];

export function recordResult(entry) {
  results.push(entry);
  appendFileSync(join(RESULTS_DIR, 'refund-results.jsonl'), JSON.stringify(entry) + '\n');
}

export function saveResults() {
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    blocked: results.filter((r) => r.status === 'blocked').length,
    errors: results.filter((r) => r.status === 'error').length,
    uiDriven: results.filter((r) => r.executionMode === 'ui').length,
    ipcDriven: results.filter((r) => r.executionMode === 'ipc').length,
  };
  writeFileSync(join(RESULTS_DIR, 'refund-results.json'), JSON.stringify({ summary, results }, null, 2));
  console.log(`\n[RESULTS] Summary: ${JSON.stringify(summary, null, 2)}`);
  return summary;
}

// ---------------------------------------------------------------------------
// Main test execution
// ---------------------------------------------------------------------------

export async function runScenarios(options = {}) {
  const {
    limit = 50,
    offset = 0,
    onlyExecutable = true,
    port = 9222,
    mode = 'ui',
    stopOnFailure = false,
  } = options;

  const scenarios = loadScenarios(limit, offset, onlyExecutable);
  console.log(`[RUNNER] Loaded ${scenarios.length} scenarios, mode=${mode}`);

  // Discover CDP endpoint
  const info = await discoverCdpUrl(port);
  const client = new CdpClient(info.webSocketDebuggerUrl);
  await client.connect();
  await client.enableDomains();

  const app = new CdpApp(client);

  try {
    // Wait for app to be ready
    await app.waitForAppReady();
    await app.unlockIfNeeded();
    await app.openShiftIfNeeded();

    for (const scenario of scenarios) {
      const startTime = Date.now();
      let status = 'passed';
      let errorMessage = null;
      let evidenceId = null;
      let executionMode = mode;

      try {
        console.log(`\n[SCENARIO] ${scenario.id} (${scenario.dimensions.mode}, ${scenario.dimensions.paymentMethod}, ${executionMode})`);

        if (executionMode === 'ui') {
          // UI-driven execution
          await app.openRefundModal();
          await app.searchTransaction(scenario.initialState.sale.receiptNumber);
          const selected = await app.selectSaleRow();
          if (!selected) {
            status = 'failed';
            errorMessage = 'Could not select sale row in UI';
          } else {
            await app.enterManagerPin('789012');
            const submitted = await app.submitRefund();
            if (!submitted) {
              status = 'failed';
              errorMessage = 'UI submit button not found or click failed';
            } else {
              const result = await app.checkResult();
              if (!result.success && result.error) {
                if (scenario.expectedOutcome.allowed === false) {
                  status = 'passed'; // Expected rejection
                } else {
                  status = 'failed';
                  errorMessage = `UI refund failed: ${result.bodyText}`;
                  evidenceId = await app.captureScreenshot(scenario.id);
                }
              }
            }
          }
          await app.closeModal();
        } else {
          // IPC-driven execution through Tauri bridge
          const ipcResult = await invokeRefundSaleAtomic(client, scenario.request);
          if (!ipcResult.ok) {
            if (scenario.expectedOutcome.allowed === false) {
              status = 'passed'; // Expected rejection
            } else {
              status = 'failed';
              errorMessage = `IPC refund failed: ${ipcResult.error}`;
              evidenceId = await app.captureScreenshot(scenario.id);
            }
          } else if (scenario.expectedOutcome.allowed === false) {
            status = 'failed';
            errorMessage = `Expected rejection but IPC refund succeeded`;
          }
        }

        // Run oracle checks (only for successful refunds)
        if (status === 'passed') {
          const o1 = checkCumulativeRefundBound(
            scenario.initialState.sale,
            scenario.initialState.existingRefunds,
            scenario.request
          );
          const o2 = checkNoDuplicateRefunds(
            scenario.initialState.existingRefunds,
            scenario.request.refundId,
            scenario.request.itemsHash
          );
          if (!o1.passed || !o2.passed) {
            status = 'failed';
            errorMessage = (errorMessage ? errorMessage + '; ' : '') +
              `Oracle: cumulative=${o1.passed}, noDupes=${o2.passed}`;
          }
        }
      } catch (e) {
        status = 'error';
        errorMessage = e.message;
        try {
          evidenceId = await app.captureScreenshot(scenario.id);
        } catch { /* ignore */ }
      }

      const duration = Date.now() - startTime;
      recordResult({
        scenarioId: scenario.id,
        seed: scenario.seed,
        dimensions: scenario.dimensions,
        status,
        durationMs: duration,
        errorMessage,
        evidenceId,
        executionMode,
        expectedOutcome: scenario.expectedOutcome,
        timestamp: new Date().toISOString(),
        validity: scenario.validity,
      });

      if (stopOnFailure && status !== 'passed') {
        console.log(`[RUNNER] Stopping on failure: ${scenario.id}`);
        break;
      }
    }
  } finally {
    await client.close();
  }

  return saveResults();
}

export { loadScenarios, CdpApp, invokeRefundSaleAtomic, recordResult, saveResults };
export { runScenarios };