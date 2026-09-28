import { execSync } from 'child_process';
import fs from 'node:fs';

const baseContent = execSync('git cat-file -p 5dfed6deb03f37c29403a3658deae4ecec36e3ac').toString('utf8');
const lines = baseContent.split(/\r?\n/);

const startIdx = lines.findIndex((l) => l.trim() === "const orderSync = 'pending';");
const endMarker = lines.findIndex((l, i) => i > startIdx && l.includes('// 6. Enqueue inventory ledger deltas'));
console.log('Found startIdx at line', startIdx + 1, 'endMarker at line', endMarker + 1);

// Read refactor_atomic_cogs.mjs to get newBlock
const refactorScript = fs.readFileSync('scripts/refactor_atomic_cogs.mjs', 'utf8');
const startNewBlock = refactorScript.indexOf('const newBlock = `') + 'const newBlock = `'.length;
const endNewBlock = refactorScript.lastIndexOf('`;\n\nconst newLines');
const newBlock = refactorScript.slice(startNewBlock, endNewBlock);
console.log('Extracted newBlock length:', newBlock.length);

// Replace in lines
const endIdx = endMarker - 2;
console.log('Replacing from line', startIdx + 1, 'to line', endIdx + 1);
const refactoredLines = [
  ...lines.slice(0, startIdx),
  ...newBlock.split('\n'),
  ...lines.slice(endIdx + 1),
];

let adapterContent = refactoredLines.join('\n');

// Ensure ensureLocalSyncColumns has sale_batch_allocations DDL and ledger_cogs_total column
if (!adapterContent.includes('CREATE TABLE IF NOT EXISTS sale_batch_allocations')) {
  console.log('Adding sale_batch_allocations to ensureLocalSyncColumns...');
  const probeTarget = `await db.select('SELECT version FROM products LIMIT 0;');`;
  const probeReplacement = `await db.select('SELECT version FROM products LIMIT 0;');
    await db.select('SELECT sale_id FROM sale_batch_allocations LIMIT 0;');
    await db.select('SELECT ledger_cogs_total FROM transactions LIMIT 0;');`;
  adapterContent = adapterContent.replace(probeTarget, probeReplacement);

  const ddlTarget = `const statements = [`;
  const ddlStatements = `const statements = [
    \`CREATE TABLE IF NOT EXISTS sale_batch_allocations (
      id TEXT PRIMARY KEY NOT NULL,
      sale_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      qty_consumed INTEGER NOT NULL CHECK (qty_consumed > 0),
      unit_cost_at_sale REAL NOT NULL CHECK (unit_cost_at_sale >= 0),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      product_id TEXT,
      sale_item_id TEXT,
      device_id TEXT NOT NULL DEFAULT 'local',
      idempotency_key TEXT NOT NULL UNIQUE,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      deleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(batch_id) REFERENCES stock_batches(batch_id)
    );\`,
    \`CREATE INDEX IF NOT EXISTS idx_alloc_sale ON sale_batch_allocations(sale_id);\`,
    \`CREATE INDEX IF NOT EXISTS idx_alloc_batch ON sale_batch_allocations(batch_id);\`,
    \`CREATE INDEX IF NOT EXISTS idx_alloc_product ON sale_batch_allocations(product_id);\`,
    'ALTER TABLE transactions ADD COLUMN ledger_cogs_total REAL;',
    'ALTER TABLE transaction_items ADD COLUMN unit_price_charged REAL DEFAULT 0;',
    'ALTER TABLE transaction_items ADD COLUMN unit_cost_at_sale REAL DEFAULT 0;',
    'ALTER TABLE transaction_items ADD COLUMN discount_amount REAL DEFAULT 0;',
    'ALTER TABLE transaction_items ADD COLUMN line_profit REAL DEFAULT 0;',
    'ALTER TABLE stock_batches ADD COLUMN shadow_sale_id TEXT;',
    'ALTER TABLE stock_batches ADD COLUMN shadow_item_id TEXT;',
    'ALTER TABLE stock_batches ADD COLUMN shadow_qty REAL NOT NULL DEFAULT 0;',
    'ALTER TABLE stock_batches ADD COLUMN shadow_resolved INTEGER NOT NULL DEFAULT 0;',`;
  adapterContent = adapterContent.replace(ddlTarget, ddlStatements);
}

// Add remaining helper and FIFO functions
const additionalFunctions = `

function rethrowBusy(e: unknown): never {
  if (isBusyError(e) || isRetryableDbError(e)) throw e;
  throw e;
}

async function linkedTxnIsRefund(saleId: string): Promise<boolean> {
  try {
    const db = await getLocalDb();
    const rows = (await db.select('SELECT json_payload FROM transactions WHERE id = $1', [saleId]).catch(rethrowBusy)) as Array<{ json_payload?: string | null }>;
    if (!rows?.[0]?.json_payload) return false;
    const p = JSON.parse(String(rows[0].json_payload));
    return Boolean(p.isRefund);
  } catch (e) {
    if (isBusyError(e)) throw e;
    return false;
  }
}

async function depleteBatchGuarded(
  db: { select: (sql: string, args?: unknown[]) => Promise<unknown>; execute: (sql: string, args?: unknown[]) => Promise<unknown> },
  batch: { batch_id: unknown },
  want: number,
  ctx: { prodId: string; deviceId: string; now: string; txId: string }
): Promise<{ taken: number; remaining: number }> {
  const upd = await db.execute(
    \`UPDATE stock_batches
     SET quantity_remaining = quantity_remaining - $1,
         version = version + 1,
         updated_at = $2,
         sync_status = 'pending'
     WHERE batch_id = $3 AND quantity_remaining >= $1 AND deleted = 0\`,
    [want, ctx.now, batch.batch_id]
  );
  const rowsAffected = Number((upd as { rowsAffected?: number })?.rowsAffected ?? 0);
  if (rowsAffected === 0) return { taken: 0, remaining: NaN };
  const read = (await db.select('SELECT quantity_remaining, version FROM stock_batches WHERE batch_id = $1', [batch.batch_id]).catch(rethrowBusy)) as Array<{ quantity_remaining?: number; version?: number }>;
  const rem = Number(read?.[0]?.quantity_remaining);
  const ver = Number(read?.[0]?.version ?? 1);
  const outKey = \`sb-\${batch.batch_id}-\${ctx.txId}\`;
  await db.execute(
    \`INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
     VALUES ($1, 'stock_batches', $2, 'UPSERT', $3, 'pending')
     ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4\`,
    [outKey, batch.batch_id, JSON.stringify({ version: ver, batch_id: batch.batch_id, product_id: ctx.prodId, quantity_remaining: rem, updated_at: ctx.now }), ctx.now]
  );
  return { taken: want, remaining: rem };
}

function deterministicAllocationId(saleId: string, itemId: string, batchId: string): string {
  const m = String(itemId ?? '').match(/-item-(\\d+)$/);
  return m ? \`alloc-\${saleId}-\${m[1]}-\${batchId}\` : \`alloc-\${saleId}-\${String(itemId)}-\${batchId}\`;
}

async function dedupeAllocationTwins(
  db: { execute: (sql: string, args?: unknown[]) => Promise<unknown> },
  saleId?: string
): Promise<number> {
  try {
    const keepSubquery = \`EXISTS (
      SELECT 1 FROM sale_batch_allocations AS keep
      WHERE keep.sale_id = sale_batch_allocations.sale_id
        AND keep.batch_id = sale_batch_allocations.batch_id
        AND keep.qty_consumed = sale_batch_allocations.qty_consumed
        AND keep.unit_cost_at_sale = sale_batch_allocations.unit_cost_at_sale
        AND keep.id NOT GLOB 'alloc-*-item-*'
        AND keep.deleted = 0
    )\`;
    const res = saleId
      ? await db.execute(
          \`DELETE FROM sale_batch_allocations
           WHERE id GLOB 'alloc-*-item-*' AND sale_id = $1 AND deleted = 0 AND \${keepSubquery}\`,
          [String(saleId)]
        )
      : await db.execute(
          \`DELETE FROM sale_batch_allocations
           WHERE id GLOB 'alloc-*-item-*' AND deleted = 0 AND \${keepSubquery}\`
        );
    const count = Number((res as { rowsAffected?: number })?.rowsAffected ?? 0);
    return Number.isFinite(count) ? Math.max(0, count) : 0;
  } catch {
    return 0;
  }
}

export async function getAllocationCogsForSale(
  saleId: string
): Promise<{ cogs: number; rowCount: number } | null> {
  try {
    const id = String(saleId ?? '');
    if (!id) return null;
    const db = await getLocalDb();
    const rows = (await db.select(
      \`SELECT COALESCE(SUM(qty_consumed * unit_cost_at_sale), 0) AS cogs,
              COUNT(*) AS n
       FROM sale_batch_allocations
       WHERE (sale_id = $1 OR sale_id IN (SELECT id FROM transactions WHERE receipt_number = $1)) AND deleted = 0\`,
      [id]
    )) as Array<{ cogs: number; n: number }>;
    const n = Math.max(0, Math.floor(Number(rows?.[0]?.n ?? 0)));
    if (!(n > 0)) return null;
    const cogs = Math.round(Number(rows?.[0]?.cogs ?? 0));
    return { cogs: Number.isFinite(cogs) ? Math.max(0, cogs) : 0, rowCount: n };
  } catch {
    return null;
  }
}

export async function backfillSaleAllocationsFromItems(): Promise<number> {
  try {
    const db = await getLocalDb();
    return await backfillSaleAllocationsFromItemsWithDb(db);
  } catch {
    return 0;
  }
}

export async function backfillSaleAllocationsFromItemsWithDb(
  db: Database,
  opts?: { onlyTransactionIds?: string[] }
): Promise<number> {
  try {
    try {
      await db.select('SELECT sale_id FROM sale_batch_allocations LIMIT 0;');
    } catch {
      return 0;
    }
    const onlyIds = [...new Set((opts?.onlyTransactionIds ?? []).map((s) => String(s ?? '')).filter(Boolean))];
    if (onlyIds.length > 0) {
      for (const sid of onlyIds) {
        await dedupeAllocationTwins(db, sid).catch(() => 0);
      }
    } else {
      await dedupeAllocationTwins(db).catch(() => 0);
    }
    const items = (await db.select(
      onlyIds.length > 0
        ? \`SELECT id, transaction_id, product_id, json_payload
           FROM transaction_items WHERE deleted = 0 AND transaction_id IN (\${onlyIds.map(() => '?').join(',')})\`
        : \`SELECT id, transaction_id, product_id, json_payload
           FROM transaction_items WHERE deleted = 0\`,
      onlyIds.length > 0 ? onlyIds : undefined
    )) as Array<{ id: string; transaction_id: string; product_id: string; json_payload?: string | null }>;
    let inserted = 0;
    const deviceId = (await getOrCreateDeviceId(db).catch(() => 'default')) || 'default';
    const now = utcNowIso();
    for (const it of items ?? []) {
      let allocs: Array<{ batchId?: string; quantity?: number; unitCost?: number }> = [];
      try {
        const parsed = JSON.parse(String(it.json_payload ?? '{}')) as {
          fifo_allocations?: Array<{ batchId?: string; quantity?: number; unitCost?: number }>;
        };
        allocs = Array.isArray(parsed.fifo_allocations) ? parsed.fifo_allocations : [];
      } catch {
        allocs = [];
      }
      for (const a of allocs) {
        const bId = a?.batchId ? String(a.batchId) : '';
        const qty = Math.max(0, Math.floor(Number(a?.quantity ?? 0)));
        if (!bId || !(qty > 0)) continue;
        const unitCost = Math.max(0, Math.round(Number(a?.unitCost ?? 0)));
        const allocId = deterministicAllocationId(String(it.transaction_id), String(it.id), bId);
        try {
          await db.execute(
            \`INSERT INTO sale_batch_allocations
               (id, sale_id, batch_id, qty_consumed, unit_cost_at_sale,
                created_at, product_id, sale_item_id,
                device_id, idempotency_key, sync_status, version, updated_at, deleted)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',1,$6,0)
             ON CONFLICT(id) DO NOTHING\`,
            [allocId, String(it.transaction_id), bId, qty, unitCost, now, String(it.product_id ?? ''), String(it.id), deviceId, allocId]
          );
          inserted++;
        } catch (err) {
          if (isBusyError(err)) return inserted;
          continue;
        }
      }
    }
    return inserted;
  } catch {
    return 0;
  }
}

export async function backfillSaleAllocationsForSale(saleId: string): Promise<number> {
  try {
    const id = String(saleId ?? '');
    if (!id) return 0;
    const db = await getLocalDb();
    try {
      await db.select('SELECT sale_id FROM sale_batch_allocations LIMIT 0;');
    } catch {
      return 0;
    }
    const txnRows = (await db.select(
      \`SELECT id FROM transactions WHERE id = $1 OR receipt_number = $1 LIMIT 1\`,
      [id]
    )) as Array<{ id: string }>;
    const resolvedSaleId = txnRows?.[0]?.id || id;
    const items = (await db.select(
      \`SELECT id, transaction_id, product_id, json_payload
       FROM transaction_items WHERE transaction_id = $1 AND deleted = 0\`,
      [resolvedSaleId]
    )) as Array<{ id: string; transaction_id: string; product_id: string; json_payload?: string | null }>;
    if (!items || items.length === 0) return 0;
    await dedupeAllocationTwins(db, resolvedSaleId).catch(() => 0);
    let inserted = 0;
    const deviceId = (await getOrCreateDeviceId(db).catch(() => 'default')) || 'default';
    const now = utcNowIso();
    for (const it of items) {
      let allocs: Array<{ batchId?: string; quantity?: number; unitCost?: number }> = [];
      try {
        const parsed = JSON.parse(String(it.json_payload ?? '{}')) as {
          fifo_allocations?: Array<{ batchId?: string; quantity?: number; unitCost?: number }>;
        };
        allocs = Array.isArray(parsed.fifo_allocations) ? parsed.fifo_allocations : [];
      } catch {
        allocs = [];
      }
      for (const a of allocs) {
        const bId = a?.batchId ? String(a.batchId) : '';
        const qty = Math.max(0, Math.floor(Number(a?.quantity ?? 0)));
        if (!bId || !(qty > 0)) continue;
        const unitCost = Math.max(0, Math.round(Number(a?.unitCost ?? 0)));
        const allocId = deterministicAllocationId(String(it.transaction_id), String(it.id), bId);
        try {
          await db.execute(
            \`INSERT INTO sale_batch_allocations
               (id, sale_id, batch_id, qty_consumed, unit_cost_at_sale,
                created_at, product_id, sale_item_id,
                device_id, idempotency_key, sync_status, version, updated_at, deleted)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',1,$6,0)
             ON CONFLICT(id) DO NOTHING\`,
            [allocId, String(it.transaction_id), bId, qty, unitCost, now, String(it.product_id ?? ''), String(it.id), deviceId, allocId]
          );
          inserted++;
        } catch (err) {
          if (isBusyError(err)) return inserted;
          continue;
        }
      }
    }
    return inserted;
  } catch {
    return 0;
  }
}

export async function repairSaleCogsFromLedger(saleId: string): Promise<{
  repaired: boolean;
  reason: string;
  before: { costTotal: number; profit: number; ledger: number | null } | null;
  after: { costTotal: number; profit: number; ledger: number } | null;
}> {
  const id = String(saleId ?? '');
  if (!id) return { repaired: false, reason: 'empty-id', before: null, after: null };
  let db: Database;
  try {
    db = await getLocalDb();
  } catch {
    return { repaired: false, reason: 'unreachable', before: null, after: null };
  }
  try {
    await db.select('SELECT ledger_cogs_total FROM transactions LIMIT 0;');
  } catch {
    return { repaired: false, reason: 'no-ledger-column', before: null, after: null };
  }
  let useTxn = false;
  try {
    useTxn = await beginImmediate(db, 'repair:ledger-cogs');
  } catch (e) {
    if (isBusyError(e)) return { repaired: false, reason: 'busy', before: null, after: null };
    throw e;
  }
  try {
    const orderRows = (await db.select(
      \`SELECT id, total, cost_total, profit, status, deleted, json_payload, idempotency_key, version,
              ledger_cogs_total
       FROM transactions WHERE id = $1 OR receipt_number = $1 LIMIT 1\`,
      [id]
    ).catch(rethrowBusy)) as Array<Record<string, unknown>>;
    const order = orderRows?.[0];
    if (!order) {
      if (useTxn) await db.execute('ROLLBACK;').catch(() => {});
      return { repaired: false, reason: 'sale-not-found', before: null, after: null };
    }
    const realSaleId = String(order.id ?? id);
    if (Number(order.deleted ?? 0) !== 0) {
      if (useTxn) await db.execute('ROLLBACK;').catch(() => {});
      return { repaired: false, reason: 'sale-deleted', before: null, after: null };
    }
    if (String(order.status ?? '') === 'VOIDED') {
      if (useTxn) await db.execute('ROLLBACK;').catch(() => {});
      return { repaired: false, reason: 'sale-voided', before: null, after: null };
    }
    await getOrCreateDeviceId(db).catch(() => 'default');
    const now = utcNowIso();
    await dedupeAllocationTwins(db, id).catch(() => 0);\n    await dedupeAllocationTwins(db, realSaleId).catch(() => 0);
    const sumRows = (await db.select(
      \`SELECT COALESCE(SUM(qty_consumed * unit_cost_at_sale), 0) AS s, COUNT(*) AS n
       FROM sale_batch_allocations WHERE sale_id = $1 AND deleted = 0\`,
      [realSaleId]
    ).catch(rethrowBusy)) as Array<{ s: number; n: number }>;
    const ledgerSum = Math.max(0, Math.round(Number(sumRows?.[0]?.s ?? 0)));
    const rowCount = Number(sumRows?.[0]?.n ?? 0);
    if (!(rowCount > 0)) {
      if (useTxn) await db.execute('ROLLBACK;').catch(() => {});
      return {
        repaired: false,
        reason: 'no-ledger-rows',
        before: { costTotal: toIntMoney(order.cost_total ?? 0), profit: toIntMoney(order.profit ?? 0), ledger: null },
        after: null,
      };
    }
    const before = {
      costTotal: toIntMoney(order.cost_total ?? 0),
      profit: toIntMoney(order.profit ?? 0),
      ledger: order.ledger_cogs_total === null || order.ledger_cogs_total === undefined ? null : toIntMoney(order.ledger_cogs_total),
    };
    const orderTotal = toIntMoney(order.total ?? 0);
    if (before.ledger === ledgerSum && before.costTotal === ledgerSum) {
      if (useTxn) await db.execute('ROLLBACK;').catch(() => {});
      return { repaired: false, reason: 'already-exact', before, after: null };
    }
    const lineRows = (await db.select(
      \`SELECT id, product_id, quantity, applied_price, unit_price_charged,
              unit_cost_at_sale, discount_amount, line_profit, json_payload,
              idempotency_key, version
       FROM transaction_items WHERE transaction_id = $1 AND deleted = 0
       ORDER BY id\`,
      [realSaleId]
    ).catch(rethrowBusy)) as Array<Record<string, unknown>>;
    const totalAbsQty = (lineRows ?? []).reduce(
      (acc, it) => acc + Math.abs(Math.round(Number(it.quantity ?? 0))),
      0
    );
    const avgCostPerUnit = totalAbsQty > 0 ? ledgerSum / totalAbsQty : 0;
    let newCostTotal = 0;
    const linePatches = new Map<string, { unit: number; profit: number }>();
    for (const line of lineRows ?? []) {
      const lineId = String(line.id ?? '');
      const qty = Math.round(Number(line.quantity ?? 0));
      const charged = toIntMoney(line.unit_price_charged ?? line.applied_price ?? 0);
      let lineAllocUnit: number | null = null;
      try {
        const parsed = JSON.parse(String(line.json_payload ?? '{}')) as {
          fifo_allocations?: Array<{ quantity?: number; unitCost?: number }>;
        };
        const arr = Array.isArray(parsed.fifo_allocations) ? parsed.fifo_allocations : [];
        const aQty = arr.reduce((acc, a) => acc + Math.max(0, Math.floor(Number(a?.quantity ?? 0))), 0);
        const aCost = arr.reduce(
          (acc, a) => acc + Math.max(0, Math.floor(Number(a?.quantity ?? 0))) * Math.max(0, Number(a?.unitCost ?? 0)),
          0
        );
        if (aQty > 0) lineAllocUnit = toIntMoney(aCost / aQty);
      } catch {}
      if (lineAllocUnit === null) lineAllocUnit = toIntMoney(avgCostPerUnit);
      const lineProfit = toIntMoney((charged - lineAllocUnit) * qty);
      newCostTotal += lineAllocUnit * qty;
      linePatches.set(lineId, { unit: lineAllocUnit, profit: lineProfit });
      let patchedLineJson = String(line.json_payload ?? '{}');
      try {
        const parsed = JSON.parse(patchedLineJson);
        parsed.unit_cost_at_sale = lineAllocUnit;
        parsed.unitCostAtSale = lineAllocUnit;
        parsed.unitCostPrice = lineAllocUnit;
        parsed.line_profit = lineProfit;
        parsed.lineProfit = lineProfit;
        patchedLineJson = toBoundedSyncJson(parsed);
      } catch {}
      const lineVersion = (Number(line.version) || 1) + 1;
      await db.execute(
        \`UPDATE transaction_items
         SET unit_cost_at_sale = $1, line_profit = $2, json_payload = $3,
             version = $4, updated_at = $5, sync_status = 'pending'
         WHERE id = $6\`,
        [lineAllocUnit, lineProfit, patchedLineJson, lineVersion, now, lineId]
      );
      const lineKey = String(line.idempotency_key ?? \`repair-\${lineId}\`);
      await db.execute(
        \`INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1, 'order_item', $2, 'UPSERT', $3, 'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4\`,
        [lineKey, lineId, patchedLineJson, now]
      );
    }
    newCostTotal = toIntMoney(newCostTotal);
    const newProfit = orderTotal - newCostTotal;
    const newMargin = orderTotal > 0 && Number.isFinite(newProfit / orderTotal)
      ? Number(((newProfit / orderTotal) * 100).toFixed(1))
      : 0;
    const orderVersion = (Number(order.version) || 1) + 1;
    let patchedReceipt = String(order.json_payload ?? '{}');
    try {
      const parsed = JSON.parse(patchedReceipt);
      parsed.costTotal = newCostTotal;
      parsed.cost_total = newCostTotal;
      parsed.profit = newProfit;
      parsed.profitMargin = newMargin;
      parsed.profit_margin = newMargin;
      parsed.ledgerCogsTotal = ledgerSum;
      parsed.ledger_cogs_total = ledgerSum;
      const itemsArr = parsed.items;
      if (Array.isArray(itemsArr)) {
        for (const [lineId, patch] of linePatches) {
          const m = String(lineId).match(/-item-(\\d+)$/);
          const rawItem = m ? itemsArr[Number(m[1])] : undefined;
          if (rawItem && typeof rawItem === 'object') {
            rawItem.unitCostAtSale = patch.unit;
            rawItem.unitCostPrice = patch.unit;
            rawItem.unit_cost_at_sale = patch.unit;
            rawItem.lineProfit = patch.profit;
            rawItem.line_profit = patch.profit;
          }
        }
      }
      patchedReceipt = toBoundedSyncJson({ ...parsed, version: orderVersion });
    } catch {}
    await db.execute(
      \`UPDATE transactions
       SET cost_total = $1, profit = $2, profit_margin = $3, ledger_cogs_total = $4,
           json_payload = $5, version = $6, updated_at = $7, sync_status = 'pending'
       WHERE id = $8\`,
      [newCostTotal, newProfit, newMargin, ledgerSum, patchedReceipt, orderVersion, now, realSaleId]
    );
    const orderKey = String(order.idempotency_key ?? \`order-\${realSaleId}\`);
    await db.execute(
      \`INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
       VALUES ($1, 'order', $2, 'UPSERT', $3, 'pending')
       ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4\`,
      [orderKey, realSaleId, patchedReceipt, now]
    );
    if (useTxn) await db.execute('COMMIT;');
    const after = { costTotal: newCostTotal, profit: newProfit, ledger: ledgerSum };
    try {
      const { reconstructDexieTransactionsFromSql } = await import('./backfill');
      await reconstructDexieTransactionsFromSql(db, { onlyTransactionIds: [realSaleId] });
    } catch (dexErr) {
      console.warn('[repair:ledger] Dexie mirror refresh skipped:', dexErr);
    }
    try {
      await mirrorSaleAllocationsToDexie(db, [realSaleId]);
    } catch (mirrorErr) {
      console.warn('[repair:ledger] Allocation Dexie mirror skipped:', mirrorErr);
    }
    try {
      const { syncManager } = await import('../sync/SyncManager');
      syncManager.notifyLocalWrite();
    } catch {}
    return { repaired: true, reason: 'repaired', before, after };
  } catch (e) {
    if (useTxn) await db.execute('ROLLBACK;').catch(() => {});
    if (isBusyError(e) || isRetryableDbError(e)) {
      return { repaired: false, reason: 'busy', before: null, after: null };
    }
    throw e;
  }
}

export async function mirrorSaleAllocationsToDexie(db: Database, saleIds?: string[]): Promise<number> {
  try {
    const onlyIds = [...new Set((saleIds ?? []).map((s) => String(s ?? '')).filter(Boolean))];
    const rows = (await db.select(
      \`SELECT id, sale_id, batch_id, qty_consumed, unit_cost_at_sale,
              created_at, product_id, sale_item_id, device_id,
              idempotency_key, sync_status, version, updated_at, deleted
       FROM sale_batch_allocations
       \${onlyIds.length > 0 ? \`WHERE sale_id IN (\${onlyIds.map(() => '?').join(',')})\` : 'WHERE 1 = 1'}\`,
      onlyIds.length > 0 ? onlyIds : undefined
    ).catch(rethrowBusy)) as Array<Record<string, unknown>>;
    if (!rows || rows.length === 0) return 0;
    const { dexieDb } = await import('./database');
    await dexieDb.saleBatchAllocations.bulkPut(
      rows.map((r) => ({
        id: String(r.id),
        saleId: String(r.sale_id),
        batchId: String(r.batch_id),
        qtyConsumed: Math.max(0, Math.floor(Number(r.qty_consumed ?? 0))),
        unitCostAtSale: Math.max(0, Number(r.unit_cost_at_sale ?? 0)),
        createdAt: String(r.created_at ?? ''),
        productId: r.product_id ? String(r.product_id) : undefined,
        saleItemId: r.sale_item_id ? String(r.sale_item_id) : undefined,
        deviceId: r.device_id ? String(r.device_id) : undefined,
        idempotencyKey: r.idempotency_key ? String(r.idempotency_key) : undefined,
        syncStatus: r.sync_status ? (String(r.sync_status) as 'pending' | 'synced') : undefined,
        version: Number(r.version ?? 1),
        updatedAt: r.updated_at ? String(r.updated_at) : undefined,
        deleted: Number(r.deleted ?? 0),
      }))
    );
    return rows.length;
  } catch (err) {
    console.warn('[alloc:mirror] Dexie allocation mirror skipped:', err);
    return 0;
  }
}

export async function mirrorStockBatchesToDexie(db: Database, productIds?: string[]): Promise<number> {
  try {
    const onlyIds = [...new Set((productIds ?? []).map((s) => String(s ?? '')).filter(Boolean))];
    const rows = (await db.select(
      \`SELECT batch_id, product_id, quantity_remaining, unit_cost, received_at,
              purchase_order_id, deleted, updated_at
       FROM stock_batches
       \${onlyIds.length > 0 ? \`WHERE product_id IN (\${onlyIds.map(() => '?').join(',')})\` : 'WHERE 1 = 1'}
         AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')\`,
      onlyIds.length > 0 ? onlyIds : undefined
    ).catch(rethrowBusy)) as Array<Record<string, unknown>>;
    if (!rows || rows.length === 0) return 0;
    const { dexieDb } = await import('./database');
    await dexieDb.stockBatches.bulkPut(
      rows.map((r) => {
        const item: Record<string, unknown> = {
          batchId: String(r.batch_id),
          productId: String(r.product_id),
          quantityRemaining: Math.max(0, Number(r.quantity_remaining ?? 0)),
          unitCost: Math.max(0, Number(r.unit_cost ?? 0)),
          receivedAt: String(r.received_at ?? ''),
          deleted: Number(r.deleted ?? 0),
        };
        if (r.purchase_order_id) item.purchaseOrderId = String(r.purchase_order_id);
        if (r.updated_at) item.updatedAt = String(r.updated_at);
        return item as any;
      })
    );
    return rows.length;
  } catch (err) {
    console.warn('[batches:mirror] Dexie batch mirror skipped:', err);
    return 0;
  }
}

export async function getInventoryValuationTotals(): Promise<{
  units: number;
  costValue: number;
  retailValue: number;
}> {
  const db = await getLocalDb();
  const rows = (await db.select(
    \`SELECT COALESCE(SUM(sb.quantity_remaining), 0) AS units,
            COALESCE(SUM(sb.quantity_remaining * sb.unit_cost), 0) AS cost,
            COALESCE(SUM(sb.quantity_remaining * COALESCE(p.price, 0)), 0) AS retail
     FROM stock_batches sb LEFT JOIN products p ON p.id = sb.product_id
     WHERE sb.deleted = 0 AND sb.quantity_remaining > 0
       AND (sb.purchase_order_id IS NULL OR sb.purchase_order_id != 'SHADOW')\`
  )) as Array<{ units?: number; cost?: number; retail?: number }>;
  const r = rows?.[0];
  const toInt = (val: unknown) => {
    const n = Math.round(Number(val) || 0);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    units: toInt(r?.units),
    costValue: toInt(r?.cost),
    retailValue: toInt(r?.retail),
  };
}

export const SALE_ALLOC_PROFIT_PER_SALE_SQL = \`SELECT
    t.id AS sale_id,
    t.total AS total_revenue,
    COALESCE(
      (SELECT SUM(a.qty_consumed * a.unit_cost_at_sale)
       FROM sale_batch_allocations a
       WHERE a.sale_id = t.id AND a.deleted = 0),
      t.cost_total, 0
    ) AS total_cogs,
    (t.total - COALESCE(
      (SELECT SUM(a.qty_consumed * a.unit_cost_at_sale)
       FROM sale_batch_allocations a
       WHERE a.sale_id = t.id AND a.deleted = 0),
      t.cost_total, 0
    )) AS net_profit
FROM transactions t
WHERE t.deleted = 0 AND COALESCE(t.status, 'COMPLETED') != 'VOIDED'
GROUP BY t.id\`;

export async function getSaleAllocationProfitRows(opts?: {
  saleIds?: string[];
}): Promise<Array<{ saleId: string; totalRevenue: number; totalCogs: number; netProfit: number }>> {
  const db = await getLocalDb();
  const onlyIds = [...new Set((opts?.saleIds ?? []).map((s) => String(s ?? '')).filter(Boolean))];
  const sql = \`
SELECT
    t.id AS sale_id,
    t.total AS total_revenue,
    COALESCE(
      (SELECT SUM(a.qty_consumed * a.unit_cost_at_sale)
       FROM sale_batch_allocations a
       WHERE a.sale_id = t.id AND a.deleted = 0),
      t.cost_total, 0
    ) AS total_cogs,
    (t.total - COALESCE(
      (SELECT SUM(a.qty_consumed * a.unit_cost_at_sale)
       FROM sale_batch_allocations a
       WHERE a.sale_id = t.id AND a.deleted = 0),
      t.cost_total, 0
    )) AS net_profit
FROM transactions t
WHERE t.deleted = 0 AND COALESCE(t.status, 'COMPLETED') != 'VOIDED'
\${onlyIds.length > 0 ? \`AND t.id IN (\${onlyIds.map(() => '?').join(',')})\` : ''}
GROUP BY t.id
\`.trim();
  const rows = (await db.select(sql, onlyIds.length > 0 ? onlyIds : undefined)) as Array<{
    sale_id?: unknown;
    total_revenue?: unknown;
    total_cogs?: unknown;
    net_profit?: unknown;
  }>;
  const toInt = (val: unknown) => {
    const n = Math.round(Number(val) || 0);
    return Number.isFinite(n) ? n : 0;
  };
  return (rows ?? []).map((r) => ({
    saleId: String(r.sale_id),
    totalRevenue: toInt(r.total_revenue),
    totalCogs: toInt(r.total_cogs),
    netProfit: toInt(r.net_profit),
  }));
}

export async function getSalesProfitTotalsFromAllocations(opts?: {
  saleIds?: string[];
}): Promise<{ totalRevenue: number; totalCogs: number; netProfit: number; saleCount: number }> {
  const rows = await getSaleAllocationProfitRows(opts);
  return rows.reduce(
    (acc, r) => ({
      totalRevenue: acc.totalRevenue + r.totalRevenue,
      totalCogs: acc.totalCogs + r.totalCogs,
      netProfit: acc.netProfit + r.netProfit,
      saleCount: acc.saleCount + 1,
    }),
    { totalRevenue: 0, totalCogs: 0, netProfit: 0, saleCount: 0 }
  );
}

const reconciledSaleIds: string[] = [];
const MAX_DRAIN_RECONCILED = 500;

export function drainReconciledSaleIds(): string[] {
  if (reconciledSaleIds.length === 0) return [];
  const snapshot = [...new Set(reconciledSaleIds)];
  reconciledSaleIds.length = 0;
  return snapshot;
}

export async function findNegativeStockProducts(): Promise<Array<{ productId: string; stock: number }>> {
  try {
    const db = await getLocalDb();
    const rows = ((await db
      .select(
        \`SELECT product_id, COALESCE(SUM(delta), 0) AS s FROM inventory_ledger
         WHERE deleted = 0 GROUP BY product_id HAVING s < 0\`
      )
      .catch(() => [])) ?? []) as Array<{ product_id?: string; s?: number }>;
    return rows
      .map((r) => ({
        productId: String(r.product_id ?? ''),
        stock: Math.trunc(Number(r.s ?? 0)),
      }))
      .filter((r) => r.productId && r.stock < 0);
  } catch {
    return [];
  }
}

export async function reconcileShadowBatches(targetProductId?: string): Promise<number> {
  return withWriteLock(async () => {
    const db = await getLocalDb();
    const deviceId = (await getOrCreateDeviceId(db)) || 'default';
    const now = utcNowIso();
    const useTxn = await beginImmediate(db, 'fifo:reconcile');
    let reconciledCount = 0;
    const touchedSaleIds: string[] = [];
    const touchedProductIds = new Set<string>();
    try {
      const shadows = (await db
        .select(
          \`SELECT batch_id, product_id, unit_cost, idempotency_key
           FROM stock_batches
           WHERE purchase_order_id = 'SHADOW' AND deleted = 0 AND shadow_resolved = 0
           \${targetProductId ? 'AND product_id = $1' : ''}
           ORDER BY received_at ASC, batch_id ASC\`,
          targetProductId ? [targetProductId] : undefined
        )
        .catch(rethrowBusy)) as Array<{ batch_id: string; product_id: string; unit_cost: number; idempotency_key: string }>;

      const loadShadowContext = async (
        bId: string
      ): Promise<{ saleId: string; itemId: string; qty: number } | null> => {
        try {
          const rows = (await db
            .select(
              'SELECT shadow_sale_id, shadow_item_id, shadow_qty FROM stock_batches WHERE batch_id = $1',
              [bId]
            )
            .catch(rethrowBusy)) as Array<{
            shadow_sale_id?: string | null;
            shadow_item_id?: string | null;
            shadow_qty?: number | null;
          }>;
          const r = rows?.[0];
          const q = Math.round(Number(r?.shadow_qty ?? 0));
          if (!r?.shadow_sale_id || !r?.shadow_item_id || !(q > 0)) return null;
          return { saleId: String(r.shadow_sale_id), itemId: String(r.shadow_item_id), qty: q };
        } catch (e) {
          if (isBusyError(e)) throw e;
          return null;
        }
      };

      for (const sh of shadows) {
        let step = 'link';
        try {
          const ctx = await loadShadowContext(sh.batch_id);
          if (!ctx) continue;
          const prodId = String(sh.product_id);
          const shadowUnit = Math.max(0, defaultNumber(sh.unit_cost, 0));
          let need = ctx.qty;
          const takes: Array<{ batchId: string; quantity: number; unitCost: number }> = [];
          let takenCost = 0;
          const depCtx = { prodId, deviceId, now, txId: \`recon-\${sh.batch_id}\` };
          const live = (await db
            .select(
              \`SELECT batch_id, quantity_remaining, unit_cost, received_at, purchase_order_id, created_at
               FROM stock_batches
               WHERE product_id = $1 AND quantity_remaining > 0 AND deleted = 0
                 AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
               ORDER BY received_at ASC, batch_id ASC\`,
              [prodId]
            )
            .catch(rethrowBusy)) as Array<{ batch_id: string; quantity_remaining: number; unit_cost: number }>;
          step = 'deplete';
          for (const b of live) {
            if (need <= 0) break;
            const avail = Math.max(0, Math.floor(Number(b.quantity_remaining) || 0));
            const want = Math.min(avail, need);
            if (want <= 0) continue;
            const res = await depleteBatchGuarded(db, { ...b, quantity_remaining: avail }, want, depCtx);
            if (res.taken <= 0) continue;
            need -= res.taken;
            takenCost += res.taken * defaultNumber(b.unit_cost, 0);
            takes.push({ batchId: b.batch_id, quantity: res.taken, unitCost: defaultNumber(b.unit_cost, 0) });
          }
          if (need > 0) continue; // Partial PO cover: leave shadow open

          step = 'read-line';
          const lineRows = (await db
            .select(
              \`SELECT transaction_id, quantity, applied_price, unit_price_charged, unit_cost_at_sale,
                      discount_amount, line_profit, json_payload, idempotency_key, version
               FROM transaction_items WHERE id = $1\`,
              [ctx.itemId]
            )
            .catch(rethrowBusy)) as Array<Record<string, unknown>>;
          const line = lineRows?.[0];
          if (!line) continue;
          const lineQty = Math.max(1, Math.round(Number(line.quantity ?? 1)));
          const charged = defaultNumber(line.unit_price_charged ?? line.applied_price, 0);
          const oldUnit = defaultNumber(line.unit_cost_at_sale, 0);
          const newUnit = toIntMoney((oldUnit * lineQty - shadowUnit * ctx.qty + takenCost) / lineQty);
          const newLineProfit = toIntMoney((charged - newUnit) * lineQty);
          const diffCogs = newUnit * lineQty - oldUnit * lineQty;

          let priorAllocs: Array<{ batchId?: string }> = [];
          try {
            const p = JSON.parse(String(line.json_payload ?? '{}')) as { fifo_allocations?: Array<{ batchId?: string }> };
            priorAllocs = Array.isArray(p.fifo_allocations) ? p.fifo_allocations : [];
          } catch {
            priorAllocs = [];
          }
          const mergedAllocs = [
            ...priorAllocs.filter((a) => a?.batchId !== sh.batch_id && a?.batchId !== 'unbatched'),
            ...takes,
          ];
          const linePayload = toBoundedSyncJson({
            ...JSON.parse(String(line.json_payload ?? '{}')),
            unit_cost_at_sale: newUnit,
            line_profit: newLineProfit,
            fifo_allocations: mergedAllocs,
          });
          const lineKey = String(line.idempotency_key ?? \`recon-\${ctx.itemId}\`);
          const lineVersion = bumpEntityVersionValue(line.version);
          step = 'write-line';
          await db.execute(
            \`UPDATE transaction_items
             SET unit_cost_at_sale = $1, line_profit = $2, json_payload = $3,
                 version = $4, updated_at = $5, sync_status = 'pending'
             WHERE id = $6\`,
            [newUnit, newLineProfit, linePayload, lineVersion, now, ctx.itemId]
          );
          await db.execute(
            \`INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
             VALUES ($1, 'order_item', $2, 'UPSERT', $3, 'pending')
             ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4\`,
            [lineKey, ctx.itemId, linePayload, now]
          );

          step = 'read-order';
          const orderRows = (await db
            .select(
              \`SELECT total, cost_total, profit, json_payload, idempotency_key, version
               FROM transactions WHERE id = $1\`,
              [ctx.saleId]
            )
            .catch(rethrowBusy)) as Array<Record<string, unknown>>;
          const order = orderRows?.[0];
          if (order) {
            const orderTotal = toIntMoney(order.total ?? 0);
            const newCost = toIntMoney(Number(order.cost_total ?? 0) + diffCogs);
            const newProfit = orderTotal - newCost;
            const newMargin = orderTotal > 0 && Number.isFinite(newProfit / orderTotal)
              ? Number(((newProfit / orderTotal) * 100).toFixed(1))
              : 0;
            const orderVersion = bumpEntityVersionValue(order.version);
            let orderPayload: string;
            try {
              const p = JSON.parse(String(order.json_payload ?? '{}'));
              p.costTotal = newCost;
              p.cost_total = newCost;
              p.profit = newProfit;
              p.profitMargin = newMargin;
              p.profit_margin = newMargin;
              const itemsArr = p.items;
              if (Array.isArray(itemsArr)) {
                const m = String(ctx.itemId).match(/-item-(\\d+)$/);
                const rawItem = m ? itemsArr[Number(m[1])] : undefined;
                if (rawItem && typeof rawItem === 'object' && rawItem) {
                  const it = rawItem as Record<string, unknown>;
                  it.unitCostAtSale = newUnit;
                  it.unitCostPrice = newUnit;
                  it.unit_cost_at_sale = newUnit;
                  it.lineProfit = newLineProfit;
                  it.line_profit = newLineProfit;
                }
              }
              orderPayload = toBoundedSyncJson({ ...p, version: orderVersion });
            } catch {
              orderPayload = String(order.json_payload ?? '{}');
            }
            await db.execute(
              \`UPDATE transactions
               SET cost_total = $1, profit = $2, profit_margin = $3, json_payload = $4,
                   version = $5, updated_at = $6, sync_status = 'pending'
               WHERE id = $7\`,
              [newCost, newProfit, newMargin, orderPayload, orderVersion, now, ctx.saleId]
            );
            step = 'enqueue-order';
            const orderKey = (order.idempotency_key as string) ?? \`order-\${ctx.saleId}\`;
            await db.execute(
              \`INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
               VALUES ($1, 'order', $2, 'UPSERT', $3, 'pending')
               ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4\`,
              [orderKey, ctx.saleId, orderPayload, now]
            );
          }

          step = 'tombstone-shadow';
          const shadowVer = bumpEntityVersionValue(
            (await db.select('SELECT version FROM stock_batches WHERE batch_id = $1', [sh.batch_id]).catch(rethrowBusy) as Array<{ version?: number }>)?.[0]?.version
          );
          await db.execute(
            \`UPDATE stock_batches SET deleted = 1, shadow_resolved = 1, version = $1,
              updated_at = $2, sync_status = 'pending' WHERE batch_id = $3\`,
            [shadowVer, now, sh.batch_id]
          );

          step = 'ledger-swap';
          try {
            await db.execute('DELETE FROM sale_batch_allocations WHERE sale_id = $1 AND batch_id = $2', [ctx.saleId, sh.batch_id]);
            for (const t of takes) {
              const q = Math.max(0, Math.floor(Number(t.quantity ?? 0)));
              if (!(q > 0)) continue;
              const aId = \`alloc-\${ctx.saleId}-\${ctx.itemId}-\${String(t.batchId)}-recon\`;
              await db.execute(
                \`INSERT INTO sale_batch_allocations
                   (id, sale_id, batch_id, qty_consumed, unit_cost_at_sale,
                    created_at, product_id, sale_item_id,
                    device_id, idempotency_key, sync_status, version, updated_at, deleted)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',1,$6,0)
                 ON CONFLICT(id) DO NOTHING\`,
                [aId, ctx.saleId, String(t.batchId), q, Math.max(0, toIntMoney(t.unitCost ?? 0)), now, prodId, ctx.itemId, deviceId, aId]
              );
            }
          } catch (swapErr) {
            if (isBusyError(swapErr)) throw swapErr;
            console.warn('[fifo:reconcile] allocation ledger swap skipped:', swapErr);
          }

          step = 'ledger-materialize';
          try {
            const sumRows = (await db.select(
              \`SELECT COALESCE(SUM(qty_consumed * unit_cost_at_sale), 0) AS s
               FROM sale_batch_allocations WHERE sale_id = $1 AND deleted = 0\`,
              [ctx.saleId]
            ).catch(rethrowBusy)) as Array<{ s: number }>;
            const ledgerSum = Math.max(0, Math.round(Number(sumRows?.[0]?.s ?? 0)));
            const orderMeta = (await db.select('SELECT json_payload, idempotency_key, version FROM transactions WHERE id = $1', [ctx.saleId]).catch(rethrowBusy)) as Array<{ json_payload?: string; idempotency_key?: string; version?: number }>;
            const oRow = orderMeta?.[0];
            if (oRow) {
              let pJson = String(oRow.json_payload ?? '{}');
              try {
                const parsed = JSON.parse(pJson);
                parsed.ledgerCogsTotal = ledgerSum;
                parsed.ledger_cogs_total = ledgerSum;
                pJson = toBoundedSyncJson({ ...parsed, version: bumpEntityVersionValue(oRow.version) });
              } catch {}
              await db.execute(
                \`UPDATE transactions SET ledger_cogs_total = $1, json_payload = $2,
                 updated_at = $3, sync_status = 'pending' WHERE id = $4\`,
                [ledgerSum, pJson, now, ctx.saleId]
              );
              const oKey = String(oRow.idempotency_key ?? \`order-\${ctx.saleId}\`);
              await db.execute(
                \`INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
                 VALUES ($1, 'order', $2, 'UPSERT', $3, 'pending')
                 ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4\`,
                [oKey, ctx.saleId, pJson, now]
              );
            }
          } catch (matErr) {
            if (isBusyError(matErr)) throw matErr;
            console.warn('[fifo:reconcile] ledger materialization skipped:', matErr);
          }

          await db.execute(
            \`INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
             VALUES ($1, 'stock_batches', $2, 'UPSERT', $3, 'pending')
             ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4\`,
            [\`sb-\${sh.batch_id}-resolved\`, sh.batch_id, JSON.stringify({
              version: shadowVer, batch_id: sh.batch_id, product_id: prodId, quantity_remaining: 0,
              unit_cost: shadowUnit, updated_at: now, purchase_order_id: 'SHADOW', device_id: deviceId,
              shadow_sale_id: ctx.saleId, shadow_item_id: ctx.itemId, shadow_qty: ctx.qty, shadow_resolved: 1, deleted: 1
            }), now]
          );

          reconciledCount++;
          touchedSaleIds.push(ctx.saleId);
          touchedProductIds.add(prodId);
        } catch (itemErr) {
          if (isBusyError(itemErr)) throw itemErr;
          console.warn('[fifo:reconcile] shadow skipped:', sh?.batch_id, \`stage=\${step}\`, itemErr);
        }
      }
      if (useTxn) await db.execute('COMMIT;');
    } catch (err) {
      if (useTxn) await db.execute('ROLLBACK;').catch(() => {});
      throw err;
    }
    if (reconciledCount > 0) {
      try {
        const { reconstructDexieTransactionsFromSql } = await import('./backfill');
        await reconstructDexieTransactionsFromSql(db, { onlyTransactionIds: touchedSaleIds });
      } catch (dexErr) {
        console.warn('[fifo:reconcile] Dexie mirror refresh skipped:', dexErr);
      }
      for (const id of touchedSaleIds) {
        if (reconciledSaleIds.length >= MAX_DRAIN_RECONCILED) reconciledSaleIds.shift();
        reconciledSaleIds.push(String(id));
      }
      try {
        const pids = [...touchedProductIds];
        if (pids.length > 0) await mirrorStockBatchesToDexie(db, pids);
      } catch (bErr) {
        console.warn('[fifo:reconcile] Batch Dexie mirror skipped:', bErr);
      }
      try {
        const { syncManager } = await import('../sync/SyncManager');
        syncManager.notifyLocalWrite();
      } catch {}
    }
    return reconciledCount;
  });
}

function bumpEntityVersionValue(current: unknown): number {
  const n = Number(current);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) + 1 : 2;
}

export async function appendStocktakeAdjustments(
  adjustments: Array<{ productId: string; countedStock: number; refId: string }>,
  _options?: unknown
): Promise<{ adjusted: number; skippedServices: number }> {
  const clean = (adjustments ?? [])
    .map((a) => ({
      productId: String(a?.productId ?? ''),
      counted: Math.max(0, Math.floor(Number(a?.countedStock ?? NaN))),
      refId: String(a?.refId ?? ''),
    }))
    .filter((a) => a.productId && a.refId && Number.isFinite(a.counted));
  if (clean.length === 0) return { adjusted: 0, skippedServices: 0 };
  const db = await getLocalDb();
  const productIds = [...new Set(clean.map((c) => c.productId))];
  const serviceIds = new Set<string>();
  const productCosts = new Map<string, number>();
  try {
    const prodRows = (await db.select(
      \`SELECT id, category, cost_price FROM products WHERE id IN (\${productIds.map(() => '?').join(',')})\`,
      productIds
    ).catch(rethrowBusy)) as Array<{ id?: string; category?: string; cost_price?: number }>;
    for (const p of prodRows ?? []) {
      const pid = String(p?.id ?? '');
      const cost = Number(p?.cost_price ?? NaN);
      if (Number.isFinite(cost)) productCosts.set(pid, Math.max(0, Math.round(cost)));
      if (pid.startsWith('qt-') || pid.startsWith('prod-misc-') || p?.category === 'Services') {
        serviceIds.add(pid);
      }
    }
  } catch {}
  let adjusted = 0;
  let skippedServices = 0;
  const now = utcNowIso();
  for (const adj of clean) {
    if (serviceIds.has(adj.productId)) {
      skippedServices++;
      continue;
    }
    const currentBatches = await getProductStockBatches(adj.productId);
    const currentQty = currentBatches.reduce((acc, b) => acc + b.quantityRemaining, 0);
    const delta = adj.counted - currentQty;
    if (delta > 0) {
      const cost = productCosts.get(adj.productId) ?? 0;
      await insertStockBatch({
        productId: adj.productId,
        quantityRemaining: delta,
        unitCost: cost,
        purchaseOrderId: \`stocktake-\${adj.refId}\`,
        receivedAt: now,
      });
      adjusted++;
    } else if (delta < 0) {
      let needToRemove = Math.abs(delta);
      for (const b of currentBatches) {
        if (needToRemove <= 0) break;
        const take = Math.min(b.quantityRemaining, needToRemove);
        await db.execute(
          \`UPDATE stock_batches SET quantity_remaining = quantity_remaining - $1,
             version = version + 1, updated_at = $2, sync_status = 'pending'
           WHERE batch_id = $3\`,
          [take, now, b.batchId]
        );
        needToRemove -= take;
      }
      adjusted++;
    }
  }
  return { adjusted, skippedServices };
}

export async function previewFifoLineCosts(
  lines: Array<{ productId: string; qty: number; fallbackCost: number }>
): Promise<Array<{ unitCost: number; fullyCovered: boolean }>> {
  const { previewFifoCostsForLines } = await import('../utils/fifoPreview');
  const db = await getLocalDb();
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const batchesByProduct = new Map<string, Array<{ batchId: string; quantityRemaining: number; unitCost: number }>>();
  for (const pid of productIds) {
    const batches = await getProductStockBatches(pid);
    batchesByProduct.set(pid, batches);
  }
  return previewFifoCostsForLines(batchesByProduct, lines);
}

export async function ensureProductParents(productIds: Iterable<string>): Promise<void> {
  try {
    const list = [...new Set((productIds ? Array.from(productIds) : []).map(p => String(p ?? '')).filter(Boolean))];
    if (list.length === 0) return;
    const db = await getLocalDb();
    const now = utcNowIso();
    for (const p of list) {
      await db.execute(
        \`INSERT OR IGNORE INTO products (id, sku, barcode, title, brand, category, price,
          wholesale_price, cost_price, stock, json_payload, device_id, idempotency_key,
          sync_status, created_at, updated_at, deleted)
         VALUES ($1,'','','', 'Autre','Tous les produits',0, 0,0,0,$2,'local',$3,'pending',$4,$4,0)\`,
        [p, JSON.stringify({ id: p, stub: true }), \`stub-\${p}\`, now]
      ).catch(() => {});
    }
  } catch (e) {
    console.warn('[batches:parents] Product stub bridge skipped:', e);
  }
}
`;

adapterContent += additionalFunctions;

fs.writeFileSync('src/db/sqlPluginAdapter.ts', adapterContent, 'utf8');
console.log('Successfully wrote assembled src/db/sqlPluginAdapter.ts! Lines:', adapterContent.split('\n').length);
