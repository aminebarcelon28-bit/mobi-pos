# REF-87 — owner answers (1a, 1b, 3, 4) and a P0 money defect found while proving them

## P0 — MONEY DEFECT: an offline cash-cap refund on a ticket with NO customer evaporates the value

Measured on the isolated REF-87 run (E-0058), 4 000 000 000 DA ticket:

| What | Value |
|---|---|
| sale customer | **`null`** (anonymous ticket, `tenders=[Espèces 4000000000]`) |
| refund rows | 2 × `COMPLETED`, method **`Avoir Client`**, `cash_tendered = 0` |
| `cash_movements` | **0** |
| `credit_vouchers` (+ outbox) | **0** |
| wallet of the only candidate customer (`REF4-C87`, not attached to the sale) | `store_credit = 0` |
| `sync_parked_movements` | **0 rows** |
| stock | restored (2 × `REFUND +1`) |

So the 4e9 is booked as refunded, the stock is restored, and **no value reaches anyone**: no drawer
movement, no wallet, no voucher, nothing parked. That is value evaporation, and it contradicts my
previous line "no money lost" — that claim is withdrawn.

Why it happens: the offline cash cap refuses the cash lane (`createOrderSlice.ts:2285`, **before** the
native request at `:2875`), the modal parks the request and switches the method to `Avoir Client`
(`RefundModal.tsx` `OFFLINE_CASH_CAP_EXCEEDED` branch), and the re-submit commits an Avoir leg whose only
possible recipient is `originalTransaction.customer` — which is `null` here, so the wallet write block is
skipped. The ticket lands, the money goes nowhere.

This is the same recipient problem as REF-42, and it is why I did **not** implement B′: B′ would make
this loss one click instead of two. B′ needs the anonymous-ticket rule below first.

## (1a) Connectivity timeline — offline in BOTH cases; no flip, no leak

Instrumented every submit (worktree only) with `navigator.onLine` + the probe verdict:

- **Suite (18 cases, 110 diag rows):** **every** `submit-enter` logged `"online":false`, from the first
  case at 06:08:35 to the last at 06:14:56 (E-0056).
- **Isolated REF-87:** `"online":false` on every submit as well (E-0056), with `shiftCap: 10000`.

Mechanism (`RefundModal.tsx:116-136`): `onlineNow` is seeded from `navigator.onLine`, then **replaced by
`probeOnline(2500)`**; the E2E sandbox has no route to the Turso endpoint, so the probe returns false and
the modal is offline for the whole session. There is no `online`/`offline` event in the logs and no
spec that flips it.

**Classification: intended E2E configuration (offline sandbox) — not leaked state, not false-offline.**
The premise "offline in-suite, online alone" is not supported by the measurements; the differentiator
between pass and fail is timing, not connectivity.

## (1b) Who closed the dialog — the APP, on success

From the same instrumented run (E-0057), one chunk:

```
06:16:09.495 submit-enter   {method:"Espèces", total:2000000000}
06:16:09.499 slice-cap-block {shiftCashOut:0, cashOut:2000000000, shiftCap:10000, method:"Espèces"}
06:16:09.505 submit-result  {ok:false, reason:"OFFLINE_CASH_CAP_EXCEEDED"}
06:16:09.505 cap-exceeded   {}                       <- modal switches to Avoir, asks to re-validate
06:16:13.237 submit-enter   {method:"Avoir Client"}   <- helper's re-submit (PIN + click)
06:16:13.238 submit-enter   {method:"Avoir Client"}   <- same tick (guard makes the 2nd a no-op)
06:16:13.642 modal-close    {}                        <- 405 ms later
06:16:13.642 submit-result  {ok:true}
```

The close is emitted in the **same millisecond as the successful result**, i.e. by the app's own success
path; the helper only clicked submit. When the commit takes ~20 s (4e9 ticket) the close lands while the
helper is typing the PIN for its next re-validation → `refund-pin` never appears. That is the exact
in-suite failure.

## (3) Money check for the in-suite failure itself

- The cap refusal is **pre-native** (`createOrderSlice.ts:2285` precedes `nativeReq` at `:2875`), so the
  first submit creates **no refund row, no dedup hash, no parked movement** (E-0059: `slice-cap-block`
  and `submit-result false` in the same millisecond, and `refund_dedup` only ever holds the two hashes
  that actually committed).
- A parked cash refund therefore **cannot later settle as cash**: there is no parked object and no native
  request attached to it; the only thing that can commit is a new request, and it commits with the method
  displayed at that click (`Avoir Client`).
- The failure itself is not a double payment: 2 refund rows for 2 units, `refund_dedup` 2 hashes, stock
  restored exactly once, `cash_movements = 0`.
- But it is **not** "no money lost" either — see the P0 above: the committed Avoir has no recipient.

## (4) Regression tests added (unit level, specs untouched)

`scripts/test_refund_guards.mts` → **17 passed / 0 failed** (E-0060), against
`src/utils/refundGuards.ts` which the app now actually uses:

| Property requested | Test |
|---|---|
| two same-ms submits yield **one** submit | `createSubmitGuard`: two `tryEnter()` in one tick → `1`; busy; reusable after `leave()` (and the modal's double `submit-enter` rows above are exactly this case) |
| PIN for refund A must not authorise refund B | `pinAuthorisesTicket`: A→A true, A→B false, null blank false; wired into the modal's gate with a `managerPinTicket` binding set on typing |
| `refundBasis` read from SQLite right after commit | `committedRefundBasis(union, durable)` = max, incl. union-blind (`0,1 → 1`), union-ahead, NaN and negative cases; plus `refundIdentity` basis-sensitivity (identical basis → identical hash, `basis+1` → different hash) |

`reconcile`/`selftest`/unit suite all green; REF-87 alone still **2/2** on the new build `6548F47D`
(E-0061).

## Recommendation (needs your word — it is the same decision as REF-42 B)

For an offline cash-cap Avoir refund **with no customer**, the app must not book a refund it cannot
deliver. Two coherent options:

1. **Refuse fail-closed** (`CUSTOMER_UNAVAILABLE`-style) and tell the cashier to identify the customer or
   pay within the cash cap; or
2. **Issue a `credit_vouchers` "bon d'achat"** for the blocked amount (a real redeemable instrument already
   in the schema) and record it in the refund payload.

Option 2 is the only one that keeps REF-87's "two chunks must land" contract, and it is the same
mechanism REF-42 option B proposes. Until you choose, B′ stays unbuilt and this P0 stays open.
