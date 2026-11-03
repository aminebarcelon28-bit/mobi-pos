# RESUME — current (post c01-rc-10)

- **Tags:** `c01-rc-10` at the handoff commit (verified content `17feec7`) ·
  `c01-rc-9` at `8c63bf6` · `c01-rc-8` at `a9ba71b` · `c01-rc-7` at `eeda281` ·
  `c01-rc-6` at `d57ddef`. Tags are immutable from here.
- **Branch:** `c01-rc6-work`; tracked tree clean.
- **Clean-worktree gates at `17feec7`:** money 65/65 · zero-tax 23/23 · cash-terms
  32/32 · tsc 0 · lint 0 · selftest OK · reconcile 687 · cargo 460/460 · 50-sec
  10/10 · 40-shf 12/12 · 30 12/12 · 31 15/15 · 32 15/15 · 33 18/18 · 34 17/17 · 51
  10/10 · spec 92 (read-only lane) 1/1 · escpos 27/27 · syn-faults 8/8 ·
  two-device 19/19 · numbering 11/11 · acquirer 15/15 · two-instance 16/16 (run from
  the worktree).
- **SEC-01 increment 2, step 2a (landed, E-0182):** native `sql_select_ro` opens its
  own connection with `PRAGMA query_only=1`, is registered (`ReadOperationalData`)
  and handler-parity checked. Proven from the app: SELECT works; INSERT/UPDATE/
  DELETE/DDL are refused **and leave no effect**; the normal lane still writes.
  Measured: native lane p50 2.8 ms / p95 3.5 ms per call (new connection each time)
  vs 0.5/0.7 ms on the plugin pool; checkout 242–624 ms.
- **Remaining part of increment 2:** the renderer's own pool is still writable —
  flipping it needs the boot-write migration (ADR-005 steps 2–4). That is the next
  engineering item; the engine proof (`sql_boundary.rs`) and the app-path lane
  (`sql_ro.rs`) are in place, so the migration can be measured against them.
- **Owner-blocked (unchanged):** SYN-05/06/07/11/21/29 (merchant gateway + enrolled
  device keys, HAR-003) · Arabic/cut/drawer on paper (HAR-002) · fiscal numbering
  confirmation (HAR-004).
- **Other known gaps (not owner-blocked):** product gaps still failing by design
  (RCP-05/07/10/11/12/15/16/18/22/23, TIM-02/07, CRM-03/06, G-23); the two-instance
  suite covers concurrency at the protocol level (`test:sync-two-device`), not two
  GUI processes writing simultaneously.
