# Evidence ledger — Phase 2 smoke (S0–S15)

> One row per evidence item (Brief §2.1). Manifest git SHAs match HEAD
> `03e626568cdbc7f0cc4e3a57a44a31a6dd96d8ce` in all three runs
> (`dirty:true` = the uncommitted Phase 1/2 harness tree itself).
> Runner: `npx wdio run wdio.conf.ts --spec ./test/specs/smoke/phase2-smoke.e2e.ts --bail 1`
> with `POS_E2E_WIPE=1` (clean-room `.e2e` container each run).
> Binary: `target-e2e/debug/mobi-pos.exe` (e2e flavor, embedded driver,
> frontend served by vite dev :1420). Retries: 0 (`specFileRetries` unset,
> no mocha retry — single-pass logs).

| ID | Phase | Claim it supports | Command (exact) | Artifact path | git SHA | UTC time |
|---|---|---|---|---|---|---|
| EV-001 | Gate 2 run 1 | 16/16 green, test-time 23.2 s | wdio `--spec smoke/phase2-smoke --bail 1`, `POS_E2E_WIPE=1` | `e2e/evidence/EV-001-smoke-run1.log` + `-manifest.json` | `03e62656` | 2026-10-10 ~16:21Z |
| EV-002 | Gate 2 run 2 | 16/16 green, test-time 22.5 s, wall ~3.5 min | same | `e2e/evidence/EV-002-smoke-run2.log` + `-manifest.json` | `03e62656` | 2026-10-10 ~16:24Z |
| EV-003 | Gate 2 run 3 | 16/16 green, test-time 22.3 s, wall ~3.5 min | same | `e2e/evidence/EV-003-smoke-run3.log` + `-manifest.json` | `03e62656` | 2026-10-10 ~16:28Z |
| EV-004 | Gate 3 money run 1 | 11/11 green, test-time ~17 s | wdio `--spec money/phase3-money --bail 1`, `POS_E2E_WIPE=1` | `e2e/evidence/EV-004-money-run1.log` + `-manifest.json` | `03e62656` | 2026-10-10 ~17:29Z |
| EV-005 | Gate 3 money run 2 | 11/11 green, test-time 17 s | same | `e2e/evidence/EV-005-money-run2.log` + `-manifest.json` | `03e62656` | 2026-10-10 ~17:34Z |
| EV-006 | D4 proof | pin-mint 1/1: `pin_set` mints v2, `pin_verify` ok (no NOT NULL failure) | wdio `--spec pin-mint --bail 1`, `POS_E2E_WIPE=1` | `e2e/evidence/EV-006-d4-pin.log` + `-manifest.json` | `03e62656` | 2026-10-10 |
| EV-007 | D6 verify | smoke 16/16 re-green after remediation (no app fixes in-spec) | wdio `--spec smoke/phase2-smoke --bail 1`, `POS_E2E_WIPE=1` | `e2e/evidence/EV-007-smoke-verify.log` + `-manifest.json` | `03e62656` | 2026-10-10 |
| EV-008 | D6 proof | money 11/11 with M5/M6 on the UI-shift id (no seed, no mirror): refund OK, `ALREADY_REFUNDED` + `REFUND_EXCEEDS`, linkage 8/8 | wdio `--spec money/phase3-money --bail 1`, `POS_E2E_WIPE=1` | `e2e/evidence/EV-008-d6-money.log` + `-manifest.json` | `03e62656` | 2026-10-10 |

## Gate 3 parity evidence (re-runnable commands, all green 2026-10-10)

| Check | Command | Result |
|---|---|---|
| Oracle self-test (L0) | `node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types e2e/lib/oracle.test.mts` | 59 assertions (hand + ties + 28 golden + 11 displays) |
| TS parity (frozen `money.ts`) | `node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_golden_parity.mts` | 55/55 vectors (+1 app-boundary note I-027) |
| Python cross-check | `python scripts/verify_golden_sample.py` | 50 vectors (5 non-ASCII parse by design to Rust+TS) |
| Rust parity (frozen `money.rs`) | `cargo test --release -p mobi-pos --test golden_parity` | 3/3 (11 display + 12 parse + 4 parseError + 28 invoice) |
| Generator | `node scripts/generate-golden.mjs` | `e2e/golden/money-vectors.json` v1, 55 vectors |

## Money-suite per-test results (identical both runs)

M1a–d ARITH qty-matrix exact (UI≡oracle≡stored) · M2a order-independence ·
M2b discount monotonicity · M3 legs−change==total · M4 split 1500+4000,
debt +4000, drawer 1500 · M5 refund inversion (OK, |2500|, REFUNDED,
stock restored, audit 7→8/8→9, chain linkage 8/8–9/9) · M6 replay
`ALREADY_REFUNDED` + fresh-tag `REFUND_EXCEEDS`, zero writes · M7
characterization ui=200 vs singleShot=133 (DA-unit per-line rounding —
no assert beyond the [133,200] bound).

## Per-spec results (identical all 3 runs)

S0 flavor identity · S1 cold start · S2 wrong-PIN denied + 202020 unlock ·
S3 one-product oracle · S4 8-line scroll + oracle · S5 exact cash + stock ·
S6 change oracle · S7 finalize-once + Espèces leg · S8 underpay refused +
cart preserved · S9 wrong-PIN step-up denied · S10 25% step-up per oracle ·
S11 fr-DZ stable (`4\u202f000\u00a0DA`, no global RTL) · S15 burst input,
one line · S13 close booked exact (D7 bypass logged both ways: zSeen=true
once, false twice) · S12 refresh persistence · S14 printed-stub contract +
8-line stored == oracle + receipt uniqueness.

## Time budget vs the 3-minute target

In-spec test time ≈ 23 s (far under). Wall-to-wall per run ≈ 3.5 min,
dominated by app boot + WebDriver session start (~2.5–3 min), not the
tests. Reaching wall < 3 min needs a persistent session or release-profile
startup work — recorded as follow-up, not claimed.

## Defects found by the suite during bring-up (all fixed in-spec, app untouched)

- S5 absolute stock expectation ignored S4's prior purchase → delta-based.
- S2 wrong-PIN entry not cleared before the correct attempt → Backspace
  clear + lock-absence (not header-absence) as the unlock proof.
- S11 format regex assumed ASCII-space + mandatory decimals → actual is
  `4\u202f000\u00a0DA` (narrow-NBSP, NBSP, no fraction); regex relaxed,
  exact value still proven via `displayedToMinor`.
- S13 drawer expectation used SQLite's seed shift (D6 gap class) →
  composed from the known opening + SQLite sales; modal-vs-ledger agreement
  is the cross-check. See `e2e/DISCOVERY.md` §15/§16.
