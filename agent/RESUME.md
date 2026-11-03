# RESUME — current (post c01-rc-9)

- **Tags:** `c01-rc-9` at the handoff commit (harness rebuild) · `c01-rc-8` at
  `a9ba71b` (content `0832b9a`) · `c01-rc-7` at `eeda281` · `c01-rc-6` at
  `d57ddef`. Tags are immutable from here.
- **Branch:** `c01-rc6-work`; tracked tree clean.
- **Floor at `1214253`:** money 65/65 · zero-tax 23/23 · cash-terms 32/32 ·
  numbering 11/11 · tsc 0 · lint 0 · selftest OK · reconcile 687 · cargo 457/457 ·
  50-sec 10/10 · 51 10/10. **No app-source delta since `0832b9a`**, so the rc-8
  clean-worktree table (40-shf 12/12, refunds 30–34, escpos 27/27, syn-faults 8/8,
  two-device 19/19, acquirer 15/15) still describes the product.
- **Delivered this window (E-0180/E-0181):** the two-instance harness was rebuilt
  as **one deterministic suite** — `npm run test:two-instance`, 16 checks, green
  twice:
  - two real app processes (sequential, own sandbox + driver port), distinct
    device ids and fiscal series (both `000001`), B on a +90 s fake clock that does
    not leak into its number;
  - gateway faults: partition (dropped socket → failure, zero ingestion), heal
    (contiguous ACKs + `SERVERTIME_V1`), duplicate replay idempotent, reorder
    refused with `expected/received`, crash-before-ACK replay (4 rows not 8),
    clock skew, revocation isolation, one ledger row per (device, seq), cursors
    A=4 B=4.
  - Honest split: **instances REAL, transport PASS-SIM** (mutations signed by the
    runner with the enrolled test keys; the app signing path is covered by
    `test:sync-e2e` + the Rust ingestion test). Artifact:
    `tests/results/two-instance.json`.
- **Owner-blocked (unchanged):** SYN-05/06/07/11/21/29 need a merchant-issued
  gateway with real enrolled device keys (HAR-003) · Arabic/cut/drawer on paper
  (HAR-002) · fiscal layout confirmation (HAR-004).
- **Next:** SEC-01 increment 2 steps 2–4 (migrate boot-critical writes, enable the
  read-only pool, then the money paths with the latency baseline already measured)
  · product gaps still failing by design (RCP-05/07/10/11/12/15/16/18/22/23,
  TIM-02/07, CRM-03/06, G-23).
