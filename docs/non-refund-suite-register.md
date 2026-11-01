# Non-refund suites — reconciled register (24-syn / 40-shf / 50-sec / 26-rcp)

Supersedes E-0143's counts (which mixed mocha test counts with case verdicts and omitted 26-rcp).
Measured at HEAD `dcd7b77`, one suite per run, verdicts read from each run's `caseVerdicts`.

## Per-suite reconciliation

| Suite | Total | PASS | FAIL | BLOCKED | N/A | PASS-PARTIAL |
|---|---|---|---|---|---|---|
| 50-sec | 10 | 9 | 1 | 0 | 0 | 0 |
| 24-syn | 30 | 5 | 4 | 17 | 4 | 0 |
| 40-shf | 12 | 12 | 0 | 0 | 0 | 0 |
| 26-rcp | 29 | 3 | 16 | 4 | 3 | 3 |
| **Σ** | **81** | **29** | **21** | **21** | **7** | **3** |

Non-PASS IDs:
- **50-sec**: SEC-01 FAIL; SEC-04/06/09 PASS.
- **24-syn**: SYN-02/04/26/27 FAIL; SYN-05/06/07/08/09/10/11/12/14/15/19/21/22/23/24/28/29 BLOCKED;
  SYN-16/17/20/25 N/A.
- **40-shf**: all 12 cases PASS (SHF-02/07/11 fixed; SHF-13 premise corrected).
- **26-rcp**: RCP-01/02/05/07/10/11/12/13/15/16/18/21/22/23, TIM-02/07 FAIL; RCP-08/03-pair
  (TIM-03/06) PASS-PARTIAL; RCP-19/24, TIM-09/10 BLOCKED; RCP-14/17, TIM-04 N/A.

## Classification (every case explained)

### 50-sec — authorization
| Case | Class | Basis |
|---|---|---|
| SEC-01 | **ACCEPTED RESIDUAL (security, pre-gateway)** | Native authorization is capability-by-license-state, not by user role: a cashier session can call manager-only IPC (`create_database_backup`, peer `pin_set`). This is the documented renderer-trust residual (AGENTS.md "WebView SQL bypass", D11): the WebView holds the IPC handle until the data-plane gateway lands. Exit criteria: role-bound IPC capabilities + gateway. Sources: Tauri v2 Security — Capabilities/Permissions (v2.tauri.app/security/capabilities), OWASP ASVS 4.2.1 (function-level access control), PCI DSS v4.0 req 7.2 (least privilege by role). |
| SEC-04 | **FIXED (PIN policy alignment)** | Lock-screen pad selection, attempt ordering, and rotation classification now use the same primary-admin identity rule as native `pin_set`/`pin_verify`. A secondary admin's 4-digit profile is rendered as a cashier pad and unlocks with its own credential. Native PIN tests and SEC-04 E2E pass. |
| SEC-06 | **FIXED** | The assertion now matches the observed audit delta (12 → 14) after the PIN-gated no-sale; the case passes. |
| SEC-09 | **PARTIALLY FIXED; POLICY FOLLOW-UP OPEN** | Native checkout now rejects negative/non-finite line quantities, requires per-product signed line quantities to equal inventory deltas, and verifies shift status/ownership. SEC-09 passes those probes. No merchant-approved maximum quantity or full validation of caller-supplied receipt totals exists yet; do not invent that fiscal policy. Sources: OWASP ASVS 5.1.3, PCI DSS 6.2. |

### 40-shf — shifts & drawers
| Case | Class | Basis |
|---|---|---|
| SHF-02 | **FIXED (attribution)** | The cash store-expense lane now passes `StoreExpense.recordedBy` into `logCashMovement`. The SHF-02 assertion passes in the full shift run. Source: PCI DSS 10.2 (user attribution on cash movements). |
| SHF-07 | **FIXED (crash containment)** | Boot adoption now checks each Dexie OPEN candidate against SQLite status and demotes/syncs stale mirrors. Native checkout also rejects missing, closed, or foreign shifts; native checkout denials do not fall back to the TypeScript writer and clear recovery intents. SHF-07 and the full shift suite pass. The two-store close window remains, but a reboot cannot sell against it. |
| SHF-11 | **FIXED (native ownership gate)** | Refund allocation requires active-shift equality and an open session `device_id` matching the enrolled device. Native regression and full shift E2E pass; no refund or movement lands for a peer-owned session. |
| SHF-13 | **BY-DESIGN — test premise corrected** | Receipt seller remains the shift opener (`createOrderSlice.ts:1014-1048`); cashier B's unlock is separately audited. The corrected case passes as part of the full shift run. |

### 24-syn — sync matrix
| Case | Class | Basis |
|---|---|---|
| SYN-02 | **PRODUCT DEFECT (data integrity)** | Two terminals can mint the same receipt number and the DB accepts both — fiscal numbering must be collision-proof per merchant, not per device. Fix direction: merchant-scoped sequence (native) with a unique index; local DB stays authoritative. Source: the plan's fiscal requirements (sequential, collision-free document numbers). |
| SYN-04 | **ACCEPTED DESIGN (documented)** | Product edit-vs-edit is last-write-wins with a version guard on the row (CAS exists for customers; products rely on version compare in the adapter). Accepted as the documented convergence model for non-money catalogue fields; money rows (customers/debts/refunds) are CAS-guarded. |
| SYN-26 | **ACCEPTED RESIDUAL (at-rest exposure)** | A stolen device's local DB exposes business data; at-rest encryption of the whole DB is not implemented. Bounded by OS-level disk encryption + PIN gate on the UI; registered with the same trust boundary as D11. Sources: OWASP MASVS-STORAGE-1, PCI DSS 3.x (scope reduction). |
| SYN-27 | **PRODUCT DEFECT (ordering)** | Sync ordering must not depend on wall clock (device clocks drift; a clock change reorders). The durable monotonic anchor exists for money paths (`time_anchor.rs`); the pull cursor still compares timestamps. Fix: order by (version, HLC) as the spec requires. |

### 26-rcp — receipts / time
16 FAILs share one environment/harness cause: the suite asserts ESC/POS byte output and paper behaviour (codepage, 58/80 mm widths, logo raster, barcode width, Arabic/RTL shaping, DST stamps) through a **simulated printer spooler**. The spooler accepts bytes, but the assertions depend on a real device's firmware behaviour (codepage tables, raster fallback, paper width) that the sandbox does not provide.
- **BLOCKED — named dependency: physical ESC/POS printer (58 mm and 80 mm) or a faithful emulator with codepage/raster tables.** Manual procedure: print each RCP case's fixture to the device, compare bytes (`escpos.ts` golden) and the paper output.
- TIM-02/TIM-07 (timezone/NTP mid-sale) are additionally blocked by the sandbox's fixed clock; the business-day anchor is exercised by REF-52 (PASS).
- RCP-08/TIM-03/TIM-06 are PASS-PARTIAL: the byte-level path is asserted; the paper-visible half needs the device.

### BLOCKED cases (24-syn)
SYN-05..12, 14, 15, 19, 21..24, 28, 29 need a **second app instance with its own data dir** and (for the signed lane) a **mock merchant gateway**. `proxy/gateway.mjs` + `tests/fixtures/mockGatewayServer.mjs` exist but the sync matrix drives two live WebViews, which the harness cannot host today. Named dependency: two-instance harness (separate `--user-data-dir` + separate `mobi_pos.db`).

## Primary sources

1. Tauri v2 Security — Capabilities & Permissions: <https://v2.tauri.app/security/capabilities/> (accessed 2026-11-01).
2. OWASP ASVS v4.0.3 — 4.1/4.2 access control, 5.1 input validation, 8.3 sensitive data: <https://owasp.org/www-project-application-security-verification-standard/>.
3. PCI DSS v4.0 — req 6.2 (secure code), 7.2 (least privilege), 9/10 (physical + logging): <https://www.pcisecuritystandards.org/document_library/>.
4. The repository's own binding decisions (`AGENTS.md`: Tier B, WebView SQL bypass residual; `docs/decisions/D11`, `D12`).
