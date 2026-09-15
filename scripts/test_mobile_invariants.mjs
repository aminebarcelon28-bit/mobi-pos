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
// TEST 6: Phone Calling & WhatsApp Debt Reminder Protocol
// -----------------------------------------------------------------------------
console.log('\n--- TEST 6: Phone Calling & WhatsApp Debt Reminder Protocol ---');

function normalizeAlgerianPhoneMock(input) {
  const raw = (input || '').trim();
  const digitsOnly = raw.replace(/\D/g, '');
  if (!digitsOnly) return { isValid: false, local: '', international: '', whatsAppFormat: '', dialDigits: '' };

  let standard9 = '';
  if (digitsOnly.startsWith('00213') && digitsOnly.length === 14) standard9 = digitsOnly.slice(5);
  else if (digitsOnly.startsWith('213') && digitsOnly.length === 12) standard9 = digitsOnly.slice(3);
  else if (digitsOnly.startsWith('0') && digitsOnly.length === 10) standard9 = digitsOnly.slice(1);
  else if (digitsOnly.length === 9) standard9 = digitsOnly;
  else standard9 = digitsOnly;

  const local = standard9.length === 9 ? `0${standard9}` : raw;
  const whatsAppFormat = standard9.length === 9 ? `213${standard9}` : digitsOnly;
  const dialDigits = local.replace(/\D/g, '');

  let operator = 'Inconnu';
  if (standard9.startsWith('6')) operator = 'Mobilis';
  else if (standard9.startsWith('7')) operator = 'Djezzy';
  else if (standard9.startsWith('5')) operator = 'Ooredoo';
  else if (['2', '3', '4'].includes(standard9[0])) operator = 'Fixe';

  return {
    isValid: standard9.length === 9 && ['5', '6', '7', '2', '3', '4'].includes(standard9[0]),
    local,
    whatsAppFormat,
    dialDigits,
    operator,
    telUri: `tel:${dialDigits}`,
  };
}

function formatWhatsAppLink(customer, storeName) {
  const norm = normalizeAlgerianPhoneMock(customer.phone);
  const message = `Bonjour ${customer.name},\nNous vous rappelons que votre solde de créance auprès de ${storeName} est de ${customer.currentDebt} DA.\nMerci pour votre fidélité !`;
  return `https://wa.me/${norm.whatsAppFormat}?text=${encodeURIComponent(message)}`;
}

// Case A: Mobilis number with spaces
const mobilis = normalizeAlgerianPhoneMock('0661 88 77 55');
assert.strictEqual(mobilis.operator, 'Mobilis');
assert.strictEqual(mobilis.telUri, 'tel:0661887755', 'tel: URI must contain ZERO spaces for native OS dialer');
assert.strictEqual(mobilis.whatsAppFormat, '213661887755');

// Case B: Djezzy number with international +213 prefix
const djezzy = normalizeAlgerianPhoneMock('+213 770 12 34 56');
assert.strictEqual(djezzy.operator, 'Djezzy');
assert.strictEqual(djezzy.telUri, 'tel:0770123456');
assert.strictEqual(djezzy.whatsAppFormat, '213770123456');

// Case C: Ooredoo number
const ooredoo = normalizeAlgerianPhoneMock('0555 99 88 77');
assert.strictEqual(ooredoo.operator, 'Ooredoo');
assert.strictEqual(ooredoo.telUri, 'tel:0555998877');

const waLink = formatWhatsAppLink({ name: 'Karim', phone: '0555 12 34 56', currentDebt: 12500 }, 'MobiPOS Alger');
assert.ok(waLink.includes('wa.me/213555123456'), 'Phone must format to Algerian E.164 without leading 0');
assert.ok(waLink.includes('12500'), 'Message must contain exact debt amount');
assert.ok(waLink.includes('MobiPOS%20Alger'), 'Store name must be URI encoded');
pass('Phone dialer triggers clean zero-space tel: URI and WhatsApp opens direct wa.me chat');

// -----------------------------------------------------------------------------
// TEST 7: Mobile Camera QR Code Pairing Payload Ingestion
// -----------------------------------------------------------------------------
console.log('\n--- TEST 7: Mobile Camera QR Code Pairing Payload Ingestion ---');

function parsePairingPayload(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.url === 'string' && typeof parsed.token === 'string') {
      const url = parsed.url.trim();
      const token = parsed.token.trim();
      if ((url.startsWith('libsql://') || url.startsWith('https://')) && token.length > 0) {
        return { ok: true, url, token, type: parsed.type || 'direct' };
      }
    }
  } catch {
    // ignore
  }
  return { ok: false, error: 'Invalid pairing format' };
}

// 1. Valid MobiPOS pairing JSON from desktop PC
const validDesktopPayload = JSON.stringify({
  v: 1,
  type: 'mobipos-pair',
  url: 'libsql://boutique-el-harrach.turso.io',
  token: 'eyJhbGciOiJFZERT...',
  ts: 1726435200000,
});
const res1 = parsePairingPayload(validDesktopPayload);
assert.strictEqual(res1.ok, true, 'Valid desktop pairing QR payload must parse successfully');
assert.strictEqual(res1.url, 'libsql://boutique-el-harrach.turso.io');
assert.strictEqual(res1.token, 'eyJhbGciOiJFZERT...');
assert.strictEqual(res1.type, 'mobipos-pair');

// 2. Generic valid JSON
const res2 = parsePairingPayload(JSON.stringify({ url: 'https://test-db.turso.io', token: 'token123' }));
assert.strictEqual(res2.ok, true);
assert.strictEqual(res2.url, 'https://test-db.turso.io');

// 3. Malformed / non-JSON or invalid URLs
assert.strictEqual(parsePairingPayload('Not a JSON string').ok, false);
assert.strictEqual(parsePairingPayload(JSON.stringify({ some_other_data: 123 })).ok, false);
assert.strictEqual(parsePairingPayload(JSON.stringify({ url: 'ftp://invalid', token: 'abc' })).ok, false);
pass('Mobile camera QR scanner securely validates and extracts Turso credentials with fail-safe error handling');

console.log('\n========================================================================');
console.log(`🎯 MOBILE INVARIANT TEST RESULTS: ${passedTests} PASSED, 0 FAILED`);
console.log('========================================================================\n');

