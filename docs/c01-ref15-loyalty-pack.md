# REF-15 / G-07 — loyalty points after a points-conversion refund: decision pack

**Status: PARKED (pre-existing defect, not caused by C90).** Owner decision on the intended rule is
required because two mechanisms disagree and both are encodable as "correct".

## Proof it is pre-existing (OBSERVED)

| Build | HEAD | REF-15 | Failure |
|---|---|---|---|
| pre-C90 baseline, binary `407AB8CB…6512` | `e88136b` | **0/3** | `expect(lpAfterSale).toBeGreaterThanOrEqual(lpPreSale)` → Expected `>= 400`, Received **372**; plus `G-07: headline 360 > Σ buckets 0 after an exhausted bucket (reversal did not reduce headline)` |
| C90 fix, binary `6C2ADD1B…8FE2` | `06d850e` | **0/3** | byte-identical failure (`>= 400` / 372, same G-07 text) |

The C90 change (`PaymentModal` cash-tender flush) cannot influence either number: the C90 build and the
pre-C90 build produce the same 372.

## What actually happens (from the case's own log)

```
[REF-15] sale total=600 method=Avoir Client tenders=[{Avoir Client 400},{Espèces 600}] guardrailCap=400
[REF-15] points: post-conversions=400 post-sale=372
[REF-15] refund landed total=1000 cash=0 credit 600→1600 returned=1000 lp 400→372→360
[INVARIANT VIOLATION] G-07: headline 360 > Σ buckets 0
```

1. The customer converts 2 × 50 points → 1 000 DA of avoir; the conversion burns 100 points
   (500 → 400). That is LOY-03's documented contract and it passes.
2. The sale applies 400 DA of that avoir (guardrail cap). `createOrderSlice.ts:805` then computes
   `pointsToRedeem = floor(400 / 10) = 40` and burns 40 points **again** for spending credit that was
   already paid for in points; earning 12 points on the 600 DA cash slice gives `400 − 40 + 12 = 372`.
3. The refund claws the 12 earned points back (372 → 360) but leaves `Σ buckets = 0`, so the
   headline and the bucket sum disagree → **G-07**.

## Trial fix and why it was reverted (MEASURED)

Removing the sale-side burn (`pointsToRedeem = 0`, plus not emitting a zero-delta `redeem` entry)
produced, on binary `3429213B…F904`:

- REF-15: **0/2**, but the *points* assertions now pass (`post-sale=412`, `lpFinal=400 ∈ {400, 412}`);
  the only remaining failure is **G-07** (`headline 400 > Σ buckets 0`), i.e. the bucket desync is a
  separate pre-existing defect in the conversion/refund bucket accounting.
- LOY-14 (converted points + voucher + discount → 0 DA sale): **0/2**. Its baseline was **not**
  measured, so this may be a regression from the trial — reason enough to revert.

Reverted: `createOrderSlice.ts` is back to the committed state; no partial loyalty change is left in
the tree.

## Why this needs the owner

Two designs are defensible and the repo contains both:

- **A — credit is pre-paid value (what REF-15's assertion demands):** spending avoir never burns points;
  the burn happens only at conversion. Simple, matches LOY-03, makes `lpAfterSale >= lpPreSale` true.
  Risk: any merchant workflow that treats "Avoir Client" as a points-redemption channel at checkout
  loses its point accounting.
- **B — burn on spend, restore on refund (current code):** points track the credit leg both ways. Risk:
  it charges the customer twice for the same credit unless the refund restore is exact, which is what
  G-07 shows it is not.
- **C — keep B but fix the bucket arithmetic only:** the smallest change that can clear G-07, but it
  leaves the double burn that REF-15 explicitly forbids.

**Recommendation: A**, then re-derive the refund-side restore so it reverses only what the sale
actually deducted (which becomes zero for the credit leg). It is the only option consistent with both
the existing assertion and LOY-03, and it removes the double burn rather than documenting it.

## What would make this DONE

1. Decide A/B/C.
2. If A: sale-side `pointsToRedeem = 0`; refund restore reverses only recorded deductions; buckets and
   headline updated by the same delta.
3. REF-15 3/3, LOY-03 3/3, LOY-14 3/3, LOY-04 3/3, MNY-26 3/3 on a fresh-worktree build, and G-07
   silent in `finalizeInvariants`.

## Files

- Behaviour: `src/store/slices/createOrderSlice.ts:804-806` (sale deduction), `:840-856` (headline +
  `redeem` entry), refund reversal at `:2383` (`computeSpendReversal`).
- Oracle: `e2e-tests/specs/32-ref-refunds-part3.e2e.ts:2827-2830`; invariant `G-07`
  (`e2e-tests/lib/invariants.ts`).
