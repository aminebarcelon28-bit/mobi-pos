# REF-35 / REF-87 — a 0,01 line, two contradictory contracts (decision pack)

**Status: RESOLVED (2026-10-31) — authority order applied: ISO 4217 + MNY-01/02/03 > the spec, so the
spec expectation was corrected (basket 500.01, paid line refunds 500). REF-35 now passes; see E-0102.**

## What REF-35 wants

`33-ref-refunds-part4.e2e.ts:2347-2358`: add a 0,01 DA product (`P001`, seeded `priceDa: 0.01`) plus a
500 DA product, then

```ts
expect(Number(tx.total)).toBe(500);   // :2358
```

with the log line calling the small line *"display-only 0,01 line charged 0"*. On the current build the
sale is recorded as `total=500.01 subtotal=500.01`, so the case fails by exactly one minor unit. This is
**pre-existing** (baseline `e88136b`: 0/2, E-0046) and unrelated to the refund work.

## What the rest of the suite demands

| Case | Assertion | Observed on the current build |
|---|---|---|
| MNY-01 (`10-mny-money`) | 0,01 DA item: *"cart total must charge 0,01 DA"* — `expect(total).toBe(1n)` | **passes**: `unitShown=1 total=1 tx.total=0.01` |
| MNY-02 | 33,335 must charge the displayed 33,34 | **passes**: `unitShown=3334 total=3334 tx.total=33.34` |
| MNY-03 | 3 × 33,33 + 7 × 14,29 must total the displayed 200,02 | **passes**: `total=20002` |

So the suite simultaneously requires (a) a 0,01 cart to be **charged** 0,01 and (b) a 500,01 cart to be
**charged** 500. There is no rounding rule that satisfies both: dropping the sub-dinar part of a total
breaks MNY-01/02/03, and keeping it breaks REF-35.

## Currency fact

ISO 4217 gives the Algerian dinar **minor unit 2** — one dinar = 100 santeems
(`https://en.wikipedia.org/wiki/ISO_4217` table row `DZD | 012 | 2`, and Adyen's currency table
`DZD | Algerian Dinar | 2`; both read 2026-10-31). A 0,01 DA amount is therefore a valid monetary value,
not a display artefact. Nothing in the currency requires rounding it away.

## Options

| # | Change | Effect | Risk | Cost |
|---|---|---|---|---|
| **A** (recommended) | Correct REF-35 (and REF-87 if it shares the shape) to expect `500.01`, matching MNY-01/02/03 and ISO 4217 | the sale keeps charging what it displays | **edits `e2e-tests/specs` — C01 may not do this without authorisation** | one line + re-run |
| **B** | Treat sub-1-DA lines as "display-only" (charge 0) | REF-35 passes | contradicts MNY-01's explicit contract; gives away real (if tiny) value on every such line; the gift semantic would also need a UI control | larger |
| **C** | Round only *cash* sale totals to whole dinars | REF-35 passes for these tickets | MNY-01/02 are cash sales too — they would break | medium |

**Recommendation: A.** REF-35 is the outlier: every other money case (and the currency standard) says the
cent is charged, and option B would encode "give away value silently" as the rule.

## What would make it DONE

Apply A, then REF-35 3/3, MNY-01/02/03 3/3, and the full `10-mny`, `33-ref`, `34-ref` specs on a fresh
build.

## REF-87 is NOT the same cause (corrected)

The earlier note grouped REF-87 with REF-35 because both printed `500 / 500.01` in the aggregate run. The
stack trace shows REF-87 fails at `33-ref:3199`:

```ts
expect(stagedA).toBe(true);   // the 4 000 000 000 DA ticket is never selectable in the refund modal
```

with the case's own message *"the 4 000 000 000 DA ticket is never selectable in the refund modal (no-row
at 9 s + 30 s)"*. That is an extreme-value selectability problem (huge totals), a separate item.
