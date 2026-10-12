import { expect, browser, $, $$ } from '@wdio/globals';
import { createHash, randomBytes } from 'node:crypto';
import {
  tid,
  shown,
  APP_PIN,
  displayedToMinor,
  installErrorTrap,
  readErrors,
  unlockIfNeeded,
  ledger,
  getSale,
  clearWebMirrors,
  openShiftUi,
  clearCart,
  invoke,
  projectSettingToDexie,
} from '../helpers/pos';

/**
 * Phase 3.4a — cashier role matrix (HT-only, integer DA).
 * Cashier PIN is strictly 4 digits (1010: non-banal; manager 202020/6).
 * Provisioning: roster row (legacy v1 hash) + native pin_set rotation to
 * v2 (P1 fix). First login hits forced rotation (new PIN 3131), then the
 * cashier session runs real sales and hits real manager gates. B4 pins the
 * pending session-proof boundary for pin_set (red until the mechanism
 * lands — see report).
 */

const CASHIER_ID = 'usr-e2e-cashier';
const CASHIER_PIN = '1010';
// Second cashier: roster-only legacy hash (NO native mint) to prove the
// forced-rotation gate. Distinct PINs everywhere (duplicates are refused).
const CASHIER2_ID = 'usr-e2e-cashier2';
const CASHIER2_PIN = '2020';
const CASHIER2_ROTATED_PIN = '4141';

async function addSku(sku: string, times = 1) {
  const search = await $(tid('catalog-search'));
  await search.waitForDisplayed({ timeout: 15000 });
  await search.setValue(sku);
  await browser.keys(['Enter']);
  await browser.waitUntil(
    async () => (await $$(tid('product-tile'))).length === 1,
    { timeout: 15000, timeoutMsg: `single tile for ${sku}` },
  );
  for (let i = 0; i < times; i++) {
    await (await $$(tid('product-tile')))[0].click();
  }
  await search.setValue('');
  await browser.keys(['Enter']);
}

async function payExactFlow() {
  await (await $(tid('checkout-button'))).click();
  await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 15000 });
  await (await $(tid('pay-exact'))).click();
  await (await $(tid('pay-confirm'))).click();
  await browser.waitUntil(
    async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)),
    { timeout: 30000, timeoutMsg: 'pay dialog did not close' },
  );
}

async function waitNewSale(beforeId: string | null) {
  let id = '';
  await browser.waitUntil(
    async () => {
      const st = await ledger();
      id = st.recentSales[0]?.id ?? '';
      return id !== '' && id !== beforeId;
    },
    { timeout: 30000, timeoutMsg: 'new sale did not land' },
  );
  return id;
}

describe('MONEY cashier RBAC', () => {
  before(async () => {
    await installErrorTrap();
    await invoke('e2e_reset_db');
    await invoke('e2e_seed_state', {
      payload: {
        products: [
          { id: 'E2E-W1', title: 'E2E Wage A', priceDa: 1500, stock: 50, barcode: 'EWB1' },
          { id: 'E2E-W2', title: 'E2E Wage B', priceDa: 2500, stock: 50, barcode: 'EWB2' },
        ],
      },
    });
    await clearWebMirrors();
    await unlockIfNeeded();
    await openShiftUi(100000);
  });

  it('B0 provisioning mints v2 via the fixed path', async () => {
    // Roster row first (native resolves users from the roster).
    const salt = `e2e${randomBytes(4).toString('hex')}`;
    const digest = (pin: string) =>
      createHash('sha256').update(`${salt}:${pin}:mobi_pos_salt_v1`).digest('hex');
    const st0 = await ledger();
    const raw0 = st0.settingsValues.find((k) => k.key === 'cashier_users');
    const roster0 = JSON.parse((raw0?.valueJson ?? '[]') as string) as Array<
      Record<string, unknown>
    >;
    const template = roster0.find((u) => u['role'] === 'cashier') ?? {};
    const mkRow = (id: string, name: string, pin: string) => ({
      ...template,
      id,
      name,
      pin,
      role: 'cashier',
      avatarColor: '#10b981',
    });
    await invoke('e2e_seed_state', {
      payload: {
        settings: [
          {
            key: 'cashier_users',
            valueJson: JSON.stringify([
              ...roster0,
              mkRow(CASHIER_ID, 'E2E Caissier', `v1$${salt}$${digest(CASHIER_PIN)}`),
              mkRow(CASHIER2_ID, 'E2E Caissier Deux', `v1$${salt}$${digest(CASHIER2_PIN)}`),
            ]),
          },
        ],
      },
    });
    // Native mint (P1 fix verified): rotates the legacy hash to v2.
    const minted = await invoke<{ userId: string; format: string }>('pin_set', {
      request: { userId: CASHIER_ID, newPin: CASHIER_PIN },
    });
    expect(minted.format).toBe('v2');
    console.log(`[money] B0 cashier credential minted: ${minted.userId} (${minted.format})`);
    // Mirror the roster into Dexie (lock-screen reads are Dexie-first).
    // Read back the exact row the seed wrote so the mirror is byte-identical.
    const stM = await ledger();
    const rosterJson =
      stM.settingsValues.find((k) => k.key === 'cashier_users')?.valueJson ?? '[]';
    await projectSettingToDexie('cashier_users', JSON.parse(rosterJson));
    // Roster row itself persisted (provisioning state is observable).
    const stRoster = await ledger();
    expect(
      (stRoster.settingsValues.find((k) => k.key === 'cashier_users')?.valueJson ?? '').includes(
        CASHIER_ID,
      ),
    ).toBe(true);
  });

  it('B1a legacy cashier hits forced rotation and unlocks with the new PIN', async () => {
    // Reboot the store onto the projected roster (B0 wrote Dexie + SQLite
    // after boot; the lock list reads the store).
    await browser.refresh();
    await unlockIfNeeded();
    await (await $(tid('lock-button'))).click();
    await (await $(tid('lock-screen'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid(`lock-profile-${CASHIER2_ID}`))).click();
    await (await $(tid('login-pin-pad'))).click();
    await browser.keys(CASHIER2_PIN.split(''));
    // Legacy v1 hash authenticates once, then rotation is mandatory.
    const rotNew = await $(tid('rotation-new'));
    await rotNew.waitForDisplayed({ timeout: 30000 });
    await rotNew.setValue(CASHIER2_ROTATED_PIN);
    await (await $(tid('rotation-confirm'))).setValue(CASHIER2_ROTATED_PIN);
    await (await $(tid('rotation-submit'))).click();
    // Native Argon2id mint happens here; allow generous time.
    await (await $('header')).waitForDisplayed({ timeout: 120000 });
    console.log('[money] B1a legacy cashier rotated to v2 and unlocked');
  });

  it('B1b v2 cashier logs in directly and sells exactly', async () => {
    await (await $(tid('lock-button'))).click();
    await (await $(tid('lock-screen'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid(`lock-profile-${CASHIER_ID}`))).click();
    await (await $(tid('login-pin-pad'))).click();
    await browser.keys(CASHIER_PIN.split(''));
    // v2 needs no rotation: cashier flow auto-submits at 4 digits. A
    // rotation form here would mean the mint did not stick — fail loudly.
    await browser.waitUntil(
      async () =>
        (await $('header').isDisplayed().catch(() => false)) ||
        (await $(tid('rotation-new')).isDisplayed().catch(() => false)),
      { timeout: 90000, timeoutMsg: 'neither dashboard nor rotation appeared' },
    );
    expect(await $(tid('rotation-new')).isDisplayed().catch(() => false)).toBe(false);
    await (await $('header')).waitForDisplayed({ timeout: 30000 });
    await addSku('E2E-W1');
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    const sale = await getSale(await waitNewSale(before));
    expect(BigInt(Math.round(sale.totalDa * 100))).toBe(1500n * 100n);
    expect(BigInt(Math.round(sale.changeDueDa * 100))).toBe(0n);
  });

  it('B2 refund gate rejects the cashier-owned credential', async () => {
    await addSku('E2E-W1');
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    const target = await waitNewSale(before);
    const receipt = (await getSale(target)).receiptNumber;
    const tx0 = (await ledger()).tables.find((t) => t.name === 'transactions')?.rows ?? 0;
    await (await $(tid('refund-button'))).click();
    await (await $(tid('refund-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('refund-search'))).setValue(receipt);
    await browser.waitUntil(
      async () => (await $$(tid('refund-sale-row'))).length >= 1,
      { timeout: 15000, timeoutMsg: 'sale row for gate' },
    );
    await (await $$(tid('refund-sale-row')))[0].click();
    // Own (cashier) PIN cannot self-authorize a manager gate.
    await (await shown('refund-pin')).setValue(CASHIER_PIN);
    await (await shown('refund-submit')).click();
    await browser.pause(4000);
    expect(await (await $(tid('refund-dialog'))).isDisplayed()).toBe(true);
    expect(((await ledger()).tables.find((t) => t.name === 'transactions')?.rows ?? 0)).toBe(tx0);
    await browser.keys(['Escape']);
    console.log('[money] B2 non-manager credential denied at the refund gate, zero writes');
  });

  it('B3 cashier-shaped PIN cannot self-authorize a 25% discount', async () => {
    await addSku('E2E-W2'); // 2500
    await (await $(tid('discount-button'))).click();
    await (await $(tid('discount-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('discount-percent'))).setValue('25');
    const pin = await $(tid('discount-pin'));
    await pin.waitForDisplayed({ timeout: 10000 });
    await pin.setValue(CASHIER_PIN);
    await (await $(tid('discount-apply'))).click();
    await browser.pause(2500);
    expect(await (await $(tid('discount-dialog'))).isDisplayed()).toBe(true);
    expect(displayedToMinor(await (await $(tid('cart-total'))).getText())).toBe(2500n * 100n);
    await browser.keys(['Escape']);
    await browser.waitUntil(
      async () => !(await $(tid('discount-dialog')).isDisplayed().catch(() => false)),
      { timeout: 10000, timeoutMsg: 'discount dialog did not cancel' },
    );
    expect(displayedToMinor(await (await $(tid('cart-total'))).getText())).toBe(2500n * 100n);
    await clearCart();
  });

  it('B4 cashier-context escalation to manager credential is denied', async () => {
    // Privilege boundary (pending session-proof mechanism per owner
    // decision): a non-manager caller must not be able to re-key the
    // manager account, even with a well-formed request. This test is RED
    // until the pin_set caller-proof lands — it pins the exact behavior.
    let code = 'UNEXPECTED-SUCCESS';
    try {
      const r = await invoke<{ userId: string; format: string }>('pin_set', {
        request: { userId: 'usr-admin', newPin: '481516' },
      });
      code = `MINTED:${r.format}`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const m = /"detail"\s*:\s*"([^"]+)"/.exec(msg);
      code = m ? m[1] : msg.slice(0, 100);
    }
    console.log(`[money] B4 escalation probe: ${code}`);
    expect(code).not.toContain('MINTED');
  });

  after(async () => {
    expect(await readErrors()).toEqual([]);
  });

  afterEach(async () => {
    await clearCart();
  });
});
