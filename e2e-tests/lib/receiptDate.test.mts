/**
 * Pins for the receipt-date oracle (TIM-03's extractor).
 *
 * These are the exact instants TIM-03 sells at, with the exact `Date:` lines
 * the printer receives:
 *   2026-12-31T23:59:30+01:00 -> "31/12/2026 23:59:30" -> 20261231
 *   2027-01-01T00:00:30+01:00 -> "01/01/2027 00:00:30" -> 20270101 (rollover)
 *   2028-02-29T12:00:00+01:00 -> "29/02/2028 12:00:00" -> 20280229 (leap day)
 *
 * Run: node --import ./scripts/ts-resolve-hook.mjs \
 *   --experimental-strip-types e2e-tests/lib/receiptDate.test.mts
 */
import assert from 'node:assert';
import { receiptDayFromPrintedLine } from './receiptDate';

let n = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  n++;
  assert.strictEqual(String(a), String(b), msg);
};

// The three TIM-03 instants, as the ESC/POS `Date:` line renders them.
eq(receiptDayFromPrintedLine('Date: 31/12/2026 23:59:30'), '20261231', 'year end, day-first');
eq(receiptDayFromPrintedLine('Date: 01/01/2027 00:00:30'), '20270101', '31 Dec -> 1 Jan rollover');
eq(receiptDayFromPrintedLine('Date: 29/02/2028 12:00:00'), '20280229', 'leap day 29 Feb');

// Day-first, not month-first: a US reading would yield 2026-31-12 (invalid).
eq(receiptDayFromPrintedLine('Date: 31/12/2026 23:59:30') === '20263112', false, 'never MM/DD/YYYY');

// Surrounding receipt text must not confuse the extractor (the printer
// right-pads/centres lines; the date is one token inside them).
eq(
  receiptDayFromPrintedLine('   Date: 01/01/2027 00:00:30   TICKET #12   '),
  '20270101',
  'padded line',
);
eq(receiptDayFromPrintedLine('Date: --/--/----'), '?', 'absent date -> ?');
eq(receiptDayFromPrintedLine(''), '?', 'empty line -> ?');

// Exactly the array TIM-03 asserts, derived from the three printed lines.
const printed = [
  'Date: 31/12/2026 23:59:30',
  'Date: 01/01/2027 00:00:30',
  'Date: 29/02/2028 12:00:00',
];
eq(
  JSON.stringify(printed.map(receiptDayFromPrintedLine)),
  JSON.stringify(['20261231', '20270101', '20280229']),
  'TIM-03 expected array',
);

console.log(`receiptDate pins: ${n}/${n} passed`);
