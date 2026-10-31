# Cold adversarial review — D4-A (separate context, 2026-10-31)

Reviewer: separate sub-agent session (`ses_e6cf07044ffeRlqM2Js15PQw25`). Scope: `git diff 6b3bd6f^..HEAD` over
`src-tauri/src/refund.rs`, `src/db/adapters/refundNative.ts`, `src/store/slices/createOrderSlice.ts`.
Verdict: **DO NOT MERGE** — 8 findings, one of them a money regression introduced by this change.

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Atomicity of wallet + ledger + refund row + restock | PASS | `refund.rs:1708-1775`, `:1254`, `:1546`, single `tx.commit()` at `:2121` |
| 2 | Crash windows / post-commit mirror | **FAIL** | `createOrderSlice.ts:3086-3108` (silent `catch → {}`), `:3152`; native wallet UPDATE stamps no `sync_status` (`refund.rs:1768-1772`) |
| 3 | Idempotency (replay cannot double-apply) | PASS | dedup at `refund.rs:905-920` precedes the wallet write at `:1710` |
| 4 | Double credit (native + TS) | PASS | TS emission deleted (`createOrderSlice.ts:2484-2489`), native is the only increment |
| 5 | Overflow | PASS to 2^53 | `refund.rs:1722/1729/1765/1774` — f64 exact ≤ 2^53; divergence beyond |
| 6 | Rollback on forced wallet failure | PASS | `:1772` `map_err` + `?` before the only commit; test `d4a_forced_wallet_failure…` green |
| 7 | Recipient rule at the money boundary | PASS (gaps) | `refund.rs:447-458`, `:1713-1720`; **no tombstone/ownership check**; error code missing from the client taxonomy |
| 8 | Pre-COMMIT `total == cash+wallet+voucher+debt` | **FAIL** | `refund.rs:1999-2022`: card skipped entirely; debt/voucher clamps make legitimate refunds die; fractional minor-unit refunds refused; `cash_tendered` not cross-checked against `cash_move.amount` |
| 9 | Ledger emission cannot be lost | **FAIL** | non-Tauri branch credits with no emission (`createOrderSlice.ts:3280`); read-back `catch` + "unparseable payload" replace the ledger (`refund.rs:1739-1745`) |

## Findings to fix before merge (verbatim order from the reviewer)

1. **Milestone clawback money silently dropped (over-credit).** Pre-change the wallet was
   `storeCredit + creditToAdd − claw.totalRevoked`; now only `creditToAdd` reaches the native lane and the
   mirror overwrites `storeCredit`/`ledger` with the committed row, so a refund that un-earns a spend
   milestone leaves the Avoir in the customer's wallet. **Money regression introduced by D4-A.**
2. **`cargo test` red at HEAD (22/28)** — D3 is a merge gate, not a footnote; the shared `base_req`
   change also broke two previously-passing assertions.
3. **Pre-COMMIT assertion refuses legitimate refunds and checks nothing for cards** (fractional legs,
   debt/voucher clamps, card skipped).
4. **Post-commit mirror can destroy the committed ledger or revert a concurrent credit** (silent
   `catch`, whole-payload absolute write).
5. **No durable outbox for the native wallet write** (no `sync_status` stamp; propagation depends on a
   best-effort enqueue).
6. **`AVOIR_RECIPIENT_REQUIRED` missing from the client error taxonomy** → surfaces as
   `PERSISTENCE_FAILED`.
7. **`NativeRefundOk.customerPayload` is a phantom field** — `RefundOk` has no such member.
8. **No economic cap on the Avoir leg** — a caller can mint wallet credit as long as it inflates
   `value_reversed`, and the recipient only has to be non-blank.

## Consequence

D4-A is **not merged**. The 4e9 E2E proof is green (wallet delta exactly 4 000 000 000, one ledger row,
money gate clean on that DB), but finding 1 forbids merge until the clawback rides the same transaction.
