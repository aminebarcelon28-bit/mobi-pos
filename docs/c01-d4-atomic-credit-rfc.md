# D4 — Atomic wallet credit on refund: current contract and option (a)

**Status:** design only. Owner decision: option **(b)** for now (keep the current contract,
characterize it), RFC for **(a)**. No wallet-path or `refund.rs` change in this batch.
**Evidence grades:** PROVEN / OBSERVED / HYPOTHESIS / KILLED.

---

## 1. The current contract, read from the code (PROVEN, file:line)

On a refund the money moves in this order (`src/store/slices/createOrderSlice.ts`):

1. **Native commit** — `refundSaleNative(nativeReq, …)` (`:2928` region). Inside one SQLite
   transaction it writes: refund row, inventory ledger, stock, IMEI events, audit row, loyalty
   points, debt relief (`src-tauri/src/refund.rs`). It does **not** touch `customers.store_credit`.
2. **Wallet write (TS, after the native commit)** — `persistWithRetryOnce(() => repo.save(hydratedCustomer))`
   (`:3061`). `persistWithRetryOnce` = two attempts, then `{ok:false}`.
3. **Outbox + mirror** — `enqueueGenericSync('customer', …)` (`:3070`), `fireSync`, and
   `db.customers.put(hydratedCustomer)` into Dexie (`:3077`).
4. On `{ok:false}` the slice pushes a warning and **continues** (`:3064-3069`): the refund is
   already committed.

`saveCustomer` writes `store_credit = excluded.store_credit` from the object it receives
(`src/db/adapters/customerAdapter.ts:126-131`), so the wallet value is only as fresh as the caller's
snapshot.

**Consequence (PROVEN by the above ordering):** a failure at step 2 leaves SQLite with the old
wallet while the refund row, cash, stock and ledger have already moved. The Dexie mirror holds the
new value, but boot rehydrates from SQLite (`customerAdapter` read path), so the credit is **not**
visible on this terminal until a sync pull restores it — and a pull only exists if the outbox row
the same code just queued is eventually pushed to a configured gateway.

## 2. Failure modes (OBSERVED / HYPOTHESIS)

| Failure | Grade | Note |
|---|---|---|
| SQLite busy/locked at the moment of the save | OBSERVED (`BUSY` handling exists for the native call; `persistWithRetryOnce` exists precisely for this) | two attempts, ~0 backoff |
| Disk full / quota | HYPOTHESIS | same path, no separate handling |
| WebView/DB handle closed mid-flight | HYPOTHESIS | same path |
| The credit is later re-applied by sync | OBSERVED design intent (`enqueueGenericSync`) | requires a configured gateway and a reachable backend |
| Double credit on retry | KILLED (design) | the outbox payload is a whole-row upsert keyed by customer id; replay converges, it does not add |

Nothing above reproduces `wallet=300` deterministically; see the C01 report (H3/H4/H5).

## 3. Option (a): write the wallet inside `refund_sale_atomic`

**Shape.** Extend the native refund request with the post-refund wallet value (and the anomaly
flags that justify it), and apply it **inside the same transaction** as the refund row:

```
RefundRequest {
  …
  customer_store_credit_after: Option<i64>,   // minor-free DA, >= 0
}
```

`apply_refund_in_txn` then runs one UPDATE/INSERT on `customers` with:
- `store_credit = customer_store_credit_after` (only when `customer_id` is present),
- the existing debt/points replay it already does.

**Diff footprint.**
- `src-tauri/src/refund.rs`: one field on the request struct (~6 lines), one UPDATE (~10 lines),
  validation (`>= 0`, only with a customer) (~5), tests (~40).
- `src/db/adapters/refundNative.ts`: one field mapping (~3).
- `src/store/slices/createOrderSlice.ts`: pass the value; keep the TS save as a **mirror** (or drop
  it once the native write is authoritative), and keep the outbox row for sync (~10).
- No migration: `customers.store_credit` exists and is already synced.

**Interaction with sync/outbox.** Unchanged. The customer row still syncs as a whole; the outbox
payload already carries the new `storeCredit`. The native write makes the local authority match the
payload instead of lagging it.

**Risks.**
- Two writers of `store_credit` (native + the TS mirror). If the mirror is kept, it must read the
  native value back rather than recompute, or a stale snapshot can undo the credit (this is exactly
  hypothesis H3-b in the C01 report).
- The native engine must not trust an impossible value: validate `0 ≤ credit` and, ideally,
  `credit ≤ current + refund value`.
- A refund that touches a customer row which no longer exists must fail closed (or create the stub,
  as the current TS writer does).

**Tests.**
- Rust: refund with `customer_store_credit_after` writes it in the same txn; a failed refund leaves
  `store_credit` untouched; `None` leaves it untouched.
- TS: a refund whose mirror save then fails must still show the new wallet (native authority).
- E2E: refund a credit-funded ticket, kill the mirror write (test hook), reload → wallet is correct.

**Approval needed:** `src-tauri/src/refund.rs` is outside RFC §14 and inside the money/trust gate.
This RFC is the request; nothing is implemented.

## 4. Why option (c) — a compensating reverse-refund — is worse

A compensating refund would have to be written by the same layer that just failed: if the wallet
write is what fails, the compensating write fails with it, and the shop is left with two rows (the
refund and its reversal) that both claim to be money movements. It also breaks the "one ticket, one
reversal" invariant, inflates the Z-report with a phantom second movement, and needs its own audit
vocabulary and idempotency key. Atomicity inside the existing transaction is strictly simpler.

## 5. What this batch changed

Nothing in the wallet path. The refund split now records a per-lane `funding` object and an
`anomalies[]` array in the refund payload, which is what a future native writer will need to
validate `customer_store_credit_after` against (`docs/c01-refund-allocation-rfc.md` §7).
## 6. B3 evidence update (writer inventory, window, injection)

**Writers of `customers.store_credit`** (grep of SQL + every `saveCustomer`/`repo.save` caller):

| Writer | File:line | Value freshness | Can fire after a sale/refund in-session? |
|---|---|---|---|
| `customerAdapter.saveCustomer` | `customerAdapter.ts:126-131` | caller's snapshot | yes - every caller below |
| `customerRepository.save` | `customerRepository.ts:20` | caller's snapshot | yes |
| checkout customer persist | `createOrderSlice.ts:1178` | in-memory `custToSave` | yes (same checkout) |
| refund wallet save | `createOrderSlice.ts:3062` | computed post-refund value | yes (the write under study) |
| checkout-recovery replay | `checkoutRecovery.ts:421` | **a stored intent payload = old snapshot** | yes, on boot/recovery - the one stale writer that can land after a refund (HYPOTHESIS) |
| maintenance import/merge | `maintenanceAdapter.ts:272` | imported envelope | only on import (PROVEN by caller) |
| sync pull apply | `sync/genericApply.ts:263` | remote payload, version-guarded | on pull (PROVEN by caller) |

**H4 window (PROVEN by code path):** the native refund commits at `createOrderSlice.ts:2928`; the
wallet save is at `:3062`, awaited by the slice but *after* the row exists. Any reader that waits on
the refund row (the spec does) can read the customer row before the save resolves. Proving the
window exists does not prove it caused the original failure.

**Failure injection: NOT RUN.** Injecting a throw/timeout into the wallet save needs either a mock at
the `customerRepository` boundary (no seam - the store imports it dynamically) or a test-only
injection point in `createOrderSlice`. The owner allowed that injection point; it was not built in
this batch's remaining time. The contract below is therefore **code-path, not observed**.

**Current contract (PROVEN by code path):** two attempts, then warn + outbox + Dexie put; the refund
is already committed. On a terminal that never syncs the credit is invisible after the next boot
(SQLite is the authority) - the outbox row is a *push*, so a fully offline terminal has no path back.

**Recommendation:** option **(a)** - write `store_credit` inside `refund_sale_atomic`. Severity:
medium (money is preserved in Dexie/outbox and recovered on a synced terminal; lost on an offline
one). It needs the owner to lift the `refund.rs` gate; nothing is implemented.

