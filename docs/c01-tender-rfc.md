# C90 — "Tender credit over-stamp": what the data says (measurement only)

**Status:** measurement + design. No fix in this batch (owner decision Q1).
**Cluster:** `C90 TENDER-CREDIT-OVERSTAMP`, assigned through `cluster.mjs` (no hand edit).
**Case affected:** `REF-28` (FAIL / UNPROVEN), linked here as `blocked-by C01`.
**Evidence grades:** PROVEN / OBSERVED / HYPOTHESIS / KILLED. Only PROVEN is called a root cause.

---

## 1. What was observed (OBSERVED)

`REF-28` fails in isolation at a **sale-side** assertion, before any refund runs. The persisted
sale (S3, dumped from a copied sandbox DB) is:

| Field | Value |
|---|---|
| `total` (column + payload) | **800** |
| `subtotal` / `discount_total` | 1400 / 500 |
| tenders | `Avoir Client 100` + `Espèces 900` |
| `cash_tendered` / `change_due` | **1000 / 100** |
| `payment_method` | `Avoir Client` |
| customer `REF2-CUST` `store_credit` | **300** (400 before the sale) |

The spec asserts `cash tender == payable − loyaltyCap == 800` and gets **900**
(`31-ref-refunds-part2.e2e.ts:1592`).

Arithmetic: the customer owed 800 after applying 100 of store credit; the till recorded 900 cash
"tendered" and gave 100 change, so the shop kept **800 cash + 100 credit = the 900 payable**.
**No money is lost or created** (PROVEN by the four columns above). What is wrong is the
*representation*: the cash leg carries the pre-credit amount and a compensating change.

The same steps produced the correct shape (tenders `100 + 800`, change 0) in **5 of 6** full-spec
runs, and in **0 of 3** isolated runs (OBSERVED; small samples, direction consistent).

## 2. What the code says (PROVEN, file:line)

- `pay-exact` sets the tender field to `netToPay`: `PaymentModal.tsx:1188`.
- `netToPay = totals.total`, and `totals` is computed **with** `storeCreditApplied: appliedCredit`
  (`PaymentModal.tsx:99-108`) — so after "Appliquer Tout" it is 800, which matches the rendered
  `pay-net` (the run logged `pay-net after loyalty: 80000`, i.e. 800).
- "Appliquer Tout" recomputes the tender itself: `cash = netSubtotal − voucher − trade − credit`
  (`PaymentModal.tsx:209-217`), a *different* expression from `submitNet` used at commit
  (`PaymentModal.tsx:300-310`).
- The commit writes the cash leg from `cashTenderAmount` (`submitCash`), not from `submitNet`
  (`PaymentModal.tsx:310, 439-445`).

So the tender field is written by two expressions that are supposed to agree, and the commit trusts
the field. When the field holds 900 and the net is 800, the recorded sale is exactly S3.

## 3. What is NOT proven (HYPOTHESIS / KILLED)

| Claim | Grade | Basis |
|---|---|---|
| The field is set to the pre-credit net by the "Appliquer Tout" handler's expression | **HYPOTHESIS** | the two formulas are equivalent *today* only if `voucherCreditApplied`/`tradeInCreditApplied` are the same values at both points; not instrumented |
| A later state write resets the field to 900 after `pay-exact` | **HYPOTHESIS** | the only writers are lines 135/214/228/242/1188/1201; no ordering was captured |
| A user at normal speed hits this | **UNKNOWN** | not measured; the automation reproduces it 3/3 in isolation and 1/6 in sequence |
| It is only an automation timing artifact | **UNKNOWN** | cannot be separated from the above without a state trace |
| Money is lost | **KILLED** | change_due 100 is persisted and nets the cash leg to 800 |

The order of operations a human would follow is the same as the spec's: apply the credit, read the
net (800), press "Exact", confirm. So the case cannot be dismissed as "the spec clicked too fast"
without a state trace (which would need an app edit this batch forbids).

## 4. Reproduction

```powershell
node .opencode/skills/e2e-testing/scripts/run.mjs `
  --spec e2e-tests/specs/31-ref-refunds-part2.e2e.ts --grep "REF-28" --wipe --tag repro
# expect: Expected 800 / Received 900 at 31-ref-refunds-part2.e2e.ts:1592
# DB: total 800, tenders [Avoir 100, Espèces 900], cash_tendered 1000, change_due 100
```

Deterministic at unit level (no browser): feed `computeCartTotals({storeCreditApplied:100, …})`
(800) and the `handleApplyFullCredit` expression (`netSubtotal − voucher − trade − credit`) into one
assertion; if they diverge for any input, the hypothesis is proven. **Not yet written** — it needs
the two expressions exported or a small pure helper, which is a code change.

## 5. Fix options (not implemented)

| # | Change | Footprint | Gated exposure |
|---|---|---|---|
| **A** | One derivation for "net after credits", used by *both* the apply-credit handler and the commit; `pay-exact` reads the same value | `PaymentModal.tsx:209-245`, `:300-310`, `:1184-1190` (UI only) | none (no schema/sync/auth) — but PaymentModal is **read-only this batch** |
| **B** | Keep the representation, change the spec to compare `cash − change_due` | spec only | rejected unless the owner rules the over-stamp acceptable |
| **C** | Slice-level guard: ignore a tender that over-pays a credit-covered ticket and re-derive it | `createOrderSlice.ts` checkout path | out of C01 §14 scope |

Recommendation: **A**, with a pure helper (`netAfterCredits(...)`) used by both call sites, plus a
unit test that pins `pay-exact → tender == net` and an E2E that asserts the tender leg equals
`net − change`.

## 6. Test plan (deterministic first)

1. Unit: `netAfterCredits(cart, {storeCredit, voucher, trade})` equals `computeCartTotals(...).total`
   for the REF-28 fixture and for 200 random credit/voucher/trade combinations.
2. Unit: `pay-exact` sets the field to that value (component-level or extracted handler).
3. E2E: one case, apply credit → exact → confirm → assert `tenders[cash] == due − change_due` and
   `change_due == max(0, cash − due)`. Run 3× — deterministic if A is correct.

## 7. Impact if left alone

No cash is lost, but every credit-covered sale can print "Espèces 900 / Rendu 100" where the
cashier handed 800, and the Z-report's cash line is gross of change. It also keeps `REF-28`
unprovable, which keeps `CRT-05` red by derivation.
