# D-SYN two-instance + gateway faults harness

**Date:** 2026-11-03 · **Evidence:** E-0180 (delivered), E-0174/E-0177 (first form), E-0179 (park reason) · **Command:** `npm run test:two-instance`

## What it is now

One hermetic suite, one command, deterministic:

```
loopback merchant gateway (2 enrolled TEST keys, ALLOW_TEST_KEY gated)
  → app instance A: own sandbox + driver port, real checkout, real fiscal number
  → app instance B: own sandbox, +90 s fake clock, real checkout
  → runner-driven fault schedule against the gateway, signed with the two test keys:
      partition (socket dropped) → heal → duplicate delivery → reorder (future hole)
      → crash-before-ACK replay → clock skew → revocation isolation
  → invariants: one ledger row per (device, seq); cursors A=4 B=4
```

Artifact: `tests/results/two-instance.json` (each check, the ledger, cursors, both
instance payloads) plus per-instance WDIO logs.

## What it proves (16 checks, green twice — 16/16 both times)

1. Two real app processes, each with its own data dir, its own enrolled device id,
   its own fiscal series (both starting at `000001`).
2. A terminal 90 s ahead: the fake clock is visible to the app and does **not**
   leak into the fiscal number (series + counter only).
3. Transport faults against the local gateway:
   - partition: a dropped socket is a failure, never a silent ACK, zero ingestion;
   - heal: the batch commits with contiguous ACKs and a `SERVERTIME_V1` token;
   - duplicate: replay ACKs idempotently, no second row;
   - reorder: a future hole is refused with `expected_<n>_received_<m>`;
   - crash-before-ACK: replaying the same batch leaves 4 rows, not 8;
   - revocation: the revoked device is refused while the other keeps syncing;
   - final: one row per (device, seq), cursors equal the highest contiguous seq.

## Honest boundary (what is real and what is simulated)

- **Real:** the two app processes, their sandboxes, their enrolled device
  identities, their fiscal numbers, and the gateway's signature/gap/replay/
  revocation logic (the same `proxy/gateway.mjs` the server would run).
- **Simulated:** the mutations in the fault schedule are signed by the runner with
  the two enrolled **test** keys. The app's own signed lane only mints rows on
  refunds; driving the full refund UI twice would not add anything to the fault
  proof, so the suite does not pretend to test the app's signing path — that path
  is covered by `test:sync-e2e` (real Ed25519, native command) and by the Rust
  `signed_server_time_ingestion` test.
- Therefore: **REAL for the instances, PASS-SIM for the transport.** The six cases
  that need a merchant-issued gateway with real enrolled keys (SYN-05/06/07/11/21/
  29) stay **BLOCKED on HAR-003**.

## Why sequential instances, not concurrent

An earlier version launched two concurrent `wdio` processes; the second kept dying
at config load (`tsConfigPathFromConfigFile`) on this host, and concurrent WebView2
runtimes also fought over sandbox locks (orphaned `msedgewebview2` processes — a
real hygiene defect, now fixed by killing by sandbox command line). The current
design removes the race instead of retrying around it: instances run one at a
time, and the faults are a scripted sequence, which is also what makes the suite
deterministic enough to assert exact sequence numbers.

## Kept for later

- Concurrency (two terminals writing at the same instant) is a *gateway* property
  and is covered by `test:sync-two-device` (two protocol clients, fake clocks,
  concurrent same-ticket).
- Once HAR-003 supplies a real gateway, this suite can point at it by configuration
  and the same schedule becomes the production-transport proof.
