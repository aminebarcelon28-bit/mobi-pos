/**
 * SCL / RCP / TIM / I18 — scale, receipt, clock and numeric-entry edges
 * (batch 23, functional half).
 *
 * Verdict policy is the batch 20–22 policy:
 *   PASS   = observed behaviour satisfies the case, with a real control.
 *   FAIL   = observed behaviour is wrong or a required control is absent;
 *            the assertion states the expected value.
 *   N/A    = the feature does not exist; an executed absence probe is logged.
 *   BLOCKED= exact missing resource logged (kept in Remaining).
 */
import fs from 'node:fs';
import path from 'node:path';
import { $, $$, browser, expect } from '@wdio/globals';
import { all, count, db, one, openDb, run } from '../lib/db';
import { invokeRaw } from '../lib/invoke';
import {
  APP_PIN,
  addSku,
  clearWebMirrors,
  closeDialogs,
  displayedToMinor,
  ensureShiftOpen,
  installErrorTrap,
  payTenderedFlow,
  readOpenShiftDexie,
  selectCustomer,
  tid,
  typeMoneyInto,
  unlockIfNeeded,
} from '../lib/pos';
import { resetData, seedCustomerFull, seedProducts } from '../lib/seed';
import { DB_DIR, DB_PATH, ROOT } from '../lib/env';

const P = 'SCL23-P';
const HOT = 'SCL23-HOT';
const CUST = 'SCL23-C1';

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'target' || ent.name === '.git') continue;
      walkFiles(p, out);
    } else if (/\.(ts|tsx|rs|mjs|cjs)$/.test(ent.name)) {
      out.push(p);
    }
  }
  return out;
}

function grepSrc(pattern: RegExp): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const file of [...walkFiles(path.join(ROOT, 'src')), ...walkFiles(path.join(ROOT, 'src-tauri', 'src'))]) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      if (pattern.test(text)) hits.push({ file: path.relative(ROOT, file), line: i + 1, text: text.trim() });
      pattern.lastIndex = 0;
    });
  }
  return hits;
}

async function tryInvokeRaw<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return await invokeRaw<T>(cmd, args);
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

async function sqlExec(query: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await tryInvokeRaw('plugin:sql|execute', { db: 'sqlite:mobi_pos.db', query, values: [] });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

async function sqlSelect<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const r = await tryInvokeRaw<T[]>('plugin:sql|select', { db: 'sqlite:mobi_pos.db', query, values: [] });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

async function openShiftJs(openingDa: number): Promise<void> {
  await browser.execute(() => {
    (document.querySelector('[data-testid="shift-pill"]') as HTMLElement | null)?.click();
  });
  await (await $(tid('shift-open-dialog'))).waitForDisplayed({ timeout: 20000 });
  await (await $(tid('shift-open-direct'))).click();
  const float = await $(tid('shift-open-float'));
  await float.waitForDisplayed({ timeout: 20000 });
  await typeMoneyInto(float, openingDa);
  await browser.waitUntil(
    async () =>
      displayedToMinor(await (await $(tid('shift-open-total'))).getText()) === BigInt(openingDa) * 100n,
    { timeout: 20000, timeoutMsg: 'shift float did not settle' },
  );
  await (await $(tid('shift-open-confirm'))).click();
  await browser.waitUntil(
    async () => !(await $(tid('shift-open-dialog')).isDisplayed().catch(() => false)),
    { timeout: 40000, timeoutMsg: 'shift dialog did not close' },
  );
}

async function ensureShiftJs(): Promise<void> {
  if (await readOpenShiftDexie()) return;
  await openShiftJs(10000);
}

async function runStress(
  baskets: Array<{ lines: Array<{ id: string; qty: number }>; tenderedDa: number }>,
): Promise<Array<{ ok: boolean; ms: number; reason?: string }>> {
  return (await browser.execute(async (bs: typeof baskets) => {
    const w = window as unknown as {
      __posStress?: {
        runBatch: (
          b: Array<{ lines: Array<{ id: string; qty: number }>; tenderedDa: number }>,
        ) => Promise<Array<{ ok: boolean; ms: number; reason?: string }>>;
      };
    };
    if (!w.__posStress) return [{ ok: false, ms: 0, reason: 'NO_STRESS_HOOK' }];
    return await w.__posStress.runBatch(bs);
  }, baskets)) as Array<{ ok: boolean; ms: number; reason?: string }>;
}

async function clickButtonText(text: string): Promise<boolean> {
  return (await browser.execute((t: string) => {
    const el = Array.from(document.querySelectorAll('button')).find((b) =>
      ((b.textContent || '').trim() || '').includes(t),
    );
    if (!el) return false;
    (el as HTMLElement).click();
    return true;
  }, text)) as boolean;
}

async function waitBodyText(re: RegExp, timeout = 15000): Promise<boolean> {
  try {
    await browser.waitUntil(
      async () => (await browser.execute((s: string) => new RegExp(s).test(document.body.innerText), re.source)) as boolean,
      { timeout, interval: 200 },
    );
    return true;
  } catch {
    return false;
  }
}

async function closeReceipt(): Promise<void> {
  await closeDialogs(3);
}

before(async () => {
  await installErrorTrap();
  // A wiped sandbox has no DB until the app boots and runs its migrations.
  await unlockIfNeeded(APP_PIN);
  resetData();
  seedProducts([
    { id: P, title: 'SCL23 Phone', priceDa: 1000, stock: 100000, barcode: 'SCL23BAR', category: 'Test' },
  ]);
  seedCustomerFull([
    { id: HOT, name: 'SCL Hot Counter', phone: '0550999001', totalSpentDa: 0, loyaltyPointsColumnDa: 0 },
    { id: CUST, name: 'SCL Walk In', phone: '0550999002' },
  ]);
  await clearWebMirrors();
  await unlockIfNeeded(APP_PIN);
  await ensureShiftJs();
});

describe('SCL/RCP/TIM/I18 — batch 23 functional', () => {
  it('[SCL-07] duplicate phone is accepted by the UI and the phone index is non-unique', async () => {
    // Real negative control: create two customers with the same canonical
    // phone through the actual CustomersModal form.
    await (await $(tid('clients-button'))).click();
    await (await $(tid('customers-dialog'))).waitForDisplayed({ timeout: 20000 });
    const add = await clickButtonText('Ajouter un Client');
    expect(add).toBe(true);
    const nameInput = await $('input[data-testid="customer-name"]');
    await nameInput.waitForDisplayed({ timeout: 10000 });
    await nameInput.setValue('SCL Dup Alpha');
    const phone = await $('#customer-phone');
    await phone.setValue('0550111222');
    const create1 = await clickButtonText('Créer le Client');
    expect(create1).toBe(true);
    await browser.pause(500);
    await clickButtonText('Ajouter un Client');
    await (await $('input[data-testid="customer-name"]')).waitForDisplayed({ timeout: 10000 });
    await (await $('input[data-testid="customer-name"]')).setValue('SCL Dup Beta');
    await (await $('#customer-phone')).setValue('0550111222');
    const create2 = await clickButtonText('Créer le Client');
    expect(create2).toBe(true);
    await browser.pause(800);
    await closeDialogs(2);

    const rows = all<{ id: string; name: string; phone: string }>(
      `SELECT id,name,phone FROM customers
       WHERE replace(replace(replace(phone,' ',''),'-',''),'.','') = '0550111222'
       ORDER BY name`,
    );
    const idx = all<{ name: string; sql: string; unique: number }>(
      "SELECT * FROM pragma_index_list('customers') WHERE name='idx_customers_phone'",
    )[0];
    console.log(
      `[SCL-07] duplicateRows=${rows.length} rows=${JSON.stringify(rows.map((r) => [r.name, r.phone]))} ` +
        `idx_customers_phone=${JSON.stringify(idx)} expected=one-wins-or-duplicate-warning`,
    );
    // Expected: at most one row for a canonical phone (or an explicit merge
    // prompt). Actual: both rows persist and the index is non-unique.
    expect(rows.length).toBeLessThanOrEqual(1);
  });

  it('[SCL-26] two sales to one customer update one stored counters row (no sharded/derived counters)', async () => {
    await ensureShiftJs();
    await selectCustomer('SCL Hot Counter');
    const before = one<{ total_spent: number; version: number; updated_at: string }>(
      `SELECT total_spent, version, updated_at FROM customers WHERE id='${HOT}'`,
    );
    const res = await runStress([
      { lines: [{ id: P, qty: 1 }], tenderedDa: 1000 },
      { lines: [{ id: P, qty: 1 }], tenderedDa: 1000 },
    ]);
    await closeReceipt();
    const after = one<{ total_spent: number; version: number; updated_at: string }>(
      `SELECT total_spent, version, updated_at FROM customers WHERE id='${HOT}'`,
    );
    const shardTables = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%counter%' OR name LIKE '%shard%')",
    );
    const customerCols = all<{ name: string }>("SELECT name FROM pragma_table_info('customers')");
    console.log(
      `[SCL-26] sales=${JSON.stringify(res)} before=${JSON.stringify(before)} after=${JSON.stringify(after)} ` +
        `shardTables=${JSON.stringify(shardTables)} storedCounterColumns=${JSON.stringify(
          customerCols.filter((c) => /spent|points|debt/i.test(c.name)).map((c) => c.name),
        )}`,
    );
    // Expected: per-customer hot counters sharded/derived, not one mutable row.
    expect(shardTables.length).toBeGreaterThan(0);
  });

  it('[SCL-14] a long reader blocks checkpointing and the WAL keeps growing (no forgotten-read guard)', async () => {
    await ensureShiftJs();
    const reader = openDb();
    const writer = openDb();
    const wal = `${DB_PATH}-wal`;
    const size = (): number => (fs.existsSync(wal) ? fs.statSync(wal).size : 0);
    const beforeTx = count('transactions');
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT COUNT(*) AS n FROM customers').get();
      const wal0 = size();
      const t0 = Date.now();
      const res = await runStress(
        Array.from({ length: 20 }, () => ({ lines: [{ id: P, qty: 1 }], tenderedDa: 1000 })),
      );
      const saleMs = Date.now() - t0;
      await closeReceipt();
      const wal1 = size();
      // A checkpoint from a second connection while the read transaction is
      // still open: SQLite reports busy=1 and cannot truncate the WAL.
      const cp = writer.pragma('wal_checkpoint(TRUNCATE)') as Array<Record<string, number>>;
      const wal2 = size();
      console.log(
        `[SCL-14] salesOk=${res.filter((r) => r.ok).length}/${res.length} saleMs=${saleMs} ` +
          `walBefore=${wal0} walAfterSales=${wal1} walAfterCheckpoint=${wal2} checkpoint=${JSON.stringify(cp)} ` +
          `txBefore=${beforeTx} txAfter=${count('transactions')}`,
      );
      // Expected: checkpoint not blocked by a forgotten reader (busy=0 and
      // WAL bounded). Actual: busy=1 and the WAL remains until the reader ends.
      expect(Number(cp[0]?.busy ?? -1)).toBe(0);
      expect(wal2).toBeLessThan(1024 * 1024);
    } finally {
      try { reader.exec('ROLLBACK'); } catch { /* no txn */ }
      try { reader.close(); } catch { /* closed */ }
      try { writer.close(); } catch { /* closed */ }
    }
  });

  it('[RCP-04] committed receipt carries ticket id, date/time, cashier, payment line and change', async () => {
    await ensureShiftJs();
    await addSku('SCL23 Phone', { expectTitle: 'SCL23 Phone' });
    await payTenderedFlow(5000);
    // Desktop does not auto-open the receipt modal. The silent print target is
    // the committed receipt that F7/Ctrl+P prints; read its textContent (it is
    // display:none, so innerText would be empty).
    let receiptText = '';
    await browser.waitUntil(
      async () => {
        receiptText = (await browser.execute(
          () => document.querySelector('.print-receipt-target')?.textContent ?? '',
        )) as string;
        return receiptText.length > 50;
      },
      { timeout: 20000, timeoutMsg: 'silent receipt target never rendered' },
    );
    const tx = one<{
      receipt_number: string; total: number; cash_tendered: number; change_due: number;
      payment_method: string; created_at: string;
    }>(
      `SELECT receipt_number,total,cash_tendered,change_due,payment_method,created_at
       FROM transactions WHERE status='COMPLETED' ORDER BY rowid DESC LIMIT 1`,
    );
    const checks = {
      ticketId: receiptText.includes(tx.receipt_number),
      dateTime: /Date\s*\/\s*Heure\s*:/.test(receiptText),
      cashier: /Vendeur\s*:/.test(receiptText),
      paymentLine: /Esp[eè]ces/i.test(receiptText),
      change: /MONNAIE RENDUE/i.test(receiptText) && /4\s?000/.test(receiptText),
      total: /1\s?000/.test(receiptText),
    };
    console.log(
      `[RCP-04] tx=${JSON.stringify(tx)} checks=${JSON.stringify(checks)} ` +
        `receiptHead=${JSON.stringify(receiptText.slice(0, 500))}`,
    );
    // [RULE?] mandatory fields assumed: shop identity, ticket id, date/time,
    // cashier, payment line(s), total and change. Logo/footer are optional.
    expect(Object.values(checks).every(Boolean)).toBe(true);
    await closeReceipt();
  });

  it('[RCP-06] print failure leaves the sale committed but shows no clear user-visible status', async () => {
    await ensureShiftJs();
    await addSku('SCL23 Phone', { expectTitle: 'SCL23 Phone' });
    await payTenderedFlow(1000);
    await browser.waitUntil(
      async () =>
        ((await browser.execute(
          () => (document.querySelector('.print-receipt-target')?.textContent ?? '').length,
        )) as number) > 50,
      { timeout: 20000, timeoutMsg: 'silent receipt target never rendered' },
    );
    const txBefore = one<{ receipt_number: string; n: number }>(
      `SELECT receipt_number, (SELECT COUNT(*) FROM transactions) AS n
       FROM transactions ORDER BY rowid DESC LIMIT 1`,
    );
    // Force the native ESC/POS spooler to fail. The print path catches and
    // console.errors; BottomBar still toasts "envoyée" (success) because it
    // never observes the print result.
    const beforeText = await browser.execute(() => document.body.innerText);
    let clicked = false;
    try {
      await browser.execute(() => {
        const w = window as unknown as {
          __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown> };
          __scl23Invoke?: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>;
        };
        const internals = w.__TAURI_INTERNALS__;
        if (!internals?.invoke) return;
        w.__scl23Invoke = internals.invoke;
        internals.invoke = async (cmd: string, args?: unknown, opts?: unknown) => {
          if (cmd === 'sqlite_print_raw_escpos' || cmd === 'sqlite_open_cash_drawer') {
            throw new Error('SCL23_PRINTER_OFFLINE');
          }
          return w.__scl23Invoke!(cmd, args, opts);
        };
      });
      clicked = (await browser.execute(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) =>
          ((b.textContent || '').trim() || '').includes('Réimprimer'),
        ) as HTMLElement | undefined;
        if (!btn) return false;
        btn.click();
        return true;
      })) as boolean;
      await browser.pause(900);
    } finally {
      await browser.execute(() => {
        const w = window as unknown as {
          __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown> };
          __scl23Invoke?: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>;
        };
        if (w.__scl23Invoke && w.__TAURI_INTERNALS__) w.__TAURI_INTERNALS__.invoke = w.__scl23Invoke;
      });
    }
    const afterText = await browser.execute(() => document.body.innerText);
    const newText = afterText.replace(beforeText, '');
    const successToast = /R[eé]impression du ticket #/i.test(newText);
    const errorVisible = /erreur|impossible|imprimante|hors ligne|[eé]chec/i.test(newText);
    const txAfter = one<{ receipt_number: string; n: number }>(
      `SELECT receipt_number, (SELECT COUNT(*) FROM transactions) AS n
       FROM transactions ORDER BY rowid DESC LIMIT 1`,
    );
    console.log(
      `[RCP-06] clicked=${clicked} txBefore=${JSON.stringify(txBefore)} txAfter=${JSON.stringify(txAfter)} ` +
        `successToast=${successToast} errorVisible=${errorVisible} ` +
        `nativePrintError=console.error(ESC/POS Spooler Error) ` +
        `expected=clear-printer-offline-status-and-reprint`,
    );
    // Sale truth is intact; the missing control is the user-visible failure.
    expect(txAfter.n).toBe(txBefore.n);
    expect(txAfter.receipt_number).toBe(txBefore.receipt_number);
    expect(successToast).toBe(false);
    expect(errorVisible).toBe(true);
  });

  it('[RCP-20] F7 reprint keeps the committed receipt number and creates no second sale', async () => {
    await ensureShiftJs();
    const tx = one<{ id: string; receipt_number: string; n: number }>(
      `SELECT id,receipt_number,(SELECT COUNT(*) FROM transactions) AS n
       FROM transactions WHERE status='COMPLETED' ORDER BY rowid DESC LIMIT 1`,
    );
    await closeReceipt();
    const receiptBefore = (await browser.execute(
      () => document.querySelector('.print-receipt-target')?.textContent ?? '',
    )) as string;
    // Real window keydown so the app's global F7 handler runs (WebDriver's
    // F7 can land on a focused input and be swallowed).
    await browser.execute(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F7', code: 'F7', bubbles: true, cancelable: true }),
      );
    });
    await browser.pause(1200);
    const receiptAfter = (await browser.execute(
      () => document.querySelector('.print-receipt-target')?.textContent ?? '',
    )) as string;
    const txAfter = one<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
    const sameNumber = receiptAfter.includes(tx.receipt_number) && receiptBefore.includes(tx.receipt_number);
    console.log(
      `[RCP-20] committed=${JSON.stringify(tx)} sameNumber=${sameNumber} ` +
        `receiptLengths=${receiptBefore.length}->${receiptAfter.length} txAfter=${txAfter.n} ` +
        `numberAssignedBeforeCommit=true printAfterCommit=true gapPolicy=display-only-no-reuse`,
    );
    expect(sameNumber).toBe(true);
    expect(receiptAfter).toBe(receiptBefore);
    expect(txAfter.n).toBe(tx.n);
  });

  it('[I18-05] Arabic-Indic digits in the tendered field parse to the exact minor amount', async () => {
    await ensureShiftJs();
    await addSku('SCL23 Phone', { expectTitle: 'SCL23 Phone' });
    await (await $(tid('checkout-button'))).click();
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });
    const input = await $(tid('tendered-input'));
    await input.click();
    await browser.keys(['Control', 'a']);
    await browser.keys(['Backspace']);
    try {
      await input.addValue('٥٠٠٠');
    } catch {
      await browser.execute((node: HTMLElement | null, t: string) => {
        if (!node) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        setter?.call(node, t);
        node.dispatchEvent(new Event('input', { bubbles: true }));
      }, input as unknown as HTMLElement, '٥٠٠٠');
    }
    await browser.pause(400);
    const raw = (await input.getValue()) as string;
    const parsed = displayedToMinor(raw);
    const changeText = await (await $(tid('pay-change'))).getText();
    console.log(`[I18-05] input=${JSON.stringify(raw)} parsedMinor=${parsed} change=${JSON.stringify(changeText)}`);
    expect(parsed).toBe(500000n);
    expect(displayedToMinor(changeText)).toBe(400000n);
    await (await $(tid('pay-confirm'))).click();
    await browser.waitUntil(
      async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)),
      { timeout: 45000, timeoutMsg: 'pay dialog did not close' },
    );
    await closeReceipt();
  });

  it('[TIM-01] a backward clock jump in-session produces no warning and no clock audit row', async () => {
    await ensureShiftJs();
    const before = one<{ receipt_number: string; n: number }>(
      `SELECT receipt_number,(SELECT COUNT(*) FROM transactions) AS n
       FROM transactions ORDER BY rowid DESC LIMIT 1`,
    );
    await browser.execute(() => {
      const w = window as unknown as { __scl23DateNow?: () => number };
      w.__scl23DateNow = Date.now;
      Date.now = () => (w.__scl23DateNow as () => number)() - 3600000;
    });
    let res: Array<{ ok: boolean; reason?: string }> = [];
    try {
      res = await runStress([{ lines: [{ id: P, qty: 1 }], tenderedDa: 1000 }]);
    } finally {
      await browser.execute(() => {
        const w = window as unknown as { __scl23DateNow?: () => number };
        if (w.__scl23DateNow) Date.now = w.__scl23DateNow;
      });
    }
    await closeReceipt();
    const after = one<{ receipt_number: string; n: number }>(
      `SELECT receipt_number,(SELECT COUNT(*) FROM transactions) AS n
       FROM transactions ORDER BY rowid DESC LIMIT 1`,
    );
    const clockAudit = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM security_audit_logs
       WHERE lower(COALESCE(action,'') || ' ' || COALESCE(details,'')) LIKE '%clock%'
          OR lower(COALESCE(action,'') || ' ' || COALESCE(details,'')) LIKE '%horloge%'`,
    )!.n;
    const body = await browser.execute(() => document.body.innerText);
    const warningVisible = /horloge|clock|heure syst[eè]me|incoh[eé]rent/i.test(body);
    console.log(
      `[TIM-01] sale=${JSON.stringify(res)} before=${JSON.stringify(before)} after=${JSON.stringify(after)} ` +
        `unique=${after.receipt_number !== before.receipt_number} clockAuditRows=${clockAudit} ` +
        `warningVisible=${warningVisible} expected=visible-warning-and-audit`,
    );
    expect(after.receipt_number).not.toBe(before.receipt_number);
    expect(clockAudit).toBeGreaterThan(0);
    expect(warningVisible).toBe(true);
  });

  it('[SCL-48] 200 rapid sales mint 200 distinct receipt numbers with no counter-table hotspot', async () => {
    await ensureShiftJs();
    const before = count('transactions');
    const baskets = Array.from({ length: 200 }, () => ({
      lines: [{ id: P, qty: 1 }],
      tenderedDa: 1000,
    }));
    const t0 = Date.now();
    const res = await runStress(baskets);
    await closeReceipt();
    const ok = res.filter((r) => r.ok).length;
    const reasons = res.filter((r) => !r.ok).slice(0, 8).map((r) => r.reason ?? '?');
    const rows = all<{ receipt_number: string }>(
      `SELECT receipt_number FROM transactions ORDER BY rowid DESC LIMIT 200`,
    );
    const distinct = new Set(rows.map((r) => r.receipt_number)).size;
    const counterTables = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%counter%'",
    );
    const counterRows = counterTables.length
      ? all<{ name: string; n: number }>(
          counterTables.map((t) => `SELECT '${t.name}' AS name, COUNT(*) AS n FROM "${t.name}"`).join(' UNION ALL '),
        )
      : [];
    console.log(
      `[SCL-48] ok=${ok}/200 ms=${Date.now() - t0} txDelta=${count('transactions') - before} ` +
        `distinct=${distinct}/200 reasons=${JSON.stringify(reasons)} ` +
        `counterTables=${JSON.stringify(counterTables)} counterRows=${JSON.stringify(counterRows)}`,
    );
    expect(ok).toBe(200);
    expect(distinct).toBe(200);
    expect(counterTables.length).toBe(0);
  });

  it('[SCL-58] 5,000-row burst ingest is per-row autocommit, not a chunked transaction', async () => {
    // The pull lane wraps a chunk in a JS write mutex but calls
    // applyRemoteRow per row; each apply is its own SQLite transaction
    // (SyncManager.ts:2378-2404, 2821+). Measure the write amplification on
    // the real schema with the same shape.
    const stamp = Date.now();
    const row = (i: number) => ({
      id: `SCL58-${stamp}-${i}`,
      receipt: `SCL58-${stamp}-${i}`,
      total: 1000,
      created: new Date().toISOString(),
      idem: `scl58-${stamp}-${i}`,
    });
    const insert = db().prepare(
      `INSERT INTO transactions
       (id, receipt_number, subtotal, discount_total, total, cost_total, profit, profit_margin,
        pricing_tier, payment_method, cash_tendered, change_due, status, created_at, json_payload,
        idempotency_key, sync_status, updated_at, deleted, version, is_refund)
       VALUES (@id, @receipt, 1000, 0, @total, 0, 0, 0, 'Retail', 'Espèces', @total, 0,
        'COMPLETED', @created, '{}', @idem, 'pending', @created, 0, 1, 0)`,
    );
    let perRowMs = 0;
    let chunkMs = 0;
    try {
      const t0 = Date.now();
      for (let i = 0; i < 5000; i++) insert.run(row(i));
      perRowMs = Date.now() - t0;
      const t1 = Date.now();
      const tx = db().transaction((rows: ReturnType<typeof row>[]) => {
        for (const r of rows) insert.run(r);
      });
      tx(Array.from({ length: 5000 }, (_, i) => row(5000 + i)));
      chunkMs = Date.now() - t1;
    } finally {
      run(`DELETE FROM transactions WHERE id LIKE 'SCL58-${stamp}-%'`);
    }
    const sourceHits = grepSrc(/applyRemoteRow\(db, table, r\)/);
    console.log(
      `[SCL-58] perRowMs=${perRowMs} chunkedMs=${chunkMs} ratio=${chunkMs ? (perRowMs / chunkMs).toFixed(1) : 'n/a'} ` +
        `sourcePerRowHits=${JSON.stringify(sourceHits.map((h) => `${h.file}:${h.line}`))} ` +
        `expected=chunked-transaction`,
    );
    // Expected: a 5,000-row burst is committed in bounded chunks; actual is
    // 5,000 individual transactions (plus per-row SELECT/Dexie in the real lane).
    expect(perRowMs).toBeLessThan(chunkMs * 2);
  });

  it('[SCL-77] VACUUM keeps data but the cycle-count watermark stores a bare inventory_ledger rowid', async () => {
    const productId = `${P}-VAC`;
    run(
      `INSERT OR REPLACE INTO products
       (id, sku, barcode, title, brand, compatible_model, category, price, wholesale_price, cost_price,
        stock, image_url, json_payload, updated_at, idempotency_key, is_serialized, imei_number, deleted, version)
       VALUES ('${productId}','${productId}','${productId}','SCL VAC','','','Test',100,0,0,10,NULL,'{}',
        datetime('now','utc'),'${productId}',0,NULL,0,1)`,
    );
    const ids = ['SCL77-L1', 'SCL77-L2', 'SCL77-L3', 'SCL77-L4', 'SCL77-L5'];
    for (const id of ids) {
      run(
        `INSERT OR REPLACE INTO inventory_ledger
         (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status,
          created_at, updated_at, deleted, version)
         VALUES ('${id}','${productId}',1,'SALE','test','${id}','e2e','${id}','pending',
          datetime('now','utc'),datetime('now','utc'),0,1)`,
      );
    }
    run("DELETE FROM inventory_ledger WHERE id IN ('SCL77-L2','SCL77-L3','SCL77-L4')");
    const before = all<{ rowid: number; id: string }>(
      `SELECT rowid,id FROM inventory_ledger WHERE product_id='${productId}' ORDER BY rowid`,
    );
    const watermark = one<{ w: number }>(
      `SELECT COALESCE(MAX(rowid),0) AS w FROM inventory_ledger WHERE product_id='${productId}'`,
    ).w;
    run(
      `INSERT OR REPLACE INTO cycle_count_tasks
       (id, product_id, abc_class, due_at, opened_at, opened_ledger_max_id, snapshot_qty,
        counted_qty, expected_qty, counted_at, operator, created_at, updated_at, deleted)
       VALUES ('SCL77-T1','${productId}','A',datetime('now','utc'),datetime('now','utc'),${watermark},10,
        NULL,NULL,NULL,NULL,datetime('now','utc'),datetime('now','utc'),0)`,
    );
    const ftsBefore = (() => {
      try {
        return one<{ n: number }>("SELECT COUNT(*) AS n FROM products_fts WHERE products_fts MATCH 'SCL'").n;
      } catch {
        return -1;
      }
    })();
    const vac = await tryInvokeRaw('sqlite_db_maintenance', { op: 'vacuum' });
    const after = all<{ rowid: number; id: string }>(
      `SELECT rowid,id FROM inventory_ledger WHERE product_id='${productId}' ORDER BY rowid`,
    );
    const watermarkAfter = one<{ w: number }>(
      `SELECT COALESCE(MAX(rowid),0) AS w FROM inventory_ledger WHERE product_id='${productId}'`,
    ).w;
    const ftsAfter = (() => {
      try {
        return one<{ n: number }>("SELECT COUNT(*) AS n FROM products_fts WHERE products_fts MATCH 'SCL'").n;
      } catch {
        return -1;
      }
    })();
    const integrity = one<{ integrity_check: string }>('PRAGMA integrity_check');
    const refs = grepSrc(/rowid/);
    const bare = refs.filter((h) => /cycleCountSql\.ts|schemaHeal\.ts/.test(h.file));
    console.log(
      `[SCL-77] vacuum=${JSON.stringify(vac)} before=${JSON.stringify(before)} after=${JSON.stringify(after)} ` +
        `watermark=${watermark}->${watermarkAfter} fts=${ftsBefore}->${ftsAfter} integrity=${integrity.integrity_check} ` +
        `bareRowidRefs=${JSON.stringify(bare.map((h) => `${h.file}:${h.line}`))} expected=no-bare-rowid-references`,
    );
    expect(integrity.integrity_check).toBe('ok');
    expect(ftsAfter).toBe(ftsBefore);
    // Expected: no code stores a bare rowid as a durable reference. Actual:
    // cycle_count_tasks.opened_ledger_max_id is MAX(rowid) (cycleCountSql.ts:10-31).
    expect(bare.length).toBe(0);
  });

  it('[SCL-78] money columns are dynamically typed: text can be stored in transactions.total', async () => {
    const tables = all<{ name: string; strict: number }>(
      "SELECT name, strict FROM pragma_table_list WHERE name IN ('transactions','customers','products','inventory_ledger')",
    );
    const cols = all<{ name: string; type: string }>(
      "SELECT name,type FROM pragma_table_info('transactions') WHERE name IN ('subtotal','total','cash_tendered','change_due')",
    );
    let typeofTotal = '';
    const probe = db().transaction(() => {
      db().prepare(
        `INSERT INTO transactions
         (id, receipt_number, subtotal, total, status, created_at, json_payload, idempotency_key,
          sync_status, updated_at, deleted, version, is_refund)
         VALUES ('SCL78-T','SCL78-T',0,'not-a-number','COMPLETED',datetime('now','utc'),'{}','SCL78-T',
          'pending',datetime('now','utc'),0,1,0)`,
      ).run();
      typeofTotal = String(
        (db().prepare("SELECT typeof(total) AS t FROM transactions WHERE id='SCL78-T'").get() as { t: string }).t,
      );
      throw new Error('SCL78_ROLLBACK');
    });
    try { probe(); } catch { /* expected rollback */ }
    console.log(
      `[SCL-78] tables=${JSON.stringify(tables)} moneyCols=${JSON.stringify(cols)} ` +
        `typeof(total)=${typeofTotal} strictTables=${tables.filter((t) => t.strict === 1).length} ` +
        `expected=integer-or-REAL-rejected`,
    );
    // Expected: SQLite rejects text in a money column (STRICT or a CHECK).
    // Actual: `text` is stored verbatim in transactions.total.
    expect(typeofTotal).not.toBe('text');
  });

  it('[SCL-79] SQLite feature matrix works, but no startup self-test/version display exists', async () => {
    const version = await sqlSelect<{ v: string }>('SELECT sqlite_version() AS v');
    const opts = await sqlSelect<{ compile_options: string }>('PRAGMA compile_options');
    const json = await sqlSelect<{ v: number }>("SELECT json_extract('{\"a\":1}','$.a') AS v");
    const dbstat = await sqlSelect<{ n: number }>('SELECT COUNT(*) AS n FROM dbstat');
    // The plugin's `select` deliberately rejects INSERT…RETURNING (write
    // statements are not allowed on the read lane), so the feature probe runs
    // on the harness SQLite engine while the app engine version/PRAGMAs are
    // read through the plugin above.
    let strictDb = false;
    let returningDb: { id: number } | null = null;
    let trigramDb = false;
    try {
      db().exec('CREATE TEMP TABLE IF NOT EXISTS scl79_strict_db(id INTEGER PRIMARY KEY) STRICT');
      strictDb = true;
      returningDb = db()
        .prepare('INSERT INTO scl79_strict_db(id) VALUES (1) RETURNING id')
        .get() as { id: number };
    } catch { /* feature absent */ }
    try {
      db().exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.scl79_ft_db USING fts5(x, tokenize='trigram')");
      trigramDb = true;
    } catch { /* feature absent */ }
    // The renderer lane cannot execute DDL once the pool is read-only — that is
    // the flip. The engine's STRICT/RETURNING support is asserted on the host
    // connection above; the app-side probes are diagnostics, so they are
    // reported as skipped rather than attempted (an attempt would just record a
    // refused write with no extra evidence).
    const readOnlyPool = process.env.POS_SQL_QUERY_ONLY === '1';
    const appStrict = readOnlyPool
      ? { ok: false, error: 'skipped: renderer pool is read-only (POS_SQL_QUERY_ONLY=1)' }
      : await sqlExec(
          'CREATE TEMP TABLE IF NOT EXISTS scl79_strict_app(id INTEGER PRIMARY KEY) STRICT',
        );
    const appReturning = readOnlyPool
      ? [{ id: -1, err: 'skipped: renderer pool is read-only' } as unknown as { id: number }]
      : await sqlSelect<{ id: number }>(
          'INSERT INTO scl79_strict_app(id) VALUES (1) RETURNING id',
        ).catch((e) => [{ id: -1, err: String(e) } as unknown as { id: number }]);
    const guard = await tryInvokeRaw<string>('sqlite_check_db_version');
    const selfTest = grepSrc(/sqlite_version|compile_options|feature.?matrix|startup.*self.?test/i);
    console.log(
      `[SCL-79] version=${JSON.stringify(version)} fts5=${opts.some((o) => /FTS5/.test(o.compile_options))} ` +
        `dbstat=${JSON.stringify(dbstat)} json=${JSON.stringify(json)} strictDb=${strictDb} ` +
        `returningDb=${JSON.stringify(returningDb)} trigramDb=${trigramDb} ` +
        `appStrict=${JSON.stringify(appStrict)} appReturning=${JSON.stringify(appReturning)} ` +
        `guard=${JSON.stringify(guard)} startupSelfTestHits=${JSON.stringify(selfTest.map((h) => `${h.file}:${h.line}`))} ` +
        `expected=startup-feature-matrix`,
    );
    expect(version[0]?.v).toMatch(/^3\./);
    expect(opts.some((o) => /FTS5/.test(o.compile_options))).toBe(true);
    expect(dbstat[0]?.n).toBeGreaterThan(0);
    expect(json[0]?.v).toBe(1);
    expect(strictDb).toBe(true);
    expect(returningDb?.id).toBe(1);
    expect(trigramDb).toBe(true);
    expect(guard.ok).toBe(true);
    // Expected: a startup self-test reports the engine/feature matrix. Actual:
    // no such startup path (diagnostics only expose page counts/PRAGMAs).
    expect(selfTest.length).toBeGreaterThan(0);
  });

  it('[SCL-43] N/A — no sales archive exists (repair archive is a different feature)', async () => {
    const archiveTables = all<{ name: string; type: string }>(
      "SELECT name,type FROM sqlite_master WHERE lower(name) LIKE '%archive%' OR lower(name) LIKE '%sales_history%'",
    );
    const archiveSettings = all<{ key: string }>(
      "SELECT key FROM app_settings WHERE lower(key) LIKE '%archive%'",
    );
    const sourceHits = grepSrc(/sales.*archive|archive.*sales|attach.*archive|archive.*database/i);
    console.log(
      `[SCL-43] N/A archiveTables=${JSON.stringify(archiveTables)} archiveSettings=${JSON.stringify(archiveSettings)} ` +
        `sourceHits=${JSON.stringify(sourceHits.map((h) => `${h.file}:${h.line}`))} ` +
        `note=repair archive exists at CommandTicketDashboardModal.tsx:309-312 but is not a sales archive`,
    );
    expect(archiveTables.length).toBe(0);
  });

  it('[SCL-45] backup/VACUUM has no free-disk preflight (emergency export is the only preflight)', async () => {
    const files = [
      'src/db/adapters/maintenanceAdapter.ts',
      'src/db/backupManager.ts',
      'src-tauri/src/lib.rs',
    ];
    const hits: string[] = [];
    for (const f of files) {
      const txt = readSrc(f);
      const re = /statvfs|GetDiskFreeSpace|available_space|free_space|disk_free|fs2::|sysinfo::|StorageManager/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(txt))) {
        const line = txt.slice(0, m.index).split(/\r?\n/).length;
        hits.push(`${f}:${line}:${m[0]}`);
      }
    }
    const backup = await tryInvokeRaw<unknown>('create_database_backup', { kind: 'manual' });
    const exportPreflight = grepSrc(/statvfs|GetDiskFreeSpace/).filter((h) => /export_snapshot\.rs/.test(h.file));
    console.log(
      `[SCL-45] backup=${JSON.stringify(backup)} preflightHitsInBackupOrVacuum=${JSON.stringify(hits)} ` +
        `exportSnapshotPreflight=${JSON.stringify(exportPreflight.map((h) => `${h.file}:${h.line}`))} ` +
        `expected=free-space-check-before-VACUUM/backup`,
    );
    expect(hits.length).toBeGreaterThan(0);
  });

  it('[SCL-46] no SQLite interrupt/cancel control for a running maintenance query', async () => {
    const interruptApi = grepSrc(/sqlite3_interrupt|Connection::interrupt|\.interrupt\(|progress_handler/);
    const modal = readSrc('src/components/modals/DatabaseMaintenanceModal.tsx');
    const cancelControls = (modal.match(/Annuler|Interrompre|Cancel|Stop/g) || []).length;
    const t0 = Date.now();
    // The plugin's read lane rejects WITH RECURSIVE (it only allows a narrow
    // SELECT/VALUES/PRAGMA shape), so the long-query timing runs on the
    // harness SQLite engine; the app-side absence probe is the source search.
    const long = db()
      .prepare(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 2000000) SELECT COUNT(*) AS n FROM c',
      )
      .get() as { n: number };
    const ms = Date.now() - t0;
    console.log(
      `[SCL-46] interruptApi=${JSON.stringify(interruptApi.map((h) => `${h.file}:${h.line}`))} ` +
        `maintenanceModalCloseLabels=${cancelControls} (close, not query cancel) ` +
        `longQueryMs=${ms} rows=${JSON.stringify(long)} expected=sqlite-interrupt`,
    );
    // Expected: a cancel control calls sqlite3_interrupt (or the connection's
    // interrupt) and frees the reader. Actual: no interrupt API exists; the
    // modal's "Annuler" only closes the dialog and the query keeps running.
    expect(interruptApi.length).toBeGreaterThan(0);
  });

  it('[SCL-84] N/A — no attached sales-archive database exists', async () => {
    const dbs = await sqlSelect<{ name: string; file: string }>('PRAGMA database_list');
    const files = fs.existsSync(DB_DIR)
      ? fs.readdirSync(DB_DIR).filter((f) => /archive|sales.*db|\.db$/i.test(f))
      : [];
    const attachHits = grepSrc(/ATTACH\s+DATABASE|attach.*archive/i);
    console.log(
      `[SCL-84] N/A databases=${JSON.stringify(dbs)} dbDirFiles=${JSON.stringify(files)} ` +
        `attachHits=${JSON.stringify(attachHits.map((h) => `${h.file}:${h.line}`))} ` +
        `expected=archive-attached-db`,
    );
    // `PRAGMA database_list` always includes the transient `temp` schema; the
    // absence probe is about a second durable (attached archive) database.
    expect(dbs.filter((d) => d.name !== 'temp').length).toBe(1);
  });
});
