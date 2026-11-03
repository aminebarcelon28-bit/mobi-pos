# D-SYN two-instance harness (GUI half) — what it proves, what stays blocked

**Date:** 2026-11-03 · **Evidence:** E-0174 · **Command:** `npm run test:two-instance`

## What runs

`tests/harness/two-instance/run.mjs` starts **two real app processes at the same
time** — each with its own `POS_WDIO_SANDBOX` data dir and its own
`POS_TAURI_DRIVER_PORT` (4511/4512) — and each runs
`e2e-tests/specs/90-two-instance.e2e.ts`:

1. reset + seed a catalogue in its own DB, reload the WebView, unlock, open shift;
2. one real sale through the checkout UI;
3. record its fiscal number, its enrolled `device_identity.device_id` and its
   data dir into a per-instance result file.

The runner then asserts (8 checks, all green):

- both processes exit 0 and both produce results;
- **different data dirs** (no shared DB);
- **different enrolled device ids**;
- **different fiscal series**, each starting at `000001` — i.e. no shared counter,
  which is exactly the SYN-02 contract under two live terminals;
- the two run **concurrently** (their start/finish windows overlap);
- no receipt number collides across terminals.

Artifacts: `tests/results/two-instance.json`, `tests/results/two-instance-{A,B}.json`
and the per-instance WDIO logs.

## What it deliberately does not re-prove

The gateway/signature half is already proven, with real Ed25519 and faults, by:

- `npm run test:sync-e2e` — signed envelopes, gap arbitration (`409
  expected/received`), replay dedupe, revocation, verbatim `SERVERTIME_V1`;
- `npm run test:sync-two-device` — two protocol clients, fake clocks, partition/
  heal, duplicate, reorder, crash-before-ACK replay, concurrent same-ticket,
  revocation, tamper control.

Running the signed **refund** lane from two GUI processes would duplicate that
coverage while adding an unstable UI dependency; the harness keeps the GUI layer
to identity + numbering + isolation, where it is the only evidence.

## The six SYN cases that stay BLOCKED (and why)

| Case | Needs | Status |
|---|---|---|
| SYN-05 (money conflict on two devices) | merchant gateway + enrolled per-device keys, so two terminals can actually exchange and resolve a refund/loyalty/stock conflict | BLOCKED — HAR-003 |
| SYN-06 (stock counter vs ledger offline) | same, plus the server apply lane | BLOCKED — HAR-003 |
| SYN-07 (delete vs edit) | same | BLOCKED — HAR-003 |
| SYN-11 (schema/app version mismatch) | a second terminal on a **different app version** + gateway | BLOCKED — HAR-003 (+ a second device) |
| SYN-21 (propagation SLA) | gateway + a real remote peer to measure end-to-end latency | BLOCKED — HAR-003 |
| SYN-29 (migration while offline for days) | gateway + a fleet with mixed versions + time | BLOCKED — HAR-003 |

What the harness changes for them: the "we cannot even run two terminals here"
objection is gone — the remaining blocker is the merchant gateway and its enrolled
device keys, which only the owner can provide.
