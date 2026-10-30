# C01 — Refund allocation: what is true, what to change (Stage A)

**Status:** design only. No money logic has been changed. Stage B starts only after
`APPROVED C01` with answers to D1–D6.

**Scope:** the 8 rows that made up cluster C01 (`REF-ALLOCATION`) at the start of this batch:
`REF-03`, `REF-28`, `REF-33`, `CRT-05`, `CRT-06`, `CRT-17`, `MNY-26`, `MNY-30`.

**Written for:** the shop owner / product owner. Jargon is explained on first use.

---

## 0. The five lines that matter

1. Two of the three real refund cases are **already green** and were green before this batch:
   `REF-03` (a line share of an invoice discount) and `REF-33` (a bundle child) both pay the exact
   net value, in preview, in storage and in the drawer.
2. The third (`REF-28`, a stacked-discount sale paid cash + store credit) is **green 5 times out of
   6**, including 3/3 repeat runs; the one red observation did **not** reproduce and is **not
   explained yet**.
3. The "allocation is broken, refunds return 405/207 instead of 450/269" text in the case index is
   **stale**: those numbers came from before the current refund code, and the cases now assert and
   observe 450/269.
4. A **real, reproducible defect does exist** one level down, in the function that decides how much
   of a refund goes back as cash vs. store credit: it loses or creates up to **1 DA per credit leg**
   when a mixed ticket is refunded in several steps, and it **double-counts the credit leg** if the
   ticket's `total` already includes it (a full refund of a 669 DA ticket returns 876 DA).
5. Stage B is therefore *not* a rewrite of allocation. It is a small, testable correction to the
   credit lane's arithmetic and to where the per-lane amounts are recorded — and one decision about
   how to catch the unexplained `REF-28` failure.

---

## 1. What "allocation" means in this app

A refund has to answer six questions. "Allocation" is answering them consistently.

| # | Question | Where it lands | Status today |
|---|---|---|---|
| 1 | **How much** is refunded for the returned lines? | refund row `total`, receipt | correct (net of line + invoice discounts) |
| 2 | **Which payment method** gives the money back? | tender legs: cash, card, Avoir, Crédit, Reprise | correct in preview and commit for cash/card |
| 3 | **How much cash leaves the drawer?** | `cashDisbursed`, cash movement row, Z report | correct, capped at cash actually tendered |
| 4 | **What happens to the customer's balance?** | `customers.store_credit`, loyalty points, debt ledger | **defective in two corners** (this RFC) |
| 5 | **What happens to stock?** | `inventory_ledger`, `products.stock`, IMEI events | correct (restock vs. write-off, quarantine) |
| 6 | **What is printed and recorded?** | refund receipt (ESC/POS), audit log row | correct |

The defect is at **#4**, not at #1/#2/#3 — which is why the E2E cases that check money looked green
while a unit-level invariant was red.

---

## 2. The money convention (kept, not changed)

- Money is **integer dinars (DA)** everywhere in the domain; the display adds the decimals.
  Minor units are used only at the edges (the specs compare in `minor = DA × 100`).
- **`total` on a sale excludes value paid with store credit (Avoir) or debt (Crédit).** It is the
  cash/digital share. Example: a 900 DA payable paid 800 cash + 100 Avoir stores `total = 800`,
  while the tender legs sum to 900.
- The refund split's job is to turn "the customer gave 900, of which 100 was credit" into
  "800 back in cash, 100 back to the wallet".
- No floats cross a money boundary. Rounding is `Math.round` on DA, once, at the end of a
  computation.

**Consequence (important):** every piece of code that adds the credit legs to `total` must know
which convention it holds. Today the function does not, and that is defect #2 below.

---

## 3. Ground truth for the 8 rows (measured on `a9fa0ad`, freshly built `target-e2e`)

"Layer (a)/(b)/(c)" = is the *spec's expectation* right, is the *app's behaviour* right, is the
*harness reporting* it faithfully.

| Case | Index before | Measured now | (a) spec | (b) app | (c) harness | Evidence |
|---|---|---|---|---|---|---|
| **REF-03** | FAIL | **PASS** | correct (450 net share) | correct | **was wrong — stale FAIL** | `[REF-03] shownTotalMinor: 45000 rowTotal: 450 cash: 450`, run `c01-truth` |
| **REF-33** | FAIL | **PASS** | correct (269) | correct | **was wrong — stale FAIL** | `refund modal 26900 … committed total=269 cash=269`, run `c01-truth` |
| **REF-28** | FAIL | **PASS ×5 / FAIL ×1** | correct (900 = 800 cash + 100 wallet) | correct in 5 runs; one run left the wallet at 300 | **flake, unexplained** | PASS: `wallet after refund: 400 (before=400)` (solo `c01-ref28b`, order `c01-order`, repeat-run r1–r3). FAIL: `wallet after refund: 300 (before=400)` run `c01-truth` |
| **CRT-05** | FAIL | FAIL (index only) | derived from REF-28 | n/a | **stale derived row, no spec** | no spec anchors it; its canonical case is now PASS |
| **CRT-06** | FAIL | FAIL (index only) | derived from REF-03 | n/a | **stale derived row, no spec** | canonical case PASS |
| **CRT-17** | FAIL | FAIL (index only) | derived from REF-33 | n/a | **stale derived row, no spec** | canonical case PASS |
| **MNY-26** | PASS | PASS | correct | correct | fine | prior session's work, stamped |
| **MNY-30** | PASS | PASS | correct | correct | fine | prior session's work |

**Repeat-run evidence (the flake decision table):** `repeat-run --times 3` on
`31-ref-refunds-part2` → `DETERMINISTIC` for `REF-13`, `REF-36`, `REF-65` (out of C01 scope) and
**`REF-28` PASS in all three runs**. So `REF-28` is not a deterministic failure; it is a low-rate
intermittent one (1 in 6 observations).

**What the red observation showed** (verbatim): refund `total = 900`, `cashDisbursed = 800`,
customer wallet unchanged at 300 instead of returning to 400. In other words the *split* was right
(it produced 800 cash + 100 credit — otherwise the stored total would have been 800, not 900) but
the 100 never reached the wallet.

Two candidate mechanisms, **neither verified**:
- **H1** the ticket object handed to the refund had no customer link (`customer` null) while its
  tenders were present, so the "credit the wallet" branch was skipped;
- **H2** that object's tender array was absent, making the credit share 0 and the cash cap fall back
  to `total` (this is the only way 800 cash + 900 total arises without a 100 credit share).

H1 and H2 are mutually exclusive and both fit the numbers. Per the programme rule (two failed
hypotheses on one root cause → stop and ask), I am stopping here and putting it to you as **D6**.

---

## 4. Current-state map (read-only trace of the refund path)

```
UI            RefundModal.tsx:412  totalRefundAmount = Σ line refund amounts (net)
              RefundModal.tsx:432  computeRefundFundingSplit(...)      ← preview
              RefundModal.tsx:440  clampCashRefund(...)               ← preview cash cap
State         createOrderSlice.ts:2186  computeRefundFundingSplit(...)  ← commit split
              :2218 clampCashRefund                                    ← commit cash cap
              :2238 cashOut
              :2254 walletAddBase = avoirShare + cashOverflow + (method=='Avoir' ? cashShare : 0)
              :2355 if (originalTransaction.customer) { … wallet, points, tier … }
              :2410 creditToAdd = walletAddBase + tradeRestoreNow
              :2445 updatedCustomer.storeCredit
              :2561 refundTransaction { total: valueReversed, cashDisbursed: cashOut, … }
Persistence   :2928 refundSaleNative(...)        ← native single transaction (all-or-nothing)
              :3016 persistWithRetryOnce(repo.save(hydratedCustomer))  ← SQLite first
              :3032 enqueueGenericSync('customer', …) → Dexie mirror → cloud
Native        refund.rs: writes refund row, ledger deltas, stock, IMEI, audit, points, debt.
              It does NOT write customers.store_credit (that is TS-only).
Adapters      transactionAdapter.ts:257-259  hydrates `customer` from payload or customer_id
              sqlPluginAdapter.saveCustomer    authority write
Drawer        cashTerms.ts:344 physicalCashTendered, :383 clampCashRefund
Stock         createOrderSlice.ts:2329 restock/write-off, FIFO batches, IMEI events
Receipt/audit createOrderSlice.ts:2636 audit entry; ESC/POS refund receipt
```

**What exists** (and must not be re-invented): the net-value basis, the pro-rata ratio, the
cash clamp, the native atomic write, deterministic refund ids (idempotency), stock/IMEI handling,
the audit row, the offline cash cap.

**What is absent / wrong:**
- no record of the **per-lane split** on the refund row (only `cashDisbursed` and `total`), so
  cumulative conservation across partial refunds cannot be computed — this is the root of both
  arithmetic defects below;
- the split is **not convention-safe** (`total` including credits is double-counted);
- the wallet credit is applied inside `if (originalTransaction.customer)` with no fallback: if the
  link is missing the refund still pays cash (a silent asymmetry).

**Gated areas:** the split lives in `src/utils/receiptMath.ts` → **money arithmetic, owner-gated**.
Persistence changes would touch the schema only if we choose columns (see D2); the recommended
option avoids any migration. No sync-protocol, auth or PIN change is proposed.

---

## 5. The reproducible defect (three red unit tests, already written)

Added to `scripts/test_refund_root_invariants.mts` (section **I4b**), run with
`npm run test:refund-root`. Six checks are red today for the right reason:

| Check | Observation | Why it matters |
|---|---|---|
| full refund never returns more than was handed over | ticket 669 DA (462 cash + 207 avoir, `total` includes the credit): refund **876** | mints 207 DA — exactly the credit leg counted twice |
| full refund returns exactly 669 | 876 | same |
| cash share is 462 | **669** | the shop would hand cash for value it issued as credit |
| lanes always sum to the net (5 000 random tickets) | 1 shape fails | a rounding overshoot creates 1 DA from nothing |
| refund never exceeds what was handed over (5 000 random tickets) | **223/5 000 shapes** | the convention bug is systemic, not a one-off |
| three partials conserve the credit lane (100 DA) | 33 + 33 + 33 = **99** | 1 DA of the customer's credit is lost per ticket refunded in three steps |

The last one is live for any mixed ticket refunded in several visits — small, but it is exactly the
"nothing created, nothing lost" rule the owner asked for.

---

## 6. Proposed rules (R1–R6)

- **R1 — value from net lines.** A refund is the net value of the returned lines
  (`appliedPrice − line discount`), never gross. *Already true; keep.*
- **R2 — return what was given, pro-rata.** `netRefund = G × (returned net ÷ ticket net)`, where
  **G = what the customer handed over, counted once** = cash + card + Avoir + Crédit + Reprise +
  voucher. *Today G is mis-derived when `total` includes credits (D1).*
- **R3 — each source returns to its origin.** cash → drawer; Avoir → wallet; voucher → voucher;
  Crédit → reduces the debt; card/Chèque/BaridiMob → its rail. **Never** cash for credit.
  *Already true.*
- **R4 — cash cap.** Cumulative cash returned ≤ cash actually tendered; the excess becomes wallet
  credit. *Already true (`clampCashRefund`).*
- **R5 — conservation across partials.** For every lane, the sum over all refunds of a ticket equals
  that lane's original amount, exactly. **This is the new rule** (D3).
- **R6 — never more than remains.** Per line (remaining quantity × net unit) and per lane (remaining
  lane value). *Per line already true; per lane is new and is what R5 gives you.*

### Worked examples (all in DA, integers)

**E1 — the `REF-28` ticket, refunded in full.** Subtotal 1400, invoice discount 500 → net 900.
Paid 800 cash + 100 Avoir.
`G = 900`. Returned net 900 → ratio 1 → netRefund 900. Avoir share `round(900 × 100/900) = 100`.
Cash plug `900 − 100 = 800`, cap `min(800, 800) = 800`.
**Moves:** 800 out of the drawer, +100 to the wallet, refund row `total 900`,
`cashDisbursed 800`, wallet 300 → **400**. Nothing created, nothing lost.

**E2 — same ticket, one line worth 579 returned.** ratio `579/900`.
Avoir `round(579 × 100/900) = round(64.33) = 64`; cash `579 − 64 = 515`.
**Moves:** 515 cash, +64 wallet, row total 579. Remaining refundable 321.

**E3 — same ticket, three refunds of 300.** Today: Avoir `round(33.33) = 33` each → **99**, 1 DA
lost. Proposed: compute on the **cumulative** basis and subtract what was already returned —
`33` then `33` then `34` = **100**. Cash per step `267 / 267 / 266` = 800. Row totals 300/300/300.

**E4 — the double-count guard (D1).** Ticket 669 with `total` already including the 207 Avoir:
today a full refund returns **876**. Proposed: `G = max(total, Σ tenders + voucher) = 669`, so the
refund is **669** (462 cash + 207 wallet), not 876.

---

## 7. Rounding rule and why the parts always sum to the refund

1. All amounts are integers in DA.
2. For each **non-cash** lane L, the cumulative amount after this refund is
   `s_L = round(N × L ÷ G)` where `N` is the cumulative net refunded (including this one).
3. This refund's lane amount is `s_L − (already returned in L)`.
4. Cash for this refund is `(netRefund − Σ non-cash this refund)`, capped by R4; any excess goes to
   the wallet (R4), never to another lane.
5. **Why nothing is lost:** after the final refund `N = G`, so `s_L = round(G × L ÷ G) = L` for every
   lane — each lane is back to its original amount, and the cash total is `G − Σ L` = cash tendered.
   Because each step subtracts what was already returned, the sum of the steps telescopes to `L`;
   no step can be negative (the cumulative amount is monotone in `N`).
6. **Guard:** `round` can overshoot by 1 in rare shapes (measured: 1 in 5 000). When
   `Σ non-cash this refund > netRefund`, reduce the **largest** non-cash lane by the excess
   (deterministic tie-break: larger amount, then lower lane index) and re-check. This keeps rule 4
   (cash never negative) and keeps the sum exact.

---

## 8. Edge cases and expected outcomes

| Situation | Expected | Today |
|---|---|---|
| Several partial refunds of one mixed ticket | per-lane sums equal the original lanes exactly (E3) | **off by ≤1 DA per lane** |
| Refund above what is still refundable (per line) | steppers bounded by remaining; submit refuses | correct |
| Refund above what is still refundable (per payment) | cash capped at cash tendered; excess → wallet | correct |
| Stacked discounts (line + invoice + coupon + loyalty) | one net basis, preview == commit == storage | correct (REF-28, 5/6) |
| Double-click / retry | one refund row (deterministic id), no double payout | correct (`test:double-refund`) |
| Crash mid-refund | nothing or everything (native single transaction) | correct |
| Customer with an outstanding balance | debt lane reduces the debt, never cash | correct (`REF-65` covers it) |
| Refund after the drawer/shift closed | refused: `NO_OPEN_SHIFT` | correct |
| Restock vs. write-off | restock returns stock + COGS credit; write-off quarantines and books a loss memo | correct |
| Refund of a ticket whose `total` includes credits | never more than was handed over (E4) | **wrong (876 vs 669)** |
| Refund when the wallet write fails | the refund must not pay cash while the credit evaporates (D4) | **silent asymmetry** |
| Receipt and audit trail | show cash and credit separately | correct |

---

## 9. Invariants (these become the property tests)

- **I1** lanes sum to the net: `voucher + avoir + debt + cash + digital == netRefund`.
- **I2** the refund never exceeds what the customer handed over; a full refund equals it exactly.
- **I3** cash returned ≤ cash tendered − cash already returned.
- **I4** per-lane conservation across all refunds of a ticket (R5).
- **I5** credit and voucher lanes are never disbursed as cash or card.
- **I6** monotone: a larger returned net never yields a smaller refund.
- **I7** idempotent: the same refund identity writes one row.

I1, I2, I3 and I5 are already asserted (6 red today). I4 and I6 are added in Stage B.

---

## 10. Owner decisions (answer as `D1=A, D2=B, …`)

**D1 — Which `total` convention is authoritative?**
- **A (recommended).** `total` excludes credit legs. Derive the funding base defensively:
  `G = max(total, Σ tenders + voucher)` so a stray credit-inclusive row can never mint money.
- B. `total` includes credit legs; change the derivation to subtract them.
- C. Detect the convention per row and branch (most code, two paths to keep in sync).
*Consequence of A:* one guard line in the split; E4 goes from 876 to 669; no data migration.

**D2 — Where do the per-lane amounts live so partial refunds can be conserved?**
- **A (recommended).** In the refund row's existing JSON payload (`funding: {cash, avoir, voucher, debt, digital}`). No schema change, no migration, already synced with the receipt.
- B. New columns on `transactions` (cleanest to query, but a **migration** — gated, and it touches the sync payload contract).
- C. Derive from `total − cashDisbursed` (no schema, but ambiguous as soon as a card leg exists).
*Consequence of A:* conservation becomes exact; nothing to migrate; the native row keeps its current columns.

**D3 — Rounding across partial refunds?**
- **A (recommended).** Cumulative basis + cash plug + largest-lane correction (§7). Conserves exactly.
- B. Largest-remainder per refund: each refund is exact internally, but the last one absorbs the drift.
- C. Keep today's per-refund rounding: ≤1 DA lost or created per lane per ticket.
*Consequence of A:* `I4b/d` goes 99 → 100; needs D2 so "already returned" is readable.

**D4 — What if the wallet credit cannot be written (SQLite error)?**
- **A (recommended).** Fail the whole refund: no cash out, no stock change, customer keeps the sale. The credit leg is the customer's money.
- B. Keep today's behaviour: complete the refund, queue the customer write, warn loudly.
*Consequence of A:* a rare local-disk failure becomes a visible refusal instead of a silent loss. Behaviour change — needs your explicit approval.

**D5 — `CRT-05/06/17`: derived rows with no spec.**
- **A (recommended).** Anchor each to its canonical case (`CRT-06→REF-03`, `CRT-17→REF-33`, `CRT-05→REF-28`) and have the dashboard derive their verdict from the anchor (no duplicate runtime).
- B. Give each its own spec case (triples the runtime for the same evidence).
- C. Retire them as facets already covered.
*Consequence of A:* the index stops holding three red rows whose evidence is green; needs a small reconcile rule ("derived row").

**D6 — `REF-28`'s single unexplained failure.**
- **A (recommended).** Add one temporary diagnostic line (split inputs, customer id, tender count) and run `31-ref` 10× to catch it before Stage B calls the row fixed; remove the line afterwards.
- B. Accept it as a flake; require `repeat-run --times 3` for this spec in the release gate.
- C. Block C01 until it reproduces.
*Consequence of A:* ~45 min of machine time, and we either find H1/H2 or prove the flake is elsewhere.

**D7 — Offline cash cap (found while testing, not C01).**
`REF-86` failed because this shift's offline cash-refund ceiling was already spent, so the refund
could not be settled in cash. The product behaviour looks correct; the spec assumes unlimited cash.
- **A (recommended).** Handle it in its own batch (spec must model the cap or run in a fresh shift).
- B. Treat it here.
*Consequence of A:* C01 stays small; `REF-86` is recorded as an environment/ordering finding.

---

## 11. Gate impact of the recommended options

| Area | Touched by Stage B? | Gate |
|---|---|---|
| Money arithmetic (`src/utils/receiptMath.ts`) | yes — D1 guard, D3 cumulative rounding | **owner-approved only** (this RFC) |
| Money application (`src/store/slices/createOrderSlice.ts`) | yes — pass prior lanes, write `funding` into the payload | owner-approved only |
| Preview (`RefundModal.tsx`) | yes — same helper, same numbers | normal |
| Schema / migration | **no** (D2=A) | — |
| Sync protocol / outbox | **no** (payload already syncs) | — |
| Auth / PIN / roles | **no** | — |
| Native (`refund.rs`) | **no** (it does not touch `store_credit`) | — |

**No-schema alternative exists and is the recommendation** (D2=A).

---

## 12. What goes wrong in a shop if this is done wrong

- **Under-refund** (today's 1 DA drift, or a wallet credit that never lands): the customer is short
  and the shop's books still balance — invisible until the customer complains. At 30 refunds a day
  that is ~30 DA/day of lost goodwill and an unreconcilable wallet.
- **Over-refund** (E4): a credit-funded ticket pays cash for value the shop issued as credit; a
  dishonest operator can convert store credit into cash at will.
- **Drawer mismatch at Z**: if the cash leg ever absorbs a credit leg, the till is short at close and
  the Z report blames the cashier.
- **Audit/receipt disagreement**: if the split is not recorded, a disputed refund cannot be
  reconstructed from storage — only from the printed receipt.

---

## 13. Test plan

**Already written and running (Stage A):** `scripts/test_refund_root_invariants.mts` §I4b —
9 checks, **6 red** (listed in §5), 92 green including all pre-existing invariants.

**Stage B additions (after approval):**
1. `I4b` turns green; `I4`/`I6` property cases added (partial-refund conservation, monotonicity).
2. `31-ref-refunds-part2 [REF-28]`: assert the wallet delta equals the avoir share and
   `total == cashDisbursed + walletDelta` (this is the assertion that would have caught the 300 case).
3. New case **`REF-92`** — "three partial refunds of a cash+avoir ticket conserve the credit lane to
   the dinar" (registered in `CASE_INDEX.csv` before the first run, per Gate 2).
4. Red→green proof per row: revert the fix, show the case red, restore, show 3/3 green.

---

## 14. Proposed Stage B change list (minimal)

| File | Change | Case/invariant |
|---|---|---|
| `src/utils/receiptMath.ts` | D1 base guard; D3 cumulative rounding + largest-lane correction; accept prior per-lane amounts | I1–I5, REF-28, REF-92 |
| `src/store/slices/createOrderSlice.ts` | read prior lanes from refund payloads; write `funding` into the refund payload; D4 (if A) abort on wallet-write failure | REF-28, REF-92 |
| `src/components/modals/RefundModal.tsx` | pass the same prior lanes to the preview | REF-28 |
| `e2e-tests/specs/31-ref-refunds-part2.e2e.ts` | wallet-delta / total identity assertions | REF-28 |
| `e2e-tests/specs/32-ref-refunds-part3.e2e.ts` | new `REF-92` case (three partials) | REF-92 |
| `e2e-tests/CASE_INDEX.csv` | add REF-92; anchor CRT-05/06/17 per D5 | bookkeeping |
| `scripts/test_refund_root_invariants.mts` | I4/I6 properties | — |

Nothing outside this list. Anything that turns out to need a wider change stops the batch and comes
back as a question.

---

## 15. What I did NOT do, and why

- **No money logic changed.** Stage A only.
- **No spec expectation changed silently.** The `REF-03`/`REF-33`/`REF-28` evidence strings in the
  index were rewritten to the measured behaviour (they claimed 405/207, which the app no longer
  does); the assertions themselves were not touched.
- **No fix for `REF-28`'s intermittent failure.** Two hypotheses, neither verified (D6).
- **No work on `REF-13/36/65/86/91/15/66`** — other clusters, still red, unchanged.
- **No schema/migration, no sync, no auth change.**
- **`CRT-05/06/17` left FAIL** in the index because no pipeline path can re-verdict a derived row
  (D5); their evidence is now green and the rows should not be trusted as "app broken" until then.
