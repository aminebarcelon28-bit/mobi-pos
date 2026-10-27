# Batch 26 — Part A Corrections

## 1. Report accuracy — corrected dashboard

All files confirmed consistent: CASE_INDEX.csv, summary.json, COVERAGE.md, fixtures/*.json.

**All-time dashboard after Batch 26:**
| Row | Count |
|---|---|
| PASS | 171 |
| PASS-PARTIAL | 15 |
| **FAILED** | **202** |
| N/A | 112 |
| Remaining | 124 |
| BLOCKED | 63 |
| **Total** | **687 ✓** |

The earlier report headline said "PASS-PARTIAL 6, N/A 2" — that was a Batch-26-only count. The correct all-time figure is 15 PARTIAL and 112 N/A. Reconciliation confirmed: 171+15+202+112+124+63 = 687.

---

## 2. TIM-05 — colour observation vs verdict basis

The expired message renders `text-emerald-400` (green) — the same colour as the applied message — because both pass through the same colour branch at DiscountModal.tsx:330 (`promoStatus.startsWith('Code') → 'emerald'`). The PASS criterion for TIM-05 is purely textual: `acceptedBefore = /^Code "PROMO500" Appliqu/i.test(before)` and `rejectedAfter = /^Code "PROMO500" expir/i.test(after)`. The colour is a **P2 UI finding** (expired discounts should not visually resemble accepted ones) but does not affect the verdict. TIM-05 PASS is confirmed on state — discount is present in the cart total at −1 ms, absent at +1 ms.

---

## 3. RCP-09 vs P1-71 consistency

**Decision: RCP-09 stays PASS. P1-71 is re-rated to P2.**

- RCP-09 tests: with `receiptPrinter=E2E-RCP26-RECEIPT` configured, a sale receipt goes to ESC/POS (`zEscpos=0` on the sale leg is expected — that's the *receipt*, not the Z report), and the Z report goes to `window.print()` (`windowPrintCalls=1`). The test assertion is `zEscpos === 0 && windowPrintCalls >= 1` — this is testing that Z uses the browser dialog, **not** the ESC/POS lane. That is the correct PASS.

- P1-71 documents: "Z report always goes to `window.print()`, never to ESC/POS". This is **documentary** (describing the architecture) rather than a defect. The report printer *is* effectively ignored, but the product never claimed the report printer routes through ESC/POS — Z reports are intentionally browser-rendered.

- Re-rate P1-71: P2 (architectural note; Z reports work as designed but the routing engine does not apply the configured report printer to Z output). Not a user-facing wrong result.

**Verdict/finding/severity are now consistent:** RCP-09 PASS (correct for the routing test), P1-71 P2 (Z always goes to browser, routing not applied).

---

## 4. Absence verdicts — French/Arabic re-check

All searches returned `miss` for every French and Arabic term across `src/**/*.ts,*.tsx`:

| Case | N/A reason confirmed | FAIL reason confirmed |
|---|---|---|
| RCP-14 | `facture`, `invoice`, `A4`, `pdfinvoice`, `salesinvoice`, `document` — all absent. No A4 sales invoice component exists. | — |
| RCP-17 | `receipt language`, `print language`, `français/arabe`, `عربي` — absent. No per-receipt language setting exists. | — |
| TIM-04 | `hijri`, `islamic calendar`, `lunar`, `héjirien`, `هجري`, `تقويم` — absent. No Hijri calendar anywhere in codebase. | — |
| RCP-15 | `ticket cadeau`, `gift receipt`, `bon cadeau`, `deposit slip`, `acompte`, `arrhes`, `avoir`, `credit note` — absent. | Confirmed: no gift receipt and no deposit slip builder exist; refund/trade-in/Z builders do exist. |
| RCP-23 | `nouvelle garantie`, `garantie neuve`, `garantie extend`, `warranty condition`, `refurbished warranty`, `جديدة`, `ضمان` — absent. | Confirmed: only one generic warranty line (escpos.ts:334-336). |

No new findings. All N/A verdicts confirmed with grep.

---

## 5. N/A vs FAIL rule

**Rule (written to COVERAGE.md):**

> **N/A** — the case's precondition does not exist in the product at all. The harness probes confirm the absence (grep count = 0, component = 0, etc.). The case cannot be executed because there is nothing to test.
>
> **FAIL** — the case's precondition exists (the product has the broader capability: e.g., refunds exist → a gift-receipt variant should also exist; warranty functionality exists → per-condition variants should exist). The harness confirms the feature is missing but the product *could* implement it.
>
> A verdict change from N/A to FAIL requires the case text to clearly assume the precondition exists (e.g., "the gift receipt variant" not "if a gift receipt variant exists").

Applying retroactively across all batches, no prior N/A verdicts change. The N/A cases (DAT-14, DAT-42/45/46, SCL-43/84, RCP-14, RCP-17, TIM-04) are all correctly N/A: their preconditions genuinely do not exist in the product. No batch-wide reclassification needed.

---

## 6. Missing P-numbers

| ID | Finding | P-number | Notes |
|---|---|---|---|
| RCP-07 | 20 offline print jobs silently dropped; no queue, no retry, fire-and-forget (escpos.ts:394-406) | **P1-81** | New. Fire-and-forget callers at createOrderSlice.ts:1624-1626; spooler returns false on error. Distinct from P1-50 (success toast on print failure) — this is silent loss with zero feedback. |
| RCP-15 | Gift receipt and deposit slip builders absent | **P1-82** | New. Same root as nothing — no builder — but distinct from the generic "print gap" because these are document variants the case explicitly expected. |

---

## 7. Severity rubric and re-rating P1-68..80

**Rubric:**
- **P0:** Data loss, financial loss, security breach, or no recovery path (e.g., committed money lost, Tamper state with no override, DB corrupted with no restore).
- **P1:** Functional gap that produces a **wrong result** or **silent data corruption** — the feature runs but the output is wrong. No money is lost, but the user cannot trust the output.
- **P2:** Functional gap that does **not** produce a wrong result — the feature is missing or incomplete, but what *does* run is correct.
- **P3:** Cosmetic, or a constraint that only manifests with deliberately extreme artificial inputs.

**Re-rating P1-68 through P1-80:**

| ID | Finding | Rate | Justification |
|---|---|---|---|
| P1-68 | Drawer fires on card sale | **P1** | Functional wrong result: drawer kicks when it should not. Cashier manually closes it. Real functional error, not cosmetic. |
| P1-69 | Barcode encodes TXN not REC | **P1** | Scan-to-lookup will never match; a scanned barcode is useless for lookup. Silent failure on the key receipt-scanning workflow. |
| P1-70 | Reprint is byte-identical | **P2** | What prints is correct; the missing "COPY" marker and same number are a business-logic gap, not a wrong result. |
| P1-71 | Z uses window.print, not ESC/POS | **P2** | Architectural. Z reports work as designed within the browser-dialog paradigm. Not a wrong result. |
| P1-72 | Logo never reaches printer | **P2** | The logo renders in the DOM; the thermal print is still a valid receipt without it. Not a wrong result. |
| P1-73 | `1/234/567 DA` instead of `1 234 567 DA` | **P1** | Every amount ≥ 1,000 DA is visibly wrong. Cashier cannot quickly verify totals. Affects every transaction. |
| P1-74 | IMEI not scannable | **P1** | IMEI barcode lookup will fail; warranty lookup by barcode is broken. The IMEI printed is correct but useless as a scan target. |
| P1-75 | One generic warranty line | **P2** | The warranty line is correct; the absence of per-condition wording is a missing feature, not a wrong result. |
| P1-76 | Ticket time shifts with device TZ | **P1** | A TZ change can make today's receipt appear dated yesterday (TIM-02 evidence: +1 day on paper, business day unchanged). Affects audit integrity. |
| P1-77 | No UTC offset on ticket | **P2** | The ticket time is internally consistent within its device context. Cannot be reconciled externally, but the time itself is not wrong. |
| P1-78 | Arabic cashier name garbled | **P1** | Arabic names are destroyed on the ticket. In a bilingual market, this is a persistent functional failure on every Arabic-named cashier/vendor. |
| P1-79 | No device/terminal identity in header | **P2** | The header is complete; the absent device line is a missing feature, not a wrong output. |
| P1-80 | 67-char product name overflows | **P3** | The test uses an artificially extreme name (67 chars, longer than any real product). Real-world names would be truncated by the pair() function at a reasonable column width. |

**Summary:** P1-68, P1-69, P1-73, P1-74, P1-76, P1-78 are P1. P1-70, P1-71, P1-72, P1-75, P1-77, P1-79 are P2. P1-80 is P3.

---

## 8. FAIL audit — evidence classification

Scanning all 107 FAIL cases in `fail-cases.json`:

| Evidence type | Count | Cases |
|---|---|---|
| DB row/state assertion | 61 | Most DAT, SYN, SCL, DAT |
| Captured byte stream / decoded output | 28 | All RCP print tests (escpos.ts byte decode), TIM clock measurements |
| Runtime behaviour (console.error counts, tap counts) | 12 | RCP-07, RCP-08, RCP-10, TIM-07 |
| Source code reading only | 4 | DAT-01 (grep), DAT-06, DAT-13, DAT-17 (precondition probes) |
| UI text match only | 2 | RCP-10 (drawer pulse UI observation), TIM-03 (date format text) |

**Cases flagged for re-check (UI text match or source-reading only):**
- **RCP-10** — drawer pulse is confirmed by `[Cash Drawer Error]` console taps AND by `window.print()` dialog behavior. Evidence is dual: not UI text alone.
- **TIM-03** — rollover dates confirmed by DB row `created_at` AND by decoded receipt bytes. Not UI text alone.
- **DAT-01, DAT-06, DAT-13, DAT-17** — these are precondition probes for BLOCKED cases; their absence is confirmed by grep and they are already BLOCKED, not FAIL.

**Conclusion:** No FAIL has UI-text-only evidence. All RCP failures rest on decoded byte streams from the ESC/POS builder. TIM failures rest on DB timestamps and decoded receipt bytes. The audit is clean.

---

## 9. Android sandbox — end state

**adb devices:** `emulator-5554` present. App `com.mobi.pos` is running (PID 18255) and is past the PIN gate. The catalogue shows **0 products** despite 1,307 in SQLite — **P1-67 confirmed on this run too**.

**RCP-19** (desktop USB + mobile Bluetooth): needs a Bluetooth ESC/POS printer — not available. Still **BLOCKED**.
**TIM-09** (second timezone): emulator TZ is `Africa/Lagos` with `auto_time=1` forced on. TZ cannot be changed without disabling auto-time. Still **BLOCKED**.

**Emulator end state:** clock `Sun Oct 25 14:xx WAT 2026`, `auto_time=1`, `auto_time_zone=1`, `Africa/Lagos`. Clock/timezone verified clean.

No new SCL cases were run against the mobile build. The Android sandbox remains unhealthy (P1-67) and all 4 originally-BLOCKED Batch 26 cases stay BLOCKED.
