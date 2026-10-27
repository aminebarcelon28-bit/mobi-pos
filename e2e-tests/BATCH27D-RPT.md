# Batch 27d — RPT (12): triage and execution

Date: 2026-10-26
Scope: every `RPT-*` row still in the REMAIN bucket — 12 cases
(`RPT-01/03/04/05/06/07/08/09/10/11/12/13`; `RPT-02` is already N/A, the app
has no tax).
Canonical log: `e2e-tests/logs/part0-27d.log` (12 `VERDICT=` lines + 7 `FACT=` lines)
Artifacts: `e2e-tests/tools/27d-rpt-checks.mts` (all 12 cases),
`e2e-tests/tools/build-27d-log.mjs` (assembles the canonical log),
`e2e-tests/tools/update-index-27d.mjs` + `update-coverage-27d.mjs` + `verify-27d.mjs`
(reconciliation).

Result: **12/12 cases produced a `VERDICT=` line** —
**2 PASS, 1 PASS-PARTIAL, 9 FAIL**.

| Verdict | Cases |
|---|---|
| PASS | RPT-03, RPT-08 |
| PASS-PARTIAL | RPT-06 |
| FAIL | RPT-01, RPT-04, RPT-05, RPT-07, RPT-09, RPT-10, RPT-11, RPT-12, RPT-13 |

---

## 1. How 27d was run

One deterministic half, no UI spec. Every case in this batch is either

- a **measurement** — the app's own module is executed unmodified and its
  output is compared with an independent oracle or with a second shipped
  surface (`computeSalesMetrics`, `generateProfessionalExcelXml`,
  `DebtStatementTicketBuilder`, `toLocalDayKey`, `better-sqlite3` in WAL mode);
  or
- a **static absence** — the feature the case names does not exist in the
  tree, and the verdict quotes the search that proves it.

No PASS in this batch depends on a rendered string, so a WDIO run would add
no evidence the modules do not already carry; the interactive layer is
explicitly listed as unasserted in §6 where it matters.

```
node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types \
  e2e-tests/tools/27d-rpt-checks.mts
```

Machine: `AMD Ryzen 5 8500G`, 12 cores, 15.1 GiB RAM, Windows 10.0.26300,
Node v24.18.0. No Tauri WebView and no live DB are involved; the only database
opened is a throwaway WAL file in the OS temp dir for RPT-06.

### 1.1 The controlled ledger

Fourteen rows built with the real `SaleTransaction`/`CartItem` shapes
(integer DA, local-time anchors relative to the run). The shape details are
deliberate: refund vouchers carry `items: []` exactly as the app writes them,
the exchange row carries a signed return leg, one row carries a frozen
allocation that disagrees with its stored cost, and one carries a
materialized `ledgerCogsTotal` that disagrees with its stored cost.

| Row | When | Cashier | Tender | Items (unit cost) | Subtotal | Disc. | Total | Stored cost | Ledger cost | Role |
|---|---|---|---|---|---|---|---|---|---|---|
| FIX-001 | today 10:00 | Ali | Espèces | P1 ×1 (25 000) | 30 000 | 1 000 | 29 000 | 25 000 | **24 000** (alloc) | frozen-allocation override |
| FIX-002 | today 23:59:59.999 | Sara | Carte | P2 ×2 (1 000) | 10 000 | – | 10 000 | 2 000 | **1 800** (`ledgerCogsTotal`) | ledger vs stored divergence |
| FIX-003 | yesterday 00:00 | Ali | Espèces | P3 ×1 (9 000) | 8 000 | – | 8 000 | 9 000 | 9 000 | negative-margin service |
| FIX-004 | day-7 + 1 h | Sara | Espèces | P4 ×1 (9 000) | 12 000 | – | 12 000 | 9 000 | 9 000 | inside desktop 168 h, outside mobile calendar 7d |
| FIX-005 | today 10:00 | Ali | Espèces | P2 ×1 (1 000) | 5 000 | – | 5 000 | 1 000 | 1 000 | **VOIDED** |
| FIX-006 | today 10:00 | Ali | Espèces | `[]` | 3 000 | – | 3 000 | 0 | 0 | refund voucher, `restoredCogs` 2 000 |
| FIX-007 | today 10:00 | Sara | Carte | `[]` | 2 000 | – | 2 000 | 0 | 0 | refund voucher, write-off (no restore) |
| FIX-008 | today 10:00 | Ali | Espèces | P4 +1 (9 000), P2 −1 (1 000, `isReturn`) | 7 000 | – | 7 000 | 4 000 | 4 000 (signed) | trade-in exchange |
| FIX-009 | today 10:00 | Sara | Carte | P5 ×1 (3 000) | 7 000 | – | 7 000 | 3 000 | 3 000 | plain sale |
| FIX-010 | today 10:00 | Ali | Espèces | P6 ×1 (500) | 2 000 | – | 2 000 | 500 | 500 | plain sale |
| FIX-011 | today 10:00 | Sara | Carte | P7 ×1 (400) | 1 500 | – | 1 500 | 400 | 400 | plain sale |
| FIX-012 | today 10:00 | Ali | Espèces | P8 ×1 (900) | 2 500 | – | 2 500 | 900 | 900 | plain sale |
| FIX-013 | today 00:00:00.000 | Ali | Espèces | P6 ×1 (500) | 2 000 | – | 2 000 | 500 | 500 | lower day-key boundary |
| FIX-014 | tomorrow 00:00:00.000 | Sara | Carte | P8 ×1 (900) | 2 500 | – | 2 500 | 900 | 900 | future-dated row |

Canonical metrics (shipped `computeSalesMetrics`) vs the independent oracle
(raw-ledger arithmetic written from the document law, not from the module):

| Metric | App | Oracle |
|---|---|---|
| CA Net | 78 500 | 78 500 |
| COGS | 54 000 | 54 000 |
| Restored COGS | 2 000 | 2 000 |
| Profit | 26 500 | 26 500 |
| Basket | 7 591 | 7 591 |
| Gross | 84 500 | – |
| Discounts | 1 000 | – |

`FACT` lines in the log carry the numbers each verdict cites, so a reader can
re-check a verdict without re-running the tool.

---

## 2. Verdicts, case by case

### RPT-08 — Dashboard KPIs vs raw ledger — **PASS**

`computeSalesMetrics` (`src/utils/receiptMath.ts:162`) was run on the 14 rows
and every KPI compared with the oracle: CA Net, COGS, profit, basket, refunds,
restored COGS. All equal to the dinar, and the voided row contributes 0 to
every field while the allocation override (24 000 vs stored 25 000) wins as the
frozen-ledger rule requires. The KPI tile renders this same helper, so the
screen number is the asserted number.

*Unasserted:* nothing material — the case is a formula-vs-ledger comparison,
not a rendering test.

### RPT-03 — Profit report: refunds, trade-in basis, repairs, discounts — **PASS**

Five named facets, each checked separately:

| Facet | Assertion |
|---|---|
| Discounts | `discountTotal` 1 000; CA Net uses net `total` (29 000), never gross `subtotal` (30 000) |
| Refund / restock | refunds 5 000; recovered COGS 2 000 credited → profit 26 500 |
| Refund / write-off | FIX-007 has no `restoredCogs`, so the loss stays a cost burden (credit 0) |
| Trade-in cost basis | a 9 999 allocation injected on the exchange row is **ignored**; the signed stored cost 4 000 is used, cost stays 54 000 |
| Repair labour/parts | SAV row built exactly as `RepairWorkOrderModal.tsx:890-940` writes it: charge 15 000 incl. labour − frozen parts basis 6 000 = profit 9 000 |

All five match the oracle; no facet is silently skipped.

*Unasserted:* the repair row is a constructed SAV shape, not a work order
created through the modal UI.

### RPT-06 — Report while sync in progress / during sales — **PASS-PARTIAL**

Snapshot consistency is real and measured: with the report's own SELECT open
inside a WAL read transaction, a concurrent writer committed 50 rows and the
open snapshot still read 100 (visible only after commit: 150). The report
issues exactly one statement per open (`src/db/adapters/transactionAdapter.ts:528-533`),
so a sale or a pull landing mid-report cannot tear a page.

Partial for two named reasons:

1. **Sync-in-progress is not exercisable here** — no gateway is configured, so
   the drain idles; there is no second writer to race against.
2. **The failure path is silent** — a failed range read falls back to the
   bounded store window with only a `console.warn`
   (`src/components/modals/ReportsModal.tsx:207-210`, fallback at `:209`), so
   the same screen can show a truncated dataset without saying so.

### RPT-01 — Sales by day/product/cashier/tender/category sum to one total — **FAIL**

Only the tender dimension reconciles (payments sheet total 78 500 == CA Net).
The rest do not, on the same 14 rows:

| Dimension | Measured | Why it cannot sum |
|---|---|---|
| Product | 84 500 vs CA Net 78 500 | line revenue is gross: transaction-level discount never applied, refund vouchers carry no items |
| Top-5 truncation | 74 000 shown, **10 500 invisible** | `SalesAnalyticsCharts.tsx:246-248` keeps the first five products |
| Category | positives 26 300 vs all 25 300 | donut drops non-positive categories (Services −1 000) and renders integer % shares, not amounts |
| Day | 2 fixture days outside the window | buckets cover 7 calendar days only (`SalesAnalyticsCharts.tsx:101-108`) |
| Cashier | **does not exist** | `SaleTransaction` has `cashierName` only (`src/types/pos.ts:584`, no `cashierId`); 0 grouping call sites |

A report whose dimensions truncate, drop and window cannot sum to the same
grand total, so the case fails on four of five named dimensions.

### RPT-04 — Period filter boundaries (23:59:59 / 00:00:00, timezone, business day) — **FAIL**

What passes: day-key boundaries. Today 00:00:00.000 and 23:59:59.999 both map
to `2026-10-26`; tomorrow 00:00:00.000 maps to `2026-10-27` and is excluded.

What fails: there is no single period definition.

- Desktop "7 jours" is a **rolling 168 h window**
  (`src/components/modals/ReportsModal.tsx:241-247`).
- Mobile is a **calendar key range D-6..D**
  (`src/components/mobile/tabs/LiveActivityTab.tsx:208-230`).
- On this run their start instants differ by **16.2 h**
  (`2026-10-19T06:49Z` vs `2026-10-19T23:00Z`), so FIX-004 (12 000 DA) is
  desktop=true, mobile=false.
- No business-day cutoff exists: `dateUtils` exposes only a timezone
  (`src/utils/dateUtils.ts:11-19`).
- The range read has no upper bound (`transactionAdapter.ts:528-533`), so the
  future-dated 2 500 DA row sits inside 7j/30j/Tout but not inside
  "Aujourd'hui" — the same document is counted or not depending on the tab.

### RPT-05 — Export (PDF/CSV/XLSX) equals screen; 100k rows — **FAIL**

The export **headline** equals the screen (net/cost/profit 78 500/54 000/26 500),
but the columns beneath it do not:

| Check | Measured | Verdict |
|---|---|---|
| Sheet net vs CA Net | 78 500 == 78 500 | ok |
| Sheet cost vs COGS | 54 000 == 54 000 | ok |
| Sheet profit vs profit | 26 500 == 26 500 | ok |
| Row-sum net | 78 500 == 78 500 | ok |
| Row-sum cost | **54 200 != 54 000** | +200 |
| Row-sum profit | **29 300 != 26 500** | +2 800 |
| Items sheet | **84 500 != 78 500** | gross lines |

Cause: `salesRowXml` reads cost as `alloc ?? stored costTotal` only — neither
the exchange signed-cost branch nor the materialized `ledgerCogsTotal`
(`src/utils/excel/sheets.ts:151-159` vs `src/utils/receiptMath.ts:187-202`) —
and forces refund rows to `profit = 0` (`sheets.ts:160-161`), so the refund net
(−5 000) is subtracted while the restored-COGS credit (+2 000) never reaches
the rows. The items sheet sums gross charged lines with no transaction-level
discount and no refund legs.

**Scale facet measured:** 100 000 rows → **10 075 ms**, **+479 MiB heap**,
**180.7 MiB XML**, 100 000 sale rows written, last receipt present, no
truncation; 200 001 rows fail closed with the typed `TOO_LARGE`
(`MAX_EXCEL_ROWS` = 200 000).

*Unasserted:* PDF and CSV writers live inside the ReportsModal handlers and are
not importable, so only the XLSX writer was executed.

### RPT-07 — Customer statement (credit account, loyalty, repairs) — **FAIL**

The Kredy statement exists (credit-account header, Kredy label, seller line
all present) but cannot state the account:

- prints **5 of 8** ledger movements — hard `.slice(0, 5)`
  (`src/utils/debtStatementTicketBuilder.ts:55`);
- prints the **denormalised** `customer.currentDebt` (13 450) instead of the
  ledger sum (6 000), a 7 450 DA gap that no line above it explains;
- the amount is **corrupted on paper**: the fr-DZ thousands separator is
  U+202F, and `escpos.text()` does `charCodeAt & 0xFF`
  (`src/utils/escpos.ts:61-68`), so `13 450` is encoded as `13/450`;
- **loyalty points (480)** and **repairs** are absent from the document
  entirely, although the case names both.

### RPT-09 — Sales/refunds per cashier, rename/merge — **FAIL**

There is no cashier identity to group by. `SaleTransaction` carries
`cashierName` only (`src/types/pos.ts:584`); the interface block 547–660 has no
`cashierId`/`cashier_id`; 0 source files group documents by cashier.

Attribution is by display string, so history is mutable:

| | Ali | Sara |
|---|---|---|
| before rename | 47 500 | 31 000 |
| after "Ali" → "Ali Benali" | 0 / 47 500 (new name) | 31 000 |

Two different cashiers both named "Ali" merge into one line. Refund vouchers
are stamped with whoever processed the refund, so per-cashier refunds are not
the seller's refunds.

### RPT-10 — Drawer-session report: variance by cashier/drawer/device, handovers, force-closes — **FAIL**

What exists: per-session variance is real and gated — variance = physical −
expected, manager PIN at the threshold, mandatory note
(`src/components/modals/ShiftCloseModal.tsx:288,423-439`); expected cash is one
documented formula, `openingFloat + cashSales + deposits - expenses -
cashRefunds` (`src/db/adapters/shiftAdapter.ts:834`).

What does not exist:

- no cashier/drawer/device dimension — `ShiftZReportData` carries a single
  `cashierName` (`src/types/pos.ts:1892-1905`);
- no aggregation of variances across sessions (0 matching call sites);
- a mid-shift handover re-points the OPEN session's `currentCashier`
  (`shiftAdapter.ts:952-989`), so one drawer's variance belongs to whoever held
  it last and is never split between the two cashiers;
- no force-close path anywhere in the tree (0 hits for
  `forceClose|FORCE_CLOSE`).

### RPT-11 — Warranty/inspection report and claim cost vs revenue — **FAIL**

No warranty/inspection **report** exists. The only warranty surfaces are the
per-IMEI inspector (4 references to `ImeiWarrantyInspectorModal`, one device at
a time) and the per-ticket supplier RMA block inside `RepairWorkOrderModal`
(37 RMA references, create-only for the open ticket). A tree-wide search for a
warranty report or a claim cost/revenue aggregate returns **0 hits**, so
claim cost vs revenue (WAR-22) cannot be read anywhere in the app.

### RPT-12 — Same report on desktop and on mobile — **FAIL**

Both shells call the same KPI formula (`computeSalesMetrics`;
`ReportsModal.tsx:289-292`, `LiveActivityTab.tsx:378`), so the arithmetic
agrees. The dataset does not:

- "7 derniers jours" = **78 500 desktop** (rolling 168 h) vs **64 000 mobile**
  (calendar keys D-6..D) — a **14 500 DA** gap;
- 2 documents are counted only by desktop (FIX-004 12 000, FIX-014 2 500);
  0 only by mobile;
- the range sets differ: mobile offers `today/7d/30d/90d/all`, desktop
  `today/7days/30days/all`;
- mobile caps the visible feed per period (`feedLimit` 30/50/100,
  `LiveActivityTab.tsx:208-212`) with no paging or streaming control.

### RPT-13 — Customer segments (VIP, inactive, debtors) at 1 M rows — **FAIL**

There is no segment model. The customer surface offers a pricing-tier filter
and a debts tab only (`CustomersModal.tsx:29-42,1459`); the single computed
segment is `vipCount = customers.filter(pricingTier === 'VIP').length`
(`CustomersModal.tsx:436`) executed **in memory over the whole array**; a
tree-wide search for a customer inactivity/segment concept returns 0 hits;
there is no SQL aggregate over customers and the debtors view is a separate
ledger. VIP / inactive / debtors therefore cannot be produced as one segmented
report, and the 1 M-row ranking/scale facet is moot until a segment report
exists.

---

## 3. New findings from this batch

1. **Export rows do not reconcile to the export headline** (`sheets.ts:151-161`).
   Cost column +200 DA, profit column +2 800 DA, items sheet +6 000 DA on a
   14-row ledger. The headline uses `computeSalesMetrics`; the row writer
   re-implements a subset of it and diverges on exactly the cases that matter
   (frozen ledger, exchange, refunds).
2. **Two period definitions for the same label** (`ReportsModal.tsx:241-247`
   vs `LiveActivityTab.tsx:208-230`): 16.2 h start delta on this run, 14 500 DA
   of turnover difference, and no upper bound on the range read so future-dated
   rows are included.
3. **The Kredy statement is unusable as a statement**: 5-movement cap, a
   denormalised balance that disagrees with its own lines, and a byte-level
   encoding bug that turns the thousands separator into `/` (`escpos.ts:61-68`).
4. **No cashier identity** (`types/pos.ts:584`): every per-cashier figure in the
   product is a display-string join, so renames rewrite history and homonyms
   merge.
5. **No drawer/device variance dimension and no force-close**
   (`shiftAdapter.ts:952-989`): a handover silently re-attributes a drawer's
   variance.
6. **No warranty/claim report** and **no customer segment model**: two whole
   report families named by the catalog do not exist.

---

## 4. Reconciliation

| Check | Result |
|---|---|
| `logs/part0-27d.log` | 12 `VERDICT=` lines, 12 unique ids, 7 `FACT=` lines |
| `CASE_INDEX.csv` | 697 rows, 11 fields, 0 bad-field rows, 697 unique ids |
| Verdicts moved | 12 (`REMAIN → PASS` 2, `→ PASS-PARTIAL` 1, `→ FAIL` 9) |
| Log vs CSV | 0 mismatches (`verify-27d.mjs`) |
| Dashboard | 687 = 178 PASS + 24 PARTIAL + 249 FAIL + 117 N/A + 51 REMAIN + 68 BLOCKED |
| Dashboard vs CSV | matches exactly |
| `FAIL-EVIDENCE-TABLE.md` | 138 classified FAILs (DB 56, BYTES 29, RUNTIME 19, SOURCE 33, UI 1) |
| UI-text-only FAILs | **0** |

27d FAIL classes: RUNTIME 4 (RPT-01/04/05/12 — shipped functions executed,
totals compared to an independent oracle), BYTES 1 (RPT-07 — decoded ESC/POS),
SOURCE 4 (RPT-09/10/11/13 — static absence only), DB 0, UI 0.

---

## 5. Files written by this batch

- `e2e-tests/tools/27d-rpt-checks.mts`
- `e2e-tests/tools/build-27d-log.mjs`
- `e2e-tests/tools/update-index-27d.mjs`
- `e2e-tests/tools/update-coverage-27d.mjs`
- `e2e-tests/tools/verify-27d.mjs`
- `e2e-tests/logs/part0-27d.log`
- `e2e-tests/CASE_INDEX.csv` (12 RPT rows), `e2e-tests/COVERAGE.md` (12 rows +
  dashboard), `e2e-tests/FAIL-EVIDENCE-TABLE.md` (counts + 27d section)

No commits, nothing staged.

---

## 6. Facets this batch did **not** assert (explicit)

| Case | Unasserted facet | Why |
|---|---|---|
| RPT-05 | PDF and CSV writers | They are inline handlers in `ReportsModal`, not importable modules; only the XLSX writer was executed. Whether they repeat the same row-level divergence is therefore unproven, not assumed either way. |
| RPT-06 | "Sync in progress" | No gateway configured, drain idles — no concurrent writer exists to race the report. |
| RPT-07 | Physical printer output | Bytes only; the corrupted separator is a byte-level fact (`0x2F` in the stream), independent of the printer. |
| RPT-01 | Rendered chart pixels | Dimensions are computed by the chart's own rules, quoted by line; the visual layout is not asserted. |
| RPT-13 | 1 M-row ranking/scale | Moot: no segment report exists to scale. |
| RPT-09/10/11 | Second terminal / device identity | No fleet harness; the absences are structural (no column, no aggregation, no report), so they hold regardless. |
