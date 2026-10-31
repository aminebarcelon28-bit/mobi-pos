# D4 — wallet-credit atomicity: decision pack

Blocker type: **owner decision** (gated file `src-tauri/src/refund.rs`). Owner fact F1 (terminals sync
to a server) is **UNKNOWN** — the worst case is assumed below: a terminal that never syncs.

## The current contract (READ, code path)

1. `refund_sale_atomic` commits the refund row, cash, stock, ledger, audit, points and debt relief in
   one SQLite transaction (`src-tauri/src/refund.rs`).
2. **After** that commit, TypeScript writes `customers.store_credit`:
   `createOrderSlice.ts:3061` `persistWithRetryOnce(() => repo.save(hydratedCustomer))` — two attempts.
3. On failure: warning + `enqueueGenericSync('customer', …)` (`:3070`) + Dexie `put` (`:3079`), and the
   refund **stands**.

## What goes wrong (READ, not yet reproduced)

- SQLite keeps the old wallet; boot rehydrates from SQLite, so the credit is invisible after restart.
- The Dexie mirror has the new value, but the outbox row is a **push**: a terminal that never syncs has
  no path back. The customer's money is lost with no operator-visible failure beyond a console warning.

## Options

| # | Change | Footprint | Risk | Cost |
|---|---|---|---|---|
| **A** | write `store_credit` inside `refund_sale_atomic` (new request field `customer_store_credit_after`, validated `0 ≤ x`), keep the TS write as a mirror that reads back | `refund.rs` (~60 lines incl. tests), `refundNative.ts` (~3), `createOrderSlice.ts` (~10) | two writers of one column; the mirror must not overwrite the native value from a stale snapshot | medium; needs the gate lifted |
| **B** (current) | keep the non-atomic write, document it, rely on sync | none | credit lost on an offline terminal; no operator-visible failure | none |
| **C** | compensating reverse refund | new money path | rejected in B2: the compensation fails the same way and creates a phantom second movement | — |

## Recommendation

**A**, severity **medium** under F1 = UNKNOWN: the money is preserved in Dexie/outbox on a synced
terminal and lost on a non-synced one. A also removes the H3-b hazard (a stale whole-row writer
cannot undo a value that the native transaction already committed and the mirror reads back).

## What would make it DONE

1. Gate lifted in writing for `src-tauri/src/refund.rs`.
2. Failure-injection test: wallet write throws → the refund must either commit the credit natively or
   leave no refund row at all; no state where cash moved and credit vanished.
3. Replay test: same refund twice → one row, one credit (idempotency).
4. Fresh-worktree build + REF-03/33/49/MNY-26/MNY-30 3/3.

## Evidence available today

`docs/c01-d4-atomic-credit-rfc.md` (writer inventory, 7 writers, `checkoutRecovery.ts:421` as the one
stale-snapshot candidate), E-0001…E-0026. **No failure-injection run exists** — the seam was never
built, so this pack rests on code reading, not on observation, and says so.
