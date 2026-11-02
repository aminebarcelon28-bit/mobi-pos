# RESUME — c01-rc6 work

- **Phase:** 2 (build) — R1 complete and verified; R3/R4 triage committed; final report written.
- **Baseline:** `c01-rc-5` = `51c9c70`. Branch: `c01-rc6-work`. R1 commit: `9d8ab66` (+ a
  test-only guard fix afterwards).
- **R1 (SEC-01): DONE, PASS** — native session principal + deny-by-default policy table
  (`docs/adr/ADR-001-native-session-principal.md`). 50-sec **10/10**, assertion untouched.
  `cargo test --lib` **452/452**. Mutation-proven coverage tests. 40-shf 12/12; 30 12/12;
  31 15/15; 32 15/15; 33 18/18; 34 17/17. tsc clean. selftest 137/137. Register 68 rows / 0 OPEN.
  Reconcile **RECONCILED 687** (PASS 222, non-flaky 221, FAIL 212, BLOCKED 117, N/A 116,
  PASS-PARTIAL 20, FLAKY 1).
- **Not tagged:** `check-money-boundary` is 64/65 on a pre-existing delta
  (`createOrderSlice.ts` 58 vs registry 54, from `8c1fcf4`) — see `agent/HUMAN_ACTIONS.md`
  HAR-001. `check-design-tokens` is also pre-existing red on untouched files. Everything this
  branch touched is green; the tag waits on HAR-001.
- **Next action:** on HAR-001 decision, re-run `check-money-boundary`, then tag `c01-rc-6` at the
  final commit (the only post-build change is a `#[cfg(test)]` guard, no product bytes).
- **Then:** R2 (SYN-02/04/26/27 — items 2–4 of `agent/triage/24-syn.md`), R3 (6 PASS-SIM cases
  against the loopback gateway, 10 blocked on HAR-003), R4 (10 SW cases via a byte-capture sink;
  HW kit per `agent/triage/26-rcp.md`), R5 (G-21/REF-86).
- **Known transient classes (logged):** `database is locked` on `resetData` right after a build
  → `npm run e2e:clean`; reports-gate mount race (fixed in 31 by waiting on state);
  customers-dialog race under load (REF-67, isolated pass).
