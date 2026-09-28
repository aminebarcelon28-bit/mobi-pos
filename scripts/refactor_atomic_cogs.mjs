import fs from 'node:fs';

const filePath = 'src/db/sqlPluginAdapter.ts';
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\r\n');

// Find start line: "    const orderSync = 'pending';"
const startIdx = lines.findIndex((l, i) => i > 1240 && i < 1260 && l.trim() === "const orderSync = 'pending';");
if (startIdx === -1) {
  console.error('Start line not found');
  process.exit(1);
}
console.log('Found startIdx at line', startIdx + 1);

// Find end marker: "// 6. Enqueue inventory ledger deltas"
const endMarker = lines.findIndex((l, i) => i > startIdx && l.includes('// 6. Enqueue inventory ledger deltas'));
if (endMarker === -1) {
  console.error('End marker not found');
  process.exit(1);
}
console.log('Found endMarker at line', endMarker + 1);

// Check lines right before endMarker
// line endMarker - 2 is "    }"
console.log('line at endMarker - 2:', lines[endMarker - 2]);
const endIdx = endMarker - 2;

const newBlock = `    const orderSync = 'pending';

    // 1. Resolve FIFO batch depletions and freeze sale_batch_allocations BEFORE
    // inserting transactions or transaction_items.
    // FIFO authority (single source of truth for COGS): for SALE receipts the
    // per-line unit cost MUST come from FIFO batch depletion resolved here,
    // inside the same SQLite write transaction — never from the caller's
    // catalog snapshot (costPrice / 50%-of-price estimate), which varies per
    // device and would make margin/profit diverge between Desktop and Mobile
    // for the same physical stock. Refund/voucher receipts (isRefund) carry
    // no COGS: depletion is skipped so a refund can never phantom-deplete
    // the oldest batch (restitution owns the stock movement via deltas).
    const fullTxKind = (input.fullTx ?? {}) as Record<string, unknown>;
    const isRefundReceipt = Boolean(fullTxKind.isRefund);
    let fifoCostTotalAccum = 0;
    let fifoResolvedAny = false;
    let allocLedgerTotal = 0;
    let allocLedgerAvailable = true;
    let preAllocSum = 0;

    const terminalProductIds = new Set<string>();
    for (const s of (input.productSnapshots ?? []) as Array<{ id?: unknown; category?: unknown }>) {
      const sid = String(s?.id ?? '');
      if (!sid) continue;
      const category = String(s?.category ?? '');
      if (
        sid.startsWith('qt-') ||
        sid.startsWith('prod-misc-') ||
        sid.startsWith('prod-trade') ||
        category === 'Services' ||
        category === "Téléphones d'Occasion (Reprise)"
      ) {
        terminalProductIds.add(sid);
      }
    }

    let hasReturnLines = false;
    try {
      const pre = (await db
        .select(
          \`SELECT COALESCE(SUM(qty_consumed * unit_cost_at_sale), 0) AS s
           FROM sale_batch_allocations WHERE sale_id = $1 AND deleted = 0\`,
          [txId],
        )
        .catch(rethrowBusy)) as Array<{ s: number }>;
      preAllocSum = Math.max(0, Math.round(Number(pre?.[0]?.s ?? 0)));
    } catch (e) {
      if (isBusyError(e)) throw e;
      preAllocSum = 0;
    }

    type PreparedItem = {
      itemId: string;
      itemKey: string;
      prodId: string;
      qtySold: number;
      appliedPrice: number;
      discount: number;
      imeiNum: string;
      fallbackCost: number;
      unitPriceCharged: number;
      unitCostAtSale: number;
      discountAmount: number;
      lineProfit: number;
      enrichedPayload: string;
      isReturnLine: boolean;
      rawItem: Record<string, unknown>;
    };
    const preparedItems: PreparedItem[] = [];

    for (const [idx, it] of input.items.entries()) {
      const itemId = String(it.id || \`\${txId}-item-\${idx}\`);
      const prodId = String(it.product_id || it.productId || 'unknown');
      const itemKey = String(it.idempotency_key || \`\${txId}-itemkey-\${idx}\`);

      const qtySold = Number(it.quantity ?? 1);
      const appliedPrice = Number(it.applied_price ?? it.appliedPrice ?? 0);
      const unitPriceCharged = Number(it.unit_price_charged ?? it.unitPriceCharged ?? appliedPrice);
      const defaultPrice = Number(it.default_price ?? it.defaultPrice ?? (it.applied_price ?? it.appliedPrice ?? 0));
      const discountAmount = Number(it.discount_amount ?? it.discountAmount ?? Math.max(0, defaultPrice - unitPriceCharged));
      const fallbackCost = Number(it.cost_price ?? it.costPrice ?? 0);

      let blendedUnitCost = fallbackCost;
      let fifoAuthoritativeCost: number | null = null;
      const fifoAllocations: Array<{ batchId: string; quantity: number; unitCost: number }> = [];
      const isReturnLine = Boolean(it.is_return ?? it.isReturn);
      const isTerminalLine =
        terminalProductIds.has(prodId) ||
        prodId.startsWith('qt-') ||
        prodId.startsWith('prod-misc-') ||
        prodId.startsWith('prod-trade');
      if (isReturnLine) hasReturnLines = true;

      if (!isRefundReceipt && isReturnLine) {
        try {
          const lineQty = Math.abs(Math.round(Number(qtySold) || 0));
          const lineCost = toIntMoney(fallbackCost);
          if (lineQty > 0) {
            const earliest = (await db
              .select(
                \`SELECT batch_id, quantity_remaining, unit_cost, received_at, purchase_order_id, created_at
                 FROM stock_batches
                 WHERE product_id = $1 AND quantity_remaining > 0 AND deleted = 0
                   AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
                 ORDER BY received_at ASC, batch_id ASC LIMIT 1\`,
                [prodId]
              )
              .catch(rethrowBusy)) as FifoBatchRow[];
            if (earliest?.[0]) {
              const target = earliest[0];
              await db.execute(
                \`UPDATE stock_batches
                 SET quantity_remaining = quantity_remaining + $1,
                     version = version + 1,
                     updated_at = $2,
                     sync_status = 'pending'
                 WHERE batch_id = $3\`,
                [lineQty, now, target.batch_id]
              );
              const bumped = (await db
                .select('SELECT quantity_remaining, version FROM stock_batches WHERE batch_id = $1', [target.batch_id])
                .catch(rethrowBusy)) as Array<{ quantity_remaining: number; version: number }>;
              const exKey = \`sb-\${target.batch_id}-\${txId}\`;
              await db.execute(
                \`INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
                 VALUES ($1, 'stock_batches', $2, 'UPSERT', $3, 'pending')
                 ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4\`,
                [
                  exKey,
                  target.batch_id,
                  JSON.stringify({
                    version: toFiniteNumber(bumped?.[0]?.version, 1),
                    batch_id: target.batch_id,
                    product_id: prodId,
                    quantity_remaining: toFiniteNumber(bumped?.[0]?.quantity_remaining, toFiniteNumber(target.quantity_remaining, 0) + lineQty),
                    unit_cost: toFiniteNumber(target.unit_cost, 0),
                    received_at: target.received_at,
                    purchase_order_id: target.purchase_order_id ?? null,
                    created_at: target.created_at ?? target.received_at,
                    device_id: deviceId,
                    updated_at: now,
                  }),
                  now,
                ]
              );
              fifoAllocations.push({ batchId: target.batch_id, quantity: lineQty, unitCost: toFiniteNumber(target.unit_cost, 0) });
            } else {
              const exBatchId = newId('batch-exchange');
              const exKey = newIdempotencyKey();
              await db.execute(
                \`INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at,
                  purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
                 VALUES ($1, $2, $3, $4, $5, 'EXCHANGE', $6, $7, 'pending', 1, $5, $5, 0)\`,
                [exBatchId, prodId, lineQty, lineCost, now, deviceId, exKey]
              );
              await db.execute(
                \`INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
                 VALUES ($1, 'stock_batches', $2, 'UPSERT', $3, 'pending')
                 ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4\`,
                [
                  exKey,
                  exBatchId,
                  JSON.stringify({
                    version: 1, batch_id: exBatchId, product_id: prodId,
                    quantity_remaining: lineQty, unit_cost: lineCost, received_at: now,
                    purchase_order_id: 'EXCHANGE', device_id: deviceId,
                    idempotency_key: exKey, created_at: now, updated_at: now,
                  }),
                  now,
                ]
              );
              fifoAllocations.push({ batchId: exBatchId, quantity: lineQty, unitCost: lineCost });
            }
          }
          fifoAuthoritativeCost = toIntMoney(fallbackCost);
        } catch (batchErr) {
          if (isBusyError(batchErr)) throw batchErr;
          console.warn('[FIFO] Exchange restock fallback to catalog cost:', batchErr);
          fifoAuthoritativeCost = null;
        }
      } else if (!isRefundReceipt) {
        try {
          const availableBatches = (await db
            .select(
              \`SELECT batch_id, quantity_remaining, unit_cost, received_at, purchase_order_id, created_at
               FROM stock_batches
               WHERE product_id = $1 AND quantity_remaining > 0 AND deleted = 0
                 AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
               ORDER BY received_at ASC, batch_id ASC\`,
              [prodId]
            )
            .catch((e: unknown) => {
              if (isBusyError(e)) throw e;
              return [];
            })) as FifoBatchRow[];

          let needed = qtySold;
          let totalCostAccum = 0;
          let totalAllocatedQty = 0;
          const ctx: DepleteCtx = { prodId, deviceId, now, txId };

          for (const batch of availableBatches) {
            if (needed <= 0) break;
            const avail = Math.max(0, Math.floor(Number(batch.quantity_remaining) || 0));
            const want = Math.min(avail, needed);
            if (want <= 0) continue;
            let take = 0;
            const first = await depleteBatchGuarded(db, { ...batch, quantity_remaining: avail }, want, ctx);
            if (first.taken > 0) {
              take = first.taken;
            } else {
              const fresh = (await db
                .select('SELECT quantity_remaining FROM stock_batches WHERE batch_id = $1', [batch.batch_id])
                .catch(rethrowBusy)) as Array<{ quantity_remaining: number }>;
              const left = Math.max(0, Math.floor(Number(fresh?.[0]?.quantity_remaining ?? 0)));
              const want2 = Math.min(left, needed);
              if (want2 <= 0) continue;
              const second = await depleteBatchGuarded(db, { ...batch, quantity_remaining: left }, want2, ctx);
              if (second.taken <= 0) continue;
              take = second.taken;
            }
            needed -= take;
            totalAllocatedQty += take;
            totalCostAccum += take * Number(batch.unit_cost);
            fifoAllocations.push({
              batchId: batch.batch_id,
              quantity: take,
              unitCost: Number(batch.unit_cost),
            });
          }

          if (needed > 0) {
            const shadowCost = await lastKnownPurchaseCost(db, prodId, fallbackCost);
            const shadowId = \`shadow-\${txId}-\${idx}\`;
            const shadowKey = \`sb-\${shadowId}\`;
            const terminalService = isTerminalLine;
            try {
              await db.execute(
                \`INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at,
                  purchase_order_id, device_id, idempotency_key, sync_status, version,
                  created_at, updated_at, deleted, shadow_sale_id, shadow_item_id, shadow_qty, shadow_resolved)
                 VALUES ($1, $2, 0, $3, $4, 'SHADOW', $5, $6, 'pending', 1, $4, $4, 0, $7, $8, $9, $10)
                 ON CONFLICT(batch_id) DO NOTHING\`,
                [shadowId, prodId, shadowCost, now, deviceId, shadowKey, terminalService ? null : txId, terminalService ? null : itemId, needed, terminalService ? 1 : 0]
              );
              await db.execute(
                \`INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
                 VALUES ($1, 'stock_batches', $2, 'UPSERT', $3, 'pending')
                 ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4\`,
                [
                  shadowKey,
                  shadowId,
                  JSON.stringify({
                    version: 1, batch_id: shadowId, product_id: prodId,
                    quantity_remaining: 0, unit_cost: shadowCost, received_at: now,
                    purchase_order_id: 'SHADOW', device_id: deviceId,
                    idempotency_key: shadowKey, created_at: now, updated_at: now,
                    shadow_sale_id: terminalService ? null : txId, shadow_item_id: terminalService ? null : itemId,
                    shadow_qty: needed, shadow_resolved: terminalService ? 1 : 0,
                  }),
                  now,
                ]
              );
            } catch (shadowErr) {
              if (isBusyError(shadowErr)) throw shadowErr;
              console.warn('[FIFO] Shadow batch persist skipped (schema pre-heal):', shadowErr);
            }
            totalCostAccum += needed * shadowCost;
            totalAllocatedQty += needed;
            fifoAllocations.push({ batchId: shadowId, quantity: needed, unitCost: shadowCost });
          }

          if (totalAllocatedQty > 0) {
            blendedUnitCost = totalCostAccum / totalAllocatedQty;
          }
          fifoAuthoritativeCost = toIntMoney(blendedUnitCost);
        } catch (batchErr) {
          if (isBusyError(batchErr)) throw batchErr;
          console.warn('[FIFO] Batch depletion fallback to catalog cost:', batchErr);
          blendedUnitCost = fallbackCost;
          fifoAuthoritativeCost = null;
        }
      }

      const callerUnitCost = Number(it.unit_cost_at_sale ?? it.unitCostAtSale ?? blendedUnitCost);
      const unitCostAtSale = fifoAuthoritativeCost ?? callerUnitCost;
      const signedQty = isReturnLine ? -Math.abs(qtySold) : Math.abs(qtySold);
      const lineProfit = (unitPriceCharged - unitCostAtSale) * signedQty;
      if (fifoAuthoritativeCost !== null) {
        fifoResolvedAny = true;
      }
      fifoCostTotalAccum += unitCostAtSale * signedQty;
      fifoItemResolutions.push({
        itemId,
        unitCostAtSale,
        lineProfit,
        fifoAllocations: fifoAllocations.map((a) => ({ ...a })),
      });

      if (!isRefundReceipt && !isReturnLine && fifoAllocations.length > 0) {
        for (const alloc of fifoAllocations) {
          const takeQty = Math.max(0, Math.floor(Number(alloc.quantity ?? 0)));
          const frozenUnitCost = Math.max(0, toIntMoney(alloc.unitCost ?? 0));
          if (!(takeQty > 0)) continue;
          const allocId = \`alloc-\${txId}-\${idx}-\${String(alloc.batchId)}\`;
          try {
            await db.execute(
              \`INSERT INTO sale_batch_allocations
                 (id, sale_id, batch_id, qty_consumed, unit_cost_at_sale,
                  created_at, product_id, sale_item_id,
                  device_id, idempotency_key, sync_status, version, updated_at, deleted)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',1,$6,0)
               ON CONFLICT(id) DO UPDATE SET
                 qty_consumed = sale_batch_allocations.qty_consumed + excluded.qty_consumed,
                 updated_at = excluded.updated_at, sync_status = 'pending'\`,
              [
                allocId, txId, String(alloc.batchId), takeQty, frozenUnitCost,
                now, prodId, itemId, deviceId, allocId,
              ],
            );
            allocLedgerTotal += takeQty * frozenUnitCost;
          } catch (allocErr) {
            if (isBusyError(allocErr)) throw allocErr;
            const msg = String((allocErr as { message?: unknown })?.message ?? allocErr);
            if (/no such table/i.test(msg)) {
              console.warn('[FIFO-ledger] sale_batch_allocations missing (pre-v104 heal), sale still durable via lines:', msg);
              allocLedgerAvailable = false;
              break;
            }
            throw allocErr;
          }
        }
      }

      const imeiNum = String((it.imei_number as string) ?? (it.imeiNumber as string) ?? '').trim();
      const enrichedPayload = toBoundedSyncJson({
        ...it,
        id: itemId,
        transaction_id: txId,
        product_id: prodId,
        unit_price_charged: unitPriceCharged,
        unit_cost_at_sale: unitCostAtSale,
        discount_amount: discountAmount,
        line_profit: lineProfit,
        fifo_allocations: fifoAllocations,
      });

      preparedItems.push({
        itemId,
        itemKey,
        prodId,
        qtySold,
        appliedPrice,
        discount: Number(it.discount ?? 0),
        imeiNum,
        fallbackCost,
        unitPriceCharged,
        unitCostAtSale,
        discountAmount,
        lineProfit,
        enrichedPayload,
        isReturnLine,
        rawItem: it as Record<string, unknown>,
      });
    }

    // 2. Order-level FIFO calculation:
    // Determine the exact cost_total, profit, profit_margin and ledger_cogs_total
    // BEFORE inserting the sales row.
    const orderTotal = toIntMoney(input.orderRow.total ?? 0);
    if (!isRefundReceipt && fifoResolvedAny) {
      fifoOrderCostTotal = toIntMoney(fifoCostTotalAccum);
      fifoOrderProfit = orderTotal - fifoOrderCostTotal;
      fifoLedgerCogsTotal = toIntMoney(preAllocSum + allocLedgerTotal);
    }

    const finalCostTotal = fifoOrderCostTotal !== null
      ? fifoOrderCostTotal
      : toIntMoney(input.orderRow.cost_total ?? input.orderRow.costTotal ?? 0);
    const finalProfit = fifoOrderProfit !== null
      ? fifoOrderProfit
      : toIntMoney(input.orderRow.profit ?? 0);
    const finalProfitMargin = fifoOrderCostTotal !== null
      ? (orderTotal > 0 ? Number(((finalProfit / orderTotal) * 100).toFixed(1)) : 0)
      : Number(input.orderRow.profit_margin ?? input.orderRow.profitMargin ?? 0);
    const finalLedgerCogsTotal = fifoLedgerCogsTotal;

    // Canonical receipt JSON: full transaction carrying the exact FIFO totals and item costs
    const rawTx = (input.fullTx ?? input.orderRow ?? { id: txId }) as Record<string, unknown>;
    const parsedReceipt: Record<string, unknown> = {
      ...rawTx,
      id: txId,
      receiptNumber: receiptNo,
      receipt_number: receiptNo,
      deviceId,
      device_id: deviceId,
      version: nextVersion,
      costTotal: finalCostTotal,
      cost_total: finalCostTotal,
      profit: finalProfit,
      profitMargin: finalProfitMargin,
      profit_margin: finalProfitMargin,
    };
    if (finalLedgerCogsTotal !== null) {
      parsedReceipt.ledgerCogsTotal = finalLedgerCogsTotal;
      parsedReceipt.ledger_cogs_total = finalLedgerCogsTotal;
    }
    if (Array.isArray(parsedReceipt.items)) {
      parsedReceipt.items = parsedReceipt.items.map((ri, riIdx) => {
        const res = fifoItemResolutions[riIdx];
        if (!res || typeof ri !== 'object' || ri === null) return ri;
        return {
          ...ri,
          unitCostAtSale: res.unitCostAtSale,
          unitCostPrice: res.unitCostAtSale,
          unit_cost_at_sale: res.unitCostAtSale,
          lineProfit: res.lineProfit,
          line_profit: res.lineProfit,
        };
      });
    }
    const receiptJson = toBoundedSyncJson(parsedReceipt);

    // 3. Atomically write the sales record into SQLite with the exact FIFO COGS hardcoded.
    const txnParamsWithLedger = [
      txId,
      receiptNo,
      (input.orderRow.customer_id as string) ?? (input.orderRow.customerId as string) ?? null,
      Number(input.orderRow.subtotal ?? 0),
      Number(input.orderRow.tax ?? 0),
      Number(input.orderRow.discount_total ?? input.orderRow.discountTotal ?? 0),
      Number(input.orderRow.total ?? 0),
      finalCostTotal,
      finalProfit,
      finalProfitMargin,
      String(input.orderRow.pricing_tier ?? input.orderRow.pricingTier ?? 'Retail'),
      String(input.orderRow.payment_method ?? input.orderRow.paymentMethod ?? 'Espèces'),
      Number(input.orderRow.cash_tendered ?? input.orderRow.cashTendered ?? 0),
      Number(input.orderRow.change_due ?? input.orderRow.changeDue ?? 0),
      String(input.orderRow.status ?? 'COMPLETED'),
      String(input.orderRow.created_at ?? input.orderRow.createdAt ?? now),
      receiptJson,
      deviceId,
      orderKey,
      orderSync,
      now,
      nextVersion,
      finalLedgerCogsTotal,
    ];

    try {
      await db.execute(
        \`INSERT INTO transactions (id, receipt_number, customer_id, subtotal, tax, discount_total, total,
          cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, change_due,
          status, created_at, json_payload, device_id, idempotency_key, sync_status, updated_at, version, deleted, ledger_cogs_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,0,$23)
         ON CONFLICT(id) DO UPDATE SET receipt_number=excluded.receipt_number, total=excluded.total,
           cost_total=excluded.cost_total, profit=excluded.profit, profit_margin=excluded.profit_margin,
           ledger_cogs_total=excluded.ledger_cogs_total,
           status=excluded.status, json_payload=excluded.json_payload, updated_at=excluded.updated_at,
           sync_status='pending', idempotency_key=excluded.idempotency_key, version=excluded.version\`,
        txnParamsWithLedger,
      );
    } catch (insertErr) {
      if (isBusyError(insertErr)) throw insertErr;
      const msg = String((insertErr as { message?: unknown })?.message ?? insertErr);
      if (/no column named ledger_cogs_total/i.test(msg)) {
        await db.execute(
          \`INSERT INTO transactions (id, receipt_number, customer_id, subtotal, tax, discount_total, total,
            cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, change_due,
            status, created_at, json_payload, device_id, idempotency_key, sync_status, updated_at, version, deleted)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,0)
           ON CONFLICT(id) DO UPDATE SET receipt_number=excluded.receipt_number, total=excluded.total,
             cost_total=excluded.cost_total, profit=excluded.profit, profit_margin=excluded.profit_margin,
             status=excluded.status, json_payload=excluded.json_payload, updated_at=excluded.updated_at,
             sync_status='pending', idempotency_key=excluded.idempotency_key, version=excluded.version\`,
          txnParamsWithLedger.slice(0, 22),
        );
      } else {
        throw insertErr;
      }
    }

    // 4. Enqueue customer UPSERT if present in transaction (Strict Parent-First)
    const attachedCustomer = (input.fullTx as Record<string, unknown> | undefined)?.customer as Record<string, unknown> | undefined;
    if (attachedCustomer && attachedCustomer.id) {
      const custId = String(attachedCustomer.id);
      const custKey = await stableEntityKey(db, 'customer', custId);
      const custVersion = await bumpEntityVersion(db, 'customer', custId);
      await db.execute(
        \`INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1,'customer',$2,'UPSERT',$3,'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$4\`,
        [custKey, custId, toBoundedSyncJson({ ...attachedCustomer, version: custVersion }), now],
      );
    }

    // 5. Enqueue product UPSERTs
    for (const pid of touchedIds) {
      const rows = (await db.select('SELECT * FROM products WHERE id=$1', [pid]).catch(() => [])) as Array<Record<string, unknown>>;
      const prow = rows?.[0];
      if (!prow) continue;
      const pkey = (prow.idempotency_key as string) || \`stub-\${pid}\`;
      await db.execute(
        \`INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1,'product',$2,'UPSERT',$3,'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$4\`,
        [pkey, pid, toBoundedSyncJson(prow), now],
      );
    }

    // 6. Enqueue order (Parent of items & ledger)
    await db.execute(
      \`INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
       VALUES ($1,'order',$2,'UPSERT',$3,'pending')
       ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4\`,
      [orderKey, txId, receiptJson, now],
    );

    // 7. Enqueue order items & IMEI ownership
    for (const pit of preparedItems) {
      await db.execute(
        \`INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, discount,
          imei_number, cost_price, unit_price_charged, unit_cost_at_sale, discount_amount, line_profit,
          json_payload, device_id, idempotency_key, sync_status, created_at, updated_at, deleted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending',$16,$16,0)
         ON CONFLICT(id) DO UPDATE SET quantity=excluded.quantity, applied_price=excluded.applied_price,
           unit_price_charged=excluded.unit_price_charged, unit_cost_at_sale=excluded.unit_cost_at_sale,
           discount_amount=excluded.discount_amount, line_profit=excluded.line_profit,
           json_payload=excluded.json_payload, updated_at=excluded.updated_at, sync_status='pending'\`,
        [
          pit.itemId,
          txId,
          pit.prodId,
          pit.qtySold,
          pit.appliedPrice,
          pit.discount,
          pit.imeiNum || null,
          pit.fallbackCost,
          pit.unitPriceCharged,
          pit.unitCostAtSale,
          pit.discountAmount,
          pit.lineProfit,
          pit.enrichedPayload,
          deviceId,
          pit.itemKey,
          now,
        ],
      );
      await db.execute(
        \`INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1,'order_item',$2,'UPSERT',$3,'pending') ON CONFLICT(idempotency_key) DO NOTHING\`,
        [pit.itemKey, pit.itemId, pit.enrichedPayload],
      );

      if (pit.imeiNum) {
        const takesOwnership = !isRefundReceipt && !pit.isReturnLine;
        if (takesOwnership) {
          const linkedTxnIsRefund = async (linkedId: string): Promise<boolean> => {
            try {
              const t = (await db
                .select('SELECT json_payload FROM transactions WHERE id = $1', [linkedId])
                .catch(rethrowBusy)) as Array<{ json_payload?: string | null }>;
              const raw = t?.[0]?.json_payload;
              if (!raw) return false;
              try {
                const p = JSON.parse(String(raw)) as { isRefund?: unknown };
                return Boolean(p?.isRefund);
              } catch {
                return false;
              }
            } catch (e) {
              if (isBusyError(e)) throw e;
              return false;
            }
          };
          const imeiFree = await (async (): Promise<boolean> => {
            try {
              const r = (await db
                .select('SELECT data_json FROM imei_records WHERE id = $1', [pit.imeiNum])
                .catch(rethrowBusy)) as Array<{ data_json?: string | null }>;
              if (!r?.[0]) return true;
              let linked: string | null = null;
              let soldAt: string | null = null;
              try {
                const d = JSON.parse(String(r[0].data_json ?? '{}')) as {
                  sale_transaction_id?: unknown;
                  sold_at?: unknown;
                };
                linked = d.sale_transaction_id ? String(d.sale_transaction_id) : null;
                soldAt = d.sold_at ? String(d.sold_at) : null;
              } catch {
                return false;
              }
              if (!linked && !soldAt) return true;
              if (linked && (linked === txId || (await linkedTxnIsRefund(linked)))) return true;
              return false;
            } catch (e) {
              if (isBusyError(e)) throw e;
              try {
                const r2 = (await db
                  .select('SELECT sale_transaction_id, sold_at FROM imei_records WHERE imei = $1', [pit.imeiNum])
                  .catch(rethrowBusy)) as Array<{ sale_transaction_id?: string | null; sold_at?: string | null }>;
                const s = r2?.[0];
                const linked = s?.sale_transaction_id ? String(s.sale_transaction_id) : null;
                if (!linked && !s?.sold_at) return true;
                if (linked && (linked === txId || (await linkedTxnIsRefund(linked)))) return true;
                return false;
              } catch (e2) {
                if (isBusyError(e2)) throw e2;
                return true;
              }
            }
          })();
          if (!imeiFree) {
            throw new Error(\`IMEI_ALREADY_SOLD:\${pit.imeiNum}\`);
          }
        }
        const imeiVersion = await bumpEntityVersion(db, 'imei', pit.imeiNum);
        const imeiData = {
          imei: pit.imeiNum,
          product_id: pit.prodId,
          sale_transaction_id: txId,
          sold_at: now,
          received_at: now,
          version: imeiVersion,
        };
        const imeiKey = await stableEntityKey(db, 'imei', pit.imeiNum);
        try {
          await db.execute(
            \`INSERT INTO imei_records (id, data_json, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
             VALUES ($1, $2, $3, $4, 'pending', 1, $5, $5, 0)
             ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at, sync_status='pending'\`,
            [pit.imeiNum, JSON.stringify(imeiData), deviceId, imeiKey, now],
          );
        } catch {
          try {
            await db.execute(
              \`INSERT INTO imei_records (imei, product_id, sale_transaction_id, sold_at, received_at, version)
               VALUES ($1, $2, $3, $4, $4, 1)
               ON CONFLICT(imei) DO UPDATE SET sale_transaction_id=excluded.sale_transaction_id, sold_at=excluded.sold_at,
                 product_id=excluded.product_id, version=imei_records.version + 1\`,
              [pit.imeiNum, pit.prodId, txId, now],
            );
          } catch (e: unknown) {
            console.warn('[db:imei] IMEI table record write skipped:', e);
          }
        }
        await db.execute(
          \`INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
           VALUES ($1,'imei',$2,'UPSERT',$3,'pending')
           ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$4\`,
          [imeiKey, pit.imeiNum, JSON.stringify(imeiData), now],
        );
      }
    }`;

const newLines = [
  ...lines.slice(0, startIdx),
  ...newBlock.split('\n'),
  ...lines.slice(endIdx + 1),
];

fs.writeFileSync(filePath, newLines.join('\r\n'), 'utf8');
console.log('Successfully replaced lines in', filePath);
