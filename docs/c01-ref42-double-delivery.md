# REF-42 — card-funded refund delivers twice the ticket value (pre-existing, MONEY)

**Status: OPEN (measured pre-existing, not caused by this pass's changes).** This is the most serious
finding of the sweep: a 700 DA card sale delivers **1 400 DA** of value on refund.

## Observation

Same case, two builds, no code change in the area between them:

| Build | HEAD | REF-42 | Key line |
|---|---|---|---|
| pre-REF-65 build | `eb95527`, binary `8CD63F4B…42D7` | **0/2** | `Espèces attempt: landed=true refRow=700 DA / Avoir Client` → `delivered=1400` |
| REF-65 build | `2b0440e`, binary `D6866555…136B` | **0/2** | identical lines |

Spec expectation: `expect(delivered).toBe(700)` → **Received 1400**. The case's own message:

```
[REF-42] CONFIRMED EDGE-CASE VULNERABILITY [P1]: Espèces-route refund committed for a
card-funded ticket without delivering value to any usable lane (drawer untouched; walletAddBase collapses to …)
```

## What the run shows (OBSERVED)

- Sale: `total=700 method=CIB / Edahabia`, tenders `[{CIB 700}]`, `espècesLegs=0`.
- The cashier picks **Espèces** on that ticket. The refund row is stored with method
  **`Avoir Client`** — so something already re-labels the channel before the request.
- `usableDelivery` then measures **700 wallet + 700 elsewhere = 1400** for a 700 ticket.
- `count('cash_movements')` is unchanged (no drawer movement), which the spec wants; the defect is the
  delivered total, not the drawer.

## Reading (HYPOTHESIS, not yet proven)

Two values are being produced for one refund: the funding split returns the card leg (`digitalShare`,
i.e. "reverse the intake leg") **and** the store wallet is credited for the same amount, because the
refund's stored method is `Avoir Client`. The spec's own truncation ("walletAddBase collapses to …")
points at the wallet base. The precise writer has not been isolated — the fix needs the same
observe-first treatment used for C90 (instrument the wallet write + the funding payload on a diag build),
not a guess.

## Why it was not fixed in this pass

- It is a different case file (`33-ref-refunds-part4`), discovered while regression-testing REF-65.
- The mechanism is unproven; a blind change to the wallet credit would risk the C90/B-2 work.
- The value path involved (`createOrderSlice` wallet credit + the funding lanes) is editable, so this is
  fixable next — but with a RED test first.

## Next step (acceptance check)

Reproduce REF-42 in isolation with the wallet write traced (window buffer, as in
`docs/c01-c90-root-cause.md`), identify whether the double comes from (a) the wallet credit on an
`Avoir Client` refund, or (b) the card leg being paid *and* credited. Then assert
`delivered === ticket total` and run REF-42 3/3 plus REF-65 3/3 plus the full 31- and 33-ref specs.
