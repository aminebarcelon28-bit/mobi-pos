# C01 — funding-payload consumer audit (read-only, P0-c)

Binary/sha of record: HEAD `e88136b`, binary `8A9AC95B…8FC4`. Method: grep over `src`, `scripts`,
`e2e-tests` and `src-tauri/src` for `refundLaneTotalsOf`, `fundingPayloadOf`, `.funding`, `$.funding`.

| # | Consumer | file:line | Reads | Unit assumed | Safe? |
|---|---|---|---|---|---|
| 1 | writer | `src/store/slices/createOrderSlice.ts:2643` | writes `fundingPayloadOf(...)` into the refund JSON | minor + `unit:'minor'` | n/a (writer) |
| 2 | reader | `src/utils/receiptMath.ts:606` (`refundLaneTotalsOf`) | `txn.funding.*` | **unit-aware**: `unit:'minor'` → ÷100; DA object → read as DA + `funding-unit-legacy` | YES |
| 3 | reader caller (commit) | `src/store/slices/createOrderSlice.ts:2194` | via #2 | DA | YES |
| 4 | reader caller (preview) | `src/components/modals/RefundModal.tsx:438` | via #2 | DA | YES |
| 5 | tests | `scripts/test_refund_root_invariants.mts:1024-1049` | via #1/#2 | both | YES |
| 6 | reports / receipt / shift-close / export | — | **do not read `funding`** (grep: no hits) | — | YES |
| 7 | sync serialization | — | carries the payload opaquely (`json_payload`) | — | YES |
| 8 | Rust (`refund.rs`, `lib.rs`) | — | does **not** parse `funding`; reads columns `total_net` / `cash_disbursed` / `value_reversed` | DA columns | YES |

**Conclusion (PROVEN, grep + code read):** exactly one reader interprets the payload, it is
unit-aware, and no other consumer (TS, Rust, sync, reports) assumes DA. The minor-unit change is
contained; the earlier worry ("nobody audited who reads it") is closed.

**Residual:** the reader's DA fallback exists only for rows written by this branch before the format
change; no released build wrote them (no tag contains `c9118c4`), so the fallback is defensive.
