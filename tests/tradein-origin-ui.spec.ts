/**
 * Seller ORIGIN in the IMEI Inspector — the police-register read path.
 *
 * The seller identity document was written by the buyback form and then read by
 * NOTHING: no screen could go from a device identifier back to the acquisition
 * record. This spec drives the mounted inspector against a seeded store and
 * asserts the properties the owner set:
 *
 *   1. a device bought in shows an "Origine de l'appareil" section joined by the
 *      CANONICAL identifier (the seeded acquisition is hyphenated, the searched
 *      one is not — the same device);
 *   2. the document number is MASKED by default, and the reveal is a manager-only
 *      control — a cashier has no reveal affordance at all;
 *   3. an acquisition without a document shows the missing badge and the
 *      "Compléter" action instead of an invented number;
 *   4. when the same device was bought in twice, the most recent acquisition
 *      wins and the earlier one stays listed.
 *
 * Mounted through tests/harness (a second Vite entry), never the App shell: the
 * shell mounts a fail-closed license gate first and would never render a till.
 * The harness does not touch licensing — it mounts the same component against
 * the same store, so what is measured is production behaviour.
 */
import { test, expect, type Page } from '@playwright/test';

const HARNESS = '/tests/harness/index.html';

const IMEI = '352099001761481';
// Same device, GSMA-scanned spelling. The store keeps the RAW form (W-30), so a
// raw comparison would miss the origin entirely.
const IMEI_HYPHENATED = '35-209900-176148-1';
const IMEI_NO_DOC = '356938035643809';

const SELLER_ID = '198744112233';
const SELLER_PHONE = '0661889900';

interface SeedTradeIn {
  id: string;
  imei: string;
  customerName: string;
  customerPhone: string;
  nationalIdNumber?: string;
  nationalIdType?: string;
  createdAt: string;
}

function seedPayload(tradeIns: SeedTradeIn[], role: 'admin' | 'cashier') {
  return {
    activeCashier: {
      id: role === 'admin' ? 'u-admin' : 'u-cashier',
      name: role === 'admin' ? 'Gérant' : 'Karim',
      pin: '',
      role,
      avatarColor: '#000',
    },
    // One serialized product per device, sold, so `buildWarrantyDeviceList`
    // produces a row and the device resolves as a real dossier.
    products: tradeIns.map((t) => ({
      id: `p-${t.id}`,
      sku: `SKU-${t.id}`,
      title: 'iPhone 12 128 Go',
      category: 'Téléphones',
      price: 195000,
      costPrice: 150000,
      stockQuantity: 0,
      isSerialized: true,
      barcode: `20000000000${tradeIns.indexOf(t)}`,
      warrantyMonths: 12,
      createdAt: t.createdAt,
      updatedAt: t.createdAt,
    })),
    imeiRecords: tradeIns.map((t) => ({
      imei: t.imei,
      productId: `p-${t.id}`,
      receivedAt: t.createdAt,
      soldAt: new Date(new Date(t.createdAt).getTime() + 86_400_000).toISOString(),
      saleTransactionId: `tx-${t.id}`,
      warrantyMonths: 12,
      warrantyExpiresAt: new Date(new Date(t.createdAt).getTime() + 365 * 86_400_000).toISOString(),
      version: 1,
    })),
    transactions: tradeIns.map((t) => ({
      id: `tx-${t.id}`,
      receiptNumber: `F-${t.id}`,
      createdAt: t.createdAt,
      status: 'COMPLETED',
      customer: { name: 'ACHETEUR', phone: '0551000000' },
      items: [
        {
          productId: `p-${t.id}`,
          product: { id: `p-${t.id}`, title: 'iPhone 12 128 Go', category: 'Téléphones' },
          quantity: 1,
          appliedPrice: 195000,
          imeiNumber: t.imei,
          warrantyMonthsAtSale: 12,
        },
      ],
      total: 195000,
      paymentMethod: 'CASH',
    })),
    repairOrders: [],
    tradeIns: tradeIns.map((t) => ({
      id: t.id,
      deviceModel: 'iPhone 12 128',
      imei: t.imei,
      brand: 'Apple',
      conditionGrade: 'Grade B (Bon État)',
      customerName: t.customerName,
      customerPhone: t.customerPhone,
      nationalIdNumber: t.nationalIdNumber,
      nationalIdType: t.nationalIdType,
      buybackValue: 150000,
      resaleMarginPercent: 30,
      resalePrice: 195000,
      creditToWallet: false,
      createdAt: t.createdAt,
    })),
  };
}

const TWO_ACQUISITIONS: SeedTradeIn[] = [
  {
    id: 'trade-older',
    imei: IMEI_HYPHENATED,
    customerName: 'ANCIEN VENDEUR',
    customerPhone: '0551111111',
    nationalIdNumber: '111222333444',
    nationalIdType: 'PERMIS',
    createdAt: '2024-01-10T09:00:00.000Z',
  },
  {
    id: 'trade-new',
    imei: IMEI_HYPHENATED,
    customerName: 'KARIM BENALI',
    customerPhone: SELLER_PHONE,
    nationalIdNumber: SELLER_ID,
    nationalIdType: 'CNI',
    createdAt: '2025-06-01T09:00:00.000Z',
  },
  {
    id: 'trade-nodoc',
    imei: IMEI_NO_DOC,
    customerName: 'VENDEUR SANS PIECE',
    customerPhone: '0552222222',
    createdAt: '2025-07-01T09:00:00.000Z',
  },
];

declare global {
  interface Window {
    __harnessReady: boolean;
    __harnessError: string | null;
    __harnessSeed: (state: Record<string, unknown>) => void;
  }
}

async function openInspector(page: Page, role: 'admin' | 'cashier') {
  await page.goto(`${HARNESS}?modal=inspector&theme=light`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true, null, { timeout: 30_000 });
  await page.evaluate(
    (payload) => window.__harnessSeed(payload),
    seedPayload(TWO_ACQUISITIONS, role)
  );
  const err = await page.evaluate(() => window.__harnessError);
  expect(err, `harness failed to mount: ${err}`).toBeNull();
}

/** Type an identifier into the inspector's search box and resolve the dossier. */
async function search(page: Page, identifier: string) {
  // Matched on the stable part of the placeholder: the trailing ellipsis is a
  // Unicode character that a copy/paste round-trip can mangle.
  const input = page.getByPlaceholder(/15 chiffres/);
  await input.fill(identifier);
  await input.press('Enter');
  await expect(page.getByText("Origine de l'appareil")).toBeVisible({ timeout: 15_000 });
}

test.describe('IMEI Inspector — seller origin (police register)', () => {
  test('manager: masked by canonical join, reveal audited and unmasked', async ({ page }) => {
    await openInspector(page, 'admin');
    await search(page, IMEI);

    // Scoped to the dialog, not to a `hasText` div: the innermost div holding
    // the section header does not contain the seller name two rows below it.
    const origin = page.getByRole('dialog');

    // The newest acquisition wins — the 2025 one, not the 2024 one.
    await expect(origin.getByText('KARIM BENALI')).toBeVisible();
    await expect(origin.getByText('ANCIEN VENDEUR')).toHaveCount(0);

    // MASKED by default: the tail is legible, the rest is not, and the raw
    // document number is nowhere on screen.
    await expect(origin.getByText(/\u2022+2233/)).toBeVisible();
    await expect(origin.getByText(SELLER_ID)).toHaveCount(0);

    // The type comes from the record. `.first()` because the masked value is
    // rendered inside the same row ("CNI : ••••2233").
    await expect(origin.getByText('CNI').first()).toBeVisible();

    const reveal = origin.getByRole('button', { name: /Afficher/ });
    await expect(reveal).toBeVisible();
    await reveal.click();
    await expect(origin.getByText(SELLER_ID)).toBeVisible();
  });

  test('cashier: no reveal affordance and no unmasked value anywhere', async ({ page }) => {
    await openInspector(page, 'cashier');
    await search(page, IMEI);

    await expect(page.getByRole('button', { name: /Afficher/ })).toHaveCount(0);
    await expect(page.getByText(SELLER_ID)).toHaveCount(0);
    // The masked value is still shown — denial hides the reveal, not the record.
    await expect(page.getByText(/\u2022+2233/)).toBeVisible();
  });

  test('an acquisition without a document shows the missing badge and Compléter', async ({
    page,
  }) => {
    await openInspector(page, 'admin');
    await search(page, IMEI_NO_DOC);

    await expect(page.getByText('Pièce manquante')).toBeVisible();
    await expect(page.getByText('Non renseignée')).toBeVisible();
    await expect(page.getByRole('button', { name: /Compléter/ })).toBeVisible();
  });

  test('a device bought in twice keeps the earlier acquisition visible', async ({ page }) => {
    await openInspector(page, 'admin');
    await search(page, IMEI);

    const summary = page.getByText(/reprise\(s\) antérieure\(s\)/);
    await expect(summary).toBeVisible();
    await summary.click();
    await expect(page.getByRole('button', { name: 'Ouvrir la reprise trade-older' })).toBeVisible();
  });
});