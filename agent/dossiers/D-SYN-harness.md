# D-SYN-HARNESS — two-client fault harness + mock acquirer (SYN queue item 2)

**Date:** 2026-11-03 · **Outcome:** PASS-SIM suite `test:syn-faults` (8/8, negative control proves it
fails on a permissive guard) + `test:acquirer` contract (15/15). Neither is headline PASS.

## What is built

1. **`scripts/test_syn_faults.mjs`** (`npm run test:syn-faults`) — hermetic two-client convergence
   suite: two disposable libsql file DBs, rows applied through the **real**
   `tiedVersionGuardSql` predicate (`src/sync/causalVersion.ts`). Eight scenarios:
   partition/heal with equal versions, duplicate delivery, reordered stale versions, wall-clock
   skew, concurrent same-version edits, tombstone vs late edit, crash mid-batch + idempotent
   resume, and refund replay by id. Own temp files, no ports/credentials, JSON artifact in
   `tests/results/syn-faults.json`.
   - Negative control: replacing the guard with `WHERE 1=1` fails 5/8 (convergence, reorder, skew,
     same-version edits, tombstone), proving the oracle discriminates.
2. **`tests/fixtures/mockAcquirer.mjs` + `scripts/test_acquirer_contract.mjs`**
   (`npm run test:acquirer`) — zero-dependency loopback acquirer: authorize/decline, partial
   capture (once), void before capture, cumulative refunds capped at the captured amount, refund
   idempotency keys, HMAC-signed callbacks with duplicate/late acknowledgement, and an
   unknown-outcome timeout reconciled by query. 15/15 contract checks, both accept and refuse
   paths exercised.

## Mapping to the 10 SYN cases (what the harness now proves, and what it does not)

| Case | Class | Harness status |
|---|---|---|
| SYN-19 | convergence after settle | covered by scenarios 1/5/7 (PASS-SIM) |
| SYN-22 | concurrent mutable-row transitions | covered by scenario 5 (PASS-SIM) |
| SYN-23 | tombstone/redirect vs edit/sell | covered by scenario 6 (PASS-SIM) |
| SYN-28 | echo/ping-pong, replay | covered by scenarios 2/7/8 (PASS-SIM) |
| SYN-27 | wall-clock ordering | covered by scenario 4 (PASS-SIM) |
| SYN-05/06/07/11/21/29 | two live instances, device enrollment, schema skew, propagation SLA | **still BLOCKED** — needs the real two-instance app harness + merchant gateway + per-device credentials |

## Honesty qualifier

File-DB convergence proves the **merge primitives**, not the transport. A PASS-SIM result here is
recorded as such (never stamped as headline PASS). No verdict in `CASE_INDEX` is changed by this
suite.

## What only the owner can supply

- **HAR-003:** a merchant gateway endpoint with the terminals' Ed25519 pubkeys enrolled (the
  loopback verifier already covers signature/gap/replay; the real sandbox is the missing half).
- If a **real PSP** is to be contract-tested: sandbox credentials for that acquirer (the mock is a
  simulator; the product's card-acquirer integration is a separate D12 residual).
