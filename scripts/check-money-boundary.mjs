/**
 * Money boundary gate — Stage A (Zero-Drift Mandate v4, PD-22/PD-23).
 *
 * CI-blocking. Three rules:
 *  1. HARD ZERO: the forbidden entry pattern `parseFloat(...) * 100`
 *     (float×100 silently loses a santeem, e.g. "4.35" -> 434) has zero
 *     hits in src/**. Entry must go through Money.fromUserInput.
 *  2. PURITY: src/utils/money.ts and src-tauri/src/money.rs are float-free
 *     (no Math.*, parseFloat/parseInt on TS side; no f64/f32 on Rust side).
 *     BigInt<->Number conversions inside money.ts are exact (range-checked)
 *     and documented in-file — they are not float intermediates.
 *  3. REGISTRY: Math.round/floor/trunc/ceil + parseInt/parseFloat hits in
 *     the money-path file set may only DECREASE (Stage E migration burns
 *     the list down). Any increase = new float-money code = FAIL.
 *     Counts below are the author-time baseline; each entry expires at
 *     Stage E (registry deleted when the set reaches zero).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✅ [PASS] ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

console.log('========================================================================');
console.log('MONEY BOUNDARY GATE (Stage A: PD-22 string entry, PD-23 display)');
console.log('========================================================================');

// ── Rule 1: forbidden float×100 entry ──
console.log('\n--- Rule 1: no parseFloat(x)*100 anywhere in src/ ---');
{
  const { execFileSync } = await import('node:child_process');
  let hits = [];
  try {
    const output = execFileSync(
      'git',
      ['grep', '-n', '-E', 'parseFloat\\s*\\([^)]*\\)\\s*\\*\\s*100', '--', 'src/'],
      { cwd: ROOT, encoding: 'utf8' }
    );
    hits = String(output).split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    // git grep exits 1 on no match (the expected case) — distinguish from
    // real errors (no git binary) via status code.
    const status = e?.status;
    if (status !== 1) hits = ['(git grep unavailable — rule skipped in degraded mode)'];
  }
  check('zero parseFloat*100 patterns', hits.length === 0, hits.slice(0, 5).join(' | '));
}

// ── Rule 2: primitive self-purity ──
console.log('\n--- Rule 2: money.ts / money.rs are float-free ---');
{
  const ts = read('src/utils/money.ts');
  // Exactly ONE Math.* line is allowed: the dinarsToMinor dust-only fallback
  // (transitional load bridge, pinned to its documented line).
  const tsMathHits = [];
  ts.split('\n').forEach((line, i) => {
    if (/Math\./.test(line)) tsMathHits.push(i + 1);
  });
  check('money.ts: single Math.* hit (dust fallback only)', tsMathHits.length === 1,
    `hits at lines ${tsMathHits.join(',')}`);
  check('money.ts: the hit is the dust fallback line',
    tsMathHits.length === 1 && ts.split('\n')[tsMathHits[0] - 1].includes('dust-only fallback'),
    tsMathHits.length === 1 ? ts.split('\n')[tsMathHits[0] - 1].trim() : '');
  check('money.ts: no parseFloat/parseInt', !/parseFloat|parseInt/.test(ts));
  const rs = read('src-tauri/src/money.rs');
  const rsNoComments = rs.split('\n').filter((l) => !l.trim().startsWith('//!') && !l.trim().startsWith('///')).join('\n');
  check('money.rs: no f64/f32', !/\bf64\b|\bf32\b/.test(rsNoComments));
  check('money.rs: single exponent const == 2', /pub const CURRENCY_EXPONENT: u32 = 2;/.test(rs));
  check('money.ts: single exponent const == 2', /exponent: 2,/.test(ts));
}

// ── Rule 3: transitional registry (counts may only decrease) ──
console.log('\n--- Rule 3: money-path float registry (Stage E expiry) ---');
{
  // file -> max allowed hits (author-time baseline, Stage A).
  const REGISTRY = {
    'src/utils/receiptMath.ts': 25, // UI-005: 2x single-round-at-boundary Math.round (averageReceiptUnitCost, debtLimitGauge)
    'src/utils/taxEngine.ts': 1,
    'src/utils/moneyInput.ts': 1,
    'src/utils/cashTerms.ts': 8,
    'src/utils/receiptViewModel.ts': 13,
    'src/utils/fifoPreview.ts': 5,
    'src/utils/inventoryValuation.ts': 2,
    'src/utils/zReportSnapshot.ts': 3,
    'src/db/sqlPluginAdapter.ts': 50,
    'src/store/slices/createOrderSlice.ts': 23,
    'src/store/slices/createCartSlice.ts': 8,
    'src/components/PoReviewScreen.tsx': 55,
    'src/utils/savQuoteBuilder.ts': 1,
    'src/utils/escpos.ts': 2,
  };
  const pat = /Math\.(round|floor|trunc|ceil)|parseInt\s*\(|parseFloat\s*\(/g;
  for (const [file, max] of Object.entries(REGISTRY)) {
    let src;
    try {
      src = read(file);
    } catch {
      check(`${file}: readable`, false, 'file missing');
      continue;
    }
    const n = (src.match(pat) || []).length;
    check(`${file}: ${n} <= ${max}${n < max ? ' (migration progress — update registry)' : ''}`, n <= max, `got ${n}, allowed ${max}`);
  }
}

console.log('\n--- Rule 1b: BUG-MONEY-04 render-crash guard ---');
{
  const mi = read('src/components/ui/MoneyInput.tsx');
  check('MoneyInput caps keystroke magnitude (maxLength)', /maxLength=\{\d+\}/.test(mi));
}

console.log('\n--- Rule 4: Phase 1c input sweep (one parsing path) ---');
{
  // file -> max remaining legacy-parser hits. Every money input in these
  // files parses via MoneyInput (Money.fromUserInput); remaining hits are
  // enumerated non-money uses (percent, qty, volume slider, OCR extraction,
  // 1b-i-deleted TVA field). Any NEW money-field parser fails the build.
  const ADOPTION = {
    'src/components/modals/KittingBundleModal.tsx': { pla: 0, pf: 0 },
    'src/components/modals/PurchaseOrderModal.tsx': { pla: 0, pf: 0 },
    'src/components/modals/VoucherModal.tsx': { pla: 0, pf: 0 },
    'src/components/modals/ExpenseManagerModal.tsx': { pla: 0, pf: 0 },
    'src/components/modals/ReportsModal.tsx': { pla: 0, pf: 0 },
    'src/components/modals/DiscountModal.tsx': { pla: 1, pf: 0 }, // percent input
    'src/components/modals/TradeInBuybackModal.tsx': { pla: 0, pf: 1 }, // margin percent
    'src/components/modals/PaymentModal.tsx': { pla: 0, pf: 0 },
    'src/components/mobile/tabs/MobileCheckoutTab.tsx': { pla: 0, pf: 0 },
    'src/components/CartPanel.tsx': { pla: 0, pf: 0 },
    // DebtLedgerModal DEFERRED (Phase 1c doc §5): another lane is actively
    // rewriting it. Reverted to legacy parsers to leave zero footprint;
    // migrate post-settle/Stage E. pla=3 pins it.
    'src/components/modals/DebtLedgerModal.tsx': { pla: 3, pf: 0, deferred: true },
    'src/components/modals/CustomersModal.tsx': { pla: 0, pf: 0 },
    'src/components/modals/RepairWorkOrderModal.tsx': { pla: 0, pf: 0 },
    'src/components/modals/ShiftCloseModal.tsx': { pla: 0, pf: 0 },
    'src/components/modals/ShiftZReportModal.tsx': { pla: 0, pf: 0 },
    'src/components/modals/ShiftOpenModal.tsx': { pla: 0, pf: 0 },
    'src/components/modals/ShiftMovementModal.tsx': { pla: 0, pf: 0 },
    'src/components/modals/SettingsModal.tsx': { pla: 0, pf: 1 }, // audio volume slider
    'src/components/modals/InvoiceIngestionModal.tsx': { pla: 2, pf: 0 }, // OCR extraction + 1b-i-deleted TVA field
    // PoReviewScreen DEFERRED (Phase 1c doc §5): 7 parseFloat money inputs sit
    // inside another lane's in-flight card/table rewrite and cannot be
    // committed without absorbing it. Dot-decimals preserved (no destruction);
    // comma+echo arrive post-settle or Stage E. pf=9 pins the deferral.
    'src/components/PoReviewScreen.tsx': { pla: 0, pf: 9, deferred: true },
    'src/components/modals/CommandTicketDashboardModal.tsx': { pla: 0, pf: 0 },
    'src/components/modals/ProductEditorModal.tsx': { pla: 0, pf: 0 },
    'src/components/modals/CustomItemModal.tsx': { pla: 0, pf: 0 },
    'src/components/modals/ProductMatrixModal.tsx': { pla: 0, pf: 0 },
  };
  for (const [file, max] of Object.entries(ADOPTION)) {
    let src;
    try {
      src = read(file);
    } catch {
      check(`${file}: readable`, false, 'file missing');
      continue;
    }
    if (!max.deferred) {
      check(`${file}: MoneyInput adopted`, src.includes('MoneyInput'),
        'no MoneyInput import — money fields must use the shared component');
    }
    const pla = (src.match(/parseLocalizedAmount\s*\(/g) || []).length;
    const pf = (src.match(/parseFloat\s*\(/g) || []).length;
    check(`${file}: legacy parsers within registry (pla ${pla}<=${max.pla}, pf ${pf}<=${max.pf})`,
      pla <= max.pla && pf <= max.pf, `got pla=${pla} pf=${pf}`);
  }
}

console.log('\n========================================================================');
console.log(`BOUNDARY GATE: ${pass} PASSED, ${fail} FAILED`);
console.log('========================================================================');
if (fail > 0) process.exit(1);
