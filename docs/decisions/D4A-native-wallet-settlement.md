# Decision D4-A — the Avoir wallet leg settles inside `refund_sale_atomic`

- **Status:** implemented (`6b3bd6f`), reviewed below; gate lift on `refund.rs` + `refundNative.ts` +
  one TS call site expires at merge, then re-locked.
- **Owner ruling this implements:** two-phase settlement is not accepted; no build with Avoir refunds
  reaches a real store until the wallet leg commits with the refund.

## Options considered

| # | Option | Outcome |
|---|---|---|
| A1 | Keep the TS post-commit wallet write, add a pre-check | rejected by the owner: a credit that cannot be written is skipped after the money committed |
| **A2** | **Optional `wallet_credit` field; increment + `creditDeltaDzd` ledger emission inside the native transaction; recipient gate native; pre-COMMIT leg balance; TS mirrors the returned balance** | **chosen** |
| A3 | Compensating reverse-refund when the wallet write fails | rejected: the compensation fails the same way and creates a phantom second movement |
| A4 | Absolute "store_credit_after" computed in TS and written natively | rejected: a stale client value could overwrite a concurrent credit; increments computed in-transaction cannot |

## Evidence (primary sources, accessed 2026-10-31)

1. **SQLite — transactions** <https://sqlite.org/lang_transaction.html> (page last updated 2026-02-18).
   `BEGIN IMMEDIATE` starts the write transaction immediately; `COMMIT`/`ROLLBACK` bracket it; a failed
   statement can leave the transaction open, so an explicit `ROLLBACK` is the deterministic response.
   → the wallet row and its ledger emission must be statements **inside** the existing transaction, and
   any failure must return an error so the caller rolls back the whole refund.
2. **Stripe — refund destinations** <https://docs.stripe.com/refunds>. A refund can only go back to the
   original payment method; it cannot be redirected. → the cash lane must never be used to simulate a
   card/credit refund, and every refund needs a *destination of record*.
3. **Stripe — idempotent requests** <https://docs.stripe.com/api/idempotent_requests>. A retry with the
   same key must not perform the operation twice; the server compares parameters and errors on mismatch.
   → the refund's `(ticket, items_hash)` dedup and the per-refund ledger id are the idempotency anchors;
   a replay must fail at the gate before any leg is written.
4. **Transactional outbox** <https://microservices.io/patterns/data/transactional-outbox.html>. The
   database update and the emitted record must commit together; otherwise the record is sent when the
   transaction rolls back, or lost when the process dies. → the ledger emission is part of the same
   commit as the balance.
5. **ISO 4217 (DZD minor unit 2)** — see `docs/c01-research.md` R-005. Amounts are integer minor units;
   the wallet increment is an integer DZD amount.

## Choice and why

The wallet leg is applied as `store_credit = store_credit + inc` **read and written under the same write
lock**, with a `creditDeltaDzd` ledger row inserted in the same transaction, and a pre-COMMIT assertion
that `total == cash + wallet + voucher + debt` (card legs scoped out — no destination of record exists in
this schema). A missing recipient is refused **at the native boundary** (`AVOIR_RECIPIENT_REQUIRED`), so
no caller can bypass it; the TS pre-check remains UX.

## Reversal

Remove the `wallet_credit` field and block 11c, restore the TS ledger emission and the TS balance write,
drop `customer_store_credit_after`. Cash/card behaviour is untouched by the field being optional, so a
revert is a single-commit operation (`git revert 6b3bd6f`).

## Residuals

- Card lane: **no destination of record** (reported by the money gate, not exempted).
- The TS still writes the customer row (mirroring the native balance); the value written is the native
  after-value, never a TS-computed one. A partial-row update would remove even that write — a refactor,
  out of scope by the owner's "no refactors" instruction.
