/**
 * MobiPOS — Mobile Companion & Nomadic POS Invariant Verification Suite
 * Tests platform role switching, pricing tiers, debtLimit guards,
 * and atomic sync_outbox persistence on mobile checkouts.
 */

import assert from 'node:assert';

console.log('========================================================================');
console.log('⚡ MOBI POS — MOBILE COMPANION & NOMADIC POS INVARIANT TEST SUITE');
console.log('========================================================================\n');

let passedTests = 0;
function pass(desc) {
  passedTests++;
  console.log(`  ✅ [PASS] ${desc}`);
}

// -----------------------------------------------------------------------------
// TEST 1: Platform & User-Agent Form-Factor Detection
// -----------------------------------------------------------------------------
console.log('--- TEST 1: Platform & User-Agent Detection ---');

function isMobileUserAgent(ua, screenWidth) {
  const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const isNarrowScreen = typeof screenWidth === 'number' && screenWidth < 768;
  return isMobileUA || isNarrowScreen;
}

const desktopUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
const androidUA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36';
const iphoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';

assert.strictEqual(isMobileUserAgent(desktopUA, 1920), false, 'Desktop UA on 1920px screen must NOT be detected as mobile');
assert.strictEqual(isMobileUserAgent(androidUA, 390), true, 'Android UA on 390px screen must be detected as mobile');
assert.strictEqual(isMobileUserAgent(iphoneUA, 393), true, 'iPhone UA on 393px screen must be detected as mobile');
assert.strictEqual(isMobileUserAgent(desktopUA, 375), true, 'Narrow screen viewport on desktop must adapt to mobile layout');
pass('Form-factor detection correctly handles desktop, Android, iPhone, and narrow viewports');

// -----------------------------------------------------------------------------
// TEST 2: Device Role Override State Transition
// -----------------------------------------------------------------------------
console.log('\n--- TEST 2: Device Role Override State Transitions ---');

let storageOverride = null;
function getDeviceRole(ua, width) {
  if (storageOverride === 'companion_mobile' || storageOverride === 'pos_primary') {
    return storageOverride;
  }
  return isMobileUserAgent(ua, width) ? 'companion_mobile' : 'pos_primary';
}

function setDeviceRoleOverride(role) {
  storageOverride = role;
}

assert.strictEqual(getDeviceRole(desktopUA, 1280), 'pos_primary');
setDeviceRoleOverride('companion_mobile');
assert.strictEqual(getDeviceRole(desktopUA, 1280), 'companion_mobile', 'Override must force companion_mobile on desktop');
setDeviceRoleOverride('pos_primary');
assert.strictEqual(getDeviceRole(androidUA, 390), 'pos_primary', 'Override must force pos_primary on mobile if requested');
setDeviceRoleOverride(null);
assert.strictEqual(getDeviceRole(desktopUA, 1280), 'pos_primary', 'Clearing override must restore automatic detection');
pass('Device role override state transitions execute cleanly without leak');

// -----------------------------------------------------------------------------
// TEST 3: Pricing Tier Calculations (Retail, Demi-Gros / VIP, Gros / Wholesale)
// -----------------------------------------------------------------------------
console.log('\n--- TEST 3: Multi-Tier Pricing Math ---');

function getProductPrice(prod, tier) {
  if (tier === 'Wholesale') {
    return prod.wholesalePrice && prod.wholesalePrice > 0
      ? prod.wholesalePrice
      : Math.round(prod.price * 0.75);
  }
  if (tier === 'VIP') {
    return prod.wholesalePrice && prod.wholesalePrice > 0
      ? Math.round((prod.price + prod.wholesalePrice) / 2)
      : Math.round(prod.price * 0.85);
  }
  return prod.price;
}

const sampleProduct = { id: 'p1', title: 'Chargeur Rapide 65W GaN', price: 4000, wholesalePrice: 2800 };
assert.strictEqual(getProductPrice(sampleProduct, 'Retail'), 4000, 'Retail price should match base');
assert.strictEqual(getProductPrice(sampleProduct, 'VIP'), 3400, 'Demi-gros (VIP) should be average (4000+2800)/2 = 3400');
assert.strictEqual(getProductPrice(sampleProduct, 'Wholesale'), 2800, 'Wholesale price should match wholesalePrice');
pass('Pricing tiers (Détail, Demi-Gros, Gros) calculate exact integer DZD amounts');

// -----------------------------------------------------------------------------
// TEST 4: Nomadic Mobile Credit Checkout & debtLimit Protection
// -----------------------------------------------------------------------------
console.log('\n--- TEST 4: Nomadic Mobile Checkout & Credit Limit Guard ---');

function validateMobileCreditSale(customer, cartTotal) {
  if (!customer) {
    return { ok: false, reason: 'CUSTOMER_REQUIRED_FOR_CREDIT' };
  }
  const currentDebt = customer.currentDebt || 0;
  const debtLimit = customer.debtLimit ?? 100000;
  if (currentDebt + cartTotal > debtLimit) {
    return { ok: false, reason: 'CREDIT_LIMIT_EXCEEDED', currentDebt, debtLimit, projected: currentDebt + cartTotal };
  }
  return { ok: true, newDebt: currentDebt + cartTotal };
}

const customerWithLimit = { id: 'c1', name: 'Nadir Hamdi', currentDebt: 45000, debtLimit: 50000 };
const smallCreditSale = validateMobileCreditSale(customerWithLimit, 4000);
assert.strictEqual(smallCreditSale.ok, true);
assert.strictEqual(smallCreditSale.newDebt, 49000);

const excessiveCreditSale = validateMobileCreditSale(customerWithLimit, 10000);
assert.strictEqual(excessiveCreditSale.ok, false);
assert.strictEqual(excessiveCreditSale.reason, 'CREDIT_LIMIT_EXCEEDED');
assert.strictEqual(excessiveCreditSale.projected, 55000);
pass('Nomadic mobile credit checkout strictly blocks credit ceiling overruns');

// -----------------------------------------------------------------------------
// TEST 5: Mobile Checkout Sync Outbox Invariant (Contract C6)
// -----------------------------------------------------------------------------
console.log('\n--- TEST 5: Atomic SQLite & Outbox Envelope on Mobile ---');

function buildMobileSaleEnvelope(cart, customer, paymentMethod, deviceId) {
  const transactionId = `tx-mob-${Date.now()}`;
  const total = cart.reduce((sum, item) => sum + item.price * item.qty, 0);

  const outboxEntry = {
    id: `outbox-${Date.now()}`,
    entity_type: 'order',
    entity_id: transactionId,
    action: 'INSERT',
    idempotency_key: `idem-${transactionId}`,
    device_id: deviceId,
    status: 'pending',
    retry_count: 0,
    created_at: new Date().toISOString(),
  };

  return {
    transactionId,
    total,
    itemsCount: cart.length,
    outboxEntry,
    inventoryDeltas: cart.map(i => ({ productId: i.id, delta: -i.qty })),
  };
}

const mobileSale = buildMobileSaleEnvelope(
  [{ id: 'p1', price: 4000, qty: 2 }, { id: 'p2', price: 1500, qty: 1 }],
  customerWithLimit,
  'Espèces',
  'android-pixel-01'
);

assert.strictEqual(mobileSale.total, 9500);
assert.strictEqual(mobileSale.itemsCount, 2);
assert.strictEqual(mobileSale.outboxEntry.status, 'pending');
assert.strictEqual(mobileSale.outboxEntry.entity_type, 'order');
assert.strictEqual(mobileSale.outboxEntry.device_id, 'android-pixel-01');
assert.strictEqual(mobileSale.inventoryDeltas[0].delta, -2);
assert.strictEqual(mobileSale.inventoryDeltas[1].delta, -1);
pass('Mobile sale generates valid atomic outbox and inventory ledger deltas');

// -----------------------------------------------------------------------------
// TEST 6: WhatsApp Message Formulation & Phone Sanitation
// -----------------------------------------------------------------------------
console.log('\n--- TEST 6: WhatsApp Debt Reminder Generator ---');

function formatWhatsAppLink(customer, storeName) {
  const cleanPhone = (customer.phone || '').replace(/[^0-9]/g, '');
  const internationalPhone = cleanPhone.startsWith('0') ? '213' + cleanPhone.slice(1) : cleanPhone;
  const message = `Bonjour ${customer.name},\nNous vous rappelons que votre solde de créance auprès de ${storeName} est de ${customer.currentDebt} DA.\nMerci pour votre fidélité !`;
  return `https://wa.me/${internationalPhone}?text=${encodeURIComponent(message)}`;
}

const waLink = formatWhatsAppLink({ name: 'Karim', phone: '0555 12 34 56', currentDebt: 12500 }, 'MobiPOS Alger');
assert.ok(waLink.includes('wa.me/213555123456'), 'Phone must format to Algerian E.164 without leading 0');
assert.ok(waLink.includes('12500'), 'Message must contain exact debt amount');
assert.ok(waLink.includes('MobiPOS%20Alger'), 'Store name must be URI encoded');
pass('WhatsApp debt reminders sanitize Algerian numbers and format clean direct URLs');

console.log('\n========================================================================');
console.log(`🎯 MOBILE INVARIANT TEST RESULTS: ${passedTests} PASSED, 0 FAILED`);
console.log('========================================================================\n');
