# RESUME — c01-rc6 work

- **Phase:** 2 (build) — R1 implemented and SEC-01 green; item-boundary regression running.
- **Baseline:** `c01-rc-5` = `51c9c70` (rc-3=`dcd7b77`, rc-4=`2e98495`). Branch: `c01-rc6-work`.
- **R1 (SEC-01): DONE** — native session principal + deny-by-default policy table
  (ADR-001). 50-sec **10/10** (E-0151). `cargo test --lib` 452/452. Mutation check
  proven. Dossier `agent/dossiers/D-R1-authorization.md`.
- **Next action:** item-boundary regression on the tracked green suites (40-shf,
  33-ref, 30/31/32/34), then commit/tag `c01-rc-6` if every gate holds; then R2
  (SYN-02/04/26/27), R3 (24-syn triage table), R4 (26-rcp triage + hardware kit),
  R5 (G-21/REF-86).
- **Open hypotheses:** none blocking R1. R2 SYN-02 numbering scope still unread.
- **Gate baseline (must not go down):** cargo 443/443 → now 452/452 · tsc clean ·
  guards 24/24 · selftest 137/137 · RECONCILED 687 · register 68 / 0 OPEN.
- **Known environment note:** `database is locked` during `resetData` right after a
  build = orphan WebView; `npm run e2e:clean` then re-run (logged transient).
