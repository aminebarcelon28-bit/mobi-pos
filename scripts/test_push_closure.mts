/**
 * Push-batch dependency closure (SYNC-002) — tests for
 * src/sync/outboxFamily.ts. Pure logic + injected fetcher; no DB, no
 * network.
 *
 * Proves: parent extraction per lane (payload, id-fallback, corrupt-safe);
 * closure prepends missing parents ahead of children; present/missing
 * parents behave; duplicates never double-add; order otherwise stable;
 * fetcher failures skip instead of breaking the batch.
 */
import { closePushBatch, outboxParentOf } from '../src/sync/outboxFamily.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

type Row = { entity_type: string; entity_id: string; payload_json?: unknown; rowid?: number };
const row = (t: string, id: string, payload?: unknown): Row =>
  ({ entity_type: t, entity_id: id, payload_json: payload ?? '{}' });

async function main() {
  // 1. Parent extraction per lane.
  check('order_item via payload transaction_id',
    JSON.stringify(outboxParentOf(row('order_item', 'X-item-3', { transaction_id: 'TX-9' }))) ===
    JSON.stringify({ entity_type: 'order', entity_id: 'TX-9' }));
  check('order_item via id fallback (no payload link)',
    outboxParentOf(row('order_item', 'TX-9-item-3', {}))?.entity_id === 'TX-9');
  check('order_item id without suffix → null (self-parent refused)',
    outboxParentOf(row('order_item', 'TX-9', {})) === null);
  check('ledger order-ref maps',
    outboxParentOf(row('ledger', 'L1', { ref_type: 'order', ref_id: 'TX-9' }))?.entity_id === 'TX-9');
  check('ledger non-order ref skipped',
    outboxParentOf(row('ledger', 'L1', { ref_type: 'manual', ref_id: 'P-1' })) === null);
  check('ledger missing ref skipped',
    outboxParentOf(row('ledger', 'L1', {})) === null);
  check('debt maps to customer',
    outboxParentOf(row('customer_debt', 'D1', { customer_id: 'C-9' }))?.entity_type === 'customer');
  check('debt without customer skipped',
    outboxParentOf(row('customer_debt', 'D1', {})) === null);
  check('roots have no parents',
    outboxParentOf(row('order', 'TX-1', {})) === null &&
    outboxParentOf(row('product', 'P-1', {})) === null &&
    outboxParentOf(row('customer', 'C-1', {})) === null);
  check('corrupt payload never throws, skips',
    outboxParentOf(row('order_item', 'X', '###not-json')) === null);
  check('null/empty input → null',
    outboxParentOf(null) === null && outboxParentOf(undefined) === null &&
    outboxParentOf({ entity_type: '', entity_id: '' }) === null);

  // 2. Closure prepends missing parents ahead of children.
  {
    const child = row('order_item', 'TX-9-item-0', { transaction_id: 'TX-9' });
    const parent = row('order', 'TX-9', {});
    const { batch, pulled } = await closePushBatch([child], async () => parent);
    check('parent prepended ahead of child', batch.length === 2 && batch[0] === parent && batch[1] === child);
    check('pulled counted', pulled === 1);
  }

  // 3. Present parents untouched; missing parents skipped.
  {
    const parent = row('order', 'TX-9', {});
    const child = row('order_item', 'TX-9-item-0', { transaction_id: 'TX-9' });
    const r1 = await closePushBatch([parent, child], async () => { throw new Error('must not fetch'); });
    check('present parent: no fetch, order kept', r1.batch.length === 2 && r1.pulled === 0);
    const r2 = await closePushBatch([child], async () => null);
    check('absent parent: child rides alone', r2.batch.length === 1 && r2.pulled === 0);
  }

  // 4. No duplicates; fetcher failure skips; unrelated order stable.
  {
    const parent = row('order', 'TX-9', {});
    const c1 = row('order_item', 'TX-9-item-0', { transaction_id: 'TX-9' });
    const c2 = row('order_item', 'TX-9-item-1', { transaction_id: 'TX-9' });
    let fetches = 0;
    const r = await closePushBatch([c1, c2], async () => { fetches += 1; return parent; });
    check('shared parent added once', r.batch.filter((o) => o === parent).length === 1 && r.pulled === 1);
    check('second child needs no refetch', fetches === 1);
    const other = row('product', 'P-1', {});
    const r2 = await closePushBatch([other, c1], async (p) => (p.entity_id === 'TX-9' ? parent : null));
    check('unrelated rows keep relative order',
      r2.batch.map((o) => o.entity_id).join(',') === 'P-1,TX-9,TX-9-item-0');
    const r3 = await closePushBatch([c1], async () => { throw new Error('down'); });
    check('fetcher failure skips child intact', r3.batch.length === 1 && r3.pulled === 0);
  }

  // 5. Mismatched fetch result rejected.
  {
    const child = row('order_item', 'TX-9-item-0', { transaction_id: 'TX-9' });
    const wrong = row('order', 'TX-OTHER', {});
    const r = await closePushBatch([child], async () => wrong);
    check('wrong row rejected', r.batch.length === 1 && r.pulled === 0);
  }

  console.log(`\npush-closure: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
