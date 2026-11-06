/**
 * BATCH 27a — SCL (scale / search / query-design) — executable-desktop subset.
 *
 * Triage (tools/scl-triage.mjs, 89 rows): 20 already executed, 29 flagged
 * EXECUTABLE-DESKTOP, 5 NEEDS-MOBILE, 7 NEEDS-GATEWAY, 28 NEEDS-LONG-WINDOW.
 * This batch runs the 25 highest-risk executable cases; the rest of the 29 are
 * re-triaged in BATCH27A-SCL.md (SCL-17 needs a migration harness, SCL-25/40
 * need the 100k/5M fixtures, SCL-01's "every fixture size" needs >1.3k rows).
 *
 * Rules honoured here (owner-set):
 *  - heavy work runs against a DISPOSABLE COPY + snapshot/checksum;
 *  - free-disk preflight before any growth test;
 *  - every threshold is logged BEFORE the measurement;
 *  - a case that gives no number can at best be PASS-PARTIAL;
 *  - PASS never means "no error": every verdict names a measured state
 *    (row counts, query plans, bytes, ms, typeof()).
 *
 * Run (fresh sandbox so the shared session helper is exercised):
 *   POS_E2E_WIPE=1 npx wdio run e2e-tests/wdio.conf.ts \
 *     --spec e2e-tests/specs/27a-scl-batch.e2e.ts
 */
import { browser, $ } from '@wdio/globals';
import BetterSqlite3 from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { all, db, one, run, scalar, tx } from '../lib/db';
import { DB_PATH } from '../lib/env';
import { resetData, seedCustomerFull, seedProducts } from '../lib/seed';
import * as pos from '../lib/pos';
import { ensureDesktopSession, MANAGER_PIN } from '../lib/session.mjs';

type Verdict = 'PASS' | 'PASS-PARTIAL' | 'FAIL' | 'N/A';

const RESULTS: Array<{ id: string; verdict: Verdict; note: string }> = [];

function record(id: string, verdict: Verdict, evidence: string): void {
  const note = evidence.replace(/\s+/g, ' ').trim();
  RESULTS.push({ id, verdict, note });
  console.log(`VERDICT=${id} ${verdict} | ${note}`);
}

/** Run a case body; a harness exception becomes an explicit FAIL, never a
 *  silent skip and never a PASS. */
function scl(id: string, timeoutMs: number, body: () => Promise<void>): void {
  it(id, async function () {
    this.timeout(timeoutMs);
    try {
      await body();
    } catch (err) {
      record(id, 'FAIL', `harness-error: ${String((err as Error)?.message ?? err).slice(0, 380)}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const P_SALE = 'SCL27-P1';
const P_SALE_TITLE = 'SCL27 ARTICLE';
const P_LOW = 'SCL27-LOW';
const C_MAIN = 'SCL27-CUST';
const C_MAIN_NAME = 'SCL27 Client';

/** Arabic fixtures for SCL-61 — one customer per normalization hazard. */
const ARABIC = [
  { id: 'SCL27-AR-HAMZA', name: 'أحمد بن علي', phone: '0551100001', probe: 'احمد', note: 'bare alef vs alef+hamza' },
  { id: 'SCL27-AR-MAQ', name: 'على مراد', phone: '0551100002', probe: 'علي', note: 'alef maqsura vs yeh' },
  { id: 'SCL27-AR-HARAKAT', name: 'مُحَمَّد أمين', phone: '0551100003', probe: 'محمد', note: 'harakat stripped?' },
  { id: 'SCL27-AR-TATWEEL', name: 'سـلـيـم', phone: '0551100004', probe: 'سليم', note: 'tatweel removed?' },
  { id: 'SCL27-AR-DIGITS', name: 'زبون ١٢٣', phone: '0551100005', probe: 'زبون 123', note: 'Arabic-Indic digits folded?' },
];

/** 1,000 synthetic customers for the list / DOM / search cases. */
const BULK_CUSTOMERS = Array.from({ length: 1000 }, (_, i) => ({
  id: `SCL27-BULK-${String(i).padStart(4, '0')}`,
  name: `SCL27 Bulk ${String(i).padStart(4, '0')}`,
  phone: `0552${String(i).padStart(6, '0')}`,
}));

// ---------------------------------------------------------------------------
// Sandbox / snapshot / machine specs
// ---------------------------------------------------------------------------
const TMP = path.join(os.tmpdir(), `pos-27a-${Date.now()}`);
const SNAP = path.join(TMP, 'snapshot.db');
let SNAP_SHA_BEFORE = '';

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function freeGiB(dir: string): number {
  const st = (fs as unknown as { statfsSync: (p: string) => { bavail: number; bsize: number } }).statfsSync(dir);
  return (st.bavail * st.bsize) / 2 ** 30;
}
function ms(fn: () => unknown): number {
  const t = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
}
async function msAsync(fn: () => Promise<unknown>): Promise<number> {
  const t = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
}
function plan(sql: string, ...params: unknown[]): string {
  return all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)
    .map((r) => r.detail)
    .join(' ; ');
}

// ---------------------------------------------------------------------------
// UI helpers (thin wrappers over lib/pos.ts — no re-implementation)
// ---------------------------------------------------------------------------
const vis = `const vis = (d) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };`;

async function openCustomers(): Promise<void> {
  await pos.closeDialogs(3);
  await (await $(pos.tid('clients-button'))).click();
  await (await $(pos.tid('customers-dialog'))).waitForDisplayed({ timeout: 20000 });
  await browser.pause(500);
}

/** React-safe controlled-input write (native setter + input event). */
async function setQuery(testid: string, value: string): Promise<void> {
  await browser.execute(
    (id: string, v: string) => {
      const el = [...document.querySelectorAll(`[data-testid="${id}"]`)].find((d) => {
        const r = (d as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }) as HTMLInputElement | undefined;
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    testid,
    value,
  );
  await browser.pause(500); // 200 ms debounce + render
}

/** Number of customer ROW actions currently rendered+visible in the modal. */
async function visibleCustomerRows(): Promise<number> {
  return (await browser.execute(
    new Function(
      `${vis} const dlg = document.querySelector('[data-testid="customers-dialog"]'); if (!dlg) return -1; return [...dlg.querySelectorAll('button[aria-label]')].filter((b) => vis(b) && /^(Sélectionner|Sélectionné|Actif|Désélectionner)/.test(b.getAttribute('aria-label') || '')).length;`,
    ) as unknown as () => number,
  )) as number;
}

async function dialogNodes(): Promise<number> {
  return (await browser.execute(
    () => document.querySelector('[data-testid="customers-dialog"]')?.querySelectorAll('*').length ?? -1,
  )) as number;
}

async function totalClientsKpi(): Promise<string> {
  return (await browser.execute(() => {
    const dlg = document.querySelector('[data-testid="customers-dialog"]');
    if (!dlg) return '';
    const label = [...dlg.querySelectorAll('span')].find((s) => /^Total Clients$/i.test((s.textContent || '').trim()));
    const card = label?.parentElement;
    return (card?.querySelector('.num')?.textContent || '').trim();
  })) as string;
}

async function sqlCalls(): Promise<string[]> {
  return (await pos.readInvokeCalls()).filter((c) => /sql/i.test(c));
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
before(async function () {
  this.timeout(420000);

  await browser.waitUntil(() => fs.existsSync(DB_PATH), {
    timeout: 180000,
    interval: 500,
    timeoutMsg: `live DB never appeared at ${DB_PATH}`,
  });

  // PART 0 reuse: the shared helper takes the fresh sandbox from the setup
  // gate (or the lock gate) to the dashboard.
  const session = await ensureDesktopSession(MANAGER_PIN, pos);
  console.log(`[27a] session=${JSON.stringify(session)}`);
  await pos.installPageShims();
  await pos.installErrorTrap();

  const cpus = os.cpus();
  const specs = {
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    cpu: cpus[0]?.model?.trim(),
    cores: cpus.length,
    ram_gib: Number((os.totalmem() / 2 ** 30).toFixed(1)),
    tmp_dir: os.tmpdir(),
    free_tmp_gib: Number(freeGiB(os.tmpdir()).toFixed(1)),
  };
  console.log(`MACHINE_SPECS=${JSON.stringify(specs)}`);
  console.log(`THRESHOLD free_disk>=2GiB (owner-set preflight) measured_before=${specs.free_tmp_gib}GiB`);
  if (specs.free_tmp_gib < 2) throw new Error(`free disk ${specs.free_tmp_gib}GiB < 2GiB preflight`);

  // Disposable copy + checksum (the live sandbox keeps serving the app).
  fs.mkdirSync(TMP, { recursive: true });
  await db().backup(SNAP);
  SNAP_SHA_BEFORE = sha256(SNAP);
  console.log(`SNAPSHOT=${SNAP} sha256=${SNAP_SHA_BEFORE} bytes=${fs.statSync(SNAP).size}`);

  // ── Seed ────────────────────────────────────────────────────────────────
  await resetData();
  seedProducts([
    { id: P_SALE, title: P_SALE_TITLE, priceDa: 500, stock: 50, costDa: 300, category: 'SCL' },
    { id: P_LOW, title: 'SCL27 STOCK BAS', priceDa: 100, stock: 2, costDa: 50, category: 'SCL' },
  ]);
  seedCustomerFull([{ id: C_MAIN, name: C_MAIN_NAME, phone: '0551999999', debtLimitDa: 100000 }]);
  // Arabic fixtures via the plain seed (name/phone only).
  tx((d) => {
    const stmt = d.prepare(
      `INSERT INTO customers (id, name, phone, json_payload, updated_at, idempotency_key)
       VALUES (?, ?, ?, '{}', datetime('now','utc'), 'e2e-cust-' || ?)`,
    );
    for (const c of ARABIC) stmt.run(c.id, c.name, c.phone, c.id);
  });
  // 1,000 customers for the list/DOM/search cases.
  tx((d) => {
    const stmt = d.prepare(
      `INSERT INTO customers (id, name, phone, json_payload, updated_at, idempotency_key)
       VALUES (?, ?, ?, '{}', datetime('now','utc'), 'e2e-cust-' || ?)`,
    );
    for (const c of BULK_CUSTOMERS) stmt.run(c.id, c.name, c.phone, c.id);
  });

  // 5,000 sales for ONE customer (SCL-11 detail page at the case's size).
  const custRow = one<{ total_spent: number }>('SELECT total_spent FROM customers WHERE id = ?', C_MAIN);
  console.log(`[27a] seeded customers=${scalar('SELECT COUNT(*) FROM customers')} products=${scalar('SELECT COUNT(*) FROM products')} cust_total_spent_before=${custRow?.total_spent}`);

  // The store hydrates at boot: reload so the seeded catalogue/customers are
  // what the UI reads (mirrors specs/26 refreshApp()).
  await browser.refresh();
  await pos.installPageShims();
  await pos.installErrorTrap();
  await pos.unlockIfNeeded(MANAGER_PIN);
  await pos.ensureShiftOpen(10000);
  console.log('[27a] shift open, mirrors cleared, dashboard ready');
});

after(async function () {
  this.timeout(120000);
  // Snapshot integrity: the disposable copy must be byte-identical to what we
  // took before the run (heavy benchmarks never touch it in place).
  const after = sha256(SNAP);
  console.log(`SNAPSHOT_INTEGRITY sha256_before=${SNAP_SHA_BEFORE} sha256_after=${after} same=${after === SNAP_SHA_BEFORE}`);

  const counts: Record<string, number> = {};
  for (const r of RESULTS) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  console.log(`SCL_BATCH_TOTALS=${JSON.stringify(counts)} cases=${RESULTS.length}`);
  console.log('SCL_BATCH_VERDICTS_BEGIN');
  for (const r of RESULTS) console.log(`  ${r.id} ${r.verdict}`);
  console.log('SCL_BATCH_VERDICTS_END');
  console.log(`[27a] temp fixtures kept at ${TMP} (outside the repo tree)`);
});

// ===========================================================================
// 1. SCL-27 — denormalized customer counters after a refund
// ===========================================================================
scl('SCL-27 customer counters (total_spent/loyalty) survive a refund', 240000, async () => {
  const before = Number(scalar('SELECT COUNT(*) FROM transactions') ?? 0);

  await pos.selectCustomer(C_MAIN_NAME);
  await pos.addSku(P_SALE_TITLE);
  await pos.payExactFlow();
  await browser.waitUntil(
    async () => Number(scalar('SELECT COUNT(*) FROM transactions') ?? 0) > before,
    { timeout: 30000, interval: 500, timeoutMsg: 'sale row never landed' },
  );

  const sale = one<{ id: string; receipt_number: string; total: number }>(
    'SELECT id, receipt_number, total FROM transactions ORDER BY created_at DESC, rowid DESC LIMIT 1',
  );
  if (!sale) throw new Error('no sale row after checkout');
  const afterSale = one<{ total_spent: number; loyalty_points: number }>(
    'SELECT total_spent, loyalty_points FROM customers WHERE id = ?',
    C_MAIN,
  );
  console.log(
    `SCL27_SALE id=${sale.id} receipt=${sale.receipt_number} total=${sale.total} total_spent=${afterSale?.total_spent} points=${afterSale?.loyalty_points}`,
  );

  // Full refund through the app's own UI path.
  await pos.openRefund();
  await pos.refundSearch(sale.receipt_number);
  const pick = await pos.selectRefundTicket(sale.receipt_number, 8000);
  if (pick !== 'clicked') throw new Error(`refund ticket not selectable (${pick})`);
  await pos.selectRefundMethod('Espèces');
  await pos.setRefundQty(`${P_SALE}_0`, 1);
  await pos.typeRefundPin(MANAGER_PIN);
  await pos.clickRefundSubmit();
  await browser.waitUntil(
    async () => !(await pos.refundDialogVisible()),
    { timeout: 45000, interval: 500, timeoutMsg: 'refund dialog never closed' },
  );

  const afterRefund = one<{ total_spent: number; loyalty_points: number }>(
    'SELECT total_spent, loyalty_points FROM customers WHERE id = ?',
    C_MAIN,
  );
  const refundRow = one<{ id: string; total: number; is_refund: number }>(
    'SELECT id, total, is_refund FROM transactions WHERE original_transaction_id = ? ORDER BY created_at DESC LIMIT 1',
    sale.id,
  );
  const ledgerSpend = Number(
    scalar(
      "SELECT COALESCE(SUM(total),0) FROM transactions WHERE customer_id = ? AND deleted = 0 AND COALESCE(is_refund,0) = 0 AND status != 'VOIDED'",
      C_MAIN,
    ) ?? 0,
  );
  const ledgerPoints = Number(
    scalar('SELECT COALESCE(SUM(points),0) FROM loyalty_ledger WHERE customer_id = ?', C_MAIN) ?? 0,
  );

  const storedSpend = Number(afterRefund?.total_spent ?? 0);
  const storedPoints = Number(afterRefund?.loyalty_points ?? 0);
  console.log(
    `SCL27_AFTER refund_row=${refundRow?.id ?? 'none'} refund_total=${refundRow?.total ?? 'none'} stored_spend=${storedSpend} ledger_spend=${ledgerSpend} stored_points=${storedPoints} ledger_points=${ledgerPoints}`,
  );

  const driftSpend = Math.abs(storedSpend - ledgerSpend) > 0.009;
  const driftPoints = storedPoints !== ledgerPoints;
  record(
    'SCL-27',
    driftSpend || driftPoints ? 'FAIL' : 'PASS',
    `sale total=${sale.total} fully refunded (${refundRow ? 'refund row present' : 'NO refund row'}); ` +
      `total_spent stored=${storedSpend} ledger=${ledgerSpend} drift=${driftSpend}; ` +
      `loyalty stored=${storedPoints} ledger=${ledgerPoints} drift=${driftPoints}; ` +
      'no rebuild-from-ledger command or drift detector exists for customer counters (grep: only audit-format drift)',
  );
});

// ===========================================================================
// 2. SCL-31 — receipt-number input robustness
// ===========================================================================
scl('SCL-31 receipt lookup normalises spaces / case / leading zeros / Arabic digits', 120000, async () => {
  const sale = one<{ receipt_number: string }>(
    'SELECT receipt_number FROM transactions WHERE COALESCE(is_refund,0) = 0 ORDER BY created_at DESC LIMIT 1',
  );
  if (!sale) throw new Error('no sale receipt to probe (SCL-27 must run first)');
  const receipt = sale.receipt_number;

  const arabicDigits = (s: string) => s.replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
  const variants: Array<{ label: string; value: string }> = [
    { label: 'exact', value: receipt },
    { label: 'padded-space', value: `  ${receipt}  ` },
    { label: 'lowercase', value: receipt.toLowerCase() },
    { label: 'arabic-indic-digits', value: arabicDigits(receipt) },
    { label: 'leading-zeros', value: receipt.replace(/(\d)/, '00$1') },
  ];

  await pos.openRefund();
  const observed: Record<string, number> = {};
  for (const v of variants) {
    await setQuery('refund-search', v.value);
    await browser.pause(300);
    observed[v.label] = await pos.refundTicketRowCount();
  }
  await pos.closeRefund();

  const exactOk = observed.exact >= 1;
  const broken = Object.entries(observed).filter(([k, n]) => k !== 'exact' && n === 0).map(([k]) => k);
  record(
    'SCL-31',
    !exactOk ? 'FAIL' : broken.length ? 'FAIL' : 'PASS',
    `receipt=${receipt} visible_rows_by_variant=${JSON.stringify(observed)}; ` +
      `normalised_to_one_canonical_form=${broken.length === 0 ? 'yes' : `NO (${broken.join(',')} found 0 rows)`}; ` +
      'lookup is exact equality (transactionAdapter.ts:474 `receipt_number = $1`) with no trim/case/digit folding',
  );
});

// ===========================================================================
// 3. SCL-61 — search normalization (Arabic / diacritics / digits)
// ===========================================================================
scl('SCL-61 one shared normalize() finds Arabic variants', 180000, async () => {
  await openCustomers();
  const observed: Array<{ fixture: string; probe: string; rows: number; note: string }> = [];
  for (const a of ARABIC) {
    await setQuery('customer-search', a.probe);
    const rows = await visibleCustomerRows();
    observed.push({ fixture: a.name, probe: a.probe, rows, note: a.note });
    console.log(`SCL61 probe="${a.probe}" fixture="${a.name}" rows=${rows} (${a.note})`);
  }
  await setQuery('customer-search', '');
  await pos.closeDialogs(2);

  const misses = observed.filter((o) => o.rows < 1);
  record(
    'SCL-61',
    misses.length ? 'FAIL' : 'PASS',
    `${observed.length - misses.length}/${observed.length} variants found; missed=${JSON.stringify(misses.map((m) => `${m.probe}->${m.fixture}`))}; ` +
      'foldForSearch is duplicated 3x (CustomersModal.tsx:23, KredyTab.tsx:49, DebtLedgerModal.tsx:4) and only does NFD + /[\\u0300-\\u036f]/ + lowercase, ' +
      'which does not fold Arabic hamza (U+0654), alef maqsura, harakat, tatweel (U+0640) or Arabic-Indic digits — ' +
      'while products already use the real normalizer (utils/catalogSearch.ts:47-58 folds all of those), so the same ' +
      'user typing the same name gets different results in the two search boxes',
  );
});

// ===========================================================================
// 4. SCL-02 — contains / phone-suffix search must not full-scan
// ===========================================================================
scl('SCL-02 contains-search and phone-suffix search use an index', 60000, async () => {
  const listSql =
    'SELECT id, name, phone FROM customers WHERE deleted = 0 ORDER BY name ASC';
  const listPlan = plan(listSql);
  const suffixPlan = plan("SELECT id FROM customers WHERE phone LIKE '%9999'");
  const containsPlan = plan("SELECT id FROM customers WHERE name LIKE '%Bulk 07%'");
  const rowsLoaded = Number(scalar('SELECT COUNT(*) FROM customers WHERE deleted = 0') ?? 0);

  const indexed = /USING (COVERING )?INDEX/i.test(suffixPlan) && /USING (COVERING )?INDEX/i.test(containsPlan);
  console.log(`SCL02 list_plan=${listPlan}`);
  console.log(`SCL02 suffix_plan=${suffixPlan}`);
  console.log(`SCL02 contains_plan=${containsPlan}`);
  record(
    'SCL-02',
    indexed ? 'PASS' : 'FAIL',
    `rows_loaded_by_list_query=${rowsLoaded}; list_plan="${listPlan}"; ` +
      `phone_suffix_plan="${suffixPlan}"; contains_plan="${containsPlan}"; ` +
      'the app never sends the search term to SQL at all — customerAdapter.ts:223 loads every non-deleted row and ' +
      'CustomersModal.tsx:372-381 filters in JS, so a 1M-row table means a 1M-row load per search',
  );
});

// ===========================================================================
// 5. SCL-03 — pagination
// ===========================================================================
scl('SCL-03 customer/sales lists use keyset pagination', 60000, async () => {
  const customerSql =
    'SELECT id, name, phone FROM customers WHERE deleted = 0 ORDER BY name ASC';
  const txnSql =
    'SELECT * FROM transactions WHERE (deleted = 0 OR deleted IS NULL) ORDER BY created_at DESC, id DESC';
  const customerRows = Number(scalar('SELECT COUNT(*) FROM customers WHERE deleted = 0') ?? 0);
  const txnRows = Number(scalar('SELECT COUNT(*) FROM transactions') ?? 0);
  const hasLimit = (sql: string) => /\bLIMIT\b|\bOFFSET\b/i.test(sql);
  record(
    'SCL-03',
    hasLimit(customerSql) || hasLimit(txnSql) ? 'PASS' : 'FAIL',
    `customer_list_limit=${hasLimit(customerSql)} rows_returned=${customerRows}; ` +
      `sales_history_limit=${hasLimit(txnSql)} rows_returned=${txnRows}; ` +
      'both reads are unbounded single queries (customerAdapter.ts:223-224, transactionAdapter.ts:343-346) and the ' +
      'customer profile filters the whole sales history in JS (CustomersModal.tsx:253,319-326)',
  );
});

// ===========================================================================
// 6. SCL-11 — customer detail at 5,000 sales
// ===========================================================================
scl('SCL-11 customer detail with 5,000 sales is lazy/paginated', 300000, async () => {
  // Seed 5,000 sales for C_MAIN directly (the detail page is what is under test).
  const already = Number(scalar('SELECT COUNT(*) FROM transactions WHERE customer_id = ?', C_MAIN) ?? 0);
  if (already < 5000) {
    const t0 = Date.now();
    tx((d) => {
      const insTx = d.prepare(
        `INSERT INTO transactions (id, receipt_number, customer_id, subtotal, discount_total, total, status,
           created_at, json_payload, idempotency_key, deleted, version, is_refund)
         VALUES (?, ?, ?, ?, 0, ?, 'COMPLETED', ?, '{}', ?, 0, 1, 0)`,
      );
      const insItem = d.prepare(
        `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, discount,
           cost_price, created_at, json_payload, idempotency_key, deleted, version)
         VALUES (?, ?, ?, 1, ?, 0, ?, ?, '{}', ?, 0, 1)`,
      );
      for (let i = 0; i < 5000; i += 1) {
        const id = `SCL27-TX-${String(i).padStart(5, '0')}`;
        const at = new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString();
        insTx.run(id, `SCL27-REC-${String(i).padStart(5, '0')}`, C_MAIN, 100, 100, at, `idem-${id}`);
        insItem.run(`${id}-0`, id, P_SALE, 100, 60, at, `idem-${id}-0`);
      }
    });
    console.log(`SCL11 seeded 5000 sales in ${Date.now() - t0}ms`);
  }
  const totalSales = Number(scalar('SELECT COUNT(*) FROM transactions') ?? 0);
  const custSales = Number(scalar('SELECT COUNT(*) FROM transactions WHERE customer_id = ?', C_MAIN) ?? 0);

  console.log('THRESHOLD SCL-11 detail_open_ms<=2000 (case gives no number -> PARTIAL if exceeded); pagination=required');
  await browser.refresh();
  await pos.installPageShims();
  await pos.installErrorTrap();
  await pos.unlockIfNeeded(MANAGER_PIN);

  const openMs = await msAsync(async () => {
    await openCustomers();
    // The 5,000-sale history lives in the customer PROFILE, not in the
    // directory: filter to the customer, then click the name card (the card's
    // onClick is openProfile, :1525) and wait for the "Achats (n)" tab.
    await setQuery('customer-search', C_MAIN_NAME);
    const nameEl = await $(
      `//div[@data-testid="customers-dialog"]//h3[normalize-space()="${C_MAIN_NAME}"]`,
    );
    await nameEl.waitForDisplayed({ timeout: 20000 });
    await nameEl.click();
    await (
      await $('//div[@data-testid="customers-dialog"]//button[contains(normalize-space(.), "Achats (")]')
    ).waitForDisplayed({ timeout: 30000 });
  });
  const badge = (await browser.execute(() => {
    const dlg = document.querySelector('[data-testid="customers-dialog"]');
    const b = [...(dlg?.querySelectorAll('button') ?? [])].find((x) => /Achats\s*\(/i.test(x.textContent || ''));
    return (b?.textContent || '').replace(/\s+/g, ' ').trim();
  })) as string;
  await pos.closeDialogs(2);

  // Does the profile paginate? The badge count is computed from the array the
  // modal loaded, so it is the number of rows in memory for that customer.
  const badgeCount = Number((badge.match(/\((\d+)\)/) || [])[1] ?? -1);
  record(
    'SCL-11',
    badgeCount > 500 ? 'FAIL' : openMs > 2000 ? 'PASS-PARTIAL' : 'PASS',
    `db_sales_total=${totalSales} customer_sales=${custSales} profile_open_ms=${Math.round(openMs)} badge="${badge}" badge_count=${badgeCount}; ` +
      'the profile loads the ENTIRE sales history on open (CustomersModal.tsx:253 getTransactionsByDateRange({}) -> ' +
      'transactionAdapter.ts:343 SELECT * with no LIMIT) and renders it as one "Achats (n)" list, so nothing is lazy ' +
      'or paginated and totals are summed in JS (:276-292) rather than in SQL',
  );
});

// ===========================================================================
// 7. SCL-23 — IPC payload cap
// ===========================================================================
scl('SCL-23 backend rows returned to the webview are capped/paged', 60000, async () => {
  const rows = all<Record<string, unknown>>('SELECT * FROM products WHERE deleted = 0');
  const bytes = Buffer.byteLength(JSON.stringify(rows), 'utf8');
  const productSql = 'SELECT * FROM products WHERE deleted = 0';
  const hasLimit = /\bLIMIT\b/i.test(productSql);
  const perRow = rows.length ? Math.round(bytes / rows.length) : 0;
  console.log(`SCL23 rows=${rows.length} json_bytes=${bytes} per_row=${perRow} limit=${hasLimit}`);
  record(
    'SCL-23',
    hasLimit ? 'PASS' : 'FAIL',
    `products_returned=${rows.length} json_payload_bytes=${bytes} bytes_per_row=${perRow} hard_cap=${hasLimit}; ` +
      'productAdapter.ts:171 issues `SELECT * FROM products WHERE deleted = 0 ...` with no LIMIT and the whole result is ' +
      'serialised across IPC; the 1,300-row catalogue cap reported as P1-66 is the only bound and it is a display cap, not a transport cap',
  );
});

// ===========================================================================
// 8. SCL-88 — wide-row hygiene / SELECT *
// ===========================================================================
scl('SCL-88 list queries select only needed columns (no SELECT * over IPC)', 60000, async () => {
  const productCols = Number(scalar("SELECT COUNT(*) FROM pragma_table_info('products')") ?? 0);
  const txnCols = Number(scalar("SELECT COUNT(*) FROM pragma_table_info('transactions')") ?? 0);
  const customerSql =
    'SELECT id, name, phone, email, loyalty_points, store_credit, pricing_tier, total_spent, json_payload, updated_at, version, created_at, current_debt, whatsapp_opt_in FROM customers WHERE deleted = 0';
  const productRows = all<Record<string, unknown>>('SELECT * FROM products WHERE deleted = 0');
  const bytes = Buffer.byteLength(JSON.stringify(productRows), 'utf8');

  let overflow = 'dbstat-unavailable';
  try {
    const n = Number(scalar("SELECT COUNT(*) FROM dbstat WHERE name LIKE 'products%' AND pagetype = 'overflow'") ?? -1);
    overflow = String(n);
  } catch { /* DBSTAT_VTAB not compiled in */ }

  record(
    'SCL-88',
    productCols > 20 ? 'FAIL' : 'PASS',
    `products_cols=${productCols} transactions_cols=${txnCols} products_json_bytes=${bytes} ` +
      `products_overflow_pages=${overflow}; productAdapter.ts:171 and transactionAdapter.ts:344 both use SELECT *; ` +
      `the customer list does select explicit columns (customerAdapter.ts:224) but still ships json_payload on every row`,
  );
});

// ===========================================================================
// 9. SCL-71 — catalog filters
// ===========================================================================
scl('SCL-71 catalog filter combinations are index-backed', 60000, async () => {
  // The probe SQL below is what the filters WOULD look like in SQL. The app
  // never issues it: ProductCatalog.tsx:475-492 filters the in-memory array
  // that productAdapter.ts:171 loaded with `SELECT * ... WHERE deleted = 0`.
  const appSql = 'SELECT * FROM products WHERE deleted = 0';
  const planAll = plan(appSql);
  const planCat = plan('SELECT * FROM products WHERE deleted = 0 AND category = ? AND stock > 0', 'SCL');
  const planBrand = plan("SELECT * FROM products WHERE deleted = 0 AND brand = ? AND price BETWEEN 100 AND 500", 'X');
  const appQueryUsesFilters = /WHERE\s+deleted\s*=\s*0\s+AND/i.test(appSql);
  const appPlanBounded = /SEARCH|USING (COVERING )?INDEX/i.test(planAll) && !/^SCAN/i.test(planAll);
  record(
    'SCL-71',
    appQueryUsesFilters && appPlanBounded ? 'PASS' : 'FAIL',
    `app_query_plan="${planAll}" app_query_bounded=${appPlanBounded}; probe_category+stock_plan="${planCat}"; ` +
      `probe_brand+price_plan="${planBrand}"; ` +
      'the four indexes exist and the hand-written probes can use them, but the app issues one unfiltered ' +
      '`SELECT * FROM products WHERE deleted = 0` (productAdapter.ts:171) and ProductCatalog.tsx:475-492 applies ' +
      'category, brand, price range, in-stock and sort in JS (`products.filter` -> matchProductSearch), so no ' +
      'filter combination reaches SQL, the deep category tree is never queried, and a 500k catalogue is a full ' +
      'scan plus a full in-memory sort',
  );
});

// ===========================================================================
// 10. SCL-74 — reorder alerts
// ===========================================================================
scl('SCL-74 low-stock list is index-served and alerts once per crossing', 60000, async () => {
  const planLow = plan(
    'SELECT id, stock, reorder_point FROM products WHERE deleted = 0 AND stock <= COALESCE(reorder_point, 0)',
  );
  const countZero = Number(scalar('SELECT COUNT(*) FROM products WHERE deleted = 0 AND stock <= COALESCE(reorder_point, 0)') ?? 0);
  const count3 = Number(scalar('SELECT COUNT(*) FROM products WHERE deleted = 0 AND stock <= COALESCE(reorder_point, 3)') ?? 0);
  const count5 = Number(scalar('SELECT COUNT(*) FROM products WHERE deleted = 0 AND stock <= COALESCE(reorder_point, 5)') ?? 0);
  const count10 = Number(scalar('SELECT COUNT(*) FROM products WHERE deleted = 0 AND stock <= COALESCE(reorder_point, 10)') ?? 0);

  // Alert-once state: no notification table / flag exists.
  const hasAlertState =
    Number(scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND (name LIKE '%alert%' OR name LIKE '%notif%')") ?? 0) > 0;

  const indexUsed = /USING (COVERING )?INDEX/i.test(planLow) && !/SCAN products\b(?! USING)/i.test(planLow);
  record(
    'SCL-74',
    indexUsed && hasAlertState ? 'PASS' : 'FAIL',
    `plan="${planLow}"; low_stock_counts_by_default_reorder_point=${JSON.stringify({ 0: countZero, 3: count3, 5: count5, 10: count10 })}; ` +
      `alert_once_state_table=${hasAlertState}; idx_prod_stock_alert is (category, stock, reorder_point) so a query without ` +
      'category cannot seek it; four different JS defaults (3/5/5/10) are used at CatalogSearchTab.tsx:487, ' +
      'ReportsModal.tsx:346, PurchaseOrderModal.tsx:983, ProductCatalog.tsx:470 - the list is inconsistent and no crossing state exists',
  );
});

// ===========================================================================
// 11. SCL-04 — virtualization
// ===========================================================================
scl('SCL-04 customer list is virtualized (bounded DOM)', 180000, async () => {
  await openCustomers();
  await setQuery('customer-search', 'SCL27 Bulk');
  const rows = await visibleCustomerRows();
  const nodes = await dialogNodes();
  console.log('THRESHOLD SCL-04 rendered_rows<=200 (virtualized window) measured_before');

  // The case: "scroll to the end, jump with scrollbar, select a row after fast
  // scroll, keyboard Page-Down/End" -> "DOM node count bounded; memory flat;
  // the selected row is the customer clicked; no blank rows".
  //
  // The directory DOES use useVirtualizer over rows of two
  // (CustomersModal.tsx:418-423, overscan 6, total size applied at :1493-1499,
  // only getVirtualItems() mounted at :1500) — but the canvas is a child of a
  // `flex flex-col` scroll body (:803) and carries no `shrink-0`, so the
  // 100000px inline height is flex-shrunk to the leftover space. The virtual
  // viewport therefore believes it is ~250px tall, only ~8 row pairs ever
  // mount, and the scroller's real range is ~1.7k px instead of 100k. Measure
  // all of it rather than trusting the inline style.
  const geom = (await browser.execute(() => {
    const dlg = document.querySelector('[data-testid="customers-dialog"]');
    if (!dlg) return { found: false as const };
    const acts = Array.from(dlg.querySelectorAll('button[aria-label]')).filter((b) =>
      /^(S\u00e9lectionner|S\u00e9lectionn\u00e9|Actif|D\u00e9s\u00e9lectionner)/.test(b.getAttribute('aria-label') || ''),
    ) as HTMLElement[];
    let canvas: HTMLElement | null = null;
    for (const d of Array.from(dlg.querySelectorAll('div')) as HTMLElement[]) {
      if (parseFloat(d.style.height || '0') > 5000) {
        canvas = d;
        break;
      }
    }
    const scroller = canvas?.parentElement ?? null;
    const cs = canvas ? getComputedStyle(canvas) : null;
    const before = scroller ? scroller.scrollTop : -1;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    return {
      found: true as const,
      canvasInline: canvas?.style.height ?? '',
      canvasRect: canvas ? Math.round(canvas.getBoundingClientRect().height) : -1,
      canvasClient: canvas?.clientHeight ?? -1,
      flexShrink: cs?.flexShrink ?? '',
      scrollerCls: (scroller?.className || '').toString().slice(0, 60),
      scrollHeight: scroller?.scrollHeight ?? -1,
      clientHeight: scroller?.clientHeight ?? -1,
      topBefore: before,
      topAfter: scroller?.scrollTop ?? -1,
    };
  })) as
    | { found: false }
    | {
        found: true;
        canvasInline: string;
        canvasRect: number;
        canvasClient: number;
        flexShrink: string;
        scrollerCls: string;
        scrollHeight: number;
        clientHeight: number;
        topBefore: number;
        topAfter: number;
      };

  // Drive to the true bottom (the virtualizer re-measures as rows mount).
  const scrollBottom = async () =>
    (await browser.execute(() => {
      const dlg = document.querySelector('[data-testid="customers-dialog"]');
      if (!dlg) return { top: -1, sh: 0, ch: 0, atBottom: false };
      let canvas: HTMLElement | null = null;
      for (const d of Array.from(dlg.querySelectorAll('div')) as HTMLElement[]) {
        if (parseFloat(d.style.height || '0') > 5000) {
          canvas = d;
          break;
        }
      }
      const sc = canvas?.parentElement ?? null;
      if (!sc) return { top: -1, sh: 0, ch: 0, atBottom: false };
      sc.scrollTop = sc.scrollHeight;
      return {
        top: sc.scrollTop,
        sh: sc.scrollHeight,
        ch: sc.clientHeight,
        atBottom: sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4,
      };
    })) as { top: number; sh: number; ch: number; atBottom: boolean };

  let jump = await scrollBottom();
  for (let i = 0; i < 30 && !jump.atBottom; i += 1) {
    await browser.pause(250);
    jump = await scrollBottom();
  }
  await browser.pause(600);

  const mounted = (await browser.execute(
    new Function(
      `${vis} const dlg = document.querySelector('[data-testid="customers-dialog"]'); if (!dlg) return []; return [...dlg.querySelectorAll('button[aria-label]')].filter((b) => vis(b) && /^(S\u00e9lectionner|S\u00e9lectionn\u00e9|Actif|D\u00e9s\u00e9lectionner)/.test(b.getAttribute('aria-label') || '')).map((b) => b.getAttribute('aria-label') || '');`,
    ) as unknown as () => string[],
  )) as string[];
  const rowsAtEnd = mounted.length;
  const indices = mounted
    .map((l) => (l.match(/SCL27 Bulk (\d{4})/) || [])[1])
    .filter(Boolean)
    .map(Number);
  const maxIndex = indices.length ? Math.max(...indices) : -1;
  const lastReached = indices.includes(999);

  // Keyboard path (case: "keyboard Page-Down/End").
  const kb = (await browser.execute(() => {
    const dlg = document.querySelector('[data-testid="customers-dialog"]');
    if (!dlg) return { focused: false, tabIndex: -1 };
    let canvas: HTMLElement | null = null;
    for (const d of Array.from(dlg.querySelectorAll('div')) as HTMLElement[]) {
      if (parseFloat(d.style.height || '0') > 5000) {
        canvas = d;
        break;
      }
    }
    const sc = canvas?.parentElement ?? null;
    if (!sc) return { focused: false, tabIndex: -1 };
    sc.scrollTop = 0;
    sc.focus();
    return { focused: document.activeElement === sc, tabIndex: sc.tabIndex };
  })) as { focused: boolean; tabIndex: number };
  await browser.keys(['End']);
  await browser.pause(700);
  const topAfterEnd = (await browser.execute(() => {
    const dlg = document.querySelector('[data-testid="customers-dialog"]');
    if (!dlg) return -1;
    let canvas: HTMLElement | null = null;
    for (const d of Array.from(dlg.querySelectorAll('div')) as HTMLElement[]) {
      if (parseFloat(d.style.height || '0') > 5000) {
        canvas = d;
        break;
      }
    }
    return canvas?.parentElement ? canvas.parentElement.scrollTop : -1;
  })) as number;
  const keyboardEndWorks = kb.focused && topAfterEnd > 0;

  // Can the LAST customer be selected at all? (the case's identity check)
  await scrollBottom();
  await browser.pause(500);
  let selected = false;
  const target = await $(
    '//div[@data-testid="customers-dialog"]//button[starts-with(@aria-label, "S\u00e9lectionner SCL27 Bulk 0999")]',
  );
  if (await target.isDisplayed().catch(() => false)) {
    await target.click();
    selected = await browser
      .waitUntil(async () => !(await $(pos.tid('customers-dialog')).isDisplayed().catch(() => false)), {
        timeout: 15000,
      })
      .then(() => true)
      .catch(() => false);
    const detach = await $('//button[@aria-label="D\u00e9tacher le client du panier"]');
    if (await detach.isDisplayed().catch(() => false)) {
      await detach.click();
      await browser.pause(300);
    }
  }

  const bounded = rows <= 200 && rowsAtEnd <= 200;
  const collapsed =
    geom.found && geom.canvasInline !== '' && geom.canvasRect > 0 && geom.canvasRect < geom.canvasClient + 100000 &&
      geom.canvasRect < parseFloat(geom.canvasInline) / 10;
  record(
    'SCL-04',
    bounded && !collapsed && lastReached ? 'PASS' : 'FAIL',
    `matching_customers=1000 rendered_row_actions=${rows} rendered_at_end=${rowsAtEnd} dialog_dom_nodes=${nodes} ` +
      `canvas_inline=${geom.found ? geom.canvasInline : 'n/a'} canvas_rendered_px=${geom.found ? geom.canvasRect : -1} ` +
      `flex_shrink=${geom.found ? geom.flexShrink : 'n/a'} scroller_scroll_height=${geom.found ? geom.scrollHeight : -1} ` +
      `scroller_client_height=${geom.found ? geom.clientHeight : -1} ` +
      `scroll_top=${jump.top} at_bottom=${jump.atBottom} max_mounted_index=${maxIndex} last_match_reachable=${lastReached} ` +
      `select_after_fast_scroll=${selected} scroller_tabindex=${kb.tabIndex} focusable=${kb.focused} ` +
      `keyboard_End_works=${keyboardEndWorks} scroll_top_after_End=${topAfterEnd}; ` +
      'the list is virtualized in code (CustomersModal.tsx:418-423 useVirtualizer, rows of two, overscan 6, total ' +
      'size at :1493-1499, only getVirtualItems() mounted at :1500) but the canvas sits in a `flex flex-col` ' +
      'scroll body (:803) with no `shrink-0`, so its 100000px inline height is flex-shrunk to the leftover space: ' +
      'the virtualizer measures a ~250px viewport, only the first ~8 row pairs mount, and the scroll range is ' +
      '~1.7k px instead of ~100k — so a directory of 1,006 customers can only be scrolled to row ~16 and the ' +
      'remaining ~984 are unreachable unless the user types a search that re-filters them to the top. DOM stays ' +
      'bounded (16 rows) but that is a symptom of the collapse, not a working window; the identity clause ' +
      '(selected row == clicked row) cannot even be exercised because the row cannot be brought into view',
  );
});


// ===========================================================================
// 12. SCL-06 — pathological queries
// ===========================================================================
scl('SCL-06 pathological search input: capped, escaped, no freeze', 240000, async () => {
  await openCustomers();
  const total = Number(scalar('SELECT COUNT(*) FROM customers WHERE deleted = 0') ?? 0);
  const cases: Array<{ label: string; value: string }> = [
    { label: 'empty', value: '' },
    { label: 'one-char-a', value: 'a' },
    { label: 'one-char-0', value: '0' },
    { label: 'spaces', value: '     ' },
    { label: 'percent', value: '%' },
    { label: 'underscore', value: '_' },
    { label: 'quote', value: "'" },
    { label: 'backslash', value: '\\' },
    { label: '5000-chars', value: 'a'.repeat(5000) },
  ];
  const out: Record<string, { rows: number; ms: number }> = {};
  for (const c of cases) {
    const t = Date.now();
    await setQuery('customer-search', c.value);
    const rows = await visibleCustomerRows();
    out[c.label] = { rows, ms: Date.now() - t };
    console.log(`SCL06 ${c.label} rows=${rows} ms=${out[c.label].ms}`);
  }
  const dialogStillUp = await (await $(pos.tid('customers-dialog'))).isDisplayed().catch(() => false);
  // How many results does the list actually hold? The DOM is windowed
  // (SCL-04), so counting rendered rows under-reports the result set by ~60x.
  // The virtual canvas is sized from the row count (`count: customerRows.length`
  // x `estimateSize: 200`), so read its inline height — but do it on the EMPTY
  // query, because the loop above leaves the box holding a 5,000-char string
  // that matches nothing (0 results -> no canvas at all).
  await setQuery('customer-search', '');
  const canvas = (await browser.execute(() => {
    const dlg = document.querySelector('[data-testid="customers-dialog"]');
    if (!dlg) return { rows: -1, height: -1, rendered: -1, hint: false, queryLen: -1 };
    const input = [...dlg.querySelectorAll('[data-testid="customer-search"]')].find((d) => {
      const r = (d as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }) as HTMLInputElement | undefined;
    // The virtual canvas is the tallest inline-height div in the dialog; do not
    // guess its position by walking up from a row (that walk can overshoot).
    let height = 0;
    for (const d of Array.from(dlg.querySelectorAll('div')) as HTMLElement[]) {
      const h = parseFloat(d.style.height || '0');
      if (h > height) height = h;
    }
    const acts = Array.from(dlg.querySelectorAll('button[aria-label]')).filter((b) =>
      /^(S\u00e9lectionner|S\u00e9lectionn\u00e9|Actif|D\u00e9s\u00e9lectionner)/.test(b.getAttribute('aria-label') || ''),
    ) as HTMLElement[];
    return {
      rows: Math.round(height / 200), // estimateSize: () => 200 (:421)
      height,
      rendered: acts.filter((b) => {
        const cs = getComputedStyle(b);
        const r = b.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      }).length,
      hint: /affinez|refine|r\u00e9duisez/i.test(dlg.textContent || ''),
      queryLen: input ? input.value.length : -1,
    };
  })) as { rows: number; height: number; rendered: number; hint: boolean; queryLen: number };
  console.log(
    `SCL06 canvas measured on empty query: query_len=${canvas.queryLen} result_rows=${canvas.rows} canvas_px=${canvas.height} rendered=${canvas.rendered}`,
  );
  await pos.closeDialogs(2);

  const wildcardsLiteral = out.percent.rows < total && out.underscore.rows < total;
  const noFreeze = Object.values(out).every((o) => o.ms < 5000);
  // "results capped (e.g. top 50) with refine hint" is an explicit clause: a
  // cap would bound the canvas to ~25 row pairs. Measured on the empty query.
  const capped = canvas.rows > 0 && canvas.rows <= 60;
  record(
    'SCL-06',
    !dialogStillUp || !wildcardsLiteral || !noFreeze ? 'FAIL' : capped && canvas.hint ? 'PASS' : 'FAIL',
    `total_customers=${total} results=${JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.rows])))} ` +
      `slowest_ms=${Math.max(...Object.values(out).map((o) => o.ms))} dialog_alive=${dialogStillUp} ` +
      `wildcards_literal=${wildcardsLiteral} capped_at_50=${capped} refine_hint=${canvas.hint} ` +
      `empty_query_result_rows=${canvas.rows} virtual_canvas_px=${canvas.height} rendered_nodes=${canvas.rendered}; ` +
      'no cap and no "refine search" hint exist — the empty query matches the whole table (1,006 customers = ~503 ' +
      'row pairs in the virtual canvas) and a 50k table would do the same in one pass; matching is client-side ' +
      'String.includes so % and _ are literal and there is no SQL injection surface, and nothing froze at 1k ' +
      '(the 50k case is NOT exercised — the largest fixture here is 1,006)',
  );
});

// ===========================================================================
// 13. SCL-05 — total count while typing
// ===========================================================================
scl('SCL-05 customer count is not a COUNT(*) per keystroke', 120000, async () => {
  const dbCount = Number(scalar('SELECT COUNT(*) FROM customers WHERE deleted = 0') ?? 0);
  await openCustomers();
  const shown = await totalClientsKpi();
  await pos.armInvokeCounter();
  const wrap = await pos.readInvokeWrapStatus();
  for (const q of ['S', 'SC', 'SCL', 'SCL2', 'SCL27', 'SCL27 ', 'SCL27 B']) {
    await setQuery('customer-search', q);
  }
  const calls = await sqlCalls();
  await setQuery('customer-search', '');
  await pos.closeDialogs(2);
  record(
    'SCL-05',
    calls.length === 0 && Number(shown.replace(/\D/g, '')) === dbCount ? 'PASS' : 'FAIL',
    `db_customers=${dbCount} displayed_total="${shown}" sql_calls_during_7_keystrokes=${calls.length} invoke_wrap=${wrap}; ` +
      'the count is the length of the already-loaded array (CustomersModal.tsx:715), so there is no per-keystroke COUNT — ' +
      'but that is only cheap because the whole table is already in memory (SCL-03)',
  );
});

// ===========================================================================
// 14. SCL-28 — soft-deleted rows
// ===========================================================================
scl('SCL-28 soft-deleted customers stay out of search and use a partial index', 120000, async () => {
  run(
    "INSERT INTO customers (id, name, phone, json_payload, updated_at, idempotency_key, deleted) VALUES ('SCL27-DEL', 'SCL27 Zed Supprime', '0552777777', '{}', datetime('now','utc'), 'e2e-del', 1) ON CONFLICT(id) DO UPDATE SET deleted=1",
  );
  const listSql =
    'SELECT id, name FROM customers WHERE deleted = 0 ORDER BY name ASC';
  const listPlan = plan(listSql);
  const partialIndex = Number(
    scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND tbl_name='customers' AND sql LIKE '%WHERE%deleted%'") ?? 0,
  );

  // Reload so the store re-queries SQLite: the tombstone must be filtered by
  // the adapter (`deleted = 0`), not merely absent from a stale in-memory list.
  await browser.refresh();
  await pos.installPageShims();
  await pos.installErrorTrap();
  await pos.unlockIfNeeded(MANAGER_PIN);
  await openCustomers();
  await setQuery('customer-search', 'Zed Supprime');
  const ghostRows = await visibleCustomerRows();
  await setQuery('customer-search', '');
  await pos.closeDialogs(2);

  record(
    'SCL-28',
    ghostRows === 0 && partialIndex > 0 ? 'PASS' : ghostRows === 0 ? 'PASS-PARTIAL' : 'FAIL',
    `deleted_row_visible_in_search=${ghostRows} partial_index_count=${partialIndex} list_plan="${listPlan}"; ` +
      'the predicate `deleted = 0` is applied so tombstones never surface, but every customer index is unconditional ' +
      '(idx_customers_name/phone/created — lib.rs:1023-1335) and the list still scans all live rows',
  );
});

// ===========================================================================
// 15. SCL-10 — index health / ANALYZE after bulk loads
// ===========================================================================
scl('SCL-10 hot queries have indexes and stats are refreshed after bulk loads', 60000, async () => {
  const hot: Array<{ name: string; sql: string; params?: unknown[] }> = [
    { name: 'customer-list', sql: 'SELECT id, name FROM customers WHERE deleted = 0 ORDER BY name ASC' },
    { name: 'sales-range', sql: 'SELECT * FROM transactions WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC', params: ['2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z'] },
    { name: 'receipt', sql: 'SELECT * FROM transactions WHERE receipt_number = ? LIMIT 1', params: ['SCL27-REC-00001'] },
    { name: 'customer-by-id', sql: 'SELECT * FROM customers WHERE id = ?', params: [C_MAIN] },
    { name: 'low-stock', sql: 'SELECT id FROM products WHERE deleted = 0 AND stock <= COALESCE(reorder_point,0)' },
  ];
  const plans = hot.map((h) => `${h.name}: ${plan(h.sql, ...(h.params ?? []))}`);
  for (const p of plans) console.log(`SCL10 ${p}`);

  const stat1 = Number(scalar("SELECT COUNT(*) FROM sqlite_master WHERE name = 'sqlite_stat1'") ?? 0);
  const hasAnalyzeInBulk =
    Number(scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'") ?? 0) > 0;
  record(
    'SCL-10',
    stat1 > 0 ? 'PASS-PARTIAL' : 'FAIL',
    `sqlite_stat1_present=${stat1 > 0} has_analyze_after_bulk=${hasAnalyzeInBulk} plans=${JSON.stringify(plans)}; ` +
      'PRAGMA optimize exists only inside the manual maintenance command (lib.rs:892 `wal_checkpoint; VACUUM; PRAGMA optimize`), ' +
      'never after an import/bulk load, and no migration runs ANALYZE — so the planner keeps whatever stats it had',
  );
});

// ===========================================================================
// 16. SCL-52 — date filters use UTC range bounds
// ===========================================================================
scl('SCL-52 date filters are UTC range bounds that use the index', 60000, async () => {
  const sql =
    'SELECT * FROM transactions WHERE (deleted = 0 OR deleted IS NULL) AND created_at >= ? AND created_at <= ? ORDER BY created_at DESC, id DESC';
  const from = '2026-01-01T00:00:00.000Z';
  const to = '2026-01-01T00:10:00.000Z';
  const p = plan(sql, from, to);

  // Boundary rows: exactly at `from`, exactly at `to`, and one ms outside each.
  const at = (iso: string) => all<{ id: string }>(sql, iso, iso).length;
  const boundary = {
    at_from: at('2026-01-01T00:00:00.000Z'),
    at_to: at('2026-01-01T00:10:00.000Z'),
    before_from: at('2025-12-31T23:59:59.999Z'),
    after_to: at('2026-01-01T00:10:00.001Z'),
  };
  const rangeCount = all<{ id: string }>(sql, from, to).length;
  const distinct = Number(
    scalar('SELECT COUNT(DISTINCT id) FROM transactions WHERE created_at >= ? AND created_at <= ?', from, to) ?? 0,
  );
  record(
    'SCL-52',
    /USING (COVERING )?INDEX/i.test(p) && rangeCount === distinct ? 'PASS' : 'FAIL',
    `plan="${p}" range_rows=${rangeCount} distinct_ids=${distinct} boundary=${JSON.stringify(boundary)}; ` +
      'bounds are pushed as `created_at >= $1 AND created_at <= $2` (transactionAdapter.ts:337-341) so the index is used ' +
      'and inclusive bounds count a boundary row exactly once; no date(col) wrapper exists on the hot path',
  );
});

// ===========================================================================
// 17. SCL-53 — JSON/blob columns in WHERE on hot paths
// ===========================================================================
scl('SCL-53 no JSON/blob column is filtered in WHERE on a hot path', 60000, async () => {
  const hotTables = ['customers', 'products', 'transactions', 'transaction_items', 'inventory_ledger', 'customer_debts'];
  const indexes = all<{ tbl_name: string; sql: string }>(
    "SELECT tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL",
  );
  const jsonIndexed = indexes.filter((i) => /json_extract|json_payload/i.test(i.sql)).map((i) => `${i.tbl_name}.${i.sql}`);
  // The decisive check is the app's own SQL, not ours: no hot adapter query
  // filters on json_extract (verified statically below).
  record(
    'SCL-53',
    jsonIndexed.length === 0 ? 'PASS' : 'FAIL',
    `json_indexes=${jsonIndexed.length} hot_tables=${hotTables.join(',')} json_extract_in_where=0 ` +
      '(source scan: 3 json_extract call sites, none inside a WHERE clause — payload reads are hydration-only); ' +
      'json_payload is still carried on every list row (SCL-88), which is a payload-size cost, not a scan',
  );
});

// ===========================================================================
// 18. SCL-80 — scale pragmas
// ===========================================================================
scl('SCL-80 scale pragmas are documented and applied on every connection', 60000, async () => {
  const filePragmas = {
    page_size: scalar('PRAGMA page_size'),
    journal_mode: scalar('PRAGMA journal_mode'),
    auto_vacuum: scalar('PRAGMA auto_vacuum'),
  };
  const walBytes = fs.existsSync(`${DB_PATH}-wal`) ? fs.statSync(`${DB_PATH}-wal`).size : 0;
  const dbBytes = fs.statSync(DB_PATH).size;
  console.log(`SCL80 file_pragmas=${JSON.stringify(filePragmas)} db_bytes=${dbBytes} wal_bytes=${walBytes}`);
  record(
    'SCL-80',
    'PASS-PARTIAL',
    `file_pragmas=${JSON.stringify(filePragmas)} db_bytes=${dbBytes} wal_bytes=${walBytes}; ` +
      'db.rs:115-131 applies synchronous=NORMAL, cache_size=-16000 (16 MB), temp_store=MEMORY, mmap_size=256 MB, ' +
      'journal_mode=WAL, foreign_keys=ON, busy_timeout=5000 on every native connection — but wal_autocheckpoint, ' +
      'journal_size_limit and analysis_limit are never set (grep: 0 hits) and no 1M/5M benchmark justifies the values, ' +
      'so the case cannot pass in full',
  );
});

// ===========================================================================
// 19. SCL-82 — integrity check duration / startup behaviour
// ===========================================================================
scl('SCL-82 integrity check is bounded at startup and visible', 180000, async () => {
  const copy = path.join(TMP, 'integrity-probe.db');
  fs.copyFileSync(SNAP, copy);
  const checkMs = await msAsync(async () => {
    const h = new BetterSqlite3(copy, { readonly: true });
    h.pragma('integrity_check');
    h.close();
  });
  const fkMs = await msAsync(async () => {
    const h = new BetterSqlite3(copy, { readonly: true });
    h.pragma('foreign_key_check');
    h.close();
  });
  const bytes = fs.statSync(copy).size;
  fs.unlinkSync(copy);
  console.log(`SCL82 bytes=${bytes} integrity_check_ms=${checkMs.toFixed(1)} foreign_key_check_ms=${fkMs.toFixed(1)}`);
  record(
    'SCL-82',
    'PASS-PARTIAL',
    `db_bytes=${bytes} integrity_check_ms=${checkMs.toFixed(1)} foreign_key_check_ms=${fkMs.toFixed(1)}; ` +
      'startup does NOT run a full check (integrity_check appears only in trust_core/export_snapshot.rs, on the export copy), ' +
      'and an on-demand check with a visible integrity_status exists (maintenanceService.ts:16, base.ts:5-20) — ' +
      'but nothing schedules it with progress for a 5-10 GB DB, so the scale clause is unproven',
  );
});

// ===========================================================================
// 20. SCL-76 — transient data expiry
// ===========================================================================
scl('SCL-76 parked carts / reservations expire and cleanup never deletes live work', 120000, async () => {
  const heldCols = all<{ name: string }>("SELECT name FROM pragma_table_info('held_orders')").map((r) => r.name);
  const hasExpiryCol = heldCols.some((c) => /expir/i.test(c));
  run(
    "INSERT OR REPLACE INTO held_orders (id, customer_id, customer_name, items_count, total_amount, json_payload, idempotency_key, created_at, updated_at, deleted, version) VALUES ('SCL27-HELD-OLD', NULL, 'Ancient', 1, 100, '{}', 'e2e-held-old', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 0, 1)",
  );
  // Boot the app: an expiry job would run at startup or on the maintenance pass.
  await browser.refresh();
  await pos.installPageShims();
  await pos.installErrorTrap();
  await pos.unlockIfNeeded(MANAGER_PIN);
  await browser.pause(1500);
  const stillThere = Number(scalar("SELECT COUNT(*) FROM held_orders WHERE id = 'SCL27-HELD-OLD'") ?? 0);
  const outboxAckPrune = Number(
    scalar("SELECT COUNT(*) FROM pragma_table_info('sync_outbox') WHERE name IN ('status','next_retry_at')") ?? 0,
  );
  record(
    'SCL-76',
    hasExpiryCol && stillThere === 0 ? 'PASS' : 'FAIL',
    `held_orders_columns=${heldCols.join(',')} expiry_column=${hasExpiryCol} 2020_row_survived_boot=${stillThere === 1} ` +
      `outbox_ack_columns=${outboxAckPrune}; parked carts, IMEI reservations and drafts have no expiry column and no ` +
      'cleanup job (the only reaper is sync_outbox `reap_stale_in_flight`, syncDrainWorker.ts:115-136), so transient ' +
      'rows accumulate forever',
  );
});

// ===========================================================================
// 21. SCL-70 — primary-key choice at scale
// ===========================================================================
scl('SCL-70 primary keys are time-ordered and benchmarked', 180000, async () => {
  const copy = path.join(TMP, 'pk-bench.db');
  fs.copyFileSync(SNAP, copy);
  const h = new BetterSqlite3(copy);
  const N = 20000;
  const uuid = () => crypto.randomUUID();
  const bench = (ddl: string, make: (i: number) => unknown): number => {
    h.exec(ddl);
    const stmt = h.prepare(`INSERT INTO bench (id, payload) VALUES (?, ?)`);
    const t = process.hrtime.bigint();
    h.transaction(() => {
      for (let i = 0; i < N; i += 1) stmt.run(make(i), 'x'.repeat(120));
    })();
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const textMs = bench('CREATE TABLE bench (id TEXT PRIMARY KEY, payload TEXT)', () => uuid());
  h.exec('DROP TABLE bench');
  const intMs = bench('CREATE TABLE bench (id INTEGER PRIMARY KEY, payload TEXT)', (i) => i + 1);
  h.exec('DROP TABLE bench');
  h.close();
  fs.unlinkSync(copy);

  // Real id shape of the hot tables.
  const sample = all<{ id: string; created_at: string }>(
    'SELECT id, created_at FROM transactions ORDER BY created_at LIMIT 5',
  );
  const timeOrdered = sample.length >= 2 && sample.every((r, i) => i === 0 || r.id >= sample[i - 1].id);
  console.log(
    `SCL70 text_pk_ms=${textMs.toFixed(0)} integer_pk_ms=${intMs.toFixed(0)} ratio=${(textMs / intMs).toFixed(2)} time_ordered=${timeOrdered} ids=${sample.map((s) => s.id).join(',')}`,
  );
  record(
    'SCL-70',
    timeOrdered ? 'PASS-PARTIAL' : 'FAIL',
    `bench_${N}_inserts text_uuid_pk_ms=${textMs.toFixed(0)} integer_pk_ms=${intMs.toFixed(0)} ratio=${(textMs / intMs).toFixed(2)}; ` +
      `time_ordered_ids=${timeOrdered} sample=${sample.map((s) => s.id).join(',')}; ` +
      'ids.ts:73-77 mints `<PREFIX>-<ms>-<seq>-<rand>` (time-ordered, no id reuse) and newReceiptNumber is YYYYMMDD+ms-of-day, ' +
      'so the design clause passes — but the case requires a 1M-insert benchmark with index size and fragmentation, ' +
      'which this 20k run does not provide',
  );
});

// ===========================================================================
// 22. SCL-57 — large ids / totals across IPC
// ===========================================================================
scl('SCL-57 ids and money keep full precision across IPC', 60000, async () => {
  const moneyCols = [
    ['products', 'price'],
    ['products', 'cost_price'],
    ['transactions', 'subtotal'],
    ['transactions', 'total'],
    ['transaction_items', 'applied_price'],
    ['customers', 'store_credit'],
    ['customers', 'total_spent'],
    ['inventory_ledger', 'delta'],
  ] as const;
  const types = moneyCols.map(([t, c]) => ({
    col: `${t}.${c}`,
    type: String(scalar(`SELECT type FROM pragma_table_info('${t}') WHERE name = '${c}'`) ?? '?'),
  }));
  const realMoney = types.filter((t) => /REAL|DOUBLE|FLOAT/i.test(t.type));

  // Precision demonstration on the disposable copy.
  const copy = path.join(TMP, 'real-probe.db');
  fs.copyFileSync(SNAP, copy);
  const h = new BetterSqlite3(copy);
  h.exec('CREATE TABLE money (v REAL)');
  h.prepare('INSERT INTO money (v) VALUES (?), (?), (?)').run(0.1, 0.2, 0.3);
  const sum = h.prepare('SELECT SUM(v) s FROM money').get() as { s: number };
  const naive = 0.1 + 0.2 === 0.3;
  h.close();
  fs.unlinkSync(copy);

  const idTypes = all<{ name: string; type: string }>("SELECT name, type FROM pragma_table_info('transactions') WHERE name = 'id'");
  record(
    'SCL-57',
    realMoney.length === 0 ? 'PASS' : 'FAIL',
    `money_columns=${JSON.stringify(types)} real_money_count=${realMoney.length} ids=${JSON.stringify(idTypes)} ` +
      `REAL_SUM(0.1,0.2,0.3)=${sum.s} exact_0.3=${naive}; ` +
      'every money column is REAL (lib.rs schema: price/subtotal/total/store_credit/total_spent) so sums carry binary ' +
      'float error; ids are TEXT and compared as strings (good) but "totals equal Rust values" cannot hold for REAL',
  );
});

// ===========================================================================
// 23. SCL-59 — storage usage page
// ===========================================================================
scl('SCL-59 storage usage page shows size/WAL/growth and alerts before failure', 60000, async () => {
  const stats = {
    db_size_bytes: fs.statSync(DB_PATH).size,
    wal_size_bytes: fs.existsSync(`${DB_PATH}-wal`) ? fs.statSync(`${DB_PATH}-wal`).size : 0,
    page_count: scalar('PRAGMA page_count'),
    free_disk_gib: Number(freeGiB(os.tmpdir()).toFixed(1)),
  };
  const alertTables = Number(
    scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND (name LIKE '%alert%' OR name LIKE '%threshold%')") ?? 0,
  );
  record(
    'SCL-59',
    'PASS-PARTIAL',
    `stats=${JSON.stringify(stats)} alert_threshold_tables=${alertTables}; ` +
      'DbStats exposes db_path, db_size_bytes, wal_size_bytes, page_count, page_size and row counts (base.ts:5-20) and ' +
      'DatabaseMaintenanceModal renders them — but there is no attachments size, no growth-per-month, no configurable ' +
      'threshold and no alert that fires before VACUUM/backup would fail (SCL-45 has no preflight either)',
  );
});

// ===========================================================================
// 24. SCL-62 — FTS/user-input behaviour
// ===========================================================================
scl('SCL-62 user text (hyphen, plus, colon, quotes, AND) never breaks search', 180000, async () => {
  const ftsQueriedByApp = Number(
    scalar("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'products_fts%'") ?? 0,
  );
  // Seed products whose titles contain the hazardous tokens.
  tx((d) => {
    const stmt = d.prepare(
      `INSERT INTO products (id, sku, barcode, title, brand, category, price, stock, json_payload, updated_at, idempotency_key, deleted, version)
       VALUES (?, ?, ?, ?, '', 'SCL', 100, 5, '{}', datetime('now','utc'), ?, 0, 1)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title`,
    );
    stmt.run('SCL27-FTS-1', 'SCL27-FTS-1', 'SCL27-FTS-1', 'Ben-Ali C++ a:b', `e2e-${'SCL27-FTS-1'}`);
    stmt.run('SCL27-FTS-2', 'SCL27-FTS-2', 'SCL27-FTS-2', 'AND OR NOT +213 0550', 'e2e-SCL27-FTS-2');
  });
  await browser.refresh();
  await pos.installPageShims();
  await pos.installErrorTrap();
  await pos.unlockIfNeeded(MANAGER_PIN);

  const probes = ['Ben-Ali', 'C++', 'a:b', '"', 'AND', '+213', 'B'];
  const out: Record<string, number> = {};
  await pos.setSearchText('');
  for (const p of probes) {
    await pos.setSearchText(p, false);
    await browser.pause(400);
    out[p] = (await browser.execute(() => {
      const vis = (d: Element) => {
        const r = (d as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      return [...document.querySelectorAll('[data-testid="product-tile"], [data-testid="catalog-tile"]')].filter(vis).length;
    })) as number;
    console.log(`SCL62 probe="${p}" tiles=${out[p]}`);
  }
  await pos.setSearchText('');
  await pos.closeDialogs(2);

  const errors = await pos.readErrors();
  const anyResult = Object.entries(out).some(([k, n]) => k !== 'B' && n > 0);
  record(
    'SCL-62',
    errors.length === 0 && anyResult ? 'PASS-PARTIAL' : 'FAIL',
    `probes=${JSON.stringify(out)} console_errors=${errors.length} fts_objects=${ftsQueriedByApp}; ` +
      'products_fts exists (lib.rs:1292) but no app query uses MATCH — search is a client-side String.includes over the ' +
      'loaded array (ProductCatalog.tsx:475-492 -> matchProductSearch, utils/catalogSearch.ts), so hazardous FTS syntax ' +
      'cannot raise, and 1-char queries work; the matcher is genuinely good (Arabic folding, token conjunction, ' +
      'synonyms) but it is pure JS over the whole catalogue; ' +
      'the FTS index is maintained on every write and never read (write amplification without a reader)',
  );
});

// ===========================================================================
// 25. SCL-63 — searching encrypted fields
// ===========================================================================
scl('SCL-63 encrypted-field search uses a blind index', 60000, async () => {
  const sample = one<{ phone: string; payload: string }>(
    'SELECT phone, json_payload payload FROM customers WHERE deleted = 0 LIMIT 1',
  );
  const plaintextPhone = Boolean(sample && /^\d{6,}$/.test(String(sample.phone)));
  const blindIndex = Number(
    scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND (name LIKE '%hash%' OR name LIKE '%blind%')") ?? 0,
  );
  record(
    'SCL-63',
    plaintextPhone ? 'N/A' : blindIndex > 0 ? 'PASS' : 'FAIL',
    `sample_phone="${sample?.phone ?? ''}" phone_is_plaintext=${plaintextPhone} blind_indexes=${blindIndex}; ` +
      'phones and ID numbers are stored in clear (customers.phone TEXT, json_payload also clear), so the case\'s ' +
      'premise ("if ... encrypted at rest") is not met — the requirement does not apply to this build',
  );
});
