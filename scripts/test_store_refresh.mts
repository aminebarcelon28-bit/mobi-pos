/**
 * Store refresh robustness (C3: STATE-001/003) — tests for
 * settleRefreshValue() and rebaseStoreSelections() in
 * src/store/transactionOrder.ts. Pure logic, no store/Dexie/Tauri.
 *
 * Proves: rejected lanes resolve to previous data (never abort the
 * refresh); deleted selections clear to null instead of ghosting; empty
 * fresh lists (fetch-over-fallback) keep selections untouched.
 */
import {
  rebaseStoreSelections,
  settleRefreshValue,
} from '../src/store/transactionOrder.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

async function main() {
  // 1. settleRefreshValue resolves values, falls back loudly on rejection.
  check('resolves values', (await settleRefreshValue('t', Promise.resolve(7), 0)) === 7);
  const fb = { sentinel: true };
  check('rejects to fallback (same reference)',
    (await settleRefreshValue('t', Promise.reject(new Error('BUSY')), fb)) === fb);

  // 2. Rebase keeps live selections (refreshed where applicable).
  {
    const customers = [{ id: 'C1', name: 'New' } as never];
    const txns = [{ id: 'T1' }];
    const out = rebaseStoreSelections(customers, txns, {
      currentCustomer: { id: 'C1', name: 'Old' } as never,
      selectedTransactionForRefund: { id: 'T1' } as never,
    });
    check('live customer refreshes to new object', out.currentCustomer?.name === 'New');
    check('live refund target kept', out.selectedTransactionForRefund?.id === 'T1');
  }

  // 3. Vanished rows clear to null (no ghost actions).
  {
    const out = rebaseStoreSelections([{ id: 'C9' } as never], [{ id: 'T9' }], {
      currentCustomer: { id: 'C1' } as never,
      selectedTransactionForRefund: { id: 'T1' } as never,
    });
    check('deleted customer clears', out.currentCustomer === null);
    check('deleted refund target clears', out.selectedTransactionForRefund === null);
  }

  // 4. Empty fresh lists mean fetch-over-fallback: keep everything.
  {
    const sel = {
      currentCustomer: { id: 'C1' } as never,
      selectedTransactionForRefund: { id: 'T1' } as never,
    };
    const out = rebaseStoreSelections([], [], sel);
    check('empty customers keep selection', out.currentCustomer?.id === 'C1');
    check('empty transactions keep refund target', out.selectedTransactionForRefund?.id === 'T1');
  }

  // 5. Null selections stay null.
  {
    const out = rebaseStoreSelections([{ id: 'C1' } as never], [{ id: 'T1' }], {
      currentCustomer: null,
      selectedTransactionForRefund: null,
    });
    check('null stays null', out.currentCustomer === null && out.selectedTransactionForRefund === null);
  }

  console.log(`\nstore-refresh: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
