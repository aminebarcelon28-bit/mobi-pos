// Unit suite: dzPhoneUtils — Algerian phone engine (clean / detect / format / validate).
// Run: node --experimental-strip-types scripts/test_dz_phone_utils.mjs
import assert from 'node:assert/strict';
import {
  cleanPhone,
  detectDzOperator,
  formatDzPhone,
  formatDzPhoneWithCursor,
  validateDzPhone,
  toBackendNational,
  toBackendInternational,
  toNationalSignificant,
} from '../src/utils/dzPhoneUtils.ts';
import { normalizeAlgerianPhone } from '../src/utils/phoneUtils.ts';

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

console.log('==============================================================');
console.log('DZ PHONE ENGINE — clean / detect / format / validate');
console.log('==============================================================\n');

console.log('--- 1. cleanPhone: hard digit limits (no over-typing) ---');
test('national mobile truncated to 10 digits', () => {
  assert.equal(cleanPhone('0550123456789'), '0550123456');
});
test('intl 213 truncated to 12 digits', () => {
  assert.equal(cleanPhone('213550123456789'), '213550123456');
});
test('+213 truncated to +12 digits, plus preserved', () => {
  assert.equal(cleanPhone('+213550123456789'), '+213550123456');
});
test('00213 truncated to 14 digits', () => {
  assert.equal(cleanPhone('00213550123456789'), '00213550123456');
});
test('letters E . - stripped, digits kept', () => {
  assert.equal(cleanPhone('05E.50-12 34e56'), '0550123456');
});
test('garbage paste stripped to legal core', () => {
  assert.equal(cleanPhone('Appel: +213 (550) 12-34-56!!'), '+213550123456');
});
test('arabic-indic digits converted then clamped', () => {
  assert.equal(cleanPhone('٠٥٥٠١٢٣٤٥٦٧٨٩'), '0550123456');
});
test('persian + full-width digits converted', () => {
  assert.equal(cleanPhone('۰۵۵۰١٢٣٤５６'), '0550123456');
});
test('empty / nullish → empty', () => {
  assert.equal(cleanPhone(''), '');
  assert.equal(cleanPhone('   '), '');
  assert.equal(cleanPhone('abc'), '');
});
test('REGRESSION: lone leading zero survives (first keystroke of 06…)', () => {
  assert.equal(cleanPhone('0'), '0');
});
test('REGRESSION: lone + survives (intl prefix being typed)', () => {
  assert.equal(cleanPhone('+'), '+');
});
test('letters never enter state (E . - blocked)', () => {
  assert.equal(cleanPhone('05E50'), '0550');
  assert.equal(cleanPhone('e'), '');
});

console.log('\n--- 2. detectDzOperator ---');
test('06 → Mobilis', () => {
  const o = detectDzOperator('0661123456');
  assert.equal(o.id, 'mobilis');
  assert.equal(o.label, 'Mobilis');
});
test('07 → Djezzy', () => {
  assert.equal(detectDzOperator('0770123456').id, 'djezzy');
});
test('05 → Ooredoo', () => {
  assert.equal(detectDzOperator('0550123456').id, 'ooredoo');
});
test('02 → AT Centre (Alger)', () => {
  const o = detectDzOperator('021123456');
  assert.equal(o.id, 'at-algiers');
  assert.equal(o.label, 'Algérie Télécom');
});
test('03 → AT Est', () => {
  assert.equal(detectDzOperator('031123456').id, 'at-east');
});
test('04 → AT Ouest/Sud', () => {
  assert.equal(detectDzOperator('041123456').id, 'at-west');
});
test('intl forms detected (ignores +/213/00213)', () => {
  assert.equal(detectDzOperator('+213661234567').id, 'mobilis');
  assert.equal(detectDzOperator('213771234567').id, 'djezzy');
  assert.equal(detectDzOperator('00213550123456').id, 'ooredoo');
  assert.equal(detectDzOperator('+21321123456').id, 'at-algiers');
});
test('separators ignored', () => {
  assert.equal(detectDzOperator('05 50-12.34 56').id, 'ooredoo');
});
test('partial 05 live-detects while typing', () => {
  assert.equal(detectDzOperator('05').id, 'ooredoo');
});
test('09 / 01 / 08 → unknown', () => {
  assert.equal(detectDzOperator('0912345678').id, 'unknown');
  assert.equal(detectDzOperator('0812345678').label, 'Inconnu');
});
test('meta carries brand color + badge + icon', () => {
  const o = detectDzOperator('0550123456');
  assert.ok(o.color && o.badgeBg && o.badgeText && o.icon);
});
test('agrees with normalizeAlgerianPhone on valid numbers', () => {
  const cases = ['0550123456', '0661123456', '0770123456', '021123456', '031123456', '041123456'];
  for (const c of cases) {
    const legacy = normalizeAlgerianPhone(c);
    assert.equal(legacy.isValid, true, c);
    const o = detectDzOperator(c);
    assert.notEqual(o.id, 'unknown', c);
  }
  assert.equal(normalizeAlgerianPhone('0912345678').operator, 'Inconnu');
});

console.log('\n--- 3. formatDzPhone ---');
test('national mobile → 06 XX XX XX XX', () => {
  assert.equal(formatDzPhone('0550123456'), '05 50 12 34 56');
});
test('national fixe → 021 XX XX XX', () => {
  assert.equal(formatDzPhone('021123456'), '021 12 34 56');
});
test('intl mobile → +213 550 12 34 56', () => {
  assert.equal(formatDzPhone('+213550123456'), '+213 550 12 34 56');
});
test('typed intl prefix shape preserved (never rewritten under caret)', () => {
  assert.equal(formatDzPhone('213550123456'), '213 550 12 34 56');
  assert.equal(formatDzPhone('00213550123456'), '00213 550 12 34 56');
});
test('partial intl prefixes echo back untouched', () => {
  assert.equal(formatDzPhone('+'), '+');
  assert.equal(formatDzPhone('2'), '2');
  assert.equal(formatDzPhone('21'), '21');
  assert.equal(formatDzPhone('213'), '213');
  assert.equal(formatDzPhone('00'), '00');
  assert.equal(formatDzPhone('002'), '002');
  assert.equal(formatDzPhone('0021'), '0021');
  assert.equal(formatDzPhone('00213'), '00213');
  assert.equal(formatDzPhone('+00213'), '+00213');
});
test('REGRESSION: lone leading zero stays visible', () => {
  assert.equal(formatDzPhone('0'), '0');
});
test('trunk-less partials echo ungrouped (no injected trunk mid-typing)', () => {
  assert.equal(formatDzPhone('5'), '5');
  assert.equal(formatDzPhone('55'), '55');
  assert.equal(formatDzPhone('55012'), '55012');
  assert.equal(formatDzPhone('123'), '123');
});
test('complete trunk-less numbers gain the trunk once', () => {
  assert.equal(formatDzPhone('550123456'), '05 50 12 34 56');
  assert.equal(formatDzPhone('21123456'), '021 12 34 56');
});
test('format is idempotent (formatted-in-state converges)', () => {
  const samples = ['', '0', '05', '0550', '0550123456', '021123456', '123',
    '213', '213550123456', '00213550123456', '+', '+213', '+213550123456',
    '+21321123456', '550123456', '05 50 12 34 56', '+213 550 12 34 56'];
  for (const s of samples) {
    const once = formatDzPhone(s);
    assert.equal(formatDzPhone(once), once, `idempotence for ${JSON.stringify(s)}`);
  }
});
test('REGRESSION: keystroke walk of 0550123456 never drops the trunk', () => {
  const target = '0550123456';
  let prevDigits = 0;
  for (let i = 1; i <= target.length; i++) {
    const typed = target.slice(0, i);
    const display = formatDzPhone(typed);
    const dispDigits = (display.match(/\d/g) || []).length;
    assert.ok(display.startsWith('0'), `keystroke ${i}: ${JSON.stringify(display)} keeps leading 0`);
    assert.ok(dispDigits >= prevDigits, `keystroke ${i}: digit count never regresses`);
    assert.ok(dispDigits <= i, `keystroke ${i}: no phantom digits`);
    prevDigits = dispDigits;
  }
  assert.equal(formatDzPhone(target), '05 50 12 34 56');
});
test('intl fixe → +213 21 12 34 56', () => {
  assert.equal(formatDzPhone('+21321123456'), '+213 21 12 34 56');
});
test('partial typing formats progressively', () => {
  assert.equal(formatDzPhone('0550'), '05 50');
  assert.equal(formatDzPhone('05501'), '05 50 1');
});
test('rapid-type overlong input clamps before format', () => {
  assert.equal(formatDzPhone('0550123456789'), '05 50 12 34 56');
});
test('empty → empty', () => {
  assert.equal(formatDzPhone(''), '');
});
test('cursor preserved mid-edit (no jump to end)', () => {
  const { text, cursor } = formatDzPhoneWithCursor('05501', 5);
  assert.equal(text, '05 50 1');
  assert.equal(cursor, text.length);
  const mid = formatDzPhoneWithCursor('0550123456', 4);
  assert.equal(mid.text, '05 50 12 34 56');
  assert.ok(mid.cursor < mid.text.length, `cursor ${mid.cursor} should be mid-string`);
});
test('backspace over a space lands on the digit', () => {
  // '05 50|' (cursor 5) deleting back → '05 5' → '05 5'
  const { text } = formatDzPhoneWithCursor('05 5', 4);
  assert.equal(text, '05 5');
});
test('REGRESSION: lone zero keeps caret after the 0 (no swallow)', () => {
  const { text, cursor } = formatDzPhoneWithCursor('0', 1);
  assert.equal(text, '0');
  assert.equal(cursor, 1);
});
test('REGRESSION: injected trunk shifts caret by the offset (no 06|6 jump)', () => {
  // Trunk-less paste of 9 digits → display gains a trunk 0: caret that was
  // after the 9th typed digit must land after the 10th display digit (end).
  const { text, cursor } = formatDzPhoneWithCursor('550123456', 9);
  assert.equal(text, '05 50 12 34 56');
  assert.equal(cursor, text.length);
});

console.log('\n--- 4. validateDzPhone ---');
test('valid mobile + fixe', () => {
  assert.equal(validateDzPhone('0550123456').isValid, true);
  assert.equal(validateDzPhone('0661123456').isValid, true);
  assert.equal(validateDzPhone('0770123456').isValid, true);
  assert.equal(validateDzPhone('+213550123456').isValid, true);
  assert.equal(validateDzPhone('00213550123456').isValid, true);
  assert.equal(validateDzPhone('021123456').isValid, true);
  assert.equal(validateDzPhone('031123456').isValid, true);
  assert.equal(validateDzPhone('041123456').isValid, true);
});
test('incomplete → invalid + reason', () => {
  const v = validateDzPhone('05501');
  assert.equal(v.isValid, false);
  assert.ok(v.errorReason);
});
test('unknown prefix → invalid + reason', () => {
  const v = validateDzPhone('0912345678');
  assert.equal(v.isValid, false);
  assert.match(v.errorReason ?? '', /Préfixe/);
});
test('empty → invalid', () => {
  assert.equal(validateDzPhone('').isValid, false);
});
test('lone trunk is incomplete, never "requis"', () => {
  const v = validateDzPhone('0');
  assert.equal(v.isValid, false);
  assert.match(v.errorReason ?? '', /incomplet/);
});
test('over-long raw programmatic value fails loudly', () => {
  assert.equal(validateDzPhone('055012345678').isValid, false);
});
test('9-digit 02… rejected (fixe is 9 chars with trunk)', () => {
  assert.equal(validateDzPhone('0211234567').isValid, false);
});

console.log('\n--- 5. backend normalizers ---');
test('toBackendNational strips display spaces', () => {
  assert.equal(toBackendNational('05 50 12 34 56'), '0550123456');
  assert.equal(toBackendNational('+213 550 12 34 56'), '0550123456');
  assert.equal(toBackendNational('021 12 34 56'), '021123456');
});
test('toBackendInternational canonicalizes', () => {
  assert.equal(toBackendInternational('0550123456'), '+213550123456');
  assert.equal(toBackendInternational('021123456'), '+21321123456');
});
test('invalid → empty (never store noise)', () => {
  assert.equal(toBackendNational('123'), '');
  assert.equal(toBackendInternational('123'), '');
});
test('toNationalSignificant strips all prefix forms', () => {
  assert.equal(toNationalSignificant('+213550123456'), '550123456');
  assert.equal(toNationalSignificant('00213550123456'), '550123456');
  assert.equal(toNationalSignificant('213550123456'), '550123456');
  assert.equal(toNationalSignificant('0550123456'), '550123456');
});

console.log(`\n✅ ALL ${passed} ASSERTIONS PASSED`);
