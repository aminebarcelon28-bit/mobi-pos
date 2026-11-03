# RESUME — current (post c01-rc-11)

- **Tags:** `c01-rc-11` at `6c91539` (exact verified commit) · `c01-rc-10` at
  `4dd4d0e` · `c01-rc-9` at `8c63bf6` · `c01-rc-8` at `a9ba71b` · `c01-rc-7` at
  `eeda281` · `c01-rc-6` at `d57ddef`. Tags are immutable.
- **Rule (item 1):** tag only the exact verified commit; a later docs commit must
  still pass reconcile + lint + selftest before it is described as verified.
- **Clean-worktree gates at `6c91539`:** money 65/65 · zero-tax 23/23 · cash-terms
  32/32 · tsc 0 · lint 0 · selftest OK · reconcile 687 · cargo 466/466 · 50-sec
  10/10 · 40-shf 12/12 · 30 12/12 · 31 15/15 · 32 15/15 · 33 18/18 · 34 17/17 ·
  51 10/10 · spec 92 1/1 · escpos 27/27 · syn-faults 8/8 · two-device 19/19 ·
  numbering 11/11 · acquirer 15/15 · technician 9/9 · two-instance 16/16 ·
  sql-boundary 318≤318 · secrets 0 · licences 0 disallowed.
- **Hardened read-only lane (item 2/3):** `src/sql_ro.rs` — `SQLITE_OPEN_READONLY`,
  authorizer allowlist (19 tables, no PRAGMA/ATTACH/writes/DDL), single-statement
  scanner, 2000-row / 1.5 s caps, credential tables unreadable; 9 Rust tests, 11
  app-path probes each with a writable control. Latency 2.8 ms → **0.4 ms** p50
  (plugin 0.5) via a cached connection keyed on file identity.
- **SQL boundary gate (item 4):** 318 renderer writes, `--ratchet` in CI,
  `--fail` for the end state; baseline may only shrink. The pool flip itself still
  needs the boot-write migration (ADR-005 steps 2–4) — gated on the money-path
  budget (checkout p95 regression ≤10%).
- **Item 5:** app-level concurrent same-entity edits are **not** a separate case;
  rationale recorded (sequential instances + `test:sync-two-device` covers the same
  merge policy deterministically).
- **Item 6/7:** SECURITY.md, OWNER_ACTIONS.md (HAR-002/003/004 with commands and
  verdict flips), SBOM (`docs/sbom.json`, `docs/THIRD_PARTY.md`), secrets/lint/boundary
  gates in CI, quickstart executed on a clean clone, `npm audit --omit=dev` 0 vulns.
- **Owner-blocked:** HAR-002 printer · HAR-003 gateway + enrolled keys · HAR-004
  numbering confirmation. See `OWNER_ACTIONS.md`.
- **Next:** SEC-01 step 3 (boot-write migration → renderer pool read-only → money
  paths, with before/after latency); product gaps still failing by design.
