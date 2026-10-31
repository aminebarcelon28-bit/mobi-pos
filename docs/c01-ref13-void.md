# REF-13 — void did not restock the unit (fixed), and the sync residual

## Symptom (OBSERVED, isolated)

`REF-13` on the pre-fix HEAD (`b48bf72`, binary `81873CFD…1684`):

```
[REF-13] post-void: toasts="Vente #REC-… déjà annulée."  stock=499 (base 500) audits=5 moves=0 refunds=0
Expected: 500   Received: 499        (31-ref-refunds-part2.e2e.ts:1309)
```

The transaction status became `VOIDED`, no money moved, the audit row was written — but the unit came
back only in Dexie, never in SQLite stock, and the operator was told the void was *already* annulled.

## Root cause (OBSERVED)

1. `voidTransaction’s atomic lane flips the durable status itself:
   `transactionAdapter.ts:716` → `UPDATE transactions SET status='VOIDED'` inside the SQLite txn.
2. The slice then called `enqueueOrderSync(transactionId, { …status: 'VOIDED' })`
   (`createOrderSlice.ts:1893` before this fix). That function's duplicate-void guard refuses a second
   flip: `sqlPluginAdapter.ts:4109` → `throw new Error('ALREADY_VOIDED')`.
3. The throw landed in the slice's catch, which returned `{ success: false, reason: 'ALREADY_VOIDED' }`
   **before** `appendInventoryDeltas` (the `VOID +1` ledger row) and the FIFO batch restitution ran.
   `appendInventoryDeltas` is what recomputes `products.stock` from the ledger
   (`sqlPluginAdapter.ts:3391-3397`), so stock stayed one unit short.
4. DB confirmation from that run: `products.stock = 499`; `inventory_ledger` held only the `SALE -1`
   row — **no `reason='VOID'` row at all**.

So every first void reported itself as a duplicate, and the shop silently lost a unit.

## Fix (editable slice only, commit `eb95527`)

- The `VOID` ledger delta and the FIFO restitution now run **before** the sync push, so no refusal can
  skip them. Their ids are deterministic (`LED-VOID-<hash>`), so a replayed void still converges.
- The push is wrapped: `ALREADY_VOIDED` from `enqueueOrderSync` is logged, not propagated — the durable
  status is already `VOIDED`, and the operator's first void must not be reported as a duplicate. The
  outer catch no longer returns the false `ALREADY_VOIDED` result.
- A genuine duplicate never reaches this code: the atomic lane throws `ALREADY_VOIDED` first
  (`transactionAdapter.ts:706`).

## Result (OBSERVED, fresh worktree build `434E3AD5…898A`, HEAD `eb95527`)

```
[REF-13] post-void: toasts="Vente #REC-… annulée avec succès. Stocks et fidélité restaurés."
         stock=500 (base 500) audits=5 moves=0 refunds=0
REF-13: 1 passing (32.9s) | 1 passing (33.8s) | 1 passing (32.9s)   → 3/3
```

Full `31-ref-refunds-part2`: **13/15** (was 12/15); the only remaining failures are REF-36 and REF-65,
both unchanged pre-existing defects. The `G-07`/`G-08` invariant violations that this run used to raise
are gone (occurrences in the fixed run: **0**).

## Residual — the void does not push its status (PARKED, read-only lane)

Evidence from the same run's DB: the voided transaction's outbox row still carries the **sale** payload —
`TXN-…-MW3Q` has `status: null`, `version: 1`, while the local row is `VOIDED` with a bumped version.
`enqueueOrderSync` is the only function that writes that outbox payload, and it refuses the call
(`sqlPluginAdapter.ts:4109`) precisely because the atomic lane already flipped the status. `GenericEntity`
has no `transaction` member (`sqlPluginAdapter.ts:~4020`), so a generic enqueue would mint a **different**
idempotency key and fork the outbox row — the hazard the code itself warns about at
`sqlPluginAdapter.ts:4121`.

**Blocker type:** read-only file (`src/db/sqlPluginAdapter.ts`, `src/db/adapters/transactionAdapter.ts`).

**Options**

| # | Change | Risk | Cost |
|---|---|---|---|
| **A** | Let `enqueueOrderSync` accept a caller that just flipped the status (e.g. an `allowSameStatus` flag used only by the void slice) | low: the duplicate protection stays in the atomic lane | one guarded branch in a read-only file |
| **B** | Have `voidTransactionAtomic` enqueue the status payload itself, in the same transaction | lowest (one writer), but moves sync intent into the adapter | ~15 lines in the read-only adapter |
| **C** | Enqueue before the atomic call with a status-less payload | forks/misleads the cloud payload — **rejected** | — |

**Recommendation: B**, then A. Meanwhile the void is durable locally, stock/ledger/batches are exact, and
the outbox gap is logged as a warning instead of silently failing the void.

**What would make this fully DONE:** decide A/B, implement in the read-only lane, then assert that the
outbox `order` payload for a voided ticket carries `status='VOIDED'` with the bumped version, and re-run
REF-13 3/3 plus the full spec.
