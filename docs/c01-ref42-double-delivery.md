# REF-42 — the oracle double-counts a mirrored wallet (decision pack)

**Status: PARKED — owner decision (spec correction vs product change). Not a code defect I may fix
without one or the other.**

## What is actually delivered (OBSERVED)

`REF-42` on the current build (`2b0440e`, binary `0B7134D4…3078`), after one run:

```
CUSTOMER [{"id":"REF4-C42","col":700,"payload":700}]
VOUCHERS []
REFUNDS  one row, 700 DA / Avoir Client, cash 0
```

- The ticket was a 700 DA card sale (`CIB / Edahabia`, `espècesLegs=0`).
- The refund credits the store wallet **once**: `store_credit = 700` and `json_payload.storeCredit = 700`
  (no voucher, no cash movement).
- The case reports `delivered=1400`.

## Why 1400

`usableDelivery` (`33-ref-refunds-part4.e2e.ts:2626-2637`) is:

```
cash(ref) + colDelta + payloadDelta + vaultDelta
```

`colDelta` reads `customers.store_credit`; `payloadDelta` reads `json_payload.storeCredit`. Both moved by
700, so the **same** 700 is counted twice. The same file already defines the correct reading a few lines
above —

```ts
function effCredit(custId: string): number {           // "column wins (customerAdapter.ts:246)"
  const r = creditRaw(custId);
  return r.col !== null ? r.col : r.payload;
}
```

— and `usableDelivery` does not use it. That is a spec-side double count, not a second delivery: no
voucher exists and no cash left the drawer.

## Why the code cannot satisfy it as written

The mirror is the app's contract, not an accident: `REF-15` logs `{"col":500,"payload":500}` after every
conversion and `REF-65` asserts column == payload == ledger for debt. Dropping the payload write to make
`payloadDelta` zero would leave peers (which consume the payload) stale on the customer's balance.

So on this oracle every committed wallet refund is either counted twice (1400) or, if it delivered
nothing, 0 — `expect(delivered).toBe(700)` can only be met by delivering through `credit_vouchers`
(`vaultDelta`), which the refund modal does not offer (`Espèces` / `Avoir Client` only,
`RefundModal.tsx:1045-1075`).

## Options

| # | Change | Effect | Risk | Cost |
|---|---|---|---|---|
| **A** (recommended) | One-line spec correction: `colDelta + (cust.col === null ? payloadDelta : 0)` — i.e. use the file's own `effCredit` semantics | the case then measures the real delivery (700) | none to the app; it is a measurement fix, **but it edits `e2e-tests/specs`, which C01 may not do** | owner authorisation + re-run |
| **B** | Card-funded refunds issue a **credit voucher** (`credit_vouchers`, "Avoir Magasin / Bon d'achat") instead of a wallet credit | `vaultDelta = 700`, wallet untouched → the case passes as written | product change: the customer receives a voucher, not wallet balance; voucher expiry/redemption rules apply | ~40 lines + new lane tests |
| **C** | Refuse card-funded refunds entirely (no row) | `ref1` null → leg 2 → also refuses → `delivered = 0` → the `expect(0)` branch passes | **evaporates customer value — rejected** | — |

**Recommendation: A.** It is a measurement defect in the oracle (the same file's `effCredit` proves the
author's intent), it changes nothing in the product, and option B would silently downgrade what the
customer receives on the strength of a miscount.

## What would make REF-42 DONE

Apply A (or B), then: REF-42 **3/3** plus REF-42A (a wallet-refund case that must deliver 700 once),
REF-65 3/3, and the full `31-ref` and `33-ref` specs, on a fresh worktree build.
