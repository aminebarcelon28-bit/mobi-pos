# RESUME — c01-rc-7

- **Tag:** `c01-rc-7` at the handoff commit; verified content is `488d6bd` (the
  only commits after it are the E-0171 evidence line and this handoff — docs
  only). `c01-rc-6` stays at `d57ddef`; rc-1…rc-6 are untouched.
- **Branch:** `c01-rc6-work`.
- **Verified on a clean worktree of `488d6bd`** (`%TEMP%/opencode/rc7-wt`,
  tracked-clean, binary rebuilt there):

  | Gate | Result |
  |---|---|
  | money boundary | `65 PASSED, 0 FAILED` |
  | zero-tax | `23 PASSED, 0 FAILED` |
  | cash terms | `32 Passed, 0 Failed` |
  | tsc | exit 0 |
  | lint (oxlint) | exit 0 (0 errors) |
  | selftest | `SELFTEST OK` (137/137) |
  | reconcile | `RECONCILED 687 active cases` |
  | cargo | `454 passed; 0 failed` |
  | 50-sec | 10/10 |
  | 40-shf | 12/12 |
  | refund 30/31/32/33/34 | 12/12 · 15/15 · 15/15 · 18/18 · 17/17 |
  | 51 hardening | 10/10 |
  | ESC/POS sink | 27/27 (PASS-SIM) |
  | sync faults | 8/8 (PASS-SIM) |
  | two-device + gateway | 19/19 (PASS-SIM) |
  | acquirer contract | 15/15 |

- **Shipped in the rc-6 → rc-7 window (queue 2):** REF-86 measurement + D6
  decision · two-client fault suite + mock acquirer · ESC/POS capture sink,
  decoder oracle, byte goldens, Arabic raster lane (ADR-004) and hardware kit ·
  SEC-18/19/20 · G-21/G-05 · CRM-02 · DRW-24/IDN-12/DRW-08 harness waits ·
  two-device + gateway fault suite · ADR-002/003/004/005 · repo
  professionalization (README/CONTRIBUTING/CHANGELOG/LICENSE/ADR index/AGENTS
  rules/CI harness gates) · lint 0 errors (RefundModal conditional hook fixed).
- **Next (queue remains):** SEC-01 increment 1 (role requirement in the native
  authorizer + tests, ADR-005) → product gaps still failing by design (RCP-05/07/
  10/11/12/15/16/18/22/23, TIM-02/07, CRM-03/06, G-23) → real two-terminal run
  once HAR-003 is supplied.
- **Owner-only, minimised:**
  1. **HAR-002 printer:** 58 mm and 80 mm rolls, one Epson-class and one clone,
     plus the interface (USB / network IP:port / Bluetooth name). Then
     `npm run escpos:kit -- --host <ip>` + the 11-line `CHECKLIST.md`.
  2. **HAR-003 gateway:** a merchant gateway URL with the terminals' Ed25519
     public keys enrolled (and PSP sandbox credentials only if a real acquirer
     is to be contract-tested).
  3. **HAR-004 numbering:** confirm the fiscal numbering rule (device-series
     recommended) before SYN-02 changes the printed number.
