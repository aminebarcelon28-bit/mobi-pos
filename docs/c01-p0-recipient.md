# P0 — Avoir refunds require a recipient (owner ruling: fail closed)

## Rule and where it is enforced

`src/utils/refundGuards.ts → avoirRecipientRefusal({ method, hasCustomer, avoirShare })`

A refund that pays into a wallet needs a recipient. Two shapes are covered:
1. the cashier chose **Avoir Client** (manual, online or offline), and
2. the original ticket was **paid with store credit**, so the funding split carries an avoir lane.

An anonymous ticket has nobody to credit → **refuse before any write**.

Wired into `src/store/slices/createOrderSlice.ts` at two points, both before the native
request (`:2875`) and before any ledger/inventory write:

- right after the voided-ticket guard — `refundMethod === 'Avoir Client'` and no
  `originalTransaction.customer.id`;
- right after the funding split — `funding.avoirShare > 0` and no customer.

Return code `AVOIR_RECIPIENT_REQUIRED`. Because nothing is written before the refusal, a refused refund
leaves **no refund row, no restock, no dedup hash, no voucher, no cash movement, no parked movement** —
the leg is part of the refund transaction and aborts it.

## Refusal UX (terminal, no switch loop)

`RefundModal.tsx`:

- `AVOIR_RECIPIENT_REQUIRED` → terminal error toast, no method change.
- `OFFLINE_CASH_CAP_EXCEEDED` on a ticket **with** a customer keeps the existing
  switch-to-Avoir-and-confirm path; on a ticket **without** a customer it is now a **terminal** message
  (no `setRefundMethod`), which removes the re-validation loop that produced the in-suite REF-87 failure.

Copy in FR / AR / EN: `src/i18n/refundMessages.ts` (`avoirRecipientRequired`, `avoirRecipientOffline`);
FR/AR are the app's shipped locales, EN is carried for completeness.

## Proof by execution — every anonymous entry point (E-0062)

`e2e-tests/diag/p0-avoir-recipient.e2e.ts` (new diagnostic file, no catalog case; no existing spec
edited), **3/3 green**, each case asserting `snapshot(after) === snapshot(before)`:

| Entry point | Result |
|---|---|
| manual **Avoir Client**, anonymous | refused; refunds 0, dedup 0, stock unchanged, vouchers 0, cash 0, parked 0; body names the Avoir/client reason |
| **offline cash cap**, anonymous | **terminal** — the method stays `Espèces` (no silent switch), zero rows written, body names cap/Avoir/reconnect |
| **replay** (two submits), anonymous | refused both times, zero rows written |

## Unit tests (E-0063)

`scripts/test_refund_guards.mts` → **24 passed / 0 failed** (was 17). New cases: anonymous Avoir refused;
anonymous funding-avoir refused; customer-attached allowed (both shapes); anonymous cash-only allowed;
cap-switch entry refused; replay entry refused.

## RECONCILED money gate (owner item 3)

`scripts/refund-value-check.mjs` computes, per COMPLETED refund, the residual wallet leg
`total − cash_movements − credit_vouchers − sync_parked_movements − debt − digital` and fails when:

- the refund declares a cash disbursement but no `cash_movement` is attributed, or
- attributed cash exceeds the declared disbursement, or
- a **positive wallet leg has no recipient** (the P0).

`reconcile.mjs --db <path>` runs it (and `--audit-dbs` scans every retained E2E database).

| Run | Result |
|---|---|
| **historical audit** — 23 retained DBs (E-0058 and every earlier copy) | **86 completed refunds, 7 violations**, all the REF-87 P0 (`REF-184646C3`, `REF-17464530`, `REF-2B3BE9B3`, `REF-5F98450B`, `REF-8974735F`, `REF-A2F69253`, `REF-A1F690C0` — each `wallet leg 2 000 000 000 DA with NO recipient`); 7 `REF-FORGE-*` negative-control writes excluded (deliberate bypass, no movement by design) — E-0064 |
| **fresh post-fix DB** (full 33-ref) | **20 completed refunds, 0 violations**, and **0 anonymous Avoir refunds** — E-0065 |

## Positive path (owner item 4)

From the fresh DB: every Avoir refund with a recipient has a matching wallet —
`REF-FB80868D` 700 DA → `REF4-C42` 700; `REF-428739A7` 1 000 DA → `REF4-C51` 1 000;
`REF-DFC41589` 500 DA → `REF4-C56` 500 (E-0065). `REF4-C87`'s 200 000 000 is an app-generated
"Solde d'Avoir initial reporté" credit-genesis adjustment, not a refund (checked: no refund row, no debt).

## REF-87 after the authorised fixture change

The fixture now attaches `REF4-C87` to the sale. Isolated runs then failed at **selection**
(`expect(stagedA).toBe(true)` → "no-row at 9 s + 30 s", the 95 MB selectability flake), not at the
recipient rule — 0/3 in this configuration (E-0066). Full `33-ref` after the change: **15/18, identical
to E-0054** (REF-35, REF-42, REF-87) — **delta 0** (E-0066). REF-87 stays parked.

## Spec dependencies (owner item 5)

Specs that relied on an **anonymous over-cap Avoir** refund: **only REF-87**. Confirmed twice — the
historical audit's 7 violations are all REF-87 chunks, and the fresh DB has `ANON_AVOIR = []`. No other
spec depends on the now-refused behaviour, so no other spec edit is requested.

## REF-42 in light of this ruling

The ruling answers REF-42's *recipient* question for **Avoir** refunds: a wallet leg with no customer is
refused, never written. What remains for REF-42 is the **card** lane, where the schema has no recipient at
all:

- **A (recommended, unchanged)** — correct the case's `usableDelivery` to count the wallet once
  (`effCredit` semantics). It is a measurement fix: the app credits 700 once; the case sums column +
  payload and reports 1400.
- **B (now narrower)** — deliver card refunds as a `credit_vouchers` bon d'achat instead of a wallet
  credit. The recipient ruling does not apply (a voucher is bearer paper), so B stays viable, but it
  changes what the customer receives and needs your explicit call.
- **C** — refuse card refunds entirely: still rejected (value evaporation), and now clearly inconsistent
  with the fail-closed rule, which refuses only when *nobody can be credited*, not when a rail exists.
