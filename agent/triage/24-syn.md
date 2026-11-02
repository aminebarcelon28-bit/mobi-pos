# Triage — 24-syn (30 cases: 5 PASS · 4 FAIL · 17 BLOCKED · 4 N/A)

Measured at `c01-rc-5`/`c01-rc-6` (register: `docs/non-refund-suite-register.md`). Buckets are
**what the case needs to be honestly executable**, not what has been run. "Status today" is
explicit so a bucket is never read as a verdict.

## The 17 BLOCKED

| Case | What it asserts | Bucket | Status today | Exact requirement to close |
|---|---|---|---|---|
| SYN-05 | Money-row conflicts: same refund / same loyalty redemption / last unit on two devices | BLOCKED | not executed | Two live instances (own data dir + DB) + enrolled device keys + merchant gateway. |
| SYN-06 | Stock counter vs ledger: two devices decrement offline | BLOCKED | not executed | Two instances, then settle and compare; also needs the merchant-scoped ledger contract. |
| SYN-07 | Delete vs edit (deleted on A, sold on B) | BLOCKED | not executed | Two instances + gateway. |
| SYN-08 | Sync interrupted at 50% (kill/network cut/sleep) | PASS-SIM | not executed | Executable **today** against the signed lane: `proxy/gateway.mjs` + drain worker + TCP kill mid-batch. Result would be PASS-SIM (simulated transport), never headline PASS. |
| SYN-09 | 5,000 offline sales then reconnect | PASS-SIM | not executed | Single instance + loopback gateway; assert drain completes in order, no loss, no duplicate. |
| SYN-10 | Clock skew between devices (±5 min / ±1 day) | PASS-SIM | not executed | Single instance vs server time (`SERVERTIME_V1`); device-to-device skew needs the two-instance harness. |
| SYN-11 | Schema/app version mismatch (one updated, one not) | BLOCKED | not executed | Two app builds + two instances. |
| SYN-12 | Auth token expired/revoked/offline for days | PASS-SIM | not executed | Loopback gateway already answers 403 revocation/not-enrolled; needs a spec exercising the client suspension + resume. |
| SYN-14 | Sync during checkout/payment/printing | PASS-SIM | not executed | Single instance: drain runs while a sale is committed; assert ordering/idempotency. |
| SYN-15 | Backend 500/429/timeout/partial JSON | PASS-SIM | not executed | Mock gateway fault modes (already supported by the loopback verifier). |
| SYN-19 | Convergence of ledger totals/row counts/hash heads after settle | BLOCKED | not executed | Two instances + gateway; then G-12 convergence oracle. |
| SYN-21 | Propagation SLA (idle / 1,000 sales/h / after reconnect) | BLOCKED | not executed | Two instances + gateway + measurement harness. |
| SYN-22 | Concurrent transitions on mutable state rows | BLOCKED | not executed | Two instances + gateway. |
| SYN-23 | Tombstones/redirects (merge/delete on A, edit/sell on B) | BLOCKED | not executed | Two instances + gateway. |
| SYN-24 | Bandwidth/payload budget (initial, 1M-row change set, photos) | RUN | not executed | Single instance: serialize the payloads and measure bytes. No second peer required. |
| SYN-28 | Echo/ping-pong (remote change re-triggered by local side effects) | BLOCKED | not executed | Two instances (a peer is required for an echo to exist) + gateway. |
| SYN-29 | Migration while offline for days; mixed versions on one backend | BLOCKED | not executed | Two app versions + two instances. |

**Summary:** RUN 1 (SYN-24) · PASS-SIM 6 (SYN-08/09/10/12/14/15) · BLOCKED 10 (SYN-05/06/07/11/19/21/22/23/28/29) · N/A 0.
The 6 PASS-SIM candidates are executable the moment a spec is written against the existing
loopback gateway; they are not executed here, so nothing is claimed.

## The 4 FAIL (classified at rc-5, unchanged)

| Case | Class | Closing action |
|---|---|---|
| SYN-02 | PRODUCT DEFECT (data integrity) | Merchant-scoped receipt sequence minted natively + unique index; failing case is the red test (R2). |
| SYN-04 | ACCEPTED convergence model | ADR for non-money LWW-with-version-guard; the case pins exactly that (R2). |
| SYN-26 | ACCEPTED at-rest residual | ADR: full-disk encryption as deployment requirement; DB encryption deferred with key-loss/recovery analysis (R2). |
| SYN-27 | PRODUCT DEFECT (ordering) | Pull cursor must order by (version, HLC), not wall clock; reuse `time_anchor` (R2). |

## The 4 N/A

SYN-16, SYN-17, SYN-20, SYN-25 are N/A per the register (covered elsewhere or not applicable to
this topology). No change.

## R3 research answers (recorded once, reused)

- Two Tauri instances: the driver binds one WebView per session; isolation requires a distinct
  app identifier + `--user-data-dir`/app-data dir per instance. `@wdio/tauri-service` does not
  host two instances in one session; the repo's `test_e2e_two_device_sync.mjs` already drives
  two *logical* devices over the sync modules, which is the cheaper path for convergence cases.
- Determinism: barriers between instances, injected clock (compile-gated), TCP proxy for faults
  (the loopback gateway already refuses out-of-order `seq_no` with `409 expectedSeq`).
- Simulator honesty: schema/contract tests on both sides (the gateway verifier already checks
  signed envelopes; a JSON-schema contract test is the remaining piece).
