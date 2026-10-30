# C01 — progress (Stage B4)

Updated at every phase boundary. Ordered backlog, P0 before P1 before P2.

| Phase | Priority | Item | Status |
|---|---|---|---|
| 0a | P0 | hygiene, gates, this file | in progress |
| 0b | P0 | binary provenance table | in progress |
| 0c | P0 | dashboard: PASS / PASS-PARTIAL / FLAKY split, stricter headline | pending |
| 1a | P0 | fractional cash + invariant (vii) payout conservation | pending |
| 1b | P0 | funding format in minor units + unit field (Q-vi) | pending |
| 1c | P0 | B-2 reachability (voucher lane without code) | pending |
| 1d | P0 | B-1 walk-in trade restore | pending |
| 1e | P0 | under-refund sub-buckets | pending |
| 1f | P0 | mixed-fleet rollback (old code over v2 history) | pending |
| 2a | P0 | store-level harness (module hooks, no app change) | pending |
| 2b | P0 | H4 controllable-delay window proof | pending |
| 2c | P0 | D4 failure injection (P0, deferred twice) | pending |
| 2d | P0 | H3-b interleaving (checkoutRecovery first) | pending |
| 2e | P0 | D4 RFC update | pending |
| 5 | P0 | verification on the FINAL binary | pending |
| 3a-f | P1 | C90 static → channel → trace → classify → tests → fix if PROVEN | pending |
| 4a | P1 | REF-92 store-level integration | pending |
| 4b | P2 | REF-92 E2E | pending |
| 6 | P2 | reviewer pack update | pending |

## Provenance finding (Phase 0b, corrects B3 §10)

`git diff --stat 97fc1d8 9d40d7d -- src src-tauri` → **`src/utils/receiptMath.ts` changed (17+/2-)**.
So the B2 runs on `97fc1d8` are **stale** for the final code; B3 §10 should not have cited them as
regression evidence. Only runs on the `9d40d7d` binary (or later, with no app-source change) count.

`git diff --stat 9d40d7d HEAD -- src src-tauri` → empty: the working binary matches HEAD app source.
