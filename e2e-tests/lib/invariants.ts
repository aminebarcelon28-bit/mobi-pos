/**
 * Global DB invariant harness — encyclopedia §2 (G-01…G-34 subset), wired
 * into every spec's afterEach per the Phase-4.4 owner mandate:
 *
 *   G-01 ledger/tender conservation   G-02 drawer never negative silently
 *   G-03 subtotal−discount=total      G-04 stock ↔ inventory_ledger drift
 *   G-05 IMEI uniqueness/lifecycle    G-06 receipt numbers unique
 *   G-07 loyalty balance identity     G-08 mutation audit trail
 *   G-09 idempotency (replays: no second effect)
 *   G-11 derived-vs-ledger (json↔columns)
 *   G-13 quick_check / FK integrity   G-14 money integer discipline
 *   G-15 authorization envelope (step-up + attributable actor)
 *   G-17 one open drawer session per register; version monotonic
 *   G-18 cross-device freshness: session snapshot ⇄ row, sane timestamps
 *   G-19 attribution (user + device + drawer on every document)
 *   G-20 session integrity (no money document outside a live session)
 *   G-21 warranty binding + claim policy on new SAV rows
 *   G-23 active-customer identity (normalized phone uniqueness)
 *   G-26 SAV attachment/blob reference integrity
 *   G-29 cumulative refund guards     G-30 ledger tables monotonic
 *   G-32 debt column == ledger == payload
 *   G-33 type discipline              G-34 derived columns rebuildable
 *
 * Baseline-delta model: `captureInvariantBaseline(tag)` runs in the spec's
 * `before()` AFTER seeding + mirrors refresh; `assertInvariants(tag)` runs in
 * `afterEach()` against the LIVE sandbox `mobi_pos.db` (better-sqlite3, the
 * same file the app is writing). Every invocation appends one NDJSON line to
 * `e2e-tests/results/invariant-events.ndjson` and, on any violation, logs
 * `[INVARIANT VIOLATION] G-xx: …` lines and FAILS the test (fail closed).
 *
 * Deliberately scoped: checks read only — never write — and use rowid deltas
 * so seeded fixture rows never masquerade as app behavior. Two calibrated
 * exceptions avoid false positives on non-wiped reruns: products/customers
 * whose baseline state was ALREADY inconsistent (legacy drift) are enforced
 * only when the current test's delta touched them.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { all, count, one, scalar } from './db';
import { DB_PATH } from './env';

// WDIO runs with cwd = e2e-tests, the coverage tool runs from the repo root.
// The file must land in e2e-tests/results either way (that is where coverage.mjs
// reads it), so resolve from THIS module's location instead of cwd. The old
// `existsSync('results') ? 'results' : …` wrote to a root results/ whenever one
// existed, which is how a generated artifact ended up tracked in git and
// churned on every run (Q-D).
const MODULE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const RESULTS_DIR = path.join(MODULE_ROOT, 'e2e-tests', 'results');
const NDJSON = path.join(RESULTS_DIR, 'invariant-events.ndjson');

export const INVARIANT_IDS = [
  'G-01', 'G-02', 'G-03', 'G-04', 'G-05', 'G-06', 'G-07', 'G-08', 'G-09', 'G-11',
  'G-13', 'G-14', 'G-15', 'G-17', 'G-18', 'G-19', 'G-20', 'G-21', 'G-23', 'G-26', 'G-29', 'G-30', 'G-32', 'G-33', 'G-34',
] as const;

/** Violations accumulated across afterEach calls; surfaced ONCE in
 *  finalizeInvariants() so a single finding can never abort the run
 *  (wdio+mocha skips all remaining tests when an afterEach hook throws). */
const PENDING: Array<{ test: string; check: string; violation: string }> = [];
/** Same violation re-observed after every test must be reported once, not N×. */
const PENDING_SEEN = new Set<string>();

/**
 * Deliberate negative-control writes (the forged-refund probes the specs build
 * by hand). They exist to prove the guards refuse what cannot be traced, and
 * they carry ids this harness generates. Their ATTRIBUTION findings are the
 * documented pre-gateway residual (AGENTS.md: the renderer holds the SQL/IPC
 * handle until the data-plane gateway lands), so they are logged as
 * RESIDUAL-ACCEPTED instead of failing the product oracle. Every other write is
 * still judged strictly: the filter is by id shape, not by actor name.
 */
const NEGATIVE_CONTROL_WRITE = /(?:^AUD-)?REF-FORGE-|AVOIR-FORGE-/;
function isNegativeControlWrite(...ids: unknown[]): boolean {
  return ids.some((id) => NEGATIVE_CONTROL_WRITE.test(String(id ?? '')));
}
function noteResidual(check: string, message: string): void {
  console.warn(`[INVARIANT RESIDUAL-ACCEPTED] ${check}: ${message} :: negative-control write (documented pre-gateway residual)`);
}

const LEDGER_TABLES = [
  'transactions',
  'transaction_items',
  'inventory_ledger',
  'cash_movements',
  'security_audit_logs',
  'customer_debts',
  'refund_dedup',
  'sync_outbox',
  'imei_records',
] as const;

interface DebtState {
  col: number | null;
  payload: number | null;
  ledger: number;
  consistent: boolean;
}

export interface InvariantBaseline {
  tag: string;
  at: string;
  rowid: {
    transactions: number; transaction_items: number; cash_movements: number;
    inventory_ledger: number; security_audit_logs: number; customer_debts: number;
    imei_records: number; refund_dedup: number; repair_orders: number; warranty_claims: number;
  };
  counts: Record<string, number>;
  stockDrift: Record<string, number>;
  customers: Record<string, DebtState>;
  openShift: string | null;
  customersMaxRowid: number;
  sessionsMaxRowid: number;
  sessionVersions: Record<string, number>;
  loyalty: Record<string, { headline: number; bucketSum: number; consistent: boolean }>;
  auditActors: string[];
}

let BASELINE: InvariantBaseline | null = null;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function norm2(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function close(a: number, b: number, eps = 0.005): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;
}

function parseJson(s: unknown): Record<string, unknown> {
  try {
    return s ? (JSON.parse(String(s)) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Credit legs of a sale, read from its tender list.
 *
 * The desktop lane does not stamp `voucherCreditApplied` / `storeCreditApplied`
 * / `tradeInCreditApplied` on every ticket: a wallet balance and a staged
 * Reprise are recorded as TENDER LEGS (`Avoir Client`, `Reprise`). Those legs
 * are value the customer already owned, not money handed to the till, so they
 * reduce `total` and must be excluded from both conservation sides.
 * ([MNY-26]: tenders 400+600+300 = 1300 vs total 600 — the 700 of credit legs
 * is exactly the gap.) `Crédit Client` is deliberately NOT here: a Kredy debt
 * leg IS revenue (the receivable), so it belongs inside `total`.
 */
const CREDIT_TENDER_METHODS = ['Avoir Client', 'Reprise'];

function creditLegsOf(j: Record<string, unknown>): number {
  const tenders = Array.isArray(j.tenders) ? (j.tenders as Array<Record<string, unknown>>) : null;
  if (!tenders) return 0;
  let sum = 0;
  for (const t of tenders) {
    const method = String(t?.method ?? '').trim();
    if (!CREDIT_TENDER_METHODS.includes(method)) continue;
    const amt = num(t?.amount ?? 0);
    if (Number.isFinite(amt) && amt > 0) sum += amt;
  }
  return sum;
}

function maxRowid(table: string): number {
  try {
    return Number(one<{ m: number | null }>(`SELECT MAX(rowid) AS m FROM "${table}"`)?.m ?? 0);
  } catch {
    return 0;
  }
}

function countSafe(table: string): number {
  try {
    return Number(count(table));
  } catch {
    return -1;
  }
}

function ledgerBalance(customerId: string): number {
  const r = one<{ b: number }>(
    `SELECT COALESCE(SUM(CASE WHEN type = 'DEBT_ACQUIRED' THEN amount
                             WHEN type = 'PAYMENT_SETTLED' THEN -amount
                             ELSE 0 END), 0) AS b
     FROM customer_debts WHERE customer_id = ? AND deleted = 0`,
    customerId,
  );
  return num(r?.b ?? 0);
}

function debtState(customerId: string): DebtState {
  const r = one<{ current_debt: number | null; jd: number | null }>(
    `SELECT current_debt, json_extract(json_payload, '$.currentDebt') AS jd
     FROM customers WHERE id = ?`,
    customerId,
  );
  if (!r) return { col: null, payload: null, ledger: ledgerBalance(customerId), consistent: false };
  const col = norm2(r.current_debt);
  const payload = norm2(r.jd);
  const ledger = ledgerBalance(customerId);
  const consistent =
    col !== null && payload !== null && close(col, payload, 0.001) && close(col, ledger, 0.001);
  return { col, payload, ledger, consistent };
}

function driftFor(pid: string): number {
  const r = one<{ d: number }>(
    `SELECT p.stock - COALESCE((SELECT SUM(l.delta) FROM inventory_ledger l
                                WHERE l.product_id = p.id AND l.deleted = 0), 0) AS d
     FROM products p WHERE p.id = ?`,
    pid,
  );
  return num(r?.d ?? NaN);
}

// ---------------------------------------------------------------------------
// baseline
// ---------------------------------------------------------------------------

export function captureInvariantBaseline(tag: string): InvariantBaseline {
  const counts: Record<string, number> = {};
  for (const t of LEDGER_TABLES) counts[t] = countSafe(t);

  const stockDrift: Record<string, number> = {};
  for (const row of all<{ id: string }>(`SELECT id FROM products`)) {
    stockDrift[String(row.id)] = driftFor(String(row.id));
  }

  const customers: Record<string, DebtState> = {};
  for (const row of all<{ id: string }>(`SELECT id FROM customers`)) {
    customers[String(row.id)] = debtState(String(row.id));
  }

  const openShift =
    one<{ id: string }>(`SELECT id FROM cash_sessions WHERE status = 'OPEN' ORDER BY rowid DESC LIMIT 1`)
      ?.id ?? null;

  const customersMaxRowid = maxRowid('customers');
  const sessionsMaxRowid = maxRowid('cash_sessions');
  const sessionVersions: Record<string, number> = {};
  for (const r of all<{ id: string; version: number }>(`SELECT id, version FROM cash_sessions`)) {
    sessionVersions[String(r.id)] = num(r.version);
  }
  const loyalty: Record<string, { headline: number; bucketSum: number; consistent: boolean }> = {};
  for (const r of all<{ id: string; loyalty_points: number; json_payload: string }>(
    `SELECT id, loyalty_points, json_payload FROM customers`,
  )) {
    const j = parseJson(String(r.json_payload));
    const buckets = Array.isArray(j.pointBuckets) ? (j.pointBuckets as Array<Record<string, unknown>>) : [];
    const bucketSum = buckets.reduce((a, b) => a + num(b?.remainingPoints ?? 0), 0);
    const headline = num(r.loyalty_points);
    loyalty[String(r.id)] = {
      headline,
      bucketSum,
      consistent: Number.isFinite(headline) && headline >= -0.001 && bucketSum <= headline + 0.001,
    };
  }
  let auditActors: string[] = [];
  try {
    const cu = one<{ value_json: string }>(`SELECT value_json FROM app_settings WHERE key = 'cashier_users'`);
    const arr = cu ? (JSON.parse(cu.value_json) as Array<{ name?: string }>) : [];
    auditActors = arr.map((u) => String(u?.name ?? '').trim()).filter(Boolean);
  } catch {
    /* settings unreadable at baseline: the name facet degrades to current-only */
  }

  BASELINE = {
    tag,
    at: new Date().toISOString(),
    rowid: {
      transactions: maxRowid('transactions'),
      transaction_items: maxRowid('transaction_items'),
      cash_movements: maxRowid('cash_movements'),
      inventory_ledger: maxRowid('inventory_ledger'),
      security_audit_logs: maxRowid('security_audit_logs'),
      customer_debts: maxRowid('customer_debts'),
      imei_records: maxRowid('imei_records'),
      refund_dedup: maxRowid('refund_dedup'),
      repair_orders: maxRowid('repair_orders'),
      warranty_claims: maxRowid('warranty_claims'),
    },
    counts,
    stockDrift,
    customers,
    openShift,
    customersMaxRowid,
    sessionsMaxRowid,
    sessionVersions,
    loyalty,
    auditActors,
  };
  return BASELINE;
}

export function hasInvariantBaseline(): boolean {
  return BASELINE !== null;
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

interface CheckOut {
  id: string;
  violations: string[];
}

export function runInvariantChecks(): CheckOut[] {
  const B = BASELINE ?? captureInvariantBaseline('auto');
  const out: CheckOut[] = [];
  const push = (id: string, v: string): void => {
    let row = out.find((o) => o.id === id);
    if (!row) {
      row = { id, violations: [] };
      out.push(row);
    }
    row.violations.push(v);
  };

  const newTx = all<Record<string, unknown>>(
    `SELECT rowid AS _rid, * FROM transactions WHERE rowid > ? ORDER BY rowid`,
    B.rowid.transactions,
  );
  const newItems = all<Record<string, unknown>>(
    `SELECT rowid AS _rid, * FROM transaction_items WHERE rowid > ?`,
    B.rowid.transaction_items,
  );
  const newMoves = all<Record<string, unknown>>(
    `SELECT rowid AS _rid, * FROM cash_movements WHERE rowid > ?`,
    B.rowid.cash_movements,
  );
  const newAudit = all<Record<string, unknown>>(
    `SELECT rowid AS _rid, * FROM security_audit_logs WHERE rowid > ?`,
    B.rowid.security_audit_logs,
  );
  const newDebt = all<Record<string, unknown>>(
    `SELECT rowid AS _rid, * FROM customer_debts WHERE rowid > ?`,
    B.rowid.customer_debts,
  );
  const newImei = all<Record<string, unknown>>(
    `SELECT rowid AS _rid, * FROM imei_records WHERE rowid > ?`,
    B.rowid.imei_records,
  );

  // ---- G-01: tender conservation + refund cashDisbursed ↔ cash_movements ----
  for (const t of newTx) {
    const j = parseJson(t.json_payload);
    const total = num(t.total);
    const tenders = Array.isArray(j.tenders) ? (j.tenders as Array<Record<string, unknown>>) : null;
    if (tenders) {
      // Tenders record cash HANDED (gross); change is handed back in the same
      // beat, so the conservation identity is Σtenders − creditLegs − change =
      // total (credit legs are prepaid value, not till money — see
      // creditLegsOf). Debt legs stay in the sum: they are part of `total`.
      const s = tenders.reduce((a, x) => a + num(x?.amount ?? 0), 0);
      const creditLegs = creditLegsOf(j);
      const chg = num(j.changeDue ?? t.change_due ?? 0);
      if (!close(s - creditLegs - chg, total, 0.01)) {
        push(
          'G-01',
          `tx ${t.receipt_number}: Σtenders−credits−change=${s - creditLegs - chg} != total=${total}`,
        );
      }
    }
    if (Number(t.is_refund) === 1) {
      const cd = num(j.cashDisbursed ?? 0);
      const mv = num(
        one<{ s: number }>(
          `SELECT COALESCE(SUM(amount),0) AS s FROM cash_movements WHERE reason LIKE ?`,
          `%${String(t.receipt_number)}%`,
        )?.s ?? 0,
      );
      if (!close(mv, cd, 0.01)) {
        push('G-01', `refund ${t.receipt_number}: cash_movements=${mv} != cashDisbursed=${cd}`);
      }
    }
  }

  // ---- G-02: drawer reconstruction never negative; no movements into closed ----
  {
    const open = one<Record<string, unknown>>(
      `SELECT * FROM cash_sessions WHERE status = 'OPEN' ORDER BY rowid DESC LIMIT 1`,
    );
    if (open) {
      const sid = String(open.id);
      const rows = all<Record<string, unknown>>(
        `SELECT * FROM transactions WHERE shift_id = ? AND is_refund = 0 AND deleted = 0`,
        sid,
      );
      let cashIn = 0;
      for (const t of rows) {
        const j = parseJson(t.json_payload);
        const tenders = Array.isArray(j.tenders) ? (j.tenders as Array<Record<string, unknown>>) : null;
        if (tenders) {
          const handed = tenders
            .filter((x) => String(x?.method ?? '') === 'Espèces')
            .reduce((a, x) => a + num(x?.amount ?? 0), 0);
          cashIn += handed - num(j.changeDue ?? t.change_due ?? 0);
        } else if (String(t.payment_method ?? '') === 'Espèces') {
          cashIn += num(t.total);
        }
      }
      const cashOut = num(
        one<{ s: number }>(`SELECT COALESCE(SUM(amount),0) AS s FROM cash_movements WHERE session_id = ?`, sid)
          ?.s ?? 0,
      );
      const expected = num(open.opening_float ?? 0) + cashIn - cashOut;
      if (expected < -0.005) {
        push(
          'G-02',
          `open session ${sid}: expected drawer ${expected} < 0 (opening=${open.opening_float} cashIn=${cashIn} cashOut=${cashOut})`,
        );
      }
    }
    // Ownership is TEMPORAL: a movement must have been booked inside its
    // session's window ([opened_at, closed_at]). The earlier "must belong to
    // the session OPEN at check time" model false-fired on every later test
    // once a test closed its shift (run-3: MOV-REF-5BECF0ED was created
    // 17:46:24 inside shift ...-HPL0's own window and kept getting re-flagged
    // after that shift closed).
    const closedMoves = all<Record<string, unknown>>(
      `SELECT m.id, m.session_id, m.amount, m.created_at AS m_at,
              s.opened_at, s.closed_at, s.status
         FROM cash_movements m
         JOIN cash_sessions s ON s.id = m.session_id
        WHERE s.status <> 'OPEN' AND m.rowid > ?`,
      B.rowid.cash_movements,
    );
    for (const m of closedMoves) {
      const t = String(m.m_at ?? '');
      const o = String(m.opened_at ?? '');
      const c = String(m.closed_at ?? '');
      if (c && t && t > c) {
        push(
          'G-02',
          `movement ${m.id} (${m.amount}) booked at ${t} AFTER its session ${m.session_id} closed (${c})`,
        );
      } else if (o && t && t < o) {
        push(
          'G-02',
          `movement ${m.id} (${m.amount}) booked at ${t} BEFORE its session ${m.session_id} opened (${o})`,
        );
      }
    }
    const orphan = Number(
      one<{ c: number }>(`SELECT COUNT(*) AS c FROM cash_movements WHERE session_id IS NULL OR session_id = ''`)
        ?.c ?? 0,
    );
    if (orphan > 0) push('G-02', `${orphan} cash movement(s) with no session id`);
  }

  // ---- G-03: subtotal − discount = total; Σ items = subtotal ----
  for (const t of newTx) {
    const sub = num(t.subtotal);
    const disc = num(t.discount_total ?? 0);
    const tot = num(t.total);
    const j = parseJson(t.json_payload);
    // Payment credits (voucher, Avoir Client, reprise) reduce the cash total
    // without living in discount_total; include them or every covered sale
    // reports a false mismatch. The desktop lane writes them as tender legs
    // only, so take the larger of the explicit stamps and the legs (never the
    // sum — a sale that carries both would count the same value twice).
    const explicitCovered =
      num(j.voucherCreditApplied ?? 0) +
      num(j.storeCreditApplied ?? 0) +
      num(j.tradeInCreditApplied ?? 0);
    const covered = Math.max(explicitCovered, creditLegsOf(j));
    if (!close(sub - disc - covered, tot, 0.01)) {
      push(
        'G-03',
        `tx ${t.receipt_number}: subtotal−discount−credits=${sub - disc - covered} != total=${tot}`,
      );
    }
    // Σ line totals = Σ(unit_price_charged × qty). `discount_amount` is a
    // per-unit MARKER, not an extra subtraction: the REF-28 override line
    // stored unit_price_charged=900 (net) with discount_amount=100 (the
    // 1000→900 delta) — subtracting it again double-counted (run-3).
    const isum = num(
      one<{ s: number }>(
        `SELECT COALESCE(SUM(unit_price_charged * quantity), 0) AS s
         FROM transaction_items WHERE transaction_id = ?`,
        String(t.id),
      )?.s ?? 0,
    );
    if (!close(isum, sub, 0.01)) {
      push('G-03', `tx ${t.receipt_number}: Σitems=${isum} != subtotal=${sub}`);
    }
  }

  // ---- G-04: stock ↔ ledger drift unchanged + no persisted negative stock ----
  for (const [pid, base] of Object.entries(B.stockDrift)) {
    const now = driftFor(pid);
    if (!Number.isFinite(now)) continue;
    if (!close(now, base, 0.001)) {
      push('G-04', `product ${pid}: drift ${now} != baseline ${base} (stock vs Σledger diverged)`);
    }
  }
  // REP-06 negative control: stock and ledger can move together to -1, so the
  // drift identity above is blind. A persisted negative stock is itself the
  // violation (a part/phone cannot be consumed below zero).
  for (const p of all<{ id: string; stock: number }>(
    `SELECT id, stock FROM products WHERE stock < -0.001`,
  )) {
    push('G-04', `product ${p.id}: stock ${p.stock} < 0 (negative stock persisted)`);
  }

  // ---- G-05: IMEI uniqueness + sale linkage ----
  for (const r of all<{ imei: string; c: number }>(
    `SELECT imei, COUNT(*) AS c FROM imei_records GROUP BY imei HAVING c > 1`,
  )) {
    push('G-05', `imei ${r.imei} appears ${r.c} times`);
  }
  for (const r of newImei) {
    if (String(r.status ?? '') === 'sold' && !String(r.sale_transaction_id ?? '').trim()) {
      push('G-05', `imei ${r.imei}: status 'sold' without sale_transaction_id`);
    }
  }
  // INV-13 negative control: duplicate-IMEI receipts currently persist stock
  // but zero imei_records rows, so the duplicate-key check above is blind.
  // Every serialized unit in stock must have a matching IMEI record.
  for (const p of all<{ id: string; stock: number; n: number }>(
    `SELECT p.id, p.stock,
            (SELECT COUNT(*) FROM imei_records i WHERE i.product_id = p.id) AS n
       FROM products p
      WHERE p.is_serialized = 1 AND p.stock > 0`,
  )) {
    if (p.n < p.stock) {
      push(
        'G-05',
        `product ${p.id}: serialized stock=${p.stock} but imei_records=${p.n} (serialized units untracked)`,
      );
    }
  }

  // ---- G-06: receipt numbering ----
  for (const r of all<{ receipt_number: string; c: number }>(
    `SELECT receipt_number, COUNT(*) AS c FROM transactions
     WHERE receipt_number IS NOT NULL AND receipt_number <> ''
     GROUP BY receipt_number HAVING c > 1`,
  )) {
    push('G-06', `receipt ${r.receipt_number} duplicated ${r.c}x`);
  }
  for (const t of newTx) {
    if (!String(t.receipt_number ?? '').trim()) push('G-06', `tx ${t.id} has empty receipt_number`);
  }

  // ---- G-07: loyalty balance identity + reversed points must not survive ----
  // (tracks the P1-7 / P1-11 classes: points from refunded/voided sales may
  // neither stay spendable nor sit outside their bucket's declared bounds)
  {
    const touched = new Set<string>();
    for (const t of newTx) if (String(t.customer_id ?? '').trim()) touched.add(String(t.customer_id));
    for (const c of all<{ id: string }>(`SELECT id FROM customers WHERE rowid > ?`, B.customersMaxRowid)) {
      touched.add(String(c.id));
    }

    for (const r of all<Record<string, unknown>>(
      `SELECT id, loyalty_points, json_payload FROM customers WHERE deleted = 0`,
    )) {
      const id = String(r.id);
      const base = B.loyalty[id];
      if (!touched.has(id) && base && !base.consistent) continue; // legacy drift: enforce only when touched
      const j = parseJson(r.json_payload);
      const buckets = Array.isArray(j.pointBuckets) ? (j.pointBuckets as Array<Record<string, unknown>>) : [];
      const headline = num(r.loyalty_points);
      const bucketSum = buckets.reduce((a, b) => a + num(b?.remainingPoints ?? 0), 0);
      if (!Number.isFinite(headline) || headline < -0.001) {
        push('G-07', `customer ${id}: headline balance ${headline} invalid or negative`);
      } else if (bucketSum > headline + 0.001) {
        push('G-07', `customer ${id}: Σ buckets remaining ${bucketSum} > headline ${headline}`);
      } else if (
        buckets.some(
          (b) => num(b?.remainingPoints ?? 0) <= 0.001 && num(b?.initialPoints ?? 0) > 0.001,
        ) &&
        headline > bucketSum + 0.001
      ) {
        // LOY-04 negative control: a full refund shrinks the origin bucket to
        // 0 but leaves the headline at 20. The old bounds check only caught
        // bucketSum > headline, never headline > bucketSum.
        push(
          'G-07',
          `customer ${id}: headline ${headline} > Σ buckets ${bucketSum} after an exhausted bucket (reversal did not reduce headline)`,
        );
      }
      for (const b of buckets) {
        const rem = num(b?.remainingPoints ?? 0);
        const init = num(b?.initialPoints ?? 0);
        if (rem < -0.001 || rem > init + 0.001) {
          push('G-07', `customer ${id}: bucket ${String(b?.id ?? '?')} remaining ${rem} outside [0, initial ${init}]`);
        }
      }
    }

    // Delta-scoped: a sale FULLY refunded by now must not keep backing points;
    // a freshly voided sale must leave no standing bucket (exact-inverse rule).
    const bucketOfCustomer = (cid: string): Array<Record<string, unknown>> => {
      const cust = one<Record<string, unknown>>(`SELECT json_payload FROM customers WHERE id = ?`, cid);
      if (!cust) return [];
      const j = parseJson(cust.json_payload);
      return Array.isArray(j.pointBuckets) ? (j.pointBuckets as Array<Record<string, unknown>>) : [];
    };
    const refundedOrigins = new Set<string>();
    for (const t of newTx) {
      if (Number(t.is_refund) === 1 && String(t.original_transaction_id ?? '').trim()) {
        refundedOrigins.add(String(t.original_transaction_id));
      }
    }
    for (const oid of refundedOrigins) {
      const orig = one<Record<string, unknown>>(`SELECT * FROM transactions WHERE id = ?`, oid);
      if (!orig) continue;
      const rsum = num(
        one<{ s: number }>(
          `SELECT COALESCE(SUM(total),0) AS s FROM transactions WHERE is_refund = 1 AND original_transaction_id = ?`,
          oid,
        )?.s ?? 0,
      );
      if (rsum < num(orig.total) - 0.01) continue; // partial: deduction is proportional, not zero
      const cid = String(orig.customer_id ?? '');
      if (!cid) continue;
      for (const b of bucketOfCustomer(cid)) {
        if (String(b?.originTransactionId ?? '') !== String(orig.receipt_number ?? '')) continue;
        const rem = num(b?.remainingPoints ?? 0);
        if (rem > 0.001) {
          push(
            'G-07',
            `customer ${cid}: fully-refunded sale ${String(orig.receipt_number)} still backs bucket ${String(b?.id)} with ${rem} pt(s)`,
          );
        }
      }
    }
    for (const v of all<Record<string, unknown>>(
      `SELECT * FROM transactions WHERE status = 'VOIDED'`,
    )) {
      const upd = String(v.updated_at ?? '');
      if (!upd || upd <= B.at) continue; // voided before this spec's baseline
      const cid = String(v.customer_id ?? '');
      if (!cid) continue;
      for (const b of bucketOfCustomer(cid)) {
        if (String(b?.originTransactionId ?? '') !== String(v.receipt_number ?? '')) continue;
        const rem = num(b?.remainingPoints ?? 0);
        if (rem > 0.001) {
          push(
            'G-07',
            `customer ${cid}: voided sale ${String(v.receipt_number)} still backs bucket ${String(b?.id)} with ${rem} pt(s)`,
          );
        }
      }
    }
  }

  // ---- G-23: active customer identity (normalized phone uniqueness) ----
  // Delta-scoped: only flag duplicate active phones where at least one side
  // was created by the current spec (legacy fixtures are not re-litigated).
  // Normalization is the last 9 digits, which folds 0550…, +213 550…, spaced
  // and dashed spellings onto the same Algerian subscriber number.
  {
    const dup = all<{ n: string; c: number; ids: string; maxrid: number }>(
      `SELECT substr(replace(replace(replace(replace(replace(phone, ' ', ''), '-', ''), '+', ''), '.', ''), '/', ''), -9) AS n,
              COUNT(*) AS c,
              GROUP_CONCAT(id) AS ids,
              MAX(rowid) AS maxrid
         FROM customers
        WHERE deleted = 0 AND phone IS NOT NULL AND TRIM(phone) <> ''
        GROUP BY n
       HAVING COUNT(*) > 1 AND MAX(rowid) > ?`,
      B.customersMaxRowid,
    );
    for (const r of dup) {
      push('G-23', `active customers share normalized phone ${r.n}: ${r.ids}`);
    }
  }

  // ---- G-08: refunds/voids are audited in the same delta ----
  {
    const auditText = (r: Record<string, unknown>): string => `${r.action ?? ''} ${r.details ?? ''}`;
    for (const t of newTx) {
      if (Number(t.is_refund) === 1) {
        const hit =
          newAudit.some((r) => auditText(r).includes(String(t.receipt_number))) ||
          newAudit.some((r) => /Rembours/i.test(String(r.action ?? '')));
        if (!hit) push('G-08', `refund ${t.receipt_number}: no security_audit_logs entry in delta`);
      }
      if (String(t.status ?? '') === 'VOIDED') {
        const hit = newAudit.some(
          (r) => auditText(r).includes(String(t.receipt_number)) || /Annul|VOID/i.test(auditText(r)),
        );
        if (!hit) push('G-08', `voided tx ${t.receipt_number}: no audit entry in delta`);
      }
    }
  }

  // ---- G-09: idempotency — the same key never yields a second effect ----
  {
    for (const r of all<Record<string, unknown>>(
      `SELECT idempotency_key, COUNT(*) AS c FROM transactions
        WHERE idempotency_key IS NOT NULL AND idempotency_key <> ''
        GROUP BY idempotency_key HAVING c > 1`,
    )) {
      push('G-09', `transactions idempotency_key '${r.idempotency_key}' reused ${r.c}×`);
    }
    for (const r of all<Record<string, unknown>>(
      `SELECT ticket_id, items_hash, COUNT(*) AS c FROM refund_dedup
        GROUP BY ticket_id, items_hash HAVING c > 1`,
    )) {
      push('G-09', `refund_dedup (${r.ticket_id}, ${r.items_hash}) duplicated ${r.c}×`);
    }
    for (const r of all<Record<string, unknown>>(
      `SELECT entity_type, entity_id, COUNT(*) AS c FROM entity_keys
        GROUP BY entity_type, entity_id HAVING c > 1`,
    )) {
      push('G-09', `entity_keys (${r.entity_type}, ${r.entity_id}) upserted ${r.c} rows`);
    }
    for (const r of all<Record<string, unknown>>(
      `SELECT idempotency_key, COUNT(*) AS c FROM entity_keys
        WHERE idempotency_key IS NOT NULL AND idempotency_key <> ''
        GROUP BY idempotency_key HAVING c > 1`,
    )) {
      push('G-09', `entity_keys idempotency_key '${r.idempotency_key}' reused ${r.c}×`);
    }
    for (const t of newTx) {
      if (!String(t.idempotency_key ?? '').trim()) {
        push('G-09', `tx ${t.receipt_number ?? t.id}: no idempotency_key (replay cannot be identified)`);
      }
    }
  }

  // ---- G-11: derived columns vs payload (json ⇄ columns) ----
  for (const t of newTx) {
    const j = parseJson(t.json_payload);
    if (j.total !== undefined && !close(num(j.total), num(t.total), 0.01)) {
      push('G-11', `tx ${t.receipt_number}: json.total=${num(j.total)} != column ${num(t.total)}`);
    }
    if (j.receiptNumber !== undefined && String(j.receiptNumber) !== String(t.receipt_number)) {
      push('G-11', `tx ${t.id}: json.receiptNumber != column`);
    }
  }
  // MNY-01/MNY-02 negative control: the displayed/applied line price can be
  // fractional while the charged price is silently rounded. The old check
  // compared only transaction totals (both integral after rounding), so the
  // UI/DB split was invisible.
  for (const i of newItems) {
    const applied = num(i.applied_price);
    const charged = num(i.unit_price_charged ?? i.applied_price);
    if (Number.isFinite(applied) && Number.isFinite(charged) && !close(applied, charged, 0.001)) {
      push(
        'G-11',
        `item ${i.id}: applied_price=${applied} != unit_price_charged=${charged} (display/charge split)`,
      );
    }
  }

  // ---- G-13: DB-level integrity ----
  // quick_check is EXCLUDED here on purpose: against the live DB a concurrent
  // app write (product stock update → FTS trigger) can transiently surface an
  // fts5 blob race (observed 2026-10-18 mid-run; `ok` on the closed DB and on
  // recheck). The full page-level check runs once in finalizeInvariants(),
  // when the suite is idle, with a settle-retry before flagging.
  {
    const fk = all(`PRAGMA foreign_key_check`);
    if (fk.length > 0) push('G-13', `PRAGMA foreign_key_check: ${fk.length} violation(s)`);
  }

  // ---- G-14: money has no sub-centime dust ----
  // Restated 2026-10-28 (owner-authorised 2-decimal fix, [MNY-01/02/03/06]).
  // The unit of account is integer MINOR units (money.ts:4-5) and the columns
  // are REAL, so a centime sale stores 0.01 — the old "integer DA" form made
  // every correct centime sale a violation (10+ per run, mny4 log). The real
  // risk this guard exists for is float dust and third-decimal leakage, so the
  // predicate is `amount*100` integral, NOT a relaxed rounding tolerance.
  // Quantities stay integer (the cart rounds magnitude before multiplying).
  {
    const integral = (v: unknown, label: string, id: string): void => {
      if (v === null || v === undefined) return;
      const n = num(v);
      if (!Number.isFinite(n)) {
        push('G-14', `${id}: ${label} not numeric`);
        return;
      }
      if (Math.abs(n - Math.round(n)) > 0.001) push('G-14', `${id}: ${label}=${n} not integer`);
    };
    const minorExact = (v: unknown, label: string, id: string): void => {
      if (v === null || v === undefined) return;
      const n = num(v);
      if (!Number.isFinite(n)) {
        push('G-14', `${id}: ${label} not numeric`);
        return;
      }
      // f64 spacing at 1e9 DA is ~1e-7 cents; 1e-6 absolute + 1e-11 relative
      // admits only representation noise, never a third decimal (33.335 is
      // 0.5 cents off) and never sub-centime dust.
      const tol = Math.max(1e-6, Math.abs(n) * 1e-11);
      if (Math.abs(n * 100 - Math.round(n * 100)) > tol) {
        push('G-14', `${id}: ${label}=${n} is not exact to 2 decimals`);
      }
    };
    for (const t of newTx) {
      for (const c of ['total', 'subtotal', 'discount_total', 'cash_tendered', 'change_due']) {
        minorExact(t[c], c, `tx ${t.receipt_number}`);
      }
    }
    for (const i of newItems) {
      integral(i.quantity, 'quantity', `item ${i.id}`);
      minorExact(i.applied_price, 'applied_price', `item ${i.id}`);
      minorExact(i.unit_price_charged, 'unit_price_charged', `item ${i.id}`);
      minorExact(i.discount_amount, 'discount_amount', `item ${i.id}`);
    }
    for (const m of newMoves) minorExact(m.amount, 'amount', `movement ${m.id}`);
  }

  // ---- G-15: authorization envelope on privileged writes ----
  // DB-observable facets: (a) every new audit row names an attributable actor
  // (a configured cashier, a supervisor attestation, or a known system lane);
  // a write that bypassed the session/role layer cannot. (b) a refund audit
  // must carry the supervisor attestation the RefundModal step-up records —
  // a landed refund without it never passed the manager gate.
  {
    const known = new Set<string>(B.auditActors);
    try {
      const cu = one<{ value_json: string }>(`SELECT value_json FROM app_settings WHERE key = 'cashier_users'`);
      const arr = cu ? (JSON.parse(cu.value_json) as Array<{ name?: string }>) : [];
      for (const u of arr) known.add(String(u?.name ?? '').trim());
    } catch {
      /* settings unreadable: the name facet degrades to baseline-only */
    }
    known.delete('');
    for (const a of newAudit) {
      const user = String(a.user ?? '').trim();
      const nameOk =
        known.has(user) ||
        String(a.actor_id ?? '').trim().length > 0 ||
        /Superviseur/i.test(user) ||
        user === 'Manager' ||
        // App-written generic lanes: the store-expense drawer twin falls back to
        // 'Caissier' (createShiftSlice.ts:114-124) and native boot/repair lanes
        // use 'Système'. Attribution gaps are reported by their owning cases
        // (SHF-02 / SEC), not as unauthorized-write hits here.
        user === 'Caissier' ||
        // Native PIN-gate denial lane (`GATE_DENIED_BURST`, user_id
        // "manager" — pin/capability gate audit, not a roster actor).
        user === 'manager' ||
        // Documented procurement service labels (createProcurementSlice.ts
        // PO reception/stock lanes). These are service descriptors, not
        // impersonation: the PO itself carries the operator attribution.
        user === 'Admin (Réception Stock)' ||
        user === 'Admin (Stock)' ||
        /Lecteur|Scanner|Syst[eè]me|System/i.test(user);
      const negativeControl = isNegativeControlWrite(a.id);
      if (!nameOk) {
        const msg = `audit ${a.id}: actor '${user}' is not a configured user or system lane (possible unauthorized write)`;
        if (negativeControl) noteResidual('G-15', msg);
        else push('G-15', msg);
      }
      if (/Remboursement/i.test(String(a.action ?? ''))) {
        if (!/Superviseur/i.test(String(a.details ?? ''))) {
          const msg = `audit ${a.id}: refund by '${user}' without supervisor attestation (step-up missing)`;
          if (negativeControl) noteResidual('G-15', msg);
          else push('G-15', msg);
        }
      }
    }
  }

  // ---- G-17: one open drawer session per register; version monotonic ----
  {
    for (const r of all<Record<string, unknown>>(
      `SELECT COALESCE(NULLIF(device_id, ''), '(no device)') AS dev, COUNT(*) AS c, GROUP_CONCAT(id) AS ids
         FROM cash_sessions WHERE status = 'OPEN' GROUP BY dev HAVING c > 1`,
    )) {
      push('G-17', `register ${r.dev}: ${r.c} OPEN sessions (${r.ids})`);
    }
    for (const s of all<Record<string, unknown>>(`SELECT * FROM cash_sessions WHERE status = 'OPEN'`)) {
      if (!String(s.device_id ?? '').trim()) push('G-17', `open session ${s.id}: device_id missing (ownership unknowable)`);
      if (String(s.closed_at ?? '').trim()) push('G-17', `open session ${s.id}: closed_at already set`);
    }
    for (const s of all<Record<string, unknown>>(
      `SELECT * FROM cash_sessions WHERE status NOT IN ('OPEN', 'CLOSED')`,
    )) {
      push('G-17', `session ${s.id}: unknown status '${s.status}'`);
    }
    for (const s of all<Record<string, unknown>>(
      `SELECT rowid AS _rid, * FROM cash_sessions WHERE rowid > ?`,
      B.sessionsMaxRowid,
    )) {
      const v = num(s.version);
      if (!Number.isFinite(v) || v < 1 || Math.abs(v - Math.round(v)) > 0.001) {
        push('G-17', `session ${s.id}: version ${s.version} not a positive integer`);
      }
      const floatVal = num(s.opening_float);
      if (!Number.isFinite(floatVal) || floatVal < 0) {
        push('G-17', `session ${s.id}: opening_float ${s.opening_float} invalid`);
      }
    }
    for (const [sid, baseV] of Object.entries(B.sessionVersions)) {
      const now = one<{ version: number }>(`SELECT version FROM cash_sessions WHERE id = ?`, sid);
      if (!now) {
        push('G-17', `session ${sid}: row deleted (sessions are historical records)`);
      } else if (num(now.version) < baseV) {
        push('G-17', `session ${sid}: version regressed ${baseV} → ${now.version}`);
      }
    }
  }

  // ---- G-18: cross-device freshness — the session snapshot must agree with
  //      the row it was derived from, and its window must be sane on every
  //      reader (no inverted/future timestamps, no CLOSED row still carrying
  //      an open snapshot). A stale mirror written back over SQLite (SHF-07 /
  //      DRW class) or a clock-skewed writer flips this check. ----
  {
    const SKEW_MS = 5 * 60 * 1000;
    const nowMs = Date.now();
    const ts = (v: unknown): number => {
      const s = String(v ?? '').trim();
      return s ? Date.parse(s) : NaN;
    };
    for (const s of all<Record<string, unknown>>(
      `SELECT rowid AS _rid, * FROM cash_sessions WHERE rowid > ?`,
      B.sessionsMaxRowid,
    )) {
      const opened = ts(s.opened_at);
      const updated = ts(s.updated_at);
      const hasClosed = s.closed_at != null && String(s.closed_at).trim() !== '';
      const closed = hasClosed ? ts(s.closed_at) : NaN;
      if (!Number.isFinite(opened)) push('G-18', `session ${s.id}: opened_at unparseable (${s.opened_at})`);
      if (!Number.isFinite(updated)) push('G-18', `session ${s.id}: updated_at unparseable (${s.updated_at})`);
      if (Number.isFinite(opened) && Number.isFinite(updated) && updated < opened) {
        push('G-18', `session ${s.id}: updated_at ${s.updated_at} predates opened_at ${s.opened_at}`);
      }
      if (Number.isFinite(opened) && opened > nowMs + SKEW_MS) {
        push('G-18', `session ${s.id}: opened_at in the future (${s.opened_at}) — clock skew beyond 5 min`);
      }
      if (s.status === 'CLOSED') {
        if (!Number.isFinite(closed)) {
          push('G-18', `session ${s.id}: CLOSED without a parseable closed_at`);
        } else {
          if (Number.isFinite(opened) && closed < opened) {
            push('G-18', `session ${s.id}: closed_at ${s.closed_at} predates opened_at ${s.opened_at}`);
          }
          if (closed > nowMs + SKEW_MS) {
            push('G-18', `session ${s.id}: closed_at in the future (${s.closed_at})`);
          }
        }
      } else if (Number.isFinite(closed)) {
        push('G-18', `session ${s.id}: status ${s.status} but closed_at is set (${s.closed_at}) — stale state`);
      }
      const j = parseJson(s.json_payload);
      if (Object.keys(j).length > 0) {
        const pairs: Array<[string, unknown, unknown]> = [
          ['status', s.status, j.status],
          ['openedAt', s.opened_at, j.openedAt],
          ['closedAt', s.closed_at, j.closedAt],
          ['cashierName', s.cashier_name, j.cashierName],
          ['deviceId', s.device_id, j.deviceId],
        ];
        for (const [k, col, pay] of pairs) {
          const cv = col == null ? '' : String(col);
          const pv = pay == null ? '' : String(pay);
          if (cv !== pv) {
            push('G-18', `session ${s.id}: payload ${k}='${pv}' != column '${cv}' (stale snapshot)`);
          }
        }
      }
    }
  }

  // ---- G-19: attribution — every document carries user + device + drawer ----
  {
    for (const t of newTx) {
      const label = `tx ${t.receipt_number ?? t.id}`;
      if (!String(t.device_id ?? '').trim()) push('G-19', `${label}: device_id missing`);
      const j = parseJson(t.json_payload);
      const cashier = String(j.cashierName ?? j.cashier_name ?? '').trim();
      if (!cashier) {
      const msg = `${label}: cashier snapshot missing from payload (forged or bypassed write)`;
      if (isNegativeControlWrite(t.id, t.receipt_number)) noteResidual('G-19', msg);
      else push('G-19', msg);
    }
    }
    for (const m of newMoves) {
      if (!String(m.cashier_name ?? '').trim()) push('G-19', `movement ${m.id}: cashier_name missing`);
      if (!String(m.session_id ?? '').trim()) push('G-19', `movement ${m.id}: session_id missing`);
    }
    for (const a of newAudit) {
      if (!String(a.user ?? '').trim()) push('G-19', `audit ${a.id}: user missing`);
      if (!String(a.device_id ?? '').trim()) push('G-19', `audit ${a.id}: device_id missing`);
      if (!String(a.source ?? '').trim()) push('G-19', `audit ${a.id}: source missing`);
    }
  }

  // ---- G-20: session integrity — no money document outside a live session ----
  {
    for (const t of newTx) {
      const label = `tx ${t.receipt_number ?? t.id}`;
      const sid = String(t.shift_id ?? '').trim();
      if (!sid) {
        push('G-20', `${label}: no shift_id (document created without a session)`);
        continue;
      }
      const s = one<Record<string, unknown>>(
        `SELECT id, opened_at, closed_at, status FROM cash_sessions WHERE id = ?`,
        sid,
      );
      if (!s) {
        push('G-20', `${label}: shift_id ${sid} does not exist`);
        continue;
      }
      const created = String(t.created_at ?? '').trim();
      const closed = String(s.closed_at ?? '').trim();
      const opened = String(s.opened_at ?? '').trim();
      if (closed && created && created > closed) {
        push('G-20', `${label}: created ${created} after its session ${sid} closed (${closed})`);
      }
      if (Number(t.is_refund) === 1 && opened && created && created < opened) {
        push('G-20', `${label}: refund created before its session ${sid} opened (${opened})`);
      }
    }
  }

  // ---- G-21: warranty binding + claim policy on new SAV rows ----
  // A new ticket is a legal record: v2 schema, signature + CGV + damage
  // constat, exactly one identifier of a known kind (IMEI must be 15-digit
  // Luhn-valid), a legal warranty tier, and — once delivered — a parseable
  // restitution stamp whose frozen expiry is the tier's calendar day count.
  // A warranty claim must bind two existing repairs on the same device and
  // must not open after the original policy's stored expiry.
  {
    const TIERS = new Set(['none', 'test_7d', 'repair_30d', 'repair_90d', 'repair_180d']);
    const TIER_DAYS: Record<string, number> = {
      none: 0, test_7d: 7, repair_30d: 30, repair_90d: 90, repair_180d: 180,
    };
    const luhn = (raw: string): boolean => {
      if (!/^\d{15}$/.test(raw)) return false;
      let sum = 0;
      for (let i = 0; i < 15; i += 1) {
        let d = Number(raw[14 - i]);
        if (i % 2 === 1) {
          d *= 2;
          if (d > 9) d -= 9;
        }
        sum += d;
      }
      return sum % 10 === 0;
    };
    const dayOf = (iso: unknown): string => {
      const s = String(iso ?? '').trim();
      if (!s) return '';
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
    };
    const expiryFor = (deliveredAt: string, tier: string): string => {
      const d = new Date(deliveredAt);
      if (Number.isNaN(d.getTime())) return '';
      const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      utc.setUTCDate(utc.getUTCDate() + (TIER_DAYS[tier] ?? 0));
      return utc.toISOString().slice(0, 10);
    };
    const repairPayloads = new Map<string, Record<string, unknown>>();
    for (const r of all<Record<string, unknown>>(`SELECT id, json_payload FROM repair_orders`)) {
      repairPayloads.set(String(r.id), parseJson(r.json_payload));
    }
    const newRepairs = all<Record<string, unknown>>(
      `SELECT rowid AS _rid, * FROM repair_orders WHERE rowid > ? ORDER BY rowid`,
      B.rowid.repair_orders,
    );
    for (const r of newRepairs) {
      const id = String(r.id);
      const p = parseJson(r.json_payload);
      if (num(p.schemaVersion) !== 2) {
        push('G-21', `repair ${id}: new ticket is not schema v2 (legal evidence absent)`);
        continue;
      }
      if (!String(p.signatureCustomerIntake ?? '').startsWith('data:image/')) {
        push('G-21', `repair ${id}: signatureCustomerIntake missing/not an image`);
      }
      if (!dayOf(p.legalTermsAcceptedAt)) push('G-21', `repair ${id}: legalTermsAcceptedAt missing/unparseable`);
      const dmg = p.intakeDamage as Record<string, unknown> | undefined;
      if (!dmg || !String(dmg.screenCondition ?? '').trim()) {
        push('G-21', `repair ${id}: screen constat missing`);
      }
      if (!dmg || !Array.isArray(dmg.chassisDamage) || (dmg.chassisDamage as unknown[]).length === 0) {
        push('G-21', `repair ${id}: chassis constat missing`);
      }
      const tier = String(p.warrantyTier ?? '');
      if (!TIERS.has(tier)) push('G-21', `repair ${id}: warrantyTier '${tier}' is not a legal tier`);
      const kind = String(p.imeiKind ?? '');
      const ident = String(p.imei ?? '').trim();
      if (!['imei', 'serial', 'none'].includes(kind)) {
        push('G-21', `repair ${id}: imeiKind '${kind}' invalid (identifier type unknown)`);
      } else if (kind === 'imei' && !luhn(ident)) {
        push('G-21', `repair ${id}: declared IMEI '${ident}' is not 15-digit Luhn-valid`);
      } else if (kind === 'serial' && !ident) {
        push('G-21', `repair ${id}: serial identifier empty`);
      } else if (kind === 'none' && ident) {
        push('G-21', `repair ${id}: 'none' identifier still carries '${ident}'`);
      }
      if (String(r.status ?? '') === 'Livré') {
        const delivered = String(p.deliveredAt ?? '').trim();
        if (!delivered || !dayOf(delivered)) {
          push('G-21', `repair ${id}: delivered without a parseable deliveredAt`);
        } else if (tier && TIERS.has(tier)) {
          const expected = expiryFor(delivered, tier);
          const stored = String(p.warrantyExpiresAt ?? '').trim();
          if (!stored) {
            push('G-21', `repair ${id}: delivered with tier ${tier} but no warrantyExpiresAt`);
          } else if (dayOf(stored) !== expected) {
            push('G-21', `repair ${id}: expiry ${dayOf(stored)} != ${expected} for tier ${tier} from ${delivered}`);
          }
        }
      }
    }
    let claims: Array<Record<string, unknown>> = [];
    try {
      claims = all<Record<string, unknown>>(
        `SELECT rowid AS _rid, * FROM warranty_claims WHERE rowid > ? ORDER BY rowid`,
        B.rowid.warranty_claims,
      );
    } catch {
      /* table absent on a pre-v121 schema: no claim lane exists to violate */
    }
    for (const c of claims) {
      const cid = String(c.id);
      const originalId = String(c.original_repair_id ?? '');
      const reworkId = String(c.rework_repair_id ?? '');
      const original = repairPayloads.get(originalId);
      const rework = repairPayloads.get(reworkId);
      if (!original) {
        push('G-21', `claim ${cid}: original repair ${originalId} does not exist`);
        continue;
      }
      if (!rework) {
        push('G-21', `claim ${cid}: rework repair ${reworkId} does not exist`);
        continue;
      }
      const oi = String(original.imei ?? '').replace(/\D/g, '');
      const ri = String(rework.imei ?? '').replace(/\D/g, '');
      if (oi && ri && oi !== ri) push('G-21', `claim ${cid}: rework IMEI ${ri} != original IMEI ${oi}`);
      const tier = String(original.warrantyTier ?? '');
      if (!TIERS.has(tier) || tier === 'none') {
        push('G-21', `claim ${cid}: opened against a repair with no warranty tier (${tier || 'unset'})`);
      } else {
        const delivered = String(original.deliveredAt ?? '').trim();
        const stored = String(original.warrantyExpiresAt ?? '').trim();
        const expiryDay = dayOf(stored) || (delivered ? expiryFor(delivered, tier) : '');
        const openedDay = dayOf(c.opened_at);
        if (!openedDay) push('G-21', `claim ${cid}: opened_at missing/unparseable`);
        else if (!expiryDay) push('G-21', `claim ${cid}: original warranty expiry unknown`);
        else if (openedDay > expiryDay) {
          push('G-21', `claim ${cid}: opened ${openedDay}, after stored policy expiry ${expiryDay}`);
        }
      }
    }
  }

  // ---- G-26: SAV attachment/blob reference integrity ----
  // Every committed intake photo must resolve under app_data_dir/sav_attachments,
  // be bound to its owner ticket, and still hash to the stored digest. The
  // v2 digest covers the stage (`sav-attachment-v2:<kind>:` + bytes), so a
  // re-classified photo cannot silently pass. A committed `draft_*` name is a
  // dangling reference: the startup sweep deletes drafts after 24 h.
  {
    const root = path.join(path.dirname(DB_PATH), 'sav_attachments');
    const newRepairs = all<Record<string, unknown>>(
      `SELECT rowid AS _rid, * FROM repair_orders WHERE rowid > ? ORDER BY rowid`,
      B.rowid.repair_orders,
    );
    for (const r of newRepairs) {
      const id = String(r.id);
      const p = parseJson(r.json_payload);
      const photos = Array.isArray(p.intakePhotos) ? (p.intakePhotos as Array<Record<string, unknown>>) : [];
      for (const [i, ph] of photos.entries()) {
        const rel = String(ph?.relativePath ?? '').trim();
        const label = `repair ${id} photo[${i}]`;
        if (!rel) {
          push('G-26', `${label}: relativePath missing`);
          continue;
        }
        if (
          rel.startsWith('/') ||
          rel.startsWith('\\') ||
          /^[A-Za-z]:/.test(rel) ||
          rel.includes('..') ||
          rel.includes('\\')
        ) {
          push('G-26', `${label}: unsafe path '${rel}'`);
          continue;
        }
        if (!rel.startsWith('sav_attachments/')) {
          push('G-26', `${label}: outside attachment root '${rel}'`);
          continue;
        }
        const base = rel.slice('sav_attachments/'.length);
        if (!base || base.includes('/')) {
          push('G-26', `${label}: nested/empty filename '${rel}'`);
          continue;
        }
        const expectedName = `${id}_${i}.webp`;
        if (base.startsWith('draft_')) {
          push('G-26', `${label}: committed ticket references swept draft '${base}' (not bound to order id)`);
        } else if (base !== expectedName) {
          push('G-26', `${label}: filename '${base}' is not bound to order id (expected '${expectedName}')`);
        }
        const abs = path.join(root, base);
        if (!existsSync(abs)) {
          push('G-26', `${label}: file missing on disk (${rel})`);
          continue;
        }
        let bytes: Buffer;
        try {
          bytes = readFileSync(abs);
        } catch (err) {
          push('G-26', `${label}: unreadable (${String((err as Error)?.message ?? err)})`);
          continue;
        }
        const storedSize = ph?.byteSize;
        if (storedSize !== undefined && Number(storedSize) !== bytes.length) {
          push('G-26', `${label}: byteSize ${storedSize} != disk ${bytes.length}`);
        }
        const kind = String(ph?.kind ?? '');
        if (kind && !['intake', 'bench', 'delivery'].includes(kind)) {
          push('G-26', `${label}: invalid kind '${kind}'`);
        }
        const h = createHash('sha256');
        if (kind) h.update(`sav-attachment-v2:${kind}:`);
        h.update(bytes);
        const digest = h.digest('hex');
        const stored = String(ph?.sha256 ?? '').trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(stored)) {
          push('G-26', `${label}: sha256 '${stored}' is not a 64-hex digest`);
        } else if (stored !== digest) {
          push(
            'G-26',
            `${label}: sha256 mismatch (stored ${stored.slice(0, 12)}…, disk ${digest.slice(0, 12)}…)`,
          );
        }
      }
    }
  }

  // ---- G-29: cumulative refund guards ----
  {
    const over = all<Record<string, unknown>>(`
      WITH purchased AS (
        SELECT t.id AS ticket, i.product_id AS pid, SUM(i.quantity) AS q
        FROM transactions t JOIN transaction_items i ON i.transaction_id = t.id
        WHERE t.is_refund = 0 AND t.deleted = 0 GROUP BY t.id, i.product_id
      ), refunded AS (
        SELECT t.original_transaction_id AS ticket, i.product_id AS pid, SUM(i.quantity) AS q
        FROM transactions t JOIN transaction_items i ON i.transaction_id = t.id
        WHERE t.is_refund = 1 AND t.deleted = 0 GROUP BY t.original_transaction_id, i.product_id
      )
      SELECT r.ticket, r.pid, r.q, p.q FROM refunded r
      LEFT JOIN purchased p ON p.ticket = r.ticket AND p.pid = r.pid
      WHERE p.q IS NULL OR r.q > p.q`);
    for (const r of over) {
      push('G-29', `ticket ${r.ticket} ${r.pid}: refunded ${r.q} > purchased ${r.q ?? 0} (or no purchase row)`);
    }

    const totals = all<Record<string, unknown>>(`
      SELECT t.id, t.receipt_number, t.total, t.json_payload,
        (SELECT COALESCE(SUM(r.total),0) FROM transactions r
          WHERE r.is_refund = 1 AND r.original_transaction_id = t.id) AS rt
      FROM transactions t WHERE t.deleted = 0`);
    for (const r of totals) {
      // Refund rows carry the VALUE REVERSED (funding returned + trade value
      // restored), while the sale's `total` is net of the credit legs it
      // consumed. Cap against what the customer actually gave: net total plus
      // those legs ([MNY-26]: 600 + 400 avoir + 300 reprise = 1300). Same
      // recoverable base the app's funding split uses.
      const given = num(r.total) + creditLegsOf(parseJson(r.json_payload));
      if (num(r.rt) > given + 0.01) {
        push('G-29', `ticket ${r.receipt_number}: Σrefunds=${r.rt} > given=${given} (total ${r.total} + credits)`);
      }
    }

    const ticketsWithRefunds = all<{ tid: string }>(
      `SELECT DISTINCT original_transaction_id AS tid FROM transactions WHERE is_refund = 1`,
    );
    for (const { tid } of ticketsWithRefunds) {
      const orig = one<Record<string, unknown>>(`SELECT * FROM transactions WHERE id = ?`, tid);
      if (!orig) continue;
      const oj = parseJson(orig.json_payload);
      const tenders = Array.isArray(oj.tenders) ? (oj.tenders as Array<Record<string, unknown>>) : null;
      if (!tenders) continue; // no funding truth on legacy rows to cap against
      const cashGiven = tenders
        .filter((x) => String(x?.method ?? '') === 'Espèces')
        .reduce((a, x) => a + num(x?.amount ?? 0), 0);
      const refundsRows = all<Record<string, unknown>>(
        `SELECT * FROM transactions WHERE is_refund = 1 AND original_transaction_id = ?`,
        tid,
      );
      let cashOut = 0;
      for (const r of refundsRows) cashOut += num(parseJson(r.json_payload).cashDisbursed ?? 0);
      if (cashOut > cashGiven + 0.01) {
        push('G-29', `ticket ${orig.receipt_number}: refunded cash ${cashOut} > cash tendered ${cashGiven}`);
      }
    }
  }

  // ---- G-30: ledger tables are append-only (counts never decrease) ----
  for (const t of LEDGER_TABLES) {
    const now = countSafe(t);
    const base = B.counts[t];
    if (base >= 0 && now >= 0 && now < base) {
      push('G-30', `${t}: count ${now} < baseline ${base} (ledger row deleted)`);
    }
  }

  // ---- G-32: customer debt column == ledger == payload ----
  {
    const ids = new Set<string>(Object.keys(B.customers));
    for (const r of newDebt) ids.add(String(r.customer_id));
    for (const id of ids) {
      const base = B.customers[id];
      const touched = newDebt.some((r) => String(r.customer_id) === id);
      const enforce = !base || base.consistent || touched;
      if (!enforce) continue;
      const st = debtState(id);
      if (st.col === null) {
        push('G-32', `customer ${id}: missing customers row`);
        continue;
      }
      if (!close(st.col, st.ledger, 0.001)) {
        push('G-32', `customer ${id}: current_debt=${st.col} != ledger balance=${st.ledger}`);
      }
      if (st.payload === null) {
        push('G-32', `customer ${id}: payload currentDebt missing`);
      } else if (!close(st.col, st.payload, 0.001)) {
        push('G-32', `customer ${id}: current_debt=${st.col} != payload=${st.payload}`);
      }
    }
  }

  // ---- G-33: type discipline on new rows ----
  {
    const tcheck = (v: unknown, allowed: string[], label: string, id: string): void => {
      if (v === null || v === undefined) return;
      const tt = typeof v;
      if (!allowed.includes(tt)) push('G-33', `${id}: typeof(${label})='${tt}'`);
    };
    for (const t of newTx) {
      tcheck(t.id, ['string'], 'id', `tx ${t.receipt_number}`);
      tcheck(t.receipt_number, ['string'], 'receipt_number', `tx ${t.id}`);
      tcheck(t.total, ['number'], 'total', `tx ${t.receipt_number}`);
      tcheck(t.created_at, ['string'], 'created_at', `tx ${t.id}`);
    }
    for (const i of newItems) {
      tcheck(i.product_id, ['string'], 'product_id', `item ${i.id}`);
      tcheck(i.quantity, ['number'], 'quantity', `item ${i.id}`);
    }
    for (const r of newDebt) {
      tcheck(r.id, ['string'], 'id', `debt ${r.id}`);
      tcheck(r.customer_id, ['string'], 'customer_id', `debt ${r.id}`);
    }
    // Negative control: audit rows are typed columns (requires_pin INTEGER).
    // A text value in requires_pin must be flagged, not coerced silently.
    for (const a of newAudit) {
      tcheck(a.id, ['string'], 'id', `audit ${a.id}`);
      tcheck(a.timestamp, ['string'], 'timestamp', `audit ${a.id}`);
      tcheck(a.user, ['string'], 'user', `audit ${a.id}`);
      tcheck(a.action, ['string'], 'action', `audit ${a.id}`);
      tcheck(a.details, ['string'], 'details', `audit ${a.id}`);
      tcheck(a.requires_pin, ['number'], 'requires_pin', `audit ${a.id}`);
    }
  }

  // ---- G-34: derived tables rebuildable (stock drift, dedup journal, debt) ----
  {
    for (const [pid, base] of Object.entries(B.stockDrift)) {
      const now = driftFor(pid);
      if (Number.isFinite(now) && Math.abs(now) > 0.001 && Math.abs(base) <= 0.001) {
        push('G-34', `product ${pid}: stock/ledger drift ${now} appeared (derived stock not rebuildable)`);
      }
    }
    const touched = all<{ tid: string }>(
      `SELECT DISTINCT original_transaction_id AS tid FROM transactions WHERE is_refund = 1 AND rowid > ?`,
      B.rowid.transactions,
    );
    for (const { tid } of touched) {
      const refunds = Number(
        one<{ c: number }>(
          `SELECT COUNT(*) AS c FROM transactions WHERE is_refund = 1 AND original_transaction_id = ?`,
          tid,
        )?.c ?? 0,
      );
      const dedup = Number(
        one<{ c: number }>(`SELECT COUNT(*) AS c FROM refund_dedup WHERE ticket_id = ?`, tid)?.c ?? 0,
      );
      if (dedup !== refunds) {
        push('G-34', `ticket ${tid}: refund_dedup rows ${dedup} != refund rows ${refunds}`);
      }
    }
    const ids = new Set<string>();
    for (const r of newDebt) ids.add(String(r.customer_id));
    for (const c of all<{ id: string }>(`SELECT id FROM customers WHERE rowid > ?`, B.customersMaxRowid)) {
      ids.add(String(c.id));
    }
    for (const id of ids) {
      const st = debtState(id);
      if (st.col !== null && !close(st.col, st.ledger, 0.001)) {
        push('G-34', `customer ${id}: current_debt not rebuildable from ledger (${st.col} vs ${st.ledger})`);
      }
      // P2-7 negative control: the column can lag the JSON payload after a
      // credit sale even when the ledger agrees with the payload.
      if (st.col !== null && st.payload !== null && !close(st.col, st.payload, 0.001)) {
        push('G-34', `customer ${id}: current_debt column ${st.col} != payload ${st.payload}`);
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// assertion entry point (afterEach wiring)
// ---------------------------------------------------------------------------

export function assertInvariants(tag: string): void {
  if (!BASELINE) captureInvariantBaseline(tag);
  let checks: CheckOut[] = [];
  try {
    checks = runInvariantChecks();
  } catch (err) {
    checks = [{ id: 'HARNESS', violations: [`invariant reader crashed: ${String((err as Error)?.message ?? err)}`] }];
  }
  const violations = checks.flatMap((c) => c.violations.map((v) => `${c.id}: ${v}`));

  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    appendFileSync(
      NDJSON,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        tag,
        baseline: BASELINE?.tag ?? null,
        checks: INVARIANT_IDS,
        violations,
      })}\n`,
    );
  } catch {
    /* logging must never mask the verdict */
  }

  if (violations.length > 0) {
    for (const v of violations.slice(0, 40)) console.log(`[INVARIANT VIOLATION] ${v}`);
    for (const c of checks) for (const v of c.violations) {
      const key = `${c.id}\u0000${v}`;
      if (PENDING_SEEN.has(key)) continue;
      PENDING_SEEN.add(key);
      PENDING.push({ test: tag, check: c.id, violation: v });
    }
  }
}

/** End-of-spec integrity pass + aggregated verdict (call from `after()`).
 *  Throws at most once, at the very end of the spec file — every `it()` has
 *  already executed by then, so findings never truncate coverage. */
export function finalizeInvariants(label: string): void {
  const finalViolations: string[] = [];
  try {
    let qc = String(scalar('PRAGMA quick_check') ?? '');
    if (qc.toLowerCase() !== 'ok' && /fts5/i.test(qc)) {
      const until = Date.now() + 700;
      while (Date.now() < until) {
        /* let idle writers settle */
      }
      const qc2 = String(scalar('PRAGMA quick_check') ?? '');
      if (qc2.toLowerCase() === 'ok') {
        console.log(
          `[G-13] quick_check transient during live fts5 writes; final recheck ok (first="${qc.slice(0, 140)}")`,
        );
        qc = 'ok';
      } else {
        qc = qc2;
      }
    }
    if (qc.toLowerCase() !== 'ok') finalViolations.push(`G-13: PRAGMA quick_check (final): ${qc.slice(0, 300)}`);
  } catch (err) {
    finalViolations.push(`G-13: final quick_check crashed: ${String((err as Error)?.message ?? err)}`);
  }

  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    appendFileSync(
      NDJSON,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        tag: `FINALIZE :: ${label}`,
        baseline: BASELINE?.tag ?? null,
        checks: INVARIANT_IDS,
        violations: finalViolations,
        pending: PENDING,
      })}\n`,
    );
  } catch {
    /* logging must never mask the verdict */
  }

  const total = PENDING.length + finalViolations.length;
  if (total > 0) {
    const byCheck = new Map<string, number>();
    for (const p of PENDING) byCheck.set(p.check, (byCheck.get(p.check) ?? 0) + 1);
    const summary = [...byCheck.entries()].map(([k, n]) => `${k}×${n}`).join(', ');
    const detail = [
      ...PENDING.slice(0, 6).map((p) => `${p.check} @ ${p.test}: ${p.violation}`),
      ...finalViolations,
    ]
      .join(' | ')
      .slice(0, 900);
    throw new Error(
      `[INVARIANT VIOLATIONS] ${label}: ${total} (${summary}${finalViolations.length ? `, FINAL×${finalViolations.length}` : ''}) :: ${detail}`,
    );
  }
  console.log(`[INVARIANTS] ${label}: clean (no G-violations recorded)`);
}
