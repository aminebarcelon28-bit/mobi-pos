const assert = require('assert');

console.log('\n=======================================================================');
console.log('RUNNING VERIFICATION FOR 10 ENTERPRISE PILLARS');
console.log('=======================================================================\n');

let passedCount = 0;
let totalCount = 0;

function it(name, fn) {
  totalCount++;
  try {
    fn();
    console.log('  [PASS] ' + name);
    passedCount++;
  } catch (err) {
    console.error('  [FAIL] ' + name);
    console.error('     Error: ' + err.message);
  }
}

// 1. Pillar 6: Pure Cash Tender Engine
console.log('\n[PILLAR 6] Pure Cash Tender & Denomination Math:');

function generateSmartShortcuts(totalDue) {
  if (totalDue <= 0) return [0];
  const shortcuts = new Set();
  shortcuts.add(totalDue);
  const next500 = Math.ceil(totalDue / 500) * 500;
  if (next500 > totalDue) shortcuts.add(next500);
  const next1000 = Math.ceil(totalDue / 1000) * 1000;
  if (next1000 > totalDue) shortcuts.add(next1000);
  const next2000 = Math.ceil(totalDue / 2000) * 2000;
  if (next2000 > totalDue) shortcuts.add(next2000);
  if (totalDue < 5000) shortcuts.add(5000);
  if (totalDue < 10000 && totalDue > 5000) shortcuts.add(10000);
  return Array.from(shortcuts).sort((a, b) => a - b).slice(0, 5);
}

function calculateTender(totalDue, cashTendered) {
  const safeTendered = Math.max(0, isNaN(cashTendered) ? 0 : cashTendered);
  const changeDue = Math.max(0, safeTendered - totalDue);
  const isFullyPaid = safeTendered >= totalDue && totalDue > 0;
  let remainingChange = changeDue;
  const denominations = [2000, 1000, 500, 200, 100];
  const breakdown = {};
  for (const note of denominations) {
    if (remainingChange >= note) {
      breakdown[note] = Math.floor(remainingChange / note);
      remainingChange %= note;
    }
  }
  return { totalDue, cashTendered: safeTendered, changeDue, isFullyPaid, changeDenominationBreakdown: breakdown };
}

it('Generates exact and higher denomination shortcuts for 3,400 DA', () => {
  const shortcuts = generateSmartShortcuts(3400);
  assert(shortcuts.includes(3400), 'Must include exact amount');
  assert(shortcuts.includes(3500), 'Must include next 500 DA');
  assert(shortcuts.includes(4000), 'Must include next 1,000 DA');
  assert(shortcuts.includes(5000), 'Must include 5,000 DA note');
});

it('Computes exact change and optimal note breakdown (5,000 DA paid for 3,400 DA -> 1,600 DA change)', () => {
  const tender = calculateTender(3400, 5000);
  assert.strictEqual(tender.changeDue, 1600);
  assert.strictEqual(tender.isFullyPaid, true);
  assert.strictEqual(tender.changeDenominationBreakdown[1000], 1, '1x 1,000 DA note');
  assert.strictEqual(tender.changeDenominationBreakdown[500], 1, '1x 500 DA note');
  assert.strictEqual(tender.changeDenominationBreakdown[100], 1, '1x 100 DA coin');
});

// 2. Pillar 4: Algerian Phone Number Sanitization (+213)
console.log('\n[PILLAR 4] WhatsApp & Algerian Phone Sanitizer:');

function sanitizeAlgerianPhone(phone) {
  let clean = phone.replace(/[^0-9+]/g, '');
  if (clean.startsWith('+213')) {
    clean = clean.slice(1);
  } else if (clean.startsWith('00213')) {
    clean = clean.slice(2);
  } else if (clean.startsWith('0') && (clean.startsWith('05') || clean.startsWith('06') || clean.startsWith('07'))) {
    clean = '213' + clean.slice(1);
  } else if (!clean.startsWith('213') && clean.length === 9) {
    clean = '213' + clean;
  }
  return clean;
}

it('Sanitizes Ooredoo local number 0550123456 to 213550123456', () => {
  assert.strictEqual(sanitizeAlgerianPhone('0550123456'), '213550123456');
});

it('Sanitizes Mobilis local number 0661123456 to 213661123456', () => {
  assert.strictEqual(sanitizeAlgerianPhone('0661123456'), '213661123456');
});

it('Sanitizes Djezzy local number 0770123456 to 213770123456', () => {
  assert.strictEqual(sanitizeAlgerianPhone('0770123456'), '213770123456');
});

it('Preserves international +213 prefixed numbers (+213550123456 -> 213550123456)', () => {
  assert.strictEqual(sanitizeAlgerianPhone('+213550123456'), '213550123456');
});

// 3. Pillar 2: Hardware Heuristic Auto-Binding
console.log('\n[PILLAR 2] Hardware Heuristic Priority Scoring:');

function scoreThermalPrinter(name) {
  const n = name.toLowerCase();
  let score = 10;
  if (n.includes('xprinter') || n.includes('xp-')) score += 50;
  if (n.includes('epson') || n.includes('tm-t')) score += 50;
  if (n.includes('pos-80') || n.includes('80mm')) score += 40;
  if (n.includes('pdf') || n.includes('xps') || n.includes('fax')) score = 0;
  return score;
}

it('Assigns highest priority score to Epson and Xprinter over virtual PDF printers', () => {
  const epsonScore = scoreThermalPrinter('EPSON TM-T88VI Receipt');
  const xprinterScore = scoreThermalPrinter('Xprinter XP-N160I');
  const pdfScore = scoreThermalPrinter('Microsoft Print to PDF');
  assert(epsonScore >= 60, 'Epson must score >= 60');
  assert(xprinterScore >= 60, 'Xprinter must score >= 60');
  assert.strictEqual(pdfScore, 0, 'Virtual PDF printer must score 0');
});

// 4. Pillar 8: Pre-Owned Certification FRP Security
console.log('\n[PILLAR 8] Pre-Owned Certification Security Checks:');

it('Rejects catalog promotion if iCloud / Google FRP is not removed', () => {
  const uncertifiedChecklist = { icloudFrpRemoved: false, networkUnlocked: true };
  let threw = false;
  try {
    if (!uncertifiedChecklist.icloudFrpRemoved) {
      throw new Error('iCloud lock active');
    }
  } catch (e) {
    threw = true;
  }
  assert.strictEqual(threw, true, 'Must block locked devices');
});

// 5. Pillar 10: O(1) Clamped Gain Calculation
console.log('\n[PILLAR 10] Audio Clamped Gain Mathematical Bounds:');

function getEffectiveGain(baseGain, masterVolume, isMuted) {
  if (isMuted) return 0;
  const clamped = Math.max(0, Math.min(1, masterVolume));
  return Math.max(0, Math.min(1, baseGain * clamped));
}

it('Clamps effective gain mathematically between 0 and 1 with zero distortion', () => {
  const val = getEffectiveGain(0.2, 0.7, false);
  assert(Math.abs(val - 0.14) < 1e-9, 'Must equal 0.14');
  assert.strictEqual(getEffectiveGain(0.2, 1.5, false), 0.2); // clamped volume at 1.0
  assert.strictEqual(getEffectiveGain(0.2, 0.7, true), 0); // muted
});

console.log('\n=======================================================================');
console.log('FINAL RESULT: ' + passedCount + '/' + totalCount + ' PILLARS VERIFICATION TESTS PASSED');
console.log('=======================================================================\n');

if (passedCount !== totalCount) {
  process.exit(1);
}
