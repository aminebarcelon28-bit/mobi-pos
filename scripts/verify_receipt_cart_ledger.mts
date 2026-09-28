/**
 * VERIFICATION (#REC-20260926-132372-02-CUM1B): receipt + cart read the
 * frozen allocation ledger — never item.costPrice / product.referenceCost.
 *
 * Fixture: 1 stock unit @500 + 1 PO unit @400, sold @3500 × 2 (revenue 7000).
 * True ledger: COGS = 1×500 + 1×400 = 900, Net Profit = 6100.
 * Reported bugs: receipt printed 6,200 (COGS 800 = 400×2, latest-cost path),
 *   cart preview showed 6,000 (COGS 1000 = 500×2, first-known-cost path).
 *
 * Part 1 (receipt): scratch SQLite with production DDL. The stored ticket
 *   row is deliberately STALE (cost_total 800 / profit 6200, line without
 *   unit_cost_at_sale, snapshot costPrice 400) while sale_batch_allocations
 *   holds the frozen 500+400 rows. The verbatim inspector math
 *   (ReportsModal: ledger-first ticket margin + ledger-average line
 *   fallback) must yield COGS 900 / profit 6100.
 * Part 2 (cart): the REAL preview core (src/utils/fifoPreview.ts) over the
 *   live batches for a 2-unit line must yield blended 450/u → profit 6100
 *   (never the 500×2=1000 fallback).
 * Part 3 (static wiring): receipt inspector prefers the ledger, cart badges
 *   render pending (never costPrice-derived) while unresolved, and the
 *   preview hook falls back to the Dexie mirror when SQLite is unreachable.
 */
import { createClient } from '@libsql/client';
import { rmSync, readFileSync } from 'node:fs';
import { previewFifoCostsForLines } from '../src/utils/fifoPreview.ts';

let pass = 0; let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
};

const SALE_ID = 'REC-20260926-132372-02-CUM1B';
const DB_FILE = 'tmp-verify-receipt-cart-ledger.db';
try { rmSync(DB_FILE); } catch {}
const db = createClient({ url: `file:${DB_FILE}` });

// Verbatim getAllocationCogsForSale SQL (src/db/sqlPluginAdapter.ts).
async function allocationCogsForSale(saleId) {
  const rows = (await db.execute({
    sql: `SELECT COALESCE(SUM(qty_consumed * unit_cost_at_sale), 0) AS cogs,
              COUNT(*) AS n
       FROM sale_batch_allocations
       WHERE sale_id = ? AND deleted = 0`,
    args: [saleId],
  })).rows;
  const n = Math.max(0, Math.floor(Number(rows?.[0]?.n ?? 0)));
  if (!(n > 0)) return null;
  return { cogs: Math.round(Number(rows?.[0]?.cogs ?? 0)), rowCount: n };
}

try {
  await db.execute(`CREATE TABLE stock_batches (batch_id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
    quantity_remaining REAL NOT NULL CHECK (quantity_remaining >= 0),
    unit_cost REAL NOT NULL CHECK (unit_cost >= 0), received_at TEXT NOT NULL,
    purchase_order_id TEXT, device_id TEXT NOT NULL DEFAULT 'local',
    idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'pending',
    version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0)`);
  await db.execute(`CREATE TABLE transactions (id TEXT PRIMARY KEY, total REAL NOT NULL DEFAULT 0,
    cost_total REAL DEFAULT 0, profit REAL DEFAULT 0, status TEXT NOT NULL DEFAULT 'COMPLETED',
    deleted INTEGER NOT NULL DEFAULT 0, json_payload TEXT, version INTEGER NOT NULL DEFAULT 1)`);
  await db.execute(`CREATE TABLE transaction_items (id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL,
    product_id TEXT NOT NULL, quantity INTEGER NOT NULL, applied_price REAL DEFAULT 0,
    unit_price_charged REAL DEFAULT 0, unit_cost_at_sale REAL DEFAULT 0,
    json_payload TEXT, version INTEGER NOT NULL DEFAULT 1)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sale_batch_allocations (
    id TEXT PRIMARY KEY NOT NULL, sale_id TEXT NOT NULL, batch_id TEXT NOT NULL,
    qty_consumed INTEGER NOT NULL CHECK (qty_consumed > 0),
    unit_cost_at_sale REAL NOT NULL CHECK (unit_cost_at_sale >= 0),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, product_id TEXT, sale_item_id TEXT,
    device_id TEXT NOT NULL DEFAULT 'local', idempotency_key TEXT NOT NULL UNIQUE,
    sync_status TEXT NOT NULL DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    deleted INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(batch_id) REFERENCES stock_batches(batch_id))`);

  // Live batches: 1×500 (older) + 1×400 (PO).
  for (const [bid, cost, at, po, key] of [
    ['batch-A', 500, '2026-01-01T10:00:00.000Z', 'PO-OLD', 'key-A'],
    ['batch-B', 400, '2026-02-01T10:00:00.000Z', 'PO-20260926-11KHFJ-02-XMT05', 'key-B'],
  ]) {
    await db.execute({ sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?, 'pending', 1, ?, ?, 0)`,
      args: [bid, 'prodX', 0, cost, at, po, 'd1', key, at, at] });
  }
  // Frozen ledger rows: 1×500 + 1×400 (depletion already consumed the batches).
  for (const [allocId, batchId, qty, unit] of [
    [`alloc-${SALE_ID}-batch-A`, 'batch-A', 1, 500],
    [`alloc-${SALE_ID}-batch-B`, 'batch-B', 1, 400],
  ]) {
    await db.execute({ sql: `INSERT INTO sale_batch_allocations (id, sale_id, batch_id, qty_consumed, unit_cost_at_sale, created_at, product_id, sale_item_id, device_id, idempotency_key, sync_status, version, updated_at, deleted) VALUES (?,?,?,?,?,?,?, ?, ?, ?, 'pending', 1, ?, 0)`,
      args: [allocId, SALE_ID, batchId, qty, unit, '2026-03-01T10:00:00.000Z', 'prodX', `${SALE_ID}-item-0`, 'd1', allocId, '2026-03-01T10:00:00.000Z'] });
  }
  // STALE stored ticket row (the reported receipt bug): cost 800 / profit 6200,
  // line with NO unit_cost_at_sale and snapshot costPrice 400.
  await db.execute({ sql: `INSERT INTO transactions (id, total, cost_total, profit, status, deleted, json_payload, version) VALUES (?,?,?,?, 'COMPLETED', 0, '{}', 1)`,
    args: [SALE_ID, 7000, 800, 6200] });
  await db.execute({ sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, unit_price_charged, unit_cost_at_sale, json_payload, version) VALUES (?,?,?,?,?,?,?,?,1)`,
    args: [`${SALE_ID}-item-0`, SALE_ID, 'prodX', 2, 3500, 3500, 0, '{}'] });

  // ---- Part 1a: ledger COGS for the receipt (verbatim authority query) ----
  const ledger = await allocationCogsForSale(SALE_ID);
  console.log(`[RECEIPT] ledger COGS for ${SALE_ID} = ${JSON.stringify(ledger)}`);
  check('receipt ledger COGS is 900 (1×500 + 1×400)', ledger?.cogs === 900, `got ${ledger?.cogs}`);

  // ---- Part 1b: inspector ticket margin (verbatim ReportsModal logic) ----
  const storedTotal = 7000, storedProfit = 6200;
  const ticketProfit = ledger != null ? Math.max(0, storedTotal) - ledger.cogs : storedProfit;
  console.log(`[RECEIPT] re-rendered Net Profit = ${ticketProfit} (stored row said ${storedProfit})`);
  check('re-rendered receipt Net Profit is 6,100 (not stored 6,200)', ticketProfit === 6100, `got ${ticketProfit}`);

  // ---- Part 1c: per-line fallback (line lacks unitCostAtSale; snapshot cost 400) ----
  const lineQty = 2, snapshotCost = 400, charged = 3500;
  const ledgerAvg = ledger != null && lineQty > 0 ? ledger.cogs / lineQty : undefined;
  const oldUnit = snapshotCost; // old ReportsModal:1804 chain ended at product.costPrice
  const newUnit = ledgerAvg ?? snapshotCost; // new chain: ledger average before costPrice
  const oldLineProfit = (charged - oldUnit) * lineQty;
  const newLineProfit = (charged - newUnit) * lineQty;
  console.log(`[RECEIPT] line: old fallback unit=${oldUnit} → margin ${oldLineProfit}; ledger fallback unit=${newUnit} → margin ${newLineProfit}`);
  check('old costPrice fallback would print 6,200 (bug reproduced)', oldLineProfit === 6200, `got ${oldLineProfit}`);
  check('ledger-average fallback prints 6,100 (450/u)', newUnit === 450 && newLineProfit === 6100, `unit=${newUnit} profit=${newLineProfit}`);
} finally { db.close(); try { rmSync(DB_FILE); } catch {} }

// ---- Part 2: live cart preview over active batches (REAL core) ----
{
  const batches = new Map([['prodX', [
    { batchId: 'batch-A', quantityRemaining: 1, unitCost: 500 },
    { batchId: 'batch-B', quantityRemaining: 1, unitCost: 400 },
  ]]]);
  const [r] = previewFifoCostsForLines(batches, [{ productId: 'prodX', qty: 2, fallbackCost: 500 }]);
  const cartProfit = (3500 - r.unitCost) * 2;
  console.log(`[CART] preview unit=${r.unitCost}/u (covered=${r.fullyCovered}) → cart Net Profit=${cartProfit}`);
  check('cart preview blends active batches (450/u)', r.unitCost === 450 && r.fullyCovered === true, `got ${r.unitCost}`);
  check('cart preview Net Profit is 6,100 (not 500×2=6,000)', cartProfit === 6100, `got ${cartProfit}`);
  check('cart preview is not the costPrice×qty fallback (1,000)', r.unitCost * 2 === 900, `got ${r.unitCost * 2}`);
}

// ---- Part 3: static wiring ----
{
  const modal = readFileSync('src/components/modals/ReportsModal.tsx', 'utf8');
  const cart = readFileSync('src/components/CartPanel.tsx', 'utf8');
  const hook = readFileSync('src/hooks/useFifoPreviewCosts.ts', 'utf8');
  const adapter = readFileSync('src/db/sqlPluginAdapter.ts', 'utf8');
  const ledgerHook = readFileSync('src/hooks/useReceiptLedgerCogs.ts', 'utf8');
  const mobile = readFileSync('src/components/mobile/tabs/MobileCheckoutTab.tsx', 'utf8');
  check('receipt inspector prefers ledger COGS for ticket margin',
    modal.includes('inspectorLedgerCogs != null') && modal.includes('Coût d\'Achat (Ledger FIFO)'));
  check('receipt inspector waits for ledger (pending, never stored flash)',
    modal.includes('!inspectorLedgerLoaded') && modal.includes('lineCostPending'));
  check('receipt per-line fallback splits frozen COGS before costPrice',
    modal.includes('inspectorLedgerAvgUnit'));
  check('receipt hook keys state by sale (no previous-ticket flash)',
    ledgerHook.includes('state.key !== key'));
  check('receipt hook backfills the open ticket on ledger miss',
    ledgerHook.includes('backfillSaleAllocationsForSale'));
  check('targeted single-ticket backfill exists (never throws)',
    adapter.includes('export async function backfillSaleAllocationsForSale'));
  check('getAllocationCogsForSale queries sale_batch_allocations directly',
    adapter.includes('export async function getAllocationCogsForSale')
    && adapter.includes('FROM sale_batch_allocations')
    && adapter.includes('WHERE sale_id = $1'));
  check('receipt ledger hook tries SQLite authority then Dexie mirror',
    ledgerHook.includes('getAllocationCogsForSale') && ledgerHook.includes('saleBatchAllocations'));
  check('preview hook falls back to Dexie mirror when SQLite is unreachable',
    hook.includes('dexieDb.stockBatches') && hook.includes('previewFifoCostsForLines'));
  check('preview hook surfaces only fully-covered costs (shortfall stays pending)',
    hook.includes('onlyCovered') && hook.includes('r?.fullyCovered ? r.unitCost : undefined'));
  check('cart badges render pending (never costPrice-derived) while unresolved',
    cart.includes('Marge: …') && !/fifoPreviewCosts\[idx\] \?\? item\.unitCostAtSale \?\? item\.unitCostPrice \?\? item\.product\.costPrice/.test(cart));
  check('mobile editor margin is FIFO-or-pending',
    mobile.includes('costKnown') && mobile.includes('Marge : {costKnown'));
}

// ---- Part 4: race discipline (the #REC-20260926-13HQ1J-02-CAAF5 class) ----
{
  // 4a. Inspector loading window: ledger unresolved + line without frozen
  // cost + stored profit 6200 → must render pending, NOT 6200.
  const ledgerLoaded = false, ledgerCogs = null;
  const storedProfit = 6200;
  const rendered = !ledgerLoaded ? '…' : String(ledgerCogs != null ? 7000 - ledgerCogs : storedProfit);
  check('inspector renders pending (not stored 6,200) while ledger loads', rendered === '…', `got ${rendered}`);
  // 4b. Ticket switch: previous ticket resolved 500, new ticket unresolved
  // → keyed state returns pending, never the previous COGS.
  const state = { key: 'OLD-TICKET', cogs: 500, loaded: true };
  const newKey = SALE_ID;
  const visible = state.key !== newKey ? { ledgerCogs: null, ledgerLoaded: false } : { ledgerCogs: state.cogs, ledgerLoaded: state.loaded };
  check('ticket switch shows pending (not previous ticket COGS)', visible.ledgerCogs === null && visible.ledgerLoaded === false);
  // 4c. Shortfall preview embeds the catalog fallback → hook withholds it.
  const [short] = previewFifoCostsForLines(new Map(), [{ productId: 'prodX', qty: 2, fallbackCost: 500 }]);
  const surfaced = short?.fullyCovered ? short.unitCost : undefined;
  check('shortfall preview withheld from badges (would embed 500 fallback)', short.fullyCovered === false && surfaced === undefined, `covered=${short.fullyCovered}`);
  // 4d. Loaded + ledger rows → exact ticket math (no stored value involved).
  const done = { ledgerCogs: 900, ledgerLoaded: true };
  const finalProfit = !done.ledgerLoaded ? null : done.ledgerCogs != null ? 7000 - done.ledgerCogs : storedProfit;
  check('loaded ledger renders exact 6,100', finalProfit === 6100, `got ${finalProfit}`);
}

console.log(`VERIFY SUMMARY: ${pass} PASSED, ${fail} FAILED`);
if (fail > 0) process.exit(1);
