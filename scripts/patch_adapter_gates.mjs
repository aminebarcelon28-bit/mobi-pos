import fs from 'node:fs';

let code = fs.readFileSync('src/db/sqlPluginAdapter.ts', 'utf8');

// 1. replay check
const targetTx = "const txId = String(input.orderRow.id || newId('TXN'));";
const replayBlock = `const txId = String(input.orderRow.id || newId('TXN'));
    const fin = (v: unknown): number | null => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? n : null;
    };
    const replayRows = (await db
      .select('SELECT cost_total, profit, ledger_cogs_total FROM transactions WHERE id = $1', [txId])
      .catch(() => [])) as Array<{ cost_total?: unknown; profit?: unknown; ledger_cogs_total?: unknown }>;
    const replayRow = replayRows?.[0];
    if (replayRow && replayRow.cost_total !== undefined) {
      let storedItems: Array<{ id: string; unitCostAtSale?: number; lineProfit?: number }> = [];
      try {
        const itemRows = (await db
          .select('SELECT id, unit_cost_at_sale, line_profit FROM transaction_items WHERE transaction_id = $1', [txId])
          .catch(() => [])) as Array<{ id: string; unit_cost_at_sale?: number; line_profit?: number }>;
        storedItems = itemRows.map((r) => ({
          id: String(r.id),
          unitCostAtSale: fin(r.unit_cost_at_sale) ?? undefined,
          lineProfit: fin(r.line_profit) ?? undefined,
        }));
      } catch {
        storedItems = [];
      }
      console.warn(
        \`[writeCheckoutAtomic] replay-after-commit for \${txId}: sale already durable — returning stored materialization, no re-depletion.\`
      );
      return {
        deviceId,
        fifoCostTotal: fin(replayRow.cost_total),
        fifoProfit: fin(replayRow.profit),
        ledgerCogsTotal:
          replayRow.ledger_cogs_total === null || replayRow.ledger_cogs_total === undefined
            ? null
            : fin(replayRow.ledger_cogs_total),
        fifoItems: storedItems,
      };
    }`;

if (!code.includes('replay-after-commit')) {
  code = code.replace(targetTx, replayBlock);
}

// 2. dedupeAllocationTwins(db, id) in repairSaleCogsFromLedger
if (!code.includes('dedupeAllocationTwins(db, id)')) {
  code = code.replace(
    'await dedupeAllocationTwins(db, realSaleId).catch(() => 0);',
    'await dedupeAllocationTwins(db, id).catch(() => 0);\n    await dedupeAllocationTwins(db, realSaleId).catch(() => 0);'
  );
}

fs.writeFileSync('src/db/sqlPluginAdapter.ts', code, 'utf8');
console.log('Updated sqlPluginAdapter.ts with replay and dedupe check');
