/**
 * UPGRADE-11 — Kredy collection & risk suite (v126).
 *
 * Part 1 — pure engine pins: integer-DZD coercion, due-date aging ladder
 *          (en-dash literals, floor semantics), the SINGLE credit gate
 *          (at-limit stays allowed), 0 %/0-fee installment plans
 *          (Σ entries === total, remainders to the earliest), FIFO repayment
 *          waterfall (due ASC → nulls last → id ASC), plan-entry fill, the
 *          0–100 reliability score (Σ factors === score) and the dunning
 *          ladder (R1/R2/R3 @ 1/15/45, never skips, quiet hours 19→08 @ UTC+1).
 * Part 2 — THE OWNER ORACLE: credit→repayment conservation across clock
 *          jumps. Money math never reads the wall clock (identical
 *          allocations at T0 and T0+75d); balances conserve
 *          (Σ outstanding === Σ acquired − Σ settled) and only the risk
 *          signals (bucket, score) move.
 * Part 3 — I1–I9 fix pins (the defect register contract): labels match
 *          predicates, memoized counts, modal-state ownership, PIN cap +
 *          honest gate reason, innermost Escape + backdrop dismissal,
 *          honest popup signal, phone search, adapter rethrow posture —
 *          plus the register statuses themselves.
 * Part 4 — EXPLAIN QUERY PLAN oracle on `node:sqlite` against the REAL v126
 *          DDL and the REAL SQL strings: every read/write resolves via
 *          SEARCH … USING INDEX; any SCAN fails the build.
 * Part 5 — single-claim dunning semantics + honest launch log on the real
 *          statements: fresh claim wins, live dup loses, stale PLANIFIEE
 *          re-takes, LANCEE is never re-claimable, release only clears
 *          PLANIFIEE; `whatsapp_launches` carries exactly 'Lancé'.
 * Part 6 — wiring + parity: lib.rs v126 ≡ schemaHeal constants ≡ adapter
 *          probe/spread; ceiling 126; engine purity; one credit gate for
 *          desktop + mobile; entries-first plan writes; claim-before-launch;
 *          local-only tables; stale I4 comments refreshed.
 * Part 7 — heal replay on a pre-v126 shape: probes fail → statements apply →
 *          probes pass → idempotent rerun → integrity_check ok, FK empty.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  ALGERIA_UTC_OFFSET_MINUTES,
  allocateRepaymentFifo,
  addDaysIso,
  agingBucketFor,
  agingBucketRank,
  applyPaymentToPlanEntries,
  assertCreditAllowed,
  buildInstallmentPlan,
  computeReliabilityScore,
  daysOverdue,
  dunningLaunchGate,
  DUNNING_STAGES,
  KREDY_AGING_BUCKETS,
  KREDY_DEFAULT_TERM_DAYS,
  KREDY_DUNNING_STALE_CLAIM_MS,
  KREDY_LAUNCH_STATUS,
  KREDY_QUIET_END_HOUR,
  KREDY_QUIET_START_HOUR,
  localHourAt,
  nextDunningStage,
  outstandingItemsFromEntries,
  parseIsoMs,
  toIntDzd,
} from '../src/utils/kredyEngine';
import {
  KREDY_V126_HEAL_SQL,
  KREDY_V126_PROBE_CUSTOMER_DEBTS_SQL,
  KREDY_V126_PROBE_CUSTOMERS_SQL,
} from '../src/db/schemaHeal';
import {
  buildKredyDunningByCustomersSql,
  buildKredyPlanEntriesSql,
  KREDY_DUNNING_BY_CUSTOMER_SQL,
  KREDY_DUNNING_CLAIM_SQL,
  KREDY_DUNNING_FINALIZE_SQL,
  KREDY_DUNNING_RELEASE_SQL,
  KREDY_ENTRY_PAY_UPDATE_SQL,
  KREDY_PLAN_ENTRY_INSERT_SQL,
  KREDY_PLAN_INSERT_SQL,
  KREDY_PLAN_STATUS_UPDATE_SQL,
  KREDY_PLANS_ACTIVE_BY_CUSTOMER_SQL,
  KREDY_WHATSAPP_BY_CUSTOMER_SQL,
  KREDY_WHATSAPP_LAUNCH_INSERT_SQL,
} from '../src/db/kredySql';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`);
  } else {
    fail++;
    failures.push(`${name}${extra ? ' :: ' + extra : ''}`);
    console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`);
  }
}
const src = (p: string) => readFileSync(`${process.cwd()}/${p}`, 'utf8');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Pre-v126 shape: the exact subtables v126 ALTERs — nothing more is needed. */
const PRE_V126_DDL = `
  CREATE TABLE customers (
    id TEXT PRIMARY KEY, name TEXT, phone TEXT, current_debt REAL,
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE customer_debts (
    id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, type TEXT NOT NULL,
    amount INTEGER NOT NULL, balance_after INTEGER, created_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  );
`;

/** Real v126 DDL — the exact objects the app runs. */
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(PRE_V126_DDL);
  for (const stmt of KREDY_V126_HEAL_SQL) db.exec(stmt);
  return db;
}

const bind = (values: Array<string | number | null>): Record<string, string | number | null> => {
  const o: Record<string, string | number | null> = {};
  values.forEach((v, i) => {
    o[String(i + 1)] = v;
  });
  return o;
};

const NOW = '2026-10-17T09:00:00.000Z';
const NOW_PLUS_30D = '2026-11-16T09:00:00.000Z';

// ── Part 1: pure engine pins ───────────────────────────────────────────────
console.log('\n--- Part 1: engine (aging, gate, plans, waterfall, score, dunning) ---');
{
  // Constants.
  check('default credit term pinned at 30d', KREDY_DEFAULT_TERM_DAYS === 30);
  check('stale-claim window pinned at 10 min', KREDY_DUNNING_STALE_CLAIM_MS === 10 * 60_000);
  check("launch status is exactly 'Lancé' (never 'Envoyé')", KREDY_LAUNCH_STATUS === 'Lancé');
  check('quiet hours pinned 19 → 08 (Algeria UTC+1)', KREDY_QUIET_START_HOUR === 19 && KREDY_QUIET_END_HOUR === 8 && ALGERIA_UTC_OFFSET_MINUTES === 60);
  check(
    'bucket literals use EN dashes, pinned order',
    (KREDY_AGING_BUCKETS as readonly string[]).join('|') === 'Courant|1–30j|31–60j|61–90j|90j+' &&
      !(KREDY_AGING_BUCKETS as readonly string[]).includes('1-30j')
  );

  // Coercion helpers.
  check('toIntDzd truncates fractions', toIntDzd(10.9) === 10 && toIntDzd(-3.7) === -3);
  check('toIntDzd never NaN (null/undefined/NaN/Infinity/garbage → 0)', toIntDzd(null) === 0 && toIntDzd(undefined) === 0 && toIntDzd(Number.NaN) === 0 && toIntDzd(Infinity) === 0 && toIntDzd('abc') === 0);
  check("toIntDzd parses numeric strings", toIntDzd('12') === 12);
  check('parseIsoMs null-safe', parseIsoMs(null) === null && parseIsoMs('') === null && parseIsoMs('garbage') === null && parseIsoMs(NOW) === Date.parse(NOW));
  check('addDaysIso month boundary', addDaysIso('2026-08-31T00:00:00.000Z', 1) === '2026-09-01T00:00:00.000Z');
  check('addDaysIso leap-year safe', addDaysIso('2028-02-28T00:00:00.000Z', 1) === '2028-02-29T00:00:00.000Z');

  // Due-date aging (floor semantics, en-dash buckets).
  check('daysOverdue: due == now → 0', daysOverdue(NOW, NOW) === 0);
  check('daysOverdue: 23h late still 0 (floor — first bucket is a FULL day)', daysOverdue('2026-10-16T10:00:00.000Z', NOW) === 0);
  check('daysOverdue: 10 full days → 10', daysOverdue(addDaysIso(NOW, -10), NOW) === 10);
  check('daysOverdue: future due is negative, never NaN', daysOverdue(addDaysIso(NOW, 1), NOW) === -1);
  check('daysOverdue: null due / garbage clock → 0', daysOverdue(null, NOW) === 0 && daysOverdue(NOW, 'garbage') === 0);
  check("bucket: not due (incl. exactly due) → 'Courant'", agingBucketFor(NOW, NOW) === 'Courant' && agingBucketFor(addDaysIso(NOW, 1), NOW) === 'Courant' && agingBucketFor(null, NOW) === 'Courant');
  check("bucket boundaries: 1/30 → '1–30j'", agingBucketFor(addDaysIso(NOW, -1), NOW) === '1–30j' && agingBucketFor(addDaysIso(NOW, -30), NOW) === '1–30j');
  check("bucket boundaries: 31/60 → '31–60j'", agingBucketFor(addDaysIso(NOW, -31), NOW) === '31–60j' && agingBucketFor(addDaysIso(NOW, -60), NOW) === '31–60j');
  check("bucket boundaries: 61/90 → '61–90j'", agingBucketFor(addDaysIso(NOW, -61), NOW) === '61–90j' && agingBucketFor(addDaysIso(NOW, -90), NOW) === '61–90j');
  check("bucket: 91+ → '90j+'", agingBucketFor(addDaysIso(NOW, -91), NOW) === '90j+');
  check('bucket rank orders 0..4 (unknown → 0)', agingBucketRank('Courant') === 0 && agingBucketRank('90j+') === 4 && agingBucketRank('zzz' as never) === 0);

  // THE single credit gate — shipped boundary preserved (at-limit allowed).
  const atLimit = assertCreditAllowed({ currentDebt: 90000, debtLimit: 100000, creditAmount: 10000 });
  check('gate: exactly at the ceiling stays ALLOWED (shipped boundary)', atLimit.allowed === true && atLimit.projectedDebt === 100000);
  const overLimit = assertCreditAllowed({ currentDebt: 90001, debtLimit: 100000, creditAmount: 10000 });
  check('gate: strictly above the ceiling is refused with the reason', overLimit.allowed === false && overLimit.reason === 'CREDIT_LIMIT_EXCEEDED');
  const sanitized = assertCreditAllowed({ currentDebt: Number.NaN, debtLimit: 100, creditAmount: Number.NaN });
  check('gate: NaN sanitizes to 0, never throws', sanitized.allowed === true && sanitized.projectedDebt === 0);
  const fractional = assertCreditAllowed({ currentDebt: 0.75, debtLimit: 1, creditAmount: 0.75 });
  check('gate: never re-rounds (raw projection kept)', fractional.allowed === false && fractional.projectedDebt === 1.5);

  // Zero-interest installment plans.
  const built = buildInstallmentPlan({ totalAmount: 100000, installments: 3, intervalDays: 30, startIso: NOW, outstandingDebt: 150000 });
  check('plan: builds with 0 %/0-fee (no fee/rate field anywhere)', built.ok === true && !/fee|interest|rate|taux/i.test(JSON.stringify(built)));
  if (built.ok) {
    const amounts = built.plan.entries.map((e) => e.amount);
    check('plan: remainder goes to the EARLIEST entries (33334/33333/33333)', amounts.join(',') === '33334,33333,33333');
    check('plan: Σ entries === total exactly', amounts.reduce((s, a) => s + a, 0) === built.plan.totalAmount);
    check('plan: entries are dated by interval (start+30/60/90)', built.plan.entries.map((e) => e.dueDate).join('|') === '2026-11-16T09:00:00.000Z|2026-12-16T09:00:00.000Z|2027-01-15T09:00:00.000Z');
    check('plan: seq is 1-based and contiguous', built.plan.entries.map((e) => e.seq).join(',') === '1,2,3');
  }
  const built2 = buildInstallmentPlan({ totalAmount: 100, installments: 6, intervalDays: 15, startIso: NOW });
  check('plan: 100/6 splits 17×4 then 16×2 (largest-remainder, deterministic)', built2.ok === true && built2.plan.entries.map((e) => e.amount).join(',') === '17,17,17,17,16,16');
  check('plan: deterministic — two runs deep-equal', JSON.stringify(built2) === JSON.stringify(buildInstallmentPlan({ totalAmount: 100, installments: 6, intervalDays: 15, startIso: NOW })));
  check('plan: same helper, same dates (addDaysIso identity)', built.ok === true && built.plan.entries[0].dueDate === addDaysIso(NOW, 30));

  const planReasons = (input: Parameters<typeof buildInstallmentPlan>[0]) => {
    const r = buildInstallmentPlan(input);
    return r.ok ? 'OK' : r.reason;
  };
  check('plan: negative → TOTAL_NEGATIVE', planReasons({ totalAmount: -1, installments: 2, intervalDays: 30, startIso: NOW }) === 'TOTAL_NEGATIVE');
  check('plan: fractional total → NON_INTEGER_TOTAL', planReasons({ totalAmount: 100.5, installments: 2, intervalDays: 30, startIso: NOW }) === 'NON_INTEGER_TOTAL');
  check('plan: installments 0/121 → INSTALLMENTS_RANGE', planReasons({ totalAmount: 100, installments: 0, intervalDays: 30, startIso: NOW }) === 'INSTALLMENTS_RANGE' && planReasons({ totalAmount: 100, installments: 121, intervalDays: 30, startIso: NOW }) === 'INSTALLMENTS_RANGE');
  check('plan: interval 0/91 → INTERVAL_RANGE', planReasons({ totalAmount: 100, installments: 2, intervalDays: 0, startIso: NOW }) === 'INTERVAL_RANGE' && planReasons({ totalAmount: 100, installments: 2, intervalDays: 91, startIso: NOW }) === 'INTERVAL_RANGE');
  check('plan: total < n → ENTRY_BELOW_ONE_DA', planReasons({ totalAmount: 3, installments: 4, intervalDays: 30, startIso: NOW }) === 'ENTRY_BELOW_ONE_DA');
  check('plan: unreadable start → INVALID_START', planReasons({ totalAmount: 100, installments: 2, intervalDays: 30, startIso: 'garbage' }) === 'INVALID_START');
  check('plan: total above outstanding → EXCEEDS_OUTSTANDING', planReasons({ totalAmount: 50000, installments: 2, intervalDays: 30, startIso: NOW, outstandingDebt: 49999 }) === 'EXCEEDS_OUTSTANDING');
  check('plan: total exactly at outstanding is allowed', planReasons({ totalAmount: 50000, installments: 2, intervalDays: 30, startIso: NOW, outstandingDebt: 50000 }) === 'OK');

  // FIFO repayment waterfall.
  const fifoItems = [
    { id: 'b', dueDate: '2026-11-01T00:00:00.000Z', remaining: 1500 },
    { id: 'a', dueDate: '2026-10-01T00:00:00.000Z', remaining: 2000 },
    { id: 'z', dueDate: null, remaining: 9999 },
    { id: 'a2', dueDate: '2026-10-01T00:00:00.000Z', remaining: 3000 },
    { id: 'm', dueDate: '2026-09-01T00:00:00.000Z', remaining: 0 },
  ];
  const w1 = allocateRepaymentFifo(fifoItems, 6000);
  check('waterfall: oldest due first, tie by id, nulls last, empty skipped', w1.allocations.map((a) => `${a.debtId}:${a.amount}`).join('|') === 'a:2000|a2:3000|b:1000');
  check('waterfall: conservation Σ allocations + leftover === payment', w1.allocations.reduce((s, a) => s + a.amount, 0) + w1.leftover === 6000 && w1.leftover === 0);
  const w2 = allocateRepaymentFifo(fifoItems, 20000);
  check('waterfall: overpay conservation still exact', w2.allocations.reduce((s, a) => s + a.amount, 0) + w2.leftover === 20000, `leftover=${w2.leftover}`);
  check('waterfall: total capacity consumed before leftover (16499 → 3501)', w2.allocations.reduce((s, a) => s + a.amount, 0) === 16499 && w2.leftover === 3501);
  const w3 = allocateRepaymentFifo(fifoItems, -500);
  check('waterfall: negative payment clamps to 0', w3.allocations.length === 0 && w3.leftover === 0);
  const w4 = allocateRepaymentFifo([], 100);
  check('waterfall: empty ledger keeps the whole payment as leftover', w4.allocations.length === 0 && w4.leftover === 100);

  // Plan-entry fill (same write path as the balance update).
  const planEntries = [
    { id: 'e1', seq: 1, amount: 10000, paidAmount: 0 },
    { id: 'e2', seq: 2, amount: 10000, paidAmount: 0 },
    { id: 'e3', seq: 3, amount: 10000, paidAmount: 0 },
  ];
  const f1 = applyPaymentToPlanEntries(planEntries, 12500);
  check('plan fill: seq order, only touched entries reported', f1.updates.map((u) => `${u.id}:${u.paidAmount}:${u.justPaid}`).join('|') === 'e1:10000:true|e2:2500:false');
  check('plan fill: conservation Σ taken + remaining === payment', f1.updates.reduce((s, u) => s + u.paidAmount, 0) + f1.remaining === 12500);
  check('plan fill: not all paid yet', f1.allPaid === false);
  const f2 = applyPaymentToPlanEntries(
    planEntries.map((e) => {
      const u = f1.updates.find((x) => x.id === e.id);
      return u ? { ...e, paidAmount: u.paidAmount } : e;
    }),
    7500
  );
  check('plan fill: second payment closes e2 exactly', f2.updates.map((u) => `${u.id}:${u.paidAmount}:${u.justPaid}`).join('|') === 'e2:10000:true' && f2.remaining === 0 && f2.allPaid === false);
  const f3 = applyPaymentToPlanEntries(
    planEntries.map((e) => {
      const fromF2 = f2.updates.find((x) => x.id === e.id)?.paidAmount;
      const fromF1 = f1.updates.find((x) => x.id === e.id)?.paidAmount;
      return { ...e, paidAmount: fromF2 ?? fromF1 ?? e.paidAmount };
    }),
    10000
  );
  check('plan fill: final payment completes the plan (allPaid)', f3.allPaid === true && f3.remaining === 0 && f3.updates.map((u) => `${u.id}:${u.paidAmount}:${u.justPaid}`).join('|') === 'e3:10000:true');

  // Reliability score — Σ factors === score ALWAYS.
  const sumFactors = (r: { score: number; factors: Array<{ points: number }> }) => r.factors.reduce((s, f) => s + f.points, 0);
  const perfect = computeReliabilityScore({
    nowIso: NOW,
    currentDebt: 0,
    debtLimit: 100000,
    entries: [
      { id: 'a', type: 'DEBT_ACQUIRED', amount: 50000, createdAt: '2026-08-01T09:00:00.000Z' },
      { id: 'p', type: 'PAYMENT_SETTLED', amount: 50000, createdAt: '2026-10-12T09:00:00.000Z', allocations: [{ debtId: 'a', amount: 50000 }] },
    ],
  });
  check('score: fully repaid + recent payment + no debt → 100', perfect.score === 100);
  check('score: Σ factors === score (no clamp case)', sumFactors(perfect) === perfect.score);
  const clamped = computeReliabilityScore({
    nowIso: NOW,
    currentDebt: 60000,
    debtLimit: 60000,
    entries: [
      { id: 'a', type: 'DEBT_ACQUIRED', amount: 100000, dueDate: '2026-07-14T09:00:00.000Z' },
      { id: 'p', type: 'PAYMENT_SETTLED', amount: 10000, createdAt: '2026-03-31T09:00:00.000Z', allocations: [{ debtId: 'a', amount: 10000 }] },
    ],
  });
  check('score: worst case clamps to 0 (90j+ overdue −40, ceiling −15)', clamped.score === 0);
  check('score: Σ factors === score WITH the clamp factor', sumFactors(clamped) === clamped.score);
  const c1 = computeReliabilityScore({
    nowIso: NOW,
    currentDebt: 50000,
    debtLimit: 100000,
    entries: [
      { id: 'ac', type: 'DEBT_ACQUIRED', amount: 100000, dueDate: null },
      { id: 'pp', type: 'PAYMENT_SETTLED', amount: 50000, createdAt: '2026-09-12T09:00:00.000Z', allocations: [{ debtId: 'ac', amount: 50000 }] },
    ],
  });
  const c2 = computeReliabilityScore({
    nowIso: NOW_PLUS_30D,
    currentDebt: 50000,
    debtLimit: 100000,
    entries: [
      { id: 'ac', type: 'DEBT_ACQUIRED', amount: 100000, dueDate: null },
      { id: 'pp', type: 'PAYMENT_SETTLED', amount: 50000, createdAt: '2026-09-12T09:00:00.000Z', allocations: [{ debtId: 'ac', amount: 50000 }] },
    ],
  });
  check('score: clock jump 35d→65d drops recency by exactly 6 (20→14→8 tier)', c2.score === c1.score - 6 && c1.score === 70 && c2.score === 64);
  check('score: Σ factors === score at BOTH clocks', sumFactors(c1) === c1.score && sumFactors(c2) === c2.score);
  const unreadableClock = computeReliabilityScore({
    nowIso: 'garbage',
    currentDebt: 5000,
    debtLimit: 100000,
    entries: [
      { id: 'a', type: 'DEBT_ACQUIRED', amount: 5000, dueDate: null },
      { id: 'p', type: 'PAYMENT_SETTLED', amount: 1000, createdAt: NOW, allocations: [{ debtId: 'a', amount: 1000 }] },
    ],
  });
  const recencyFactor = unreadableClock.factors.find((f) => f.key === 'recency');
  check('score: unreadable clock → prudent recency note, never a throw', recencyFactor?.points === 3 && (recencyFactor?.detail ?? '').includes('illisible'));

  // Outstanding items reconstructed from the ledger (allocations are the only truth).
  const ledger = [
    { id: 'a1', type: 'DEBT_ACQUIRED', amount: 50000, dueDate: '2026-09-20T09:00:00.000Z' },
    { id: 'a2', type: 'DEBT_ACQUIRED', amount: 30000, dueDate: null },
    { id: 'p1', type: 'PAYMENT_SETTLED', amount: 20000, createdAt: NOW, allocations: [{ debtId: 'a1', amount: 20000 }] },
  ];
  const items = outstandingItemsFromEntries(ledger);
  check('outstanding: remaining = amount − Σ allocations', items.find((i) => i.id === 'a1')?.remaining === 30000 && items.find((i) => i.id === 'a2')?.remaining === 30000);
  const legacyPayment = outstandingItemsFromEntries([...ledger, { id: 'p2', type: 'PAYMENT_SETTLED', amount: 5000, createdAt: NOW, allocations: null }]);
  check('outstanding: legacy payment without allocations never reduces (prudent)', legacyPayment.find((i) => i.id === 'a1')?.remaining === 30000);

  // Dunning ladder.
  check('ladder pinned: R1 @1d, R2 @15d, R3 @45d', DUNNING_STAGES.map((s) => `${s.id}:${s.minDaysOverdue}`).join(',') === 'R1:1,R2:15,R3:45');
  check('ladder: not yet 1 full day late → no stage', nextDunningStage({ launchedStages: [], daysOverdue: 0 }) === null);
  check('ladder: 1 day late → R1', nextDunningStage({ launchedStages: [], daysOverdue: 1 })?.id === 'R1');
  check('ladder: R1 launched, 14d → nothing yet', nextDunningStage({ launchedStages: ['R1'], daysOverdue: 14 }) === null);
  check('ladder: R1 launched, 15d → R2', nextDunningStage({ launchedStages: ['R1'], daysOverdue: 15 })?.id === 'R2');
  check('ladder: R1+R2 launched, 44d → nothing yet', nextDunningStage({ launchedStages: ['R1', 'R2'], daysOverdue: 44 }) === null);
  check('ladder: R1+R2 launched, 45d → R3', nextDunningStage({ launchedStages: ['R1', 'R2'], daysOverdue: 45 })?.id === 'R3');
  check('ladder: exhausted → null', nextDunningStage({ launchedStages: ['R1', 'R2', 'R3'], daysOverdue: 500 }) === null);
  check('ladder NEVER skips: 50 days overdue, nothing launched → R1', nextDunningStage({ launchedStages: [], daysOverdue: 50 })?.id === 'R1');
  check('ladder tolerates lowercase history (dedupe by uppercase)', nextDunningStage({ launchedStages: ['r1'], daysOverdue: 16 })?.id === 'R2');

  // Quiet hours (fail closed, next boundary exact).
  check('quiet: localHourAt shifts by UTC+1', localHourAt('2026-10-17T18:00:00.000Z') === 19 && localHourAt('2026-10-17T06:00:00.000Z') === 7);
  check('quiet: 18:59 local still allowed', dunningLaunchGate('2026-10-17T17:59:59.000Z').allowed === true);
  check('quiet: exactly 19:00 local → QUIET with tomorrow 08:00 boundary', (() => { const g = dunningLaunchGate('2026-10-17T18:00:00.000Z'); return g.allowed === false && g.reason === 'QUIET_HOURS' && g.nextAllowedIso === '2026-10-18T07:00:00.000Z'; })());
  check('quiet: 07:00 local → QUIET with TODAY 08:00 boundary', (() => { const g = dunningLaunchGate('2026-10-17T06:00:00.000Z'); return g.allowed === false && g.reason === 'QUIET_HOURS' && g.nextAllowedIso === '2026-10-17T07:00:00.000Z'; })());
  check('quiet: exactly 08:00 local → allowed', dunningLaunchGate('2026-10-17T07:00:00.000Z').allowed === true);
  check('quiet: after midnight local still quiet (same-day 08:00)', (() => { const g = dunningLaunchGate('2026-10-17T23:30:00.000Z'); return g.reason === 'QUIET_HOURS' && g.nextAllowedIso === '2026-10-18T07:00:00.000Z'; })());
  check('quiet: unreadable clock fails closed', (() => { const g = dunningLaunchGate('garbage'); return g.allowed === false && g.reason === 'INVALID_CLOCK' && g.nextAllowedIso === null; })());
}

// ── Part 2: THE OWNER ORACLE — conservation across clock jumps ────────────
console.log('\n--- Part 2: owner oracle — credit/repayment conservation across clock jumps ---');
{
  const T0 = NOW;
  const T1 = addDaysIso(NOW, 75); // '2026-12-31T09:00:00.000Z' — a big clock jump
  check('clock jump is 75 days', T1 === '2026-12-31T09:00:00.000Z');

  // Credit: two acquisitions (dated + undated) = 80 000 DA.
  const acquisitions = [
    { id: 'a1', type: 'DEBT_ACQUIRED', amount: 50000, dueDate: '2026-09-20T09:00:00.000Z' },
    { id: 'a2', type: 'DEBT_ACQUIRED', amount: 30000, dueDate: null },
  ];
  const totalAcquired = acquisitions.reduce((s, a) => s + a.amount, 0);
  check('acquired truth = 80 000', totalAcquired === 80000);

  // Repayment 1 @T0: the waterfall reads DUE DATES only — never the clock.
  const itemsAtT0 = outstandingItemsFromEntries(acquisitions);
  const pay1 = allocateRepaymentFifo(itemsAtT0, 20000);
  check('payment 1: oldest due absorbs it fully (a1)', pay1.allocations.map((a) => `${a.debtId}:${a.amount}`).join('|') === 'a1:20000' && pay1.leftover === 0);
  check('payment 1: conservation Σ + leftover === 20000', pay1.allocations.reduce((s, a) => s + a.amount, 0) + pay1.leftover === 20000);

  const ledgerAfterPay1 = [...acquisitions, { id: 'p1', type: 'PAYMENT_SETTLED', amount: 20000, createdAt: T0, allocations: pay1.allocations }];
  const itemsAfterPay1 = outstandingItemsFromEntries(ledgerAfterPay1);
  const outstanding1 = itemsAfterPay1.reduce((s, i) => s + i.remaining, 0);
  check('after payment 1: Σ outstanding === Σ acquired − Σ settled (60 000)', outstanding1 === totalAcquired - 20000);

  // THE JUMP: aging and score move — money must not.
  check("aging at T0: a1 in '1–30j'", agingBucketFor('2026-09-20T09:00:00.000Z', T0) === '1–30j');
  check("aging at T1: same debt now '90j+'", agingBucketFor('2026-09-20T09:00:00.000Z', T1) === '90j+');
  const itemsAtT1 = outstandingItemsFromEntries(ledgerAfterPay1);
  check('money at T1: identical remaining items (clock never enters)', JSON.stringify(itemsAtT1) === JSON.stringify(itemsAfterPay1));
  check('Σ outstanding still 60 000 after the jump', itemsAtT1.reduce((s, i) => s + i.remaining, 0) === 60000);

  // Repayment 2 @T1: identical allocations to the ones computed @T0.
  const pay2AtT1 = allocateRepaymentFifo(itemsAtT1, 45000);
  const pay2AtT0 = allocateRepaymentFifo(itemsAtT1, 45000);
  check('payment 2 allocation is clock-invariant', JSON.stringify(pay2AtT1) === JSON.stringify(pay2AtT0));
  check('payment 2: FIFO fills a1 then a2 (30 000 + 15 000)', pay2AtT1.allocations.map((a) => `${a.debtId}:${a.amount}`).join('|') === 'a1:30000|a2:15000' && pay2AtT1.leftover === 0);

  const ledgerAfterPay2 = [...ledgerAfterPay1, { id: 'p2', type: 'PAYMENT_SETTLED', amount: 45000, createdAt: T1, allocations: pay2AtT1.allocations }];
  const itemsFinal = outstandingItemsFromEntries(ledgerAfterPay2);
  const outstandingFinal = itemsFinal.reduce((s, i) => s + i.remaining, 0);
  const settledFinal = ledgerAfterPay2.filter((e) => e.type === 'PAYMENT_SETTLED').reduce((s, e) => s + e.amount, 0);
  check('final conservation: Σ outstanding + Σ settled === Σ acquired', outstandingFinal + settledFinal === totalAcquired, `${outstandingFinal} + ${settledFinal}`);
  check('final: only a2 partially open (15 000)', itemsFinal.find((i) => i.id === 'a1')?.remaining === 0 && itemsFinal.find((i) => i.id === 'a2')?.remaining === 15000);

  // Score identity survives the jump too (risk moves, sums stay exact).
  const sT0 = computeReliabilityScore({ nowIso: T0, currentDebt: 60000, debtLimit: 100000, entries: ledgerAfterPay1 });
  const sT1 = computeReliabilityScore({ nowIso: T1, currentDebt: 60000, debtLimit: 100000, entries: ledgerAfterPay1 });
  check('score identity at T0 and T1 (Σ factors === score, jump or not)', sT0.factors.reduce((s, f) => s + f.points, 0) === sT0.score && sT1.factors.reduce((s, f) => s + f.points, 0) === sT1.score);
  check('score moved across the jump (aging penalty grew), money did not', sT1.score <= sT0.score && outstanding1 === 60000);
}

// ── Part 3: I1–I9 fix pins (the register contract) ────────────────────────
console.log('\n--- Part 3: I1–I9 pins (labels, ownership, honest signals) ---');
{
  const modal = src('src/components/modals/DebtLedgerModal.tsx');
  const phone = src('src/utils/phoneUtils.ts');
  const custAdapter = src('src/db/adapters/customerAdapter.ts');
  const shiftSlice = src('src/store/slices/createShiftSlice.ts');
  const uiSlice = src('src/store/slices/createUISlice.ts');
  const repairSlice = src('src/store/slices/createRepairSlice.ts');
  const register = src('docs/kredy-defects.md');

  // I1 — label matches the inclusive predicate.
  check('I1: tab reads ≥ 20k DA and predicate stays >= 20000', modal.includes('Dettes Élevées (≥ 20k DA)') && modal.includes('>= 20000'));
  check('I1: the contradictory "> 20k" literal is gone', !modal.includes('Dettes Élevées (> 20k DA)') && !modal.includes('Dettes Élevées (&gt; 20k DA)'));

  // I2 — relabel to the honest boundary.
  check('I2: tab + card read "Plafond Atteint / Dépassé"', modal.includes('Plafond Atteint / Dépassé') && !modal.includes('🚨 Plafond Dépassé'));
  check('I2: predicates untouched (safe ≥ at counter + filter)', modal.includes("filterType === 'over_limit'") && modal.includes('(c.debtLimit ?? DEFAULT_CREDIT_LIMIT)'));

  // I3 — memoized count on the high-debt tab.
  check('I3: memoized highDebtCount rendered in the tab', modal.includes('const highDebtCount = useMemo(') && modal.includes('({highDebtCount})'));

  // I4 — modal-state ownership moved out of logCashMovement.
  const logCashSeg = shiftSlice.split('logCashMovement: async')[1]?.split('closeShift: async')[0] ?? '';
  check('I4: logCashMovement never writes activeModal', logCashSeg.length > 0 && !logCashSeg.includes('activeModal'));
  check('I4: stale side-effect comments refreshed in both consumers', uiSlice.includes('I4 (UPGRADE-11)') && repairSlice.includes('I4 (UPGRADE-11)'));

  // I5 — PIN cap ≥ 6 and the real gate reason.
  const maxLen = /maxLength=\{(\d+)\}/.exec(modal)?.[1];
  check('I5: manager PIN field accepts the 6-digit policy', maxLen != null && Number(maxLen) >= 6, `maxLength=${maxLen}`);
  check('I5: unavailable gate reason gets its own message', modal.includes("gate.reason === 'unavailable'"));
  check('I5: fail-closed no-fallback path untouched (pinGate import intact)', modal.includes('verifyManagerGate(managerPin)'));

  // I6 — innermost Escape + backdrop dismissal on all layers.
  check('I6: Escape unwinds the innermost panel first', modal.includes('if (versementOpen && plafondOpen)') && modal.includes("lastOpenedPanel.current === 'plafond'"));
  const backdropHits = (modal.match(/e\.target === e\.currentTarget/g) ?? []).length;
  check('I6: backdrop dismissal on all three overlay layers', backdropHits >= 3, `hits=${backdropHits}`);

  // I7 — honest popup signal.
  check('I7: window.open returns the honest blocked signal', phone.includes("window.open(waUrl, '_blank')") && phone.includes('popup.opener = null'));
  check('I7: noopener-as-window-feature pitfall removed', !phone.includes("window.open(waUrl, '_blank', 'noopener"));
  check('I7: anchor fallback only for throwing engines, with rel noopener/noreferrer', phone.includes("a.rel = 'noopener noreferrer'"));
  check('I7: modal no longer calls openWhatsApp directly (store path owns launches)', !modal.includes('openWhatsApp'));

  // I8 — phone search normalized.
  check('I8: phone branch normalizes through normalizeAlgerianPhone', modal.includes('phoneMatchesSearch') && modal.includes('normalizeAlgerianPhone(q).digitsOnly'));
  check('I8: raw includes-phone branch removed', !modal.includes("(c.phone || '').includes("));

  // I9 — debt-save catches rethrow like saveCustomer (B-016 posture).
  check('I9: both debt catches distinguish web mode from failures', custAdapter.includes('I9 (UPGRADE-11)') && (custAdapter.match(/if \(isTauriEnv\(\)\)/g) ?? []).length >= 4);
  check('I9: blanket swallow comment removed', !custAdapter.includes('ignore web mode fallback'));

  // The register itself: nine fixed, zero reported.
  check('register: header declares the fix', register.includes('FIXED (UPGRADE-11, v126)'));
  check('register: exactly nine fixed statuses', (register.match(/\*\*Status:\*\* fixed/g) ?? []).length === 9);
  check('register: no reported status remains', !register.includes('**Status:** reported'));
}

// ── Part 4: EXPLAIN QUERY PLAN — SEARCH … USING INDEX only ────────────────
console.log('\n--- Part 4: EXPLAIN QUERY PLAN (no SCAN) ---');
{
  const db = makeDb();
  const plan = (sql: string): string[] =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail?: string }>).map((r) => String(r.detail ?? ''));
  const noScan = (p: string[]) => p.every((d) => !d.includes('SCAN'));
  const uses = (p: string[], needle: string) => p.some((d) => d.includes(needle));

  const plansActive = plan(KREDY_PLANS_ACTIVE_BY_CUSTOMER_SQL);
  check('plans-active plan: SEARCH debt_plans via idx_debt_plans_cust', uses(plansActive, 'SEARCH debt_plans USING INDEX idx_debt_plans_cust') && noScan(plansActive), plansActive.join(' | '));
  const planEntries = plan(buildKredyPlanEntriesSql(3));
  check('plan-entries plan: SEARCH debt_plan_entries via idx_dpe_plan_seq', uses(planEntries, 'SEARCH debt_plan_entries USING INDEX idx_dpe_plan_seq') && noScan(planEntries), planEntries.join(' | '));
  const entryPay = plan(KREDY_ENTRY_PAY_UPDATE_SQL);
  check('entry-pay plan: SEARCH via the id PK index', uses(entryPay, 'SEARCH debt_plan_entries USING INDEX sqlite_autoindex_debt_plan_entries_1') && noScan(entryPay), entryPay.join(' | '));
  const planStatus = plan(KREDY_PLAN_STATUS_UPDATE_SQL);
  check('plan-status plan: SEARCH via the id PK index', uses(planStatus, 'SEARCH debt_plans USING INDEX sqlite_autoindex_debt_plans_1') && noScan(planStatus), planStatus.join(' | '));
  const finalize = plan(KREDY_DUNNING_FINALIZE_SQL);
  check('finalize plan: SEARCH via the unique (customer, stage) index', uses(finalize, 'SEARCH dunning_queue USING INDEX idx_dunning_cust_stage') && noScan(finalize), finalize.join(' | '));
  const release = plan(KREDY_DUNNING_RELEASE_SQL);
  check('release plan: SEARCH via the unique (customer, stage) index', uses(release, 'SEARCH dunning_queue USING INDEX idx_dunning_cust_stage') && noScan(release), release.join(' | '));
  const byCust = plan(KREDY_DUNNING_BY_CUSTOMER_SQL);
  check('dunning-by-customer plan: SEARCH via idx_dunning_cust_stage', uses(byCust, 'SEARCH dunning_queue USING INDEX idx_dunning_cust_stage') && noScan(byCust), byCust.join(' | '));
  const byCusts = plan(buildKredyDunningByCustomersSql(4));
  check('dunning batch plan: SEARCH via idx_dunning_cust_stage, no SCAN', uses(byCusts, 'SEARCH dunning_queue USING INDEX idx_dunning_cust_stage') && noScan(byCusts), byCusts.join(' | '));
  const waByCust = plan(KREDY_WHATSAPP_BY_CUSTOMER_SQL);
  check('launch-log read plan: SEARCH via idx_whatsapp_cust', uses(waByCust, 'SEARCH whatsapp_launches USING INDEX idx_whatsapp_cust') && noScan(waByCust), waByCust.join(' | '));

  // Upserts insert through the PK/unique constraint: only the absence of any
  // SCAN is provable (an INSERT reads no rows), and that is the law.
  for (const [label, sql] of [
    ['plan-insert', KREDY_PLAN_INSERT_SQL],
    ['plan-entry-insert', KREDY_PLAN_ENTRY_INSERT_SQL],
    ['dunning-claim', KREDY_DUNNING_CLAIM_SQL],
    ['launch-log-insert', KREDY_WHATSAPP_LAUNCH_INSERT_SQL],
  ] as Array<[string, string]>) {
    const p = plan(sql);
    check(`${label} plan: no SCAN`, noScan(p), p.join(' | ') || '(no rows)');
  }

  // The one-launch-per-stage guarantee is an INDEX, not a convention.
  const dunningIdx = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_dunning_cust_stage'`).all() as Array<Record<string, unknown>>;
  check('idx_dunning_cust_stage is UNIQUE (backstop against double launch)', String(dunningIdx[0]?.sql ?? '').includes('UNIQUE'));
  const dpeIdx = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_dpe_plan_seq'`).all() as Array<Record<string, unknown>>;
  check('idx_dpe_plan_seq is UNIQUE (one seq per plan)', String(dpeIdx[0]?.sql ?? '').includes('UNIQUE'));
  db.close();
}

// ── Part 5: single-claim + honest launch log on the real statements ───────
console.log('\n--- Part 5: single-claim dunning + honest launch log ---');
{
  const db = makeDb();
  const claim = (id: string, cust: string, stage: string, at: string, staleBefore: string) =>
    Number(db.prepare(KREDY_DUNNING_CLAIM_SQL).run(bind([id, cust, stage, at, staleBefore])).changes);

  check('claim #1 (fresh): single winner', claim('d1', 'c1', 'R1', '2026-10-17T10:00:00.000Z', '2026-10-17T09:50:00.000Z') === 1);
  check('claim #2 (live duplicate): refused', claim('d2', 'c1', 'R1', '2026-10-17T10:01:00.000Z', '2026-10-17T09:51:00.000Z') === 0);
  check('claim #3 (stale crashed claim): re-taken', claim('d3', 'c1', 'R1', '2026-10-17T10:20:00.000Z', '2026-10-17T10:10:00.000Z') === 1);
  check('finalize: claim → LANCEE', Number(db.prepare(KREDY_DUNNING_FINALIZE_SQL).run(bind(['c1', 'R1', '2026-10-17T10:20:01.000Z'])).changes) === 1);
  check('claim #4 (after LANCEE, even stale): NEVER re-claimable', claim('d4', 'c1', 'R1', '2026-10-17T11:00:00.000Z', '2026-10-17T10:30:00.000Z') === 0);
  check('release of LANCEE: no-op (history is not erasable)', Number(db.prepare(KREDY_DUNNING_RELEASE_SQL).run(bind(['c1', 'R1'])).changes) === 0);
  check('claim #5 (next stage R2): allowed (ladder moves forward)', claim('d5', 'c1', 'R2', '2026-10-17T11:00:00.000Z', '2026-10-17T10:50:00.000Z') === 1);
  check('release of PLANIFIEE: clears the claim (retryable)', Number(db.prepare(KREDY_DUNNING_RELEASE_SQL).run(bind(['c1', 'R2'])).changes) === 1);
  check('claim #6 (retry after release): winner again', claim('d6', 'c1', 'R2', '2026-10-17T11:05:00.000Z', '2026-10-17T10:55:00.000Z') === 1);

  const rows = db.prepare(KREDY_DUNNING_BY_CUSTOMER_SQL).all(bind(['c1'])) as Array<Record<string, unknown>>;
  check('ladder state reads back R1:LANCEE + R2:PLANIFIEE', rows.map((r) => `${r.stage}:${r.status}`).join(',') === 'R1:LANCEE,R2:PLANIFIEE');
  const batch = db.prepare(buildKredyDunningByCustomersSql(2)).all(bind(['c1', 'c2'])) as Array<Record<string, unknown>>;
  check('batch read answers for a whole list (one query)', batch.length === 2);

  // Plan lane: header + entries, conservation, single-close, entry fill.
  check('plan insert #1 wins', Number(db.prepare(KREDY_PLAN_INSERT_SQL).run(bind(['P1', 'c1', 30000, 3, 30, '2026-10-17T09:00:00.000Z', null, '2026-10-17T09:00:00.000Z'])).changes) === 1);
  check('plan insert retry is a no-op (ON CONFLICT DO NOTHING)', Number(db.prepare(KREDY_PLAN_INSERT_SQL).run(bind(['P1', 'c1', 30000, 3, 30, '2026-10-17T09:00:00.000Z', null, '2026-10-17T09:00:00.000Z'])).changes) === 0);
  const entryChanges = [1, 2, 3].map((i) => Number(db.prepare(KREDY_PLAN_ENTRY_INSERT_SQL).run(bind([`E${i}`, 'P1', i, addDaysIso('2026-10-17T09:00:00.000Z', 30 * i), 10000])).changes));
  check('entries land (3 rows)', entryChanges.join(',') === '1,1,1');
  const sumEntries = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM debt_plan_entries WHERE plan_id = 'P1'`).all()[0] as Record<string, unknown>).s;
  check('Σ entries === header total exactly (30 000 — 0 fee by construction)', Number(sumEntries) === 30000);
  check('plans-active read finds it', (db.prepare(KREDY_PLANS_ACTIVE_BY_CUSTOMER_SQL).all(bind(['c1'])) as Array<Record<string, unknown>>).length === 1);
  check('entries batch read finds all 3 ordered by seq', (db.prepare(buildKredyPlanEntriesSql(1)).all(bind(['P1'])) as Array<Record<string, unknown>>).map((r) => r.seq).join(',') === '1,2,3');
  check('entry fill updates (1 row)', Number(db.prepare(KREDY_ENTRY_PAY_UPDATE_SQL).run(bind(['E1', 10000, '2026-10-18T09:00:00.000Z'])).changes) === 1);
  check('plan close claims once', Number(db.prepare(KREDY_PLAN_STATUS_UPDATE_SQL).run(bind(['P1', 'SOLDE', '2026-10-18T09:01:00.000Z'])).changes) === 1);
  check('plan close is single-shot', Number(db.prepare(KREDY_PLAN_STATUS_UPDATE_SQL).run(bind(['P1', 'SOLDE', '2026-10-18T09:02:00.000Z'])).changes) === 0);

  // Honest launch log: written only with the exact pinned status.
  check('launch log row lands', Number(db.prepare(KREDY_WHATSAPP_LAUNCH_INSERT_SQL).run(bind(['W1', 'c1', '0550002222', 'RELANCE', 'R1', 'preview', KREDY_LAUNCH_STATUS, '2026-10-17T10:20:01.000Z', 'Farida'])).changes) === 1);
  const waRow = (db.prepare(KREDY_WHATSAPP_BY_CUSTOMER_SQL).all(bind(['c1'])) as Array<Record<string, unknown>>)[0];
  check("launch log status is exactly 'Lancé'", String(waRow?.status ?? '') === 'Lancé');
  db.close();
}

// ── Part 6: wiring + parity ────────────────────────────────────────────────
console.log('\n--- Part 6: wiring + parity ---');
{
  const libRs = src('src-tauri/src/lib.rs');
  const heal = src('src/db/schemaHeal.ts');
  const adapter = src('src/db/sqlPluginAdapter.ts');
  const remote = src('src/sync/remoteSchema.ts');
  const generic = src('src/sync/genericApply.ts');
  const maintenance = src('src/db/adapters/maintenanceAdapter.ts');
  const engine = src('src/utils/kredyEngine.ts');
  const orderSlice = src('src/store/slices/createOrderSlice.ts');
  const customerSlice = src('src/store/slices/createCustomerSlice.ts');
  const mobileTab = src('src/components/mobile/tabs/MobileCheckoutTab.tsx');
  const kredyTab = src('src/components/mobile/tabs/KredyTab.tsx');
  const loyaltyModal = src('src/components/modals/LoyaltyCardModal.tsx');
  const pkg = JSON.parse(src('package.json')) as { scripts: Record<string, string> };

  check('lib.rs v126 migration present', norm(libRs).includes('version: 126, description: "UPGRADE-11: Kredy due dates, 0-fee plans, dunning ladder, honest launch log"'));
  check('lib.rs ceiling bumped to 126', /EXPECTED_MAX_DB_USER_VERSION: u32 = 126;/.test(libRs));
  check('lib.rs is append-only (v125 + v124 still present)', libRs.includes('version: 125,') && libRs.includes('version: 124,'));

  check('heal exports 14 v126 statements (5 ALTER + 4 CREATE TABLE + 5 INDEX)', KREDY_V126_HEAL_SQL.length === 14, `len=${KREDY_V126_HEAL_SQL.length}`);

  // 3-way DDL parity: every heal statement appears verbatim in Rust v126.
  const v126Block = libRs.split('version: 126,')[1]?.split('kind: MigrationKind::Up')[0] ?? '';
  const rustNorm = norm(v126Block);
  for (const stmt of KREDY_V126_HEAL_SQL) {
    const body = norm(stmt.replace(/;$/, ''));
    check(`heal parity: rust contains ${body.slice(0, 60)}…`, rustNorm.includes(body));
  }

  check('probe (debts) pins due_date + kind', KREDY_V126_PROBE_CUSTOMER_DEBTS_SQL.includes('due_date') && KREDY_V126_PROBE_CUSTOMER_DEBTS_SQL.includes('kind'));
  check('probe (customers) pins opt-in + score', KREDY_V126_PROBE_CUSTOMERS_SQL.includes('whatsapp_opt_in') && KREDY_V126_PROBE_CUSTOMERS_SQL.includes('credit_score'));

  check('adapter probes both v126 shapes at boot', adapter.includes('await db.select(KREDY_V126_PROBE_CUSTOMER_DEBTS_SQL)') && adapter.includes('await db.select(KREDY_V126_PROBE_CUSTOMERS_SQL)'));
  check('adapter spreads the v126 heal statements', adapter.includes('...KREDY_V126_HEAL_SQL,'));
  check('adapter imports the single-source constants', adapter.includes('KREDY_V126_HEAL_SQL, KREDY_V126_PROBE_CUSTOMER_DEBTS_SQL, KREDY_V126_PROBE_CUSTOMERS_SQL'));
  const kredyProbeIdx = adapter.indexOf('await db.select(KREDY_V126_PROBE_CUSTOMER_DEBTS_SQL)');
  const kredySpreadIdx = adapter.indexOf('...KREDY_V126_HEAL_SQL,');
  check('heal lane reads the probes BEFORE the statements execute', kredyProbeIdx > 0 && kredySpreadIdx > kredyProbeIdx);

  // Local-only: none of the four tables may ride a sync lane.
  for (const table of ['debt_plans', 'debt_plan_entries', 'dunning_queue', 'whatsapp_launches']) {
    check(`${table} never appears in the remote schema`, !remote.includes(table));
    check(`${table} is never a generic-apply lane`, !generic.includes(table));
  }
  check('debt mirror carries due_date + kind (same lane, new columns)', generic.includes('due_date, kind') && maintenance.includes('due_date, kind'));

  // Engine purity: money math never reads the wall clock (comments excluded —
  // the header itself documents the rule).
  const engineCode = engine.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('engine has zero Date.now() in code', !/Date\.now\s*\(/.test(engineCode));

  // ONE credit gate for both lanes.
  check('desktop gate uses assertCreditAllowed', orderSlice.includes('assertCreditAllowed({'));
  check('mobile gate uses the SAME assertCreditAllowed', mobileTab.includes('assertCreditAllowed({'));
  check('mobile divergent predicate is gone', !mobileTab.includes('currentDebt + submitNet > debtLimit'));
  check('credit-sale debt entry carries kind + due date', orderSlice.includes("kind: 'ACHAT'") && orderSlice.includes('dueDate: addDaysIso(debtCreatedAt, KREDY_DEFAULT_TERM_DAYS)'));
  check('void debt entry carries the CORRECTION kind', orderSlice.includes("kind: 'CORRECTION'"));

  // Slice law: waterfall + plan fill on the payment path, claim-before-launch.
  check('payment path runs the FIFO waterfall on the real ledger', customerSlice.includes('allocateRepaymentFifo(') && customerSlice.includes('outstandingItemsFromEntries(customerDebts.filter'));
  check('payment entry stamps kind VERSEMENT', customerSlice.includes("kind: 'VERSEMENT'"));
  check('plan fill rides the same payment write path', customerSlice.includes('applyPaymentToPlanEntries(') && customerSlice.includes('kredy.updateDebtPlanEntries('));
  check('plan persistence is entries-first (crash-safe ordering)', (() => {
    const seg = adapter.split('export async function insertDebtPlanWithEntries')[1]?.split('export async function finalizeDunningLaunch')[0] ?? '';
    return seg.length > 0 && seg.indexOf('KREDY_PLAN_ENTRY_INSERT_SQL') > -1 && seg.indexOf('KREDY_PLAN_ENTRY_INSERT_SQL') < seg.indexOf('KREDY_PLAN_INSERT_SQL');
  })());
  check('dunning launch: opt-in gate present', customerSlice.includes('whatsappOptIn !== true'));
  check('dunning launch: quiet-hours gate present', customerSlice.includes('dunningLaunchGate(nowIso)'));
  check('dunning launch: claim BEFORE opening WhatsApp', (() => {
    const seg = customerSlice.split('launchDebtReminder')[1]?.split('setWhatsappOptIn')[0] ?? '';
    const claim = seg.indexOf('claimDunningLaunch(');
    const open = seg.indexOf('openWhatsApp(');
    return claim > -1 && open > -1 && claim < open;
  })());
  check('launch log passes the pinned status constant', customerSlice.includes('status: KREDY_LAUNCH_STATUS,'));
  check('blocked popup releases the claim + writes nothing', customerSlice.includes('releaseDunningLaunchClaim(') && customerSlice.includes("reason: 'WHATSAPP_BLOCKED'"));
  check('slate records the credit score', customerSlice.includes('creditScore: score.score'));

  // UI surfaces.
  check('KredyTab mounts the aging strip from the engine buckets', kredyTab.includes('KREDY_AGING_BUCKETS.map(') && kredyTab.includes('kredyOverview.agingTotals[bucket]'));
  check('KredyTab wires dunning + opt-in + plan actions', kredyTab.includes('launchDebtReminder(customer.id') && kredyTab.includes('setWhatsappOptIn(customer.id') && kredyTab.includes('createInstallmentPlan(customer.id'));
  check('KredyTab reads ladder state in one batch', kredyTab.includes('listDunningRowsForCustomers(ids)'));
  check('KredyTab uses the frozen reference clock for nowIso', kredyTab.includes('new Date(referenceTime).toISOString()'));
  check('DebtLedgerModal routes WhatsApp through the store action', src('src/components/modals/DebtLedgerModal.tsx').includes('await launchDebtReminder(customer.id)'));
  check('LoyaltyCardModal renders a real scannable QR', loyaltyModal.includes('<QRCodeImage value={cardCode}'));
  check('LoyaltyCardModal derives point value from pointRedemptionRate', loyaltyModal.includes('(customer.loyaltyPoints || 0) * (loyaltyCfg.pointRedemptionRate || 10)') && !loyaltyModal.includes('(customer.loyaltyPoints || 0) * 10)'));

  // Suite wiring (self-pinned).
  check('package.json wires test:kredy', (pkg.scripts['test:kredy'] ?? '').includes('test_kredy.mts'));
  check('npm test runs test:kredy', (pkg.scripts['test'] ?? '').includes('test:kredy'));
  check('npm run test:all runs test:kredy', (pkg.scripts['test:all'] ?? '').includes('test:kredy'));

  // Heal constants stay single-sourced (adapter must not inline the DDL).
  check('heal file owns the v126 DDL constants', heal.includes('KREDY_V126_HEAL_SQL: readonly string[]'));
}

// ── Part 7: heal replay on a pre-v126 shape ───────────────────────────────
console.log('\n--- Part 7: heal replay (pre-v126 shape) ---');
{
  const db = new DatabaseSync(':memory:');
  db.exec(PRE_V126_DDL);

  let probeFailed = false;
  try {
    db.prepare(KREDY_V126_PROBE_CUSTOMER_DEBTS_SQL).all();
  } catch {
    probeFailed = true;
  }
  check('pre-v126: debts probe fails (heal required)', probeFailed);
  let probeCustomersFailed = false;
  try {
    db.prepare(KREDY_V126_PROBE_CUSTOMERS_SQL).all();
  } catch {
    probeCustomersFailed = true;
  }
  check('pre-v126: customers probe fails (heal required)', probeCustomersFailed);

  for (const stmt of KREDY_V126_HEAL_SQL) db.exec(stmt);
  let probesPass = true;
  try {
    db.prepare(KREDY_V126_PROBE_CUSTOMER_DEBTS_SQL).all();
    db.prepare(KREDY_V126_PROBE_CUSTOMERS_SQL).all();
  } catch {
    probesPass = false;
  }
  check('post-heal: both probes pass', probesPass);

  for (const stmt of KREDY_V126_HEAL_SQL) {
    try {
      db.exec(stmt);
    } catch {
      // ALTER ADD COLUMN re-application throws — tolerated exactly like the
      // adapter's statement loop; CREATEs are IF NOT EXISTS by contract.
    }
  }
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<Record<string, unknown>>).map((r) => String(r.name));
  check('heal creates all four v126 tables', ['debt_plans', 'debt_plan_entries', 'dunning_queue', 'whatsapp_launches'].every((t) => tables.includes(t)), tables.join(','));
  const integrity = (db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>).map((r) => String(Object.values(r)[0]));
  check("integrity_check = 'ok'", integrity.length === 1 && integrity[0] === 'ok', integrity.join(','));
  const fk = db.prepare('PRAGMA foreign_key_check').all() as Array<Record<string, unknown>>;
  check('foreign_key_check empty', fk.length === 0, String(fk.length));

  // The lane works on the freshly healed shape end to end.
  db.prepare(KREDY_PLAN_INSERT_SQL).run(bind(['P-h', 'ch', 20000, 2, 30, NOW, null, NOW]));
  db.prepare(KREDY_PLAN_ENTRY_INSERT_SQL).run(bind(['Eh1', 'P-h', 1, addDaysIso(NOW, 30), 10000]));
  db.prepare(KREDY_PLAN_ENTRY_INSERT_SQL).run(bind(['Eh2', 'P-h', 2, addDaysIso(NOW, 60), 10000]));
  const hSum = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM debt_plan_entries WHERE plan_id = 'P-h'`).all()[0] as Record<string, unknown>).s;
  check('healed shape: plan conservation holds (20 000)', Number(hSum) === 20000);
  check('healed shape: claim lane available', Number(db.prepare(KREDY_DUNNING_CLAIM_SQL).run(bind(['Dh1', 'ch', 'R1', NOW, addDaysIso(NOW, -1)])).changes) === 1);
  db.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
