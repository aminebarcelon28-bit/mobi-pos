// Unit Verification Test Suite: Algerian Phone Normalization, RFC 3966 tel:, & WhatsApp (Bug Fix F-01)
// 41 assertions verifying all operators, input variations, character sets, and URL compliance.

import assert from 'node:assert/strict';
import {
  normalizeAlgerianPhone,
  convertNonAsciiDigits,
  buildTelUri,
  buildWhatsAppUrl,
} from '../src/utils/phoneUtils.ts';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}:`, err.message);
    process.exit(1);
  }
}

console.log('========================================================================');
console.log('⚡ MOBI POS — ALGERIAN PHONE NORMALIZATION & NATIVE INTENT TEST SUITE');
console.log('========================================================================\n');

// ─── 1. Non-ASCII Digits Conversion ───
console.log('--- 1. Non-ASCII Digit Conversion (Arabic-Indic & Full-Width) ---');
test('Arabic-Indic digits conversion (٠-٩)', () => {
  assert.equal(convertNonAsciiDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
});

test('Persian/Eastern Arabic digits conversion (۰-۹)', () => {
  assert.equal(convertNonAsciiDigits('۰۱۲۳۴۵۶۷۸۹'), '0123456789');
});

test('Full-width digits conversion (０-９)', () => {
  assert.equal(convertNonAsciiDigits('０１２３４５６７８９'), '0123456789');
});

test('Mixed Arabic-Indic with standard symbols and spaces', () => {
  assert.equal(convertNonAsciiDigits('+٢١٣ ٥٥٠-١٢.٣٤.٥٦'), '+213 550-12.34.56');
});

// ─── 2. Algerian Mobile Operators Detection ───
console.log('\n--- 2. Operator Identification ---');
test('Ooredoo detection (prefix 05)', () => {
  const res = normalizeAlgerianPhone('0550123456');
  assert.equal(res.operator, 'Ooredoo');
  assert.equal(res.isValid, true);
});

test('Mobilis detection (prefix 06)', () => {
  const res = normalizeAlgerianPhone('0661123456');
  assert.equal(res.operator, 'Mobilis');
  assert.equal(res.isValid, true);
});

test('Djezzy detection (prefix 07)', () => {
  const res = normalizeAlgerianPhone('0770123456');
  assert.equal(res.operator, 'Djezzy');
  assert.equal(res.isValid, true);
});

test('Fixe Algérie Télécom detection (prefix 02)', () => {
  const res = normalizeAlgerianPhone('021123456');
  assert.equal(res.operator, 'Fixe');
  assert.equal(res.isValid, true);
});

test('Fixe Algérie Télécom detection (prefix 03)', () => {
  const res = normalizeAlgerianPhone('031123456');
  assert.equal(res.operator, 'Fixe');
  assert.equal(res.isValid, true);
});

test('Fixe Algérie Télécom detection (prefix 04)', () => {
  const res = normalizeAlgerianPhone('041123456');
  assert.equal(res.operator, 'Fixe');
  assert.equal(res.isValid, true);
});

test('Invalid/Unknown operator detection', () => {
  const res = normalizeAlgerianPhone('091234567');
  assert.equal(res.operator, 'Inconnu');
  assert.equal(res.isValid, false);
});

// ─── 3. Input Prefix Variations & Cleaning ───
console.log('\n--- 3. Format Normalization (Standard 10-digit, 9-digit, +213, 00213) ---');
test('Standard 10 digits with leading 0 (0550123456)', () => {
  const res = normalizeAlgerianPhone('0550123456');
  assert.equal(res.local, '0550123456');
  assert.equal(res.international, '+213550123456');
  assert.equal(res.whatsAppFormat, '213550123456');
  assert.equal(res.formattedDisplay, '0550 12 34 56');
});

test('9 digits without leading 0 (550123456)', () => {
  const res = normalizeAlgerianPhone('550123456');
  assert.equal(res.local, '0550123456');
  assert.equal(res.international, '+213550123456');
  assert.equal(res.whatsAppFormat, '213550123456');
});

test('International with +213 (+213550123456)', () => {
  const res = normalizeAlgerianPhone('+213550123456');
  assert.equal(res.local, '0550123456');
  assert.equal(res.international, '+213550123456');
  assert.equal(res.whatsAppFormat, '213550123456');
});

test('International with 00213 (00213550123456)', () => {
  const res = normalizeAlgerianPhone('00213550123456');
  assert.equal(res.local, '0550123456');
  assert.equal(res.international, '+213550123456');
  assert.equal(res.whatsAppFormat, '213550123456');
});

test('International with 213 (213550123456)', () => {
  const res = normalizeAlgerianPhone('213550123456');
  assert.equal(res.local, '0550123456');
  assert.equal(res.international, '+213550123456');
  assert.equal(res.whatsAppFormat, '213550123456');
});

test('Formatted with spaces (05 50 12 34 56)', () => {
  const res = normalizeAlgerianPhone('05 50 12 34 56');
  assert.equal(res.local, '0550123456');
  assert.equal(res.isValid, true);
});

test('Formatted with dots and dashes (05.50-12-34-56)', () => {
  const res = normalizeAlgerianPhone('05.50-12-34-56');
  assert.equal(res.local, '0550123456');
  assert.equal(res.isValid, true);
});

test('Arabic-Indic phone input (٠٥٥٠١٢٣٤٥٦)', () => {
  const res = normalizeAlgerianPhone('٠٥٥٠١٢٣٤٥٦');
  assert.equal(res.local, '0550123456');
  assert.equal(res.international, '+213550123456');
  assert.equal(res.operator, 'Ooredoo');
  assert.equal(res.isValid, true);
});

test('Full-width phone input (０６６１１２３４５６)', () => {
  const res = normalizeAlgerianPhone('０６６１１２３４５６');
  assert.equal(res.local, '0661123456');
  assert.equal(res.international, '+213661123456');
  assert.equal(res.operator, 'Mobilis');
  assert.equal(res.isValid, true);
});

// ─── 4. RFC 3966 tel: URI Compliance ───
console.log('\n--- 4. RFC 3966 tel: URI Generation ---');
test('buildTelUri from local 10 digits', () => {
  assert.equal(buildTelUri('0550123456'), 'tel:+213550123456');
});

test('buildTelUri from 9 digits without leading 0', () => {
  assert.equal(buildTelUri('661123456'), 'tel:+213661123456');
});

test('buildTelUri from +213 with spaces', () => {
  assert.equal(buildTelUri('+213 770 12 34 56'), 'tel:+213770123456');
});

test('buildTelUri from Arabic-Indic digits', () => {
  assert.equal(buildTelUri('٠٥٥٠١٢٣٤٥٦'), 'tel:+213550123456');
});

test('buildTelUri from full-width digits', () => {
  assert.equal(buildTelUri('０７７０１２３４５６'), 'tel:+213770123456');
});

test('buildTelUri fallback for non-standard digits', () => {
  assert.equal(buildTelUri('1234'), 'tel:1234');
});

test('buildTelUri fallback for empty input', () => {
  assert.equal(buildTelUri(''), 'tel:');
});

// ─── 5. WhatsApp URL Construction & Encoding ───
console.log('\n--- 5. WhatsApp URL Construction & Special Characters ---');
test('buildWhatsAppUrl simple message', () => {
  const url = buildWhatsAppUrl('0550123456', 'Bonjour');
  assert.equal(url, 'https://wa.me/213550123456?text=Bonjour');
});

test('buildWhatsAppUrl with spaces and accents', () => {
  const url = buildWhatsAppUrl('0661123456', 'Rappel créance: 12 000 DA');
  assert.equal(url, 'https://wa.me/213661123456?text=Rappel%20cr%C3%A9ance%3A%2012%20000%20DA');
});

test('buildWhatsAppUrl with multi-line message', () => {
  const msg = 'Ligne 1\nLigne 2\n*Ligne 3*';
  const url = buildWhatsAppUrl('0770123456', msg);
  assert.ok(url.startsWith('https://wa.me/213770123456?text='));
  assert.ok(url.includes('Ligne%201%0ALigne%202%0A*Ligne%203*'));
});

test('buildWhatsAppUrl with Arabic text', () => {
  const msg = 'مرحبا، يرجى تسوية رصيد الحساب';
  const url = buildWhatsAppUrl('0550123456', msg);
  assert.ok(url.startsWith('https://wa.me/213550123456?text='));
  assert.ok(url.includes(encodeURIComponent(msg)));
});

test('buildWhatsAppUrl with Arabic-Indic phone input', () => {
  const url = buildWhatsAppUrl('٠٥٥٠١٢٣٤٥٦', 'Test');
  assert.equal(url, 'https://wa.me/213550123456?text=Test');
});

test('buildWhatsAppUrl with full-width phone input', () => {
  const url = buildWhatsAppUrl('０７７０１２３４５６', 'Test');
  assert.equal(url, 'https://wa.me/213770123456?text=Test');
});

test('buildWhatsAppUrl with DZD currency symbol and formatted numbers', () => {
  const url = buildWhatsAppUrl('0661123456', 'Montant : 45 500,00 DZD');
  assert.ok(url.includes('45%20500%2C00%20DZD'));
});

// ─── 6. Edge Cases & Robustness ───
console.log('\n--- 6. Edge Cases & Boundary Handling ---');
test('Null input handling', () => {
  const res = normalizeAlgerianPhone(null);
  assert.equal(res.isValid, false);
  assert.equal(res.digitsOnly, '');
});

test('Undefined input handling', () => {
  const res = normalizeAlgerianPhone(undefined);
  assert.equal(res.isValid, false);
  assert.equal(res.digitsOnly, '');
});

test('Empty string handling', () => {
  const res = normalizeAlgerianPhone('');
  assert.equal(res.isValid, false);
  assert.equal(res.digitsOnly, '');
});

test('Whitespace-only input handling', () => {
  const res = normalizeAlgerianPhone('    ');
  assert.equal(res.isValid, false);
});

test('Text without digits', () => {
  const res = normalizeAlgerianPhone('Client Inconnu');
  assert.equal(res.isValid, false);
  assert.equal(res.digitsOnly, '');
});

test('Phone with embedded letters (0550-abc-123456)', () => {
  const res = normalizeAlgerianPhone('0550-abc-123456');
  assert.equal(res.local, '0550123456');
  assert.equal(res.isValid, true);
});

test('Truncated 8-digit number (invalid length)', () => {
  const res = normalizeAlgerianPhone('05501234');
  assert.equal(res.isValid, false);
});

test('Overlong 11-digit number (invalid length)', () => {
  const res = normalizeAlgerianPhone('05501234567');
  assert.equal(res.isValid, false);
});

console.log('\n========================================================================');
console.log(`🎯 DIALER & WHATSAPP UNIT TESTS: ${passed} PASSED, 0 FAILED`);
console.log('========================================================================');

