/**
 * Debt settlement reentrancy & side-effect idempotency regression tests.
 *
 * Incident: rapid multi-click on Versement "Valider" passed the
 * state-only `isProcessing` guard (all clicks land before the next React
 * render). The debt LEDGER row converged (deterministic entryId upsert) but
 * each call minted a fresh drawer MANUAL_DEPOSIT (random MOV UUID) and a
 * fresh audit row — N clicks = N drawer deposits for one payment.
 *
 * Fixes under test (no copies — real modules):
 *   1. Synchronous ref latch in DebtLedgerModal (static wiring check).
 *   2. Deterministic drawer-movement id `MOV-DEBT-<entryId>` (ids.ts) —
 *      repeats collapse via put-upsert + stable outbox key (convergence
 *      simulation with Map upsert semantics, the same contract Dexie.put
 *      and the stable idempotency key provide).
 *   3. Session cashier binding (no hardcoded 'Caissier (Farida)').
 *
 * Run: node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_debt_reentrancy_idempotency.mts
 */
import { debtDepositMovementId } from '../src/utils/ids.ts';
import { claimAuditKey, resetAuditKeys } from '../src/utils/auditIdempotency.ts';
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}
const src = (p: string): string => readFileSync(p, 'utf8');

// ------------------------------------------------- deterministic movement id ---
console.log('\n--- Deterministic drawer-movement ids ---');
{
  const a = debtDepositMovementId('debt-pay-cust-1-1790000000000');
  const b = debtDepositMovementId('debt-pay-cust-1-1790000000000');
  check('same entryId derives the same movement id', a === b, a);
  check('movement id carries the entry (traceable)', a === 'MOV-DEBT-debt-pay-cust-1-1790000000000', a);
  check('distinct entryIds derive distinct ids',
    debtDepositMovementId('E1') !== debtDepositMovementId('E2'));
  check('empty entry falls back safely', debtDepositMovementId('') === 'MOV-DEBT-unknown');
}

// --------------------------------------- 5-click burst convergence simulation ---
console.log('\n--- 5-click burst collapses to 1 drawer row ---');
{
  // Same contract as Dexie.put by primary key + stable outbox key: last
  // writer wins on the SAME id, never a second row.
  const drawer = new Map<string, { id: string; amount: number }>();
  const entryId = 'debt-pay-cust-88-1790000000000';
  for (let click = 0; click < 5; click++) {
    const mov = { id: debtDepositMovementId(entryId), amount: 3000 };
    drawer.set(mov.id, mov); // put-upsert semantics
  }
  check('5 spam clicks yield exactly 1 drawer row', drawer.size === 1, `got ${drawer.size}`);
  const only = [...drawer.values()][0];
  check('single row totals 3000 DA, not 15000', only.amount === 3000, `got ${only.amount}`);
  check('row id is the deterministic key', only.id === `MOV-DEBT-${entryId}`);
}

// --------------------------------------- audit session-dedupe (chain-safe) ---
console.log('\n--- Audit session dedupe: repeats are replays, chain untouched ---');
{
  resetAuditKeys();
  const key = 'DEBT-SETTLE-debt-pay-cust-88-1790000000000';
  const first = claimAuditKey(key);
  const repeats = [claimAuditKey(key), claimAuditKey(key), claimAuditKey(key), claimAuditKey(key)];
  check('first claim owns the write', first === true);
  check('4 repeats all denied (replay, no new row)', repeats.every((r) => r === false));
  check('distinct intents claim independently',
    claimAuditKey('DEBT-SETTLE-other-entry') === true);
  check('blank key never blocks (fail-open for unkeyed callers)', claimAuditKey('') === true);
  resetAuditKeys();
  check('reset restores writability (tests only)', claimAuditKey(key) === true);
}

// ------------------------------------------------------- wiring (UI+slice+adapter) ---
console.log('\n--- Wiring: latch + deterministic ids + cashier binding ---');
{
  const modal = src('src/components/modals/DebtLedgerModal.tsx');
  check('modal has synchronous ref latch', modal.includes('submittingRef = useRef(false)'));
  check('latch gates before validation', modal.includes('if (submittingRef.current) return;'));
  check('latch releases in finally', modal.includes('submittingRef.current = false;') && modal.includes('} finally {'));
  const slice = src('src/store/slices/createCustomerSlice.ts');
  check('debt path uses deterministic movement id', slice.includes('debtDepositMovementId(debtEntry.id)'));
  check('debt audit passes key to the funnel',
    slice.split('DEBT-SETTLE-${debtEntry.id}').length >= 3);
  check('no hardcoded Farida in debt path', !slice.includes("'Caissier (Farida)'"));
  check('cashier bound from session', slice.includes('activeCashier?.name'));
  const shift = src('src/db/adapters/shiftAdapter.ts');
  check('logExpense accepts explicit movement id', shift.includes('movementId?: string'));
  const types = src('src/store/types.ts');
  check('store movement signature threads id', types.includes('movementId?: string'));
  check('debt audit claims idempotency key before append',
    slice.includes("claimAuditKey(`DEBT-SETTLE-${debtEntry.id}`)"));
  // Durable audit idempotency (native): key-as-event-id replay, chain untouched.
  check('native request carries idempotency key',
    src('src-tauri/src/trust_core/audit_append.rs').includes('pub idempotency_key: Option<String>'));
  check('native replay returns original receipt without second link',
    src('src-tauri/src/trust_core/audit_append.rs').includes('ON CONFLICT(id) DO NOTHING'));
  check('audit funnel threads key end-to-end',
    src('src/api/audit.ts').includes('idempotencyKey?: string') &&
    src('src/store/slices/createUISlice.ts').includes('idempotencyKey?: string'));
  // Second submit surface: CustomersModal inline "Encaisser Versement" had
  // NO latch and NO entryId (each call minted fresh random ids — full
  // ledger+drawer+audit triplication). Same treatment required.
  const cust = src('src/components/modals/CustomersModal.tsx');
  check('inline versement has synchronous ref latch', cust.includes('debtPayLatch = useRef(false)'));
  check('inline latch gates before validation', cust.includes('if (debtPayLatch.current) return;'));
  check('inline latch releases in finally', cust.includes('debtPayLatch.current = false;'));
  check('inline versement passes per-open entryId', cust.includes('debtPayEntryId.current = `debt-pay-'));
  check('inline entryId reaches the slice', cust.includes('{ entryId: debtPayEntryId.current || undefined }'));
}

console.log(`\nDEBT REENTRANCY SUMMARY: ${pass} PASSED, ${fail} FAILED`);
if (fail > 0) process.exit(1);
process.exit(0);
