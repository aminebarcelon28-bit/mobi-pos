# Decision D12 â€” card refunds and drawer-movement amounts (cases 26 & 34)

- **Status:** cases 26 and 34 are **ACCEPTED residuals**, each with the exact mechanism, the reporting test,
  and the exit criteria. Nothing here weakens a money invariant.

## Case 26 â€” the card lane has no destination of record

**What exists.** `refund_sale_atomic` derives the card leg from the durable ticket tenders (CIB / Edahabia /
BaridiMob / ChÃ¨que) and, when present, **scopes it out of the pre-COMMIT `total == Î£ legs` assertion with a
warning** (`refund.rs`, "rail carte sans destination de remboursement â€¦ hors Ã©quilibre"). The refund still
commits; the cash/wallet/voucher/debt legs are checked, the card part is not.

**Why it cannot be silently fixed.** A destination of record for a card refund is the acquirer: the refund
must be posted against the original authorization (Stripe's rule: a refund can only go back to the original
payment method, and it cannot be redirected). This build has **no acquirer integration** â€” no CIB/Edahabia/
BaridiMob refund API, no terminal-level reversal command, no callback to reconcile. Inventing a local
"card refund" row without an acquirer reference would *manufacture* a destination that no money ever reaches,
which is worse than reporting the gap.

**Options considered.**

| # | Option | Verdict |
|---|---|---|
| A | Record a local `card_refund` row with status `pending_acquirer` | rejected: a row is not a destination; it would satisfy the gate with fiction |
| B | Refuse every refund of a card-funded ticket | **correct but breaking**: spec 30/33/34 exercise card-funded sales and refunds, and a merchant cannot reverse a card sale at all until the lane exists â€” this needs an owner/acquirer decision, not a silent behaviour change on a money path |
| C | Keep the documented scope-out, report it on every run, and gate the feature on the acquirer lane | **chosen** |

**How it is reported, not hidden:** `scripts/refund-value-check.mjs` counts the refund's `total` against the
durable destinations and flags a mismatch (the "16 historical violations" of E-0067 were forged probes plus
this lane). `docs/EDGE_CASES.md` case 26 tracks it. The native warning names the amount on every such refund.

**Exit criteria:** an acquirer refund adapter that returns a reference, a `card_refund` table keyed by
(ticket, refund, acquirer_ref, amount, status) written **inside** the same transaction, and the leg-sum gate
including the card leg. Until then the risk is bounded by: card refunds are not offered in the RefundModal
(methods are EspÃ¨ces / Avoir Client only), so only a forged/IPC caller reaches this path â€” the documented
renderer-trust residual (D11).

## Case 34 â€” `cash_move.amount` is not the refund cash

**Evidence.** A fixture that refunds 150 DA in cash carries `cash_move.amount = 6000`
(`supervisor_pin_bypass_prevention`); the field is a **drawer allocation**, not the payout amount. Comparing
them refused a legitimate refund (that check was reverted, E-0093).

**What was done instead (fail-closed at the right level):** the native now requires a drawer movement for
**any** cash payout, whatever the request's `method` string says (`d4a_cash_payout_requires_a_drawer_movement`),
because the forged lane could otherwise pay cash with no `cash_movements` row at all â€” the actual money-gate
violation. The amount equality is **not** implemented because the field's meaning does not support it.

**Exit criteria:** a schema change that separates `payout_amount` from `allocation_amount` on the drawer
movement, with a migration (backup + dry run) and the refund writing both. Register: case 34 accepted for the
amount half, covered for the presence half.

## Reversal

Nothing to reverse: case 26's behaviour is unchanged (documented scope-out) and case 34's presence guard is a
strict addition. Implementing A/B for card or the schema split for the drawer amounts supersedes this record.


## Update 2026-11-01 — the observable contract is now tested

- A cash refund of a card/cheque ticket is **refused** by the native always-balance gate
  (`INVALID:refund legs do not balance`); REF-67 proves no row and no drawer movement (E-0125).
- An **Avoir** refund of the same ticket delivers the card leg's value (the only destination of record in
  this build) and never disburses cash; REF-06 proves total 500 / cashDisbursed 0 / drawer untouched (E-0125).
- The delivery oracle now counts the wallet **once** (the `store_credit` column and the JSON `storeCredit`
  are the same scalar; summing them reported a 900 DA refund as 1800).
- Still open: the acquirer-side refund table (option A/B in this record) and the drawer-amount split.
