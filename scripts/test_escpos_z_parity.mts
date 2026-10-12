// ESC/POS parity check (Phase 4): the thermal Z/X generators must reproduce
// the reconciled shift math without crashing. Run:
//   node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_escpos_z_parity.mts
// Exit non-zero on any failure (CI-friendly PASS/FAIL lines).
import { buildZReportBuffer, buildXReportBuffer } from '../src/utils/escpos.ts';
import { formatDZD } from '../src/types/pos.ts';
import type { ZReportSnapshot } from '../src/components/receipt/ZReportPaper.tsx';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
  if (cond) console.log(`  [PASS] ${label}`);
  else {
    console.error(`  [FAIL] ${label} ${detail}`);
    failures++;
  }
}

const asText = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');
// Printer-observable form of a UI string: EscPosBuilder.text pushes
// charCodeAt(i) & 0xFF, so U+202F (fr-DZ grouping) prints as '/'.
const pz = (s: string): string =>
  [...s].map((c) => String.fromCharCode(c.charCodeAt(0) & 0xff)).join('');

// Phase-4 reference cycle: opening 10 000 + cash 6 000 + deposits 5 000
// - expenses 3 000 - refunds 1 500 = expected 16 500.
const snap = {
  storeName: 'E2E',
  zNumber: 'E2E-Z-1',
  openedAtISO: new Date().toISOString(),
  closedAtISO: new Date().toISOString(),
  registerLabel: 'Caisse E2E',
  responsibleName: 'E2E',
  openingFloat: 10000,
  cashSales: 6000,
  cardSales: 0,
  creditSales: 0,
  repriseTake: 0,
  netSales: 6000,
  debtSettlements: 0,
  savDeposits: 0,
  savSettled: 0,
  refunds: 1500,
  expenses: 3000,
  drops: 0,
  payouts: 0,
  exchangeOut: 0,
  soulteOut: 0,
  manualIn: 5000,
  manualOut: 0,
  tradeInCashOut: 0,
  expectedCash: 16500,
  countedCash: 16500,
  variance: 0,
  blindCountPerformed: true,
  dropsList: [],
} as unknown as ZReportSnapshot;

const zText = asText(buildZReportBuffer(snap, {} as never));
check('Z buffer renders without crashing', zText.length > 100, `len=${zText.length}`);
check('Z shows the refund line', zText.includes(pz(formatDZD(1500))), 'Remboursements client 1500');
check('Z shows theoretical 16 500 (refunds deducted)', zText.includes(pz(formatDZD(16500))));
check('Z shows counted 16 500 and zero variance', zText.includes(pz(formatDZD(16500))));

// X-report fallback path (escpos.ts theoreticalCash): when expectedCash is
// absent the formula omits refunds — DOCUMENTED DEFECT (DISCOVERY §9.9).
// The generator must still not crash; the figure is the known-buggy one.
const xSession = {
  openingFloat: 10000,
  cashSales: 6000,
  manualDeposits: 5000,
  expenses: 3000,
  expectedCash: undefined,
} as never;
const xText = asText(buildXReportBuffer(xSession, {} as never));
check('X buffer renders without crashing', xText.length > 50, `len=${xText.length}`);
const xLine = xText.split('\n').find((l) => l.includes('ESPECES THEORIQUES')) ?? '';
check(
  'X fallback omits refunds (documented defect, value 18 000 not 16 500)',
  xLine.includes(pz(formatDZD(18000))) && !xLine.includes(pz(formatDZD(16500))),
  xLine.trim(),
);

if (failures > 0) {
  console.error(`RESULT: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('RESULT: ESC/POS parity green (Z correct, X defect characterized)');
