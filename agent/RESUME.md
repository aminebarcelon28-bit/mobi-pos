# RESUME — c01-rc6 work

- **Phase:** release disposition (2026-11-02). **Disposition: BLOCKED — owner decision (HAR-001).**
- **Baseline:** `c01-rc-5` = `51c9c70`. Branch: `c01-rc6-work`. R1 commit: `9d8ab66`.
- **R1 (SEC-01): DONE, PASS** — native session principal + deny-by-default policy table
  (`docs/adr/ADR-001-native-session-principal.md`). 50-sec **10/10**, assertion untouched.
  `cargo test --lib` **452/452**. Mutation-proven coverage tests. 40-shf 12/12; 30 12/12;
  31 15/15; 32 15/15; 33 18/18; 34 17/17. tsc clean. selftest 137/137. Register 68 rows / 0 OPEN.
  Reconcile **RECONCILED 687** (PASS 222, non-flaky 221, FAIL 212, BLOCKED 117, N/A 116,
  PASS-PARTIAL 20, FLAKY 1).
- **Release disposition (E-0153):** both static gates reproduce red; the money gate is
  CI-blocking (`npm test` → `test:boundaries` → `check-money-boundary`, and the isolated
  `audit-money-gates` job). Provenance corrected: the 4 extra hits arrived with **`177e6b1`**,
  an ancestor of `c01-rc-5`, not with `8c1fcf4`; the money gate is red at the existing candidate
  too. Design-token debt is identical at rc-5 and HEAD (39 inherited violations) and the gate is
  not wired into CI or `npm test`.
- **Next action:** owner decision HAR-001 (recommended: reconcile the registry 54 → 58 with the
  `177e6b1` justification, then a separate Stage E money-unit task) and HAR-005 (design-token
  criterion). On approval: re-run the gate, then tag `c01-rc-6`.
- **Then:** R2 (SYN-02/04/26/27), R3 (6 PASS-SIM cases against the loopback gateway, 10 blocked
  on HAR-003), R4 (10 SW cases via a byte-capture sink; HW kit per `agent/triage/26-rcp.md`),
  R5 (G-21/REF-86).
- **Known transient classes (logged):** `database is locked` on `resetData` right after a build
  → `npm run e2e:clean`; reports-gate mount race (fixed in 31 by waiting on state);
  customers-dialog race under load (REF-67, isolated pass).

