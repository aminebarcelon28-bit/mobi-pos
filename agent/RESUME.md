# RESUME — after c01-rc-6, queue 2 (toward c01-rc-7)

- **c01-rc-6** is tagged at `d57ddef` (immutable). Branch `c01-rc6-work`.
- **Latest commits:** `c6ed8bc` (ESC/POS sink + Arabic lane) · `96fe3b7` (RCP oracles,
  clusters) · `3e1501c` (two-device suite + ADR-005) · `88057fd` (repo
  professionalization).
- **Queue 2 done:** REF-86 measured (D6 not built, evidence) · two-client fault
  suite + mock acquirer · ESC/POS capture sink + decoder + byte goldens + Arabic
  raster lane (ADR-004) + hardware kit · SEC-18/19/20 · G-21/G-05 · CRM-02 ·
  DRW-24/IDN-12/DRW-08 harness waits · ADR-002/003/004/005 · two-device + gateway
  fault suite.
- **Floors on HEAD (main tree and clean worktree `88057fd`):** money 65/65 ·
  zero-tax 23/23 (worktree needs the root `*.db` test artifacts copied in — the
  gate inspects real DBs and fails closed without them) · cash-terms 32/32 ·
  tsc 0 · selftest 137/137 · reconcile 687 · escpos 27/27 · syn-faults 8/8 ·
  two-device 19/19 · acquirer 15/15.
- **E2E on HEAD:** spec 26 16 PASS (RCP-01/02/13/21 now PASS), the rest are
  pre-existing product gaps; 50-sec / 40-shf / 30–34 re-run under the rc-7
  verification (see E-0169/E-0170).
- **Parked, with reasons:**
  - **Two GUI app instances** (SYN-05/06/07/11/21/29): the protocol half is
    proven (two-device + gateway suite); the GUI half needs a second enrolled
    terminal + merchant gateway (HAR-003).
  - **Arabic legibility on paper** (HAR-002): bytes verified; a human must print
    `npm run escpos:kit` and sign `CHECKLIST.md`.
  - **Fiscal numbering** (HAR-004): device-series recommended; needs the owner /
    accountant confirmation before SYN-02 changes the printed number.
  - Product gaps still failing by design: RCP-05/07/10/11/12/15/16/18/22/23,
    TIM-02/07, CRM-03/06, G-23.
- **Next:** SEC-01 increment 1 (role requirement in the native authorizer +
  tests, ADR-005), then the owner asks above.
