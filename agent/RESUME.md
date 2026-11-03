# RESUME — c01-rc6 work

- **Phase:** release disposition + owner-requested verification (2026-11-03).
- **Baseline:** `c01-rc-5` = `51c9c70`; branch `c01-rc6-work`; last commit `7ac204d` (+ uncommitted
  harness edits to specs 50/51, and the evidence/doc updates being written now).
- **Disposition:** **BLOCKED — OWNER DECISION** (HAR-001 money registry; HAR-007 zero-tax re-pin;
  HAR-008 SHF-05 premise). Tag `c01-rc-6` not created.
- **R1/SEC-01:** PASS; **50-sec now STABLE 10/10 ×3** after the state-based unlock wait (E-0155).
  `cargo 452/452`, tsc clean, selftest 137/137, register 68/0 OPEN, reconcile 687.
- **D1 (money wrappers):** 2996/2998 redundant (12/12 identical across fractional-cent, negative,
  repeated-qty, line-to-total; model run in `e2e-tests/results/d1_wrapper_equivalence.mts`); 2997
  and 3001 are not (250.55 → 251 vs 250.55). B (cap 58) vs B′ (remove 2, cap 56) awaiting the owner;
  analysis in `agent/D1-money-wrapper-analysis.md`.
- **D2:** all conditions met (E-0155) — (a) state wait in 50/51; (b) negative control passes;
  (c) SHF-13 green 3/3; (d) rc-5 2.36–2.45 s vs HEAD 2.46–2.50 s ≈ +29 ms (noise). 50-sec is
  **STABLE 10/10 ×3**.
- **D3:** design tokens **not** a release criterion; inherited debt, no baseline refresh.
- **Requested runs (E-0156):** 31/32/33/34/71 clean; 75 two improvements; the only PASS→FAIL deltas
  are test-side (REF-19/IDN-12/DRW-08 order-dependent, DRW-24 actionability, CRM-02 test-authoring).
  No R1 product regression.
- **40-shf:** 11/12 ×3 — SHF-05 wall-clock premise (HAR-008).
- **New red gate:** `test_zero_tax` 21/23 — 6 sqlPluginAdapter entries stale since rc-5 + 5 lib.rs
  entries shifted +9 by R1 (HAR-007; exact re-pin prepared, not applied).
- **"guards 24/24":** only `node scripts/check-contrast.mjs` reports exactly 24/24.
- **Next:** commit the harness fix + evidence, then owner decisions (D1 B/B′, HAR-001/007/008/009).
