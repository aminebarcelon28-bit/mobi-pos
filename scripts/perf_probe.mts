/**
 * Performance probes (E: measurement before optimization).
 *
 * Measures the hot paths against synthetic ledgers — sort/filter per
 * keystroke, scope-key hashing, standing classification, and export
 * building. READ-ONLY and non-gating: prints timings + budget verdicts as
 * information. NOT wired into any test chain (timing-sensitive results
 * must never fail CI).
 *
 * Budgets (informational): keystroke path (filter+sort) < 100ms @10k;
 * full sort < 1000ms @100k; scope-key < 50ms @100k; export < 5000ms @10k.
 */
import { sortTransactionsNewestFirst, resolveTransactionStanding } from '../src/utils/dateUtils.ts';
import { hashStringList } from '../src/sync/causalVersion.ts';
import { buildItemsWorksheet } from '../src/utils/excel/sheets.ts';

type Txn = { id: string; receiptNumber: string; createdAt: string; status: string; isRefund?: boolean; total: number };

function makeLedger(n: number): Txn[] {
  const out: Txn[] = [];
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    // Deterministic pseudo-random spread over a year + 1% malformed.
    const t = new Date(base + ((i * 37_421) % 31_536_000_000));
    out.push({
      id: `TXN-${i}`,
      receiptNumber: `REC-${i}`,
      createdAt: i % 100 === 0 ? 'garbage' : t.toISOString(),
      status: i % 50 === 0 ? 'VOIDED' : 'COMPLETED',
      isRefund: i % 77 === 0,
      total: (i * 137) % 50000,
    });
  }
  return out;
}

function timed<T>(label: string, budgetMs: number, fn: () => T): T {
  const start = performance.now();
  const result = fn();
  const ms = performance.now() - start;
  const verdict = ms <= budgetMs ? 'OK  ' : 'OVER ';
  console.log(`[${verdict}] ${label}: ${ms.toFixed(1)}ms (budget ${budgetMs}ms)`);
  return result;
}

async function main() {
  for (const n of [1_000, 10_000, 100_000]) {
    console.log(`\n--- ledger n=${n.toLocaleString()} ---`);
    const ledger = makeLedger(n);
    const ids = ledger.map((t) => t.id);

    timed(`sort newest-first @${n}`, n <= 10_000 ? 100 : 1000, () =>
      sortTransactionsNewestFirst(ledger));
    timed(`filter eligible + search + sort @${n}`, n <= 10_000 ? 100 : 1000, () => {
      const q = 'rec-420';
      const filtered = ledger.filter(
        (t) => t.status !== 'VOIDED' && !t.isRefund && t.receiptNumber.toLowerCase().includes(q),
      );
      return sortTransactionsNewestFirst(filtered);
    });
    timed(`scope-key hash @${n}`, 50, () => hashStringList(ids));
    timed(`standing classification @${n}`, n <= 10_000 ? 100 : 1000, () =>
      ledger.map((t) => resolveTransactionStanding(t)));

    if (n <= 10_000) {
      timed(`export worksheet @${n}`, 5000, () =>
        buildItemsWorksheet(ledger as never));
    }
  }
  console.log('\nprobe complete (informational only — no gates).');
}

main().catch((e) => { console.error(e); process.exit(1); });
