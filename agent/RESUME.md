# RESUME — c01-rc6 work

- **rc-6 is tagged** at `d57ddef` (annotated). Never move it.
- **Branch:** `c01-rc6-work`; latest queue-2 commits: `7c4d204` (G-05), `ef20b6c` (ADRs + SYN notes),
  `9434706` (harness waits, E-0160).
- **Gates on rc-6 (all green):** money 65/65 · zero-tax 23/23 · cash-terms 32/32 · tsc 0 · cargo
  453/453 · selftest 137/137 · reconcile 687 · register 68/0 OPEN · seven guards · 50-sec 10/10 ×3
  · 40-shf 12/12 · 30/31/32/33 12/15/15/18 · 34 17/17 + clean invariants (after the G-05 fix).
- **Queue 2 done so far:** G-21 (create-path delivery stamp), G-05 (fixture registers units), CRM-02
  (unique-per-run variants), DRW-24 (named interceptor = late lock-screen overlay + React-set blind
  input), IDN-12 and DRW-08 (boot-marker/reload unlock), ADR-002 convergence model, ADR-003 at-rest
  residual, SYN-02 numbering decision (HAR-004 options), SYN-27 mitigation note.
- **Next queue:** validate 66/65/75 full suites with the harness fixes → REF-86 (D6 aggregation
  measurement + fix) → SEC-18 (audit app_version + structured session column, migration v129) →
  SEC-19 (browse throttle/audit) → SEC-20 (content protection + clipboard auto-clear) → two-instance
  + gateway harness (24-syn PASS-SIM/RUN) → ESC/POS capture sink → SEC-01 enterprise design record.
- **Owner-only blockers:** SYN-02 numbering rule (HAR-004: A device-series recommended), printer
  session (HAR-002), merchant gateway + device keys (HAR-003).
- **Known parks:** REF-86 (mega-refund perf; D6 aggregation), 24-syn 10 blocked on the gateway,
  26-rcp 10 software-verifiable + 4 hardware, G-23/CRM-03/06 product gaps.
