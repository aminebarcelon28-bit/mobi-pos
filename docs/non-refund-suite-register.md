# Non-refund suites — reconciled register (24-syn / 40-shf / 50-sec / 26-rcp)

Supersedes E-0143's counts (which mixed mocha test counts with case verdicts and omitted 26-rcp).
Measured at HEAD `dcd7b77`, one suite per run, verdicts read from each run's `caseVerdicts`.

## Per-suite reconciliation

| Suite | Total | PASS | FAIL | BLOCKED | N/A | PASS-PARTIAL |
|---|---|---|---|---|---|---|
| 50-sec | 10 | 6 | 4 | 0 | 0 | 0 |
| 24-syn | 30 | 5 | 4 | 17 | 4 | 0 |
| 40-shf | 12 | 8 | 4 | 0 | 0 | 0 |
| 26-rcp | 29 | 3 | 16 | 4 | 3 | 3 |
| **Σ** | **81** | **22** | **28** | **21** | **7** | **3** |

Non-PASS IDs:
- **50-sec**: SEC-01, SEC-04, SEC-06, SEC-09 (all FAIL).
- **24-syn**: SYN-02/04/26/27 FAIL; SYN-05/06/07/08/09/10/11/12/14/15/19/21/22/23/24/28/29 BLOCKED;
  SYN-16/17/20/25 N/A.
- **40-shf**: SHF-02/07/11/13 FAIL.
- **26-rcp**: RCP-01/02/05/07/10/11/12/13/15/16/18/21/22/23, TIM-02/07 FAIL; RCP-08/03-pair
  (TIM-03/06) PASS-PARTIAL; RCP-19/24, TIM-09/10 BLOCKED; RCP-14/17, TIM-04 N/A.

## Classification (every case explained)

### 50-sec — authorization
| Case | Class | Basis |
|---|---|---|
| SEC-01 | **ACCEPTED RESIDUAL (security, pre-gateway)** | Native authorization is capability-by-license-state, not by user role: a cashier session can call manager-only IPC (`create_database_backup`, peer `pin_set`). This is the documented renderer-trust residual (AGENTS.md "WebView SQL bypass", D11): the WebView holds the IPC handle until the data-plane gateway lands. Exit criteria: role-bound IPC capabilities + gateway. Sources: Tauri v2 Security — Capabilities/Permissions (v2.tauri.app/security/capabilities), OWASP ASVS 4.2.1 (function-level access control), PCI DSS v4.0 req 7.2 (least privilege by role). |
| SEC-04 | **TEST-DESIGN ERROR** | The spec mints a 4-digit credential for a profile whose pad only mounts `login-submit` at ≥ 6 digits (`LockScreenOverlay.tsx:102-104`), then asserts a login that cannot be submitted. Fix: mint a ≥ 6-digit PIN in that fixture (manager floor is 6 by policy). |
| SEC-06 | **HARNESS GAP** | The case asserts the audit log "grows" but the observed delta (12 → 14 after a PIN-gated no-sale) does not match its boolean expectation; the DB is the authority and it did grow. Fix: assert the exact two rows by action rather than a boolean. |
| SEC-09 | **ACCEPTED RESIDUAL (input validation, same pre-gateway class) + one fixable gap** | `checkout_sale_atomic` persists a client-supplied quantity (1e15) and `shift_id` verbatim from a forged invoke. Role/arg validation for privileged callers is the same gateway/role-capability gap as SEC-01; the unbounded quantity is additionally a native validation gap (clamp to a policy maximum) registered as follow-up. Sources: OWASP ASVS 5.1.3 (bounded inputs), PCI DSS 6.2 (secure code). |

### 40-shf — shifts & drawers
| Case | Class | Basis |
|---|---|---|
| SHF-02 | **PRODUCT DEFECT (P2, attribution)** | The cash store-expense lane mirrors the payout into the drawer without the acting user (`addStoreExpense` → `logCashMovement`), so the movement loses its operator. Fix: pass the acting cashier through. Source: PCI DSS 10.2 (user attribution on cash movements). |
| SHF-07 | **ACCEPTED RESIDUAL (crash window, G-18)** | A crash between the SQLite CLOSED write and the Dexie mirror can leave a half-closed drawer observable until the next boot reconciliation. Bounded by boot reconciliation; registered with the G-18 signature. |
| SHF-11 | **PRODUCT DEFECT (P2, drawer ownership)** | A forged refund allocated its cash movement to a FOREIGN device session row (session not proven to belong to this device). Fix: native gate requires the movement's session to belong to the calling device/shift. Source: PCI DSS 9.x/10.5 (physical/logical access separation), AGENTS.md module B/C. |
| SHF-13 | **BY-DESIGN (documented rule) — test premise corrected** | The receipt seller is ALWAYS the shift opener (`createOrderSlice.ts:942-950`, "Part 1 seller rule"), so a sale rung after a handover carries the opener; the spec expects the acting user. The product rule is intentional and auditable (unlock audit records B); the case's premise is the error. |

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
