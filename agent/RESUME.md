# RESUME — c01-rc6 work

- **rc-6 is tagged** at `d57ddef` (annotated, never move it).
- **Branch:** `c01-rc6-work`; latest commits: `9434706` harness waits, `2d52468` SEC-18, `e76d586`
  SEC-19/20, `4f23824` index + reconcile.
- **State on HEAD (`4f23824`):** all app-source gates green — money 65/65 · zero-tax 23/23 ·
  cash-terms 32/32 · tsc 0 · cargo **454/454** · selftest 137/137 · reconcile **687** (PASS 227,
  226 non-flaky) · register 0 OPEN · guards green · **50-sec 10/10** · **51 10/10** (SEC-18/19/20
  closed) · 40-shf 12/12 and refund 30-34 green as of `d57ddef` (re-run on request).
- **Queue 2 done:** G-21 create-path delivery stamp · G-05 fixture units · CRM-02 · DRW-24
  (lock-overlay + React-set blind input) · IDN-12/DRW-08 (reload unlock + mobile-shell boot) ·
  ADR-002 convergence · ADR-003 at-rest · SYN-02 decision (HAR-004) · SYN-27 note · SEC-18 audit
  app_version/session_id (v129 + self-heal) · SEC-19 throttled browse audit · SEC-20
  contentProtected + clipboard auto-clear.
- **Queue remaining (large, no user blocker):**
  1. **REF-86** — mega-refund latency: D6 aggregation (shrink the ~80 MB customer ledger), then one
     lifecycle pass; measure before/after with the case.
  2. **Two-instance + merchant-gateway harness** — unblocks the 10 SYN cases; loopback gateway
     exists (`proxy/gateway.mjs`); needs isolated data dirs/ports and a deterministic driver.
  3. **ESC/POS capture sink + decoder oracle** — makes the 10 software-verifiable RCP cases run
     without hardware; 4 stay hardware-only.
  4. **SEC-01 design record** — research enterprise role-bound IPC (gateway contract) and deepen
     ADR-001; R1 already enforces the IPC layer.
- **Owner-only:** SYN-02 numbering rule (HAR-004; device-series recommended), printer (HAR-002),
  merchant gateway + enrolled keys (HAR-003).
