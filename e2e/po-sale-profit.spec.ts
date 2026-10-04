/**
 * Fail-closed licensing + FIFO purchase-to-sale invariants.
 *
 * HISTORY: this spec used to be a 3-step *manual* diagnostic (its own
 * docstring said so) that opened the PO form, filled a "Coût Unitaire Estimé"
 * field, and scoured the screen for "6 100"/"6 200". Every step skipped:
 *
 *   - the unit-cost field does not exist any more (PO entry is now
 *     paste-to-parse invoice text — InvoiceIngestionModal.tsx:159);
 *   - the button regex `/Bon|Commande|Fournisseur/i` matched the wrong control
 *     ("File d'Attente des Commandes & Ventes Suspendues", Header.tsx:359);
 *   - "6 100" only appears after a full PO→receive→2×checkout run, and
 *     checkout fail-closes without the Tauri runtime (documented at lines 16-19).
 *
 * The 6,100-vs-6,200 regression those steps hunted is NOT unguarded: it has 23
 * dedicated automated checks (`test_fifo_issue_6100.mts` 9, `test_po_case_6100.mts`
 * 14, plus `verify_alloc_ledger_6100.mjs`, `test_fifo_properties.mts`,
 * `test_inventory_valuation.mts`). Re-adding a brittle UI twin would duplicate
 * that coverage and add a failing test every time the PO UI is redesigned.
 *
 * So the intent is preserved and the obsolete UI coupling is dropped:
 *   1. 403 entitlement ⇒ the till fails closed (AGENTS.md rule 1). Previously
 *      an unconditional skip; this is a real security assertion now.
 *   2. FIFO allocates 500 then 400 ⇒ 6,100, not the 6,200 latest-cost bug.
 *   3. PO receipt mints per-unit batch cost, never the line total.
 *
 * 2 and 3 drive the REAL shipped module (src/utils/fifoPreview.ts) in the
 * browser context, so they cover the app's actual arithmetic while running in
 * plain Chromium — no Tauri, no serial, no obsolete form selectors.
 */
import { test, expect, type Page } from '@playwright/test';
import { seedE2ELicense, stubRevokedLicensingBackend, licenseGate } from './sav-license';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:1420';
const SELL_PRICE = 3500;
const EXPECTED_PROFIT = SELL_PRICE - 500 + (SELL_PRICE - 400); // 6100 FIFO
const BUGGY_PROFIT = (SELL_PRICE - 400) * 2; // 6200 latest-cost-to-both

interface FifoBatch {
  batchId: string;
  quantityRemaining: number;
  unitCost: number;
}
interface FifoLineResult {
  unitCost: number;
  fullyCovered: boolean;
  coveredQty: number;
  shortQty: number;
}

/**
 * Run the shipped FIFO pricer in the page and return its per-line verdict.
 *
 * Deliberately `previewFifoCostsForLines`, not `simulateFifoAllocation`: the
 * latter is exported but has no caller in src/ (dead surface — grep confirms a
 * single definition at fifoPreview.ts:70), so asserting on it would guard
 * nothing. `previewFifoCostsForLines` is the live cost path
 * (sqlPluginAdapter.ts:4479 at checkout, useFifoPreviewCosts.ts:90 behind the
 * cart margin badge), and it is the blended unit cost that surfaces to the user.
 */
async function priceFifo(
  page: Page,
  batchesByProduct: Record<string, FifoBatch[]>,
  lines: { productId: string; qty: number; fallbackCost: number }[],
): Promise<FifoLineResult[]> {
  return page.evaluate(
    async ({ batchesByProduct: b, lines: l }) => {
      const mod = await import('/src/utils/fifoPreview.ts');
      return mod.previewFifoCostsForLines(b, l);
    },
    { batchesByProduct, lines },
  );
}

test.describe('fail-closed licensing', () => {
  test('403 entitlement response fails the till closed', async ({ page }) => {
    await seedE2ELicense(page);
    // Booted licensed. Now the ledger starts answering the production
    // revocation 403. checkBootLicense() pings the server on every boot
    // (client.ts:377) and latches suspension on 403/404/active:false
    // (client.ts:394) — so a reload is enough to exercise it.
    await stubRevokedLicensingBackend(page);
    await page.reload({ waitUntil: 'domcontentloaded' });

    // The durable latch is the security-critical invariant: it must survive a
    // reload so airplane mode / offline boot cannot bypass revocation.
    await expect
      .poll(() => page.evaluate(() => Boolean(localStorage.getItem('mobi_pos_license_suspension_v1'))), {
        timeout: 30000,
      })
      .toBe(true);

    // ...and the till must actually be blocked behind the gate, not merely
    // flagged. Matched by heading role: the copy is split across two spans.
    await expect(licenseGate(page)).toHaveCount(1, { timeout: 30000 });
    await expect(page.getByText(/Statut de la licence\s*:/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ouvrir Caisse' })).toHaveCount(0);
  });

  test('a licensed till does not show the license gate', async ({ page }) => {
    await seedE2ELicense(page);
    await expect(licenseGate(page)).toHaveCount(0, { timeout: 30000 });
  });
});

test.describe('PO purchase-to-sale FIFO profit', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  });

  test('two sales @3500 off 500+400 stock cost 6,100, not 6,200', async ({ page }) => {
    // Batches are consumed oldest-first (received_at ASC, batch_id ASC), which
    // is the order the checkout query uses.
    const [res] = await priceFifo(
      page,
      {
        'prod-1': [
          { batchId: 'b-initial', quantityRemaining: 1, unitCost: 500 },
          { batchId: 'b-po', quantityRemaining: 1, unitCost: 400 },
        ],
      },
      [{ productId: 'prod-1', qty: 2, fallbackCost: 400 }],
    );

    expect(res.fullyCovered).toBe(true);
    expect(res.coveredQty).toBe(2);
    expect(res.shortQty).toBe(0);

    // FIFO blends 1 @500 + 1 @400 = 900 across 2 units ⇒ 450/unit.
    // The 6,200 bug applies the newest cost (400) to both units ⇒ 400/unit.
    expect(res.unitCost).toBe(450);

    const totalCost = res.unitCost * res.coveredQty;
    expect(totalCost).toBe(900);

    const profit = SELL_PRICE * res.coveredQty - totalCost;
    expect(profit).toBe(EXPECTED_PROFIT); // 6100
    expect(profit).not.toBe(BUGGY_PROFIT); // 6200 must stay dead
  });

  test('PO receipt stores per-unit cost, never the line total', async ({ page }) => {
    // A 3-unit line received at 750/unit must price at 750/unit.
    // The old bug stored 3 × 750 = 2,250 as the unit cost, inflating every
    // later margin by 1,500 per unit.
    const [res] = await priceFifo(
      page,
      { 'prod-1': [{ batchId: 'b-po-line', quantityRemaining: 3, unitCost: 750 }] },
      [{ productId: 'prod-1', qty: 1, fallbackCost: 750 }],
    );

    expect(res.unitCost).toBe(750);
    expect(res.unitCost).not.toBe(3 * 750);
  });
});
