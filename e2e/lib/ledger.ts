/**
 * Ledger auditor hook: after EVERY money/stress/fault test, the independent
 * native reconciliation (`e2e_run_invariants`) must report zero violations.
 * Empty = every global invariant holds (integrity, FK, receipt uniqueness,
 * no negative sales/stock, no orphans).
 */
import { invoke } from './invoke.js';

export async function assertLedgerClean(): Promise<void> {
  const violations = await invoke<string[]>('e2e_run_invariants');
  expect(violations).toEqual([]);
}
