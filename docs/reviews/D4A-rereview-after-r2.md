# Cold adversarial re-review — D4-A after r1/r2 (2026-10-31)

Reviewer: fresh sub-agent context (`ses_e6cd8accdffeqz4qWyj51GXVbl`), repo at `64c831b`.
Verdict: **DO NOT MERGE.**

Test evidence from the reviewer: `cargo test --lib refund::tests` → **23 passed, 6 failed**;
`cargo test --lib refund::tests::d4a` → **4 passed, 0 failed**.

## Status of the original 8 findings

| # | Finding | Verdict |
|---|---|---|
| 1 | Milestone clawback dropped (over-credit) | **CLOSED** (Tauri path) — `wallet_clawback` in-txn, two ledger rows, mirror spreads the committed row last; proven by `d4a_clawback_revokes_in_the_same_transaction` |
| 2 | `cargo test` red | **OPEN** — 6 fixtures (`refund.rs:2053` gate + `base_req` still `value_reversed 450` / `total_net 200`) |
| 3 | Pre-COMMIT assertion refuses legitimate clamped/fractional refunds; card unchecked | **OPEN** — `refund.rs:2034-2059` unchanged |
| 4 | Mirror can destroy the ledger / revert a concurrent credit | **PARTIAL** — silent fallback gone (`__mirrorUnavailable` skips the save); the write is still a whole-payload absolute upsert with a stale-read retry, and store state still receives the projection on failure |
| 5 | No durable marker for the native wallet write | **PARTIAL** — `sync_status='pending'` now stamped (`refund.rs:1802-1808`), but **nothing reads it** (`SyncManager.ts:129`), and the loyalty write has no stamp |
| 6 | `AVOIR_RECIPIENT_REQUIRED` missing from the taxonomy | **PARTIAL** — parsed + modal copy added; the slice's native-failure mapper (`createOrderSlice.ts:3029-3045`) has no branch → `PERSISTENCE_FAILED` |
| 7 | `customerPayload` phantom field | **CLOSED** — removed from both sides |
| 8 | No economic cap on the Avoir leg | **OPEN** — `value_reversed` and `wallet_credit` both caller-supplied; inflating both satisfies the gate |

## NEW findings introduced by the fixes (r1/r2)

1. **Clamped clawback emits a full-size ledger delta** (`ecb327c`). Balance is floored at zero
   (`refund.rs:1740`) but the row still records `-wallet_claw` (`:1770`) with `balanceAfter: 0`. Σ`creditDeltaDzd`
   then diverges from the balance, and `genericApply.ts:242-244` + `loyaltyEngine.ts:1453-1462` **re-derive the
   scalar unclamped on the next pull**, so a peer can persist a negative balance and swallow the customer's next
   earned credit. No test covers `claw > balance`.
2. **The clawback is an uncapped, unauthenticated debit** (`refund.rs:1718`): it applies even when
   `wallet_credit == 0`, tied to nothing but the ticket id, so any reachable caller can zero a wallet.
3. **The conservation gate is disabled by a client-controlled field**: `funding.digital` is read from
   `req.refund_payload` (written verbatim to the row), so a caller can set `digital > 0` and skip
   `total == legs` entirely.
4. Minor: `__mirrorUnavailable` leaks into the persisted customer payload (spread into the object, then
   serialised by `customerAdapter.saveCustomer`).
5. Risk (lower confidence): duplicate milestone revocation across tabs — the native revocation row uses
   `referenceId = ticket_id`, which the clawback engine does not recognise as an already-revoked marker.

## Decision

Not merged. Fix order (money first): (1) clamp the revocation to what is actually revocable and emit that
amount; (2) authenticate/bound the clawback (balance + explicit reason + refund linkage); (3) remove the
client-controlled skip — cap `total_reversed` against the ticket's remaining refundable value, which also
closes finding 8; (4) make the gate accept clamped legs only when the unabsorbed part is routed by the caller
(explicit field), never by skipping; (5) slice error mapping; (6) legacy fixtures (D3); then a third review.
