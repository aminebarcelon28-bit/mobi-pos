# Change requests 1–5 — status, evidence, blockers

## 1. Write path — BLOCKED on the read-only native lane

The ruling asks for the wallet leg to abort the refund, with refund row + restock + settlement in one
SQLite transaction. The settlement does **not** live in that transaction:

| Effect | Where it commits | Evidence |
|---|---|---|
| refund row, ticket status, `refundedItems`, inventory ledger (+ restock) | native `refund_sale_atomic`, one `BEGIN IMMEDIATE` (`refund.rs` header lines 3-36; inserts at `:1190`, `:1294`, `:1548`) | read |
| **wallet credit (Avoir Client leg)** | TypeScript **after** the native commit — `createOrderSlice.ts:3117-3118` `persistWithRetryOnce(() => repo.save(hydratedCustomer))` | read |

`NativeRefundRequest` carries no store-credit field (`refundNative.ts:139-160`) and `refund.rs` mentions no
`store_credit`, so the native command cannot settle the wallet. Therefore a throw at the TS wallet write
**cannot abort the refund** — the money is already committed. A write-time throw would be theatre, not an
invariant, so I did not add one.

**What would satisfy the ruling:** the D4-A option already documented — extend `refund_sale_atomic` with
`customer_store_credit_after` (validated, written in-txn) and make the TS write a read-back mirror. That
edits `src-tauri/src/refund.rs`, which is on the read-only list. **Decision required: lift the gate for
that file, or accept the two-phase settlement and keep the fail-closed precondition (current state).**

## 2. Money gate — DONE

`scripts/refund-value-check.mjs` now asserts **equality** per COMPLETED refund:

```
total == cash_movements + wallet credit + credit_vouchers + sync_parked_movements + card reversal
```

- destinations of record: cash by refund receipt (`[AVOIR-…]` in the movement reason), wallet by the
  `creditDeltaDzd` ledger emission keyed to the refunded **sale** and matched as the residual, vouchers and
  parked rows by reference;
- **the card lane records no destination** in this schema — reported as such, never exempted;
- **no exclusions in audit mode**: `REF-FORGE-*` rows must fail, and they do;
- default E2E run (`run.mjs`) runs it on the run's DB with negative-control writes excluded and **blocks**
  (the run is red if it fails); `reconcile.mjs --audit-dbs` only reports.

| Run | Result |
|---|---|
| fresh post-fix DB, default mode | **20 refunds, 0 violations** (E-0067) |
| fresh DB, audit mode | **2 violations — both `REF-FORGE-*`, as ruled** (E-0067) |
| 25 retained DBs, audit mode | **16 violations**: forged rows + the REF-87 P0 `2e9` rows (E-0067) |

## 3. Selection regression — one pass done, conclusion OPEN

Measured factor comparison from the existing logs (E-0071):

| Fixture | sale `json_payload` |
|---|---|
| anonymous (E-0054) | 95 687 006 B |
| customer attached (E-0066) | 95 702 604 B |

**+15 598 B = +0.016 %.** A 0.016 % payload increase cannot explain 5/5 → 0/3, so the "96 MB payload"
explanation stays withdrawn and the fixture is **not** disproven as the trigger — it remains the only
changed factor. The failure itself is at *selection* (`expect(stagedA)` → "no-row at 9 s + 30 s"), which is
the modal's DB fallback parses the full row (`transactionAdapter.ts:467-478`, `SELECT *` + payload mapping).

Not yet run (requires several isolated runs): the full one-factor matrix (customer vs anonymous × sale
size × amount ≥ 2³¹) and the 2³¹+1 / 4e9 wallet-loyalty-native credit proofs. **Those remain open.**

## 4. REF-42 — DONE (narrow authorisation honoured)

`usableDelivery` now derives delivery from the **destination of record** (wallet balance column delta,
counted once) + cash + voucher vault; the payload mirror is asserted **separately**
(`creditRaw(C42).payload == creditRaw(C42).col`) so a mirror drift can never read as a second payment.

```
[REF-42] Espèces leg committed: delivered=700
[REF-42] outcome: row=700 DA / Avoir Client delivered=700 outboxDelta=700 movesDelta=0 refunds=1
REF-42: 3/3
```

The diag additions you asked for (anonymous card-paid refund → refused/zero rows; PIN A ≠ ticket B) are
**not yet added**; the PIN property is covered by the unit test (`pinAuthorisesTicket`) and the anonymous
Avoir refusal by the three-case diag. Both E2E additions are still to do.

## 5. REF-87 in-suite helper — NOT STARTED

It depends on (3). B′ stays shelved.

## Full 33-ref delta (E-0069)

**15/18** (E-0054 was 15/18): **REF-42 now PASSES** (+1); **REF-51 failed once** with
`refund-submit not clickable` — the same harness flake documented at baseline (E-0033: 1 failure in 5
runs), so −1 is the flake, not a regression; REF-87 still fails at selection; REF-35 unchanged.
The run's own **money gate passed** (`moneyViolation: none`).
