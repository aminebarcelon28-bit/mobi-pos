# RESUME — current (post c01-rc-8)

- **Tags:** `c01-rc-8` at `a9ba71b` (verified content `0832b9a`; the tag commit adds
  docs + harness script only) · `c01-rc-7` at `eeda281` · `c01-rc-6` at `d57ddef`.
  rc-1…rc-8 untouched from here on.
- **Branch:** `c01-rc6-work`; tree tracked-clean.
- **Clean-worktree gates at `0832b9a`:** money 65/65 · zero-tax 23/23 · cash-terms
  32/32 · tsc 0 · lint 0 · selftest OK · reconcile 687 · cargo 457/457 · 50-sec
  10/10 · 40-shf 12/12 · 30 12/12 · 31 15/15 · 32 15/15 · 33 18/18 · 34 17/17 · 51
  10/10 · escpos 27/27 · syn-faults 8/8 · two-device 19/19 · numbering 11/11 ·
  acquirer 15/15.
- **Shipped in this window (E-0172…E-0179):**
  - **SYN-02 + ADR-006:** device-series numbering seam (`PREFIX-<SERIES>-000001`),
    stamped PASS from a real sale with a two-series negative control; legacy
    scheme selectable; provisional pending the owner's fiscal confirmation.
  - **SEC-01 increment 1:** sync credentials are manager-only in the native
    authorizer (failing→passing test; lib 457).
  - **SEC-01 increment 2 (staged):** `sql_boundary.rs` proves `query_only`
    refuses all write classes with SQLITE_READONLY while native connections write,
    with the negative control and read-latency numbers; enabling it on the renderer
    pool was measured to break boot, so it ships only with the write migration
    (ADR-005 steps 2–4).
  - **Two-instance harness:** two live terminals, isolated dirs/ports, own series,
    one on a fake clock — 10/10 twice; concurrency then became unreliable on this
    host (second wdio process fails at config load) and is **parked with evidence**
    in `agent/dossiers/D-SYN-two-instance.md`. No verdict depends on it.
- **Blocked on the owner only:** SYN-05/06/07/11/21/29 (merchant gateway + enrolled
  per-device keys, HAR-003) · Arabic/cut/drawer on paper (HAR-002) · fiscal layout
  confirmation (HAR-004).
- **Next:** SEC-01 increment 2 steps 2–4 (migrate boot-critical writes, then enable
  the pool, then the money paths with latency) · product gaps still failing by
  design (RCP-05/07/10/11/12/15/16/18/22/23, TIM-02/07, CRM-03/06, G-23).
