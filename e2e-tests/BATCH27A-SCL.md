# Batch 27a — SCL scale/performance triage + execution

Date: 2026-10-26
Scope: every `SCL-*` row in the encyclopaedia (89 rows, not 69 — see §1), triaged
before execution, then the 25 highest-risk executable cases run on a disposable
copy of the desktop sandbox DB.
Canonical log: `e2e-tests/logs/part0-27a-scl.log`
Spec: `e2e-tests/specs/27a-scl-batch.e2e.ts`

Result: **25/25 cases produced a `VERDICT=` line** in 1 m 4.2 s —
16 FAIL, 3 PASS, 5 PASS-PARTIAL, 1 N/A. Snapshot integrity held
(`SNAPSHOT_INTEGRITY … same=true`), and the source DB was byte-identical before
and after the run.

---

## 1. Triage of all SCL cases (before any execution)

The brief said 69 SCL cases; the encyclopaedia actually carries **89** `SCL-*`
rows (`SCL-01` … `SCL-89`, no gaps). All 89 are classified below.

Category definitions:

| Category | Meaning |
|---|---|
| EXECUTED | already had a verdict in `CASE_INDEX.csv` before this batch |
| EXECUTED 27a | run in this batch |
| EXECUTABLE-DESKTOP | no external dependency; runs on the desktop sandbox — queued for 27b |
| NEEDS-MOBILE | needs the Android companion's own UI/sync path |
| NEEDS-GATEWAY | needs a second enrolled terminal, the sync gateway, or a cloud backend |
| NEEDS-LONG | needs a fixture far larger than 1 k rows and/or a multi-hour window. Tier S = 100 k–500 k rows, L = 1 M–5 M, X = 10 M+ / 3-year projection |
| N/A | precondition absent from the product |

Counts: EXECUTED 20 (19 + SCL-23 re-run), EXECUTED 27a 24, EXECUTABLE-DESKTOP 3,
NEEDS-MOBILE 5, NEEDS-GATEWAY 8, NEEDS-LONG 29, N/A 0. Total 89.

| Case | Category | Tier | Precondition cited |
|---|---|---|---|
| SCL-01 | NEEDS-LONG | L | case needs a p95 curve from 1 k -> 1 M rows and stale-query cancellation; the largest fixture the box has ever held is 1,006 customers (27a log) |
| SCL-02 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-03 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-04 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-05 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-06 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-07 | EXECUTED | - | executed in an earlier batch (CASE_INDEX.csv) |
| SCL-08 | NEEDS-LONG | S | 100 k-row CSV import (Arabic, bad rows, duplicates) + kill/resume |
| SCL-09 | NEEDS-GATEWAY | - | merge of two terminals' edits - needs the sync gateway |
| SCL-10 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-11 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-12 | EXECUTED | - | executed in an earlier batch (CASE_INDEX.csv) |
| SCL-13 | EXECUTED | - | executed in an earlier batch (CASE_INDEX.csv) |
| SCL-14 | EXECUTED | - | executed in an earlier batch (CASE_INDEX.csv) |
| SCL-15 | NEEDS-LONG | L | 1 M customers + 5 M lines: VACUUM/backup/restore timing |
| SCL-16 | NEEDS-MOBILE | - | needs mobile enrol/bootstrap against a paired till |
| SCL-17 | NEEDS-GATEWAY | - | needs a replicated table + >=2 enrolled terminals to observe conflict creation and convergence; no gateway harness exists (`syncDrainWorker.ts` idles when `sync.gateway_url` is unset) |
| SCL-18 | NEEDS-LONG | L | 1 M rows under a custom Arabic/French collation on every connection |
| SCL-19 | NEEDS-LONG | L | 1 M-row CSV/XLSX export, cancel midway, low-RAM profile |
| SCL-20 | NEEDS-LONG | L | aggregate screens over 1 M customers |
| SCL-21 | NEEDS-GATEWAY | - | gateway or second device |
| SCL-22 | NEEDS-LONG | X | 5 M sale lines / 10 M audit rows / 2 M IMEIs growth curve |
| SCL-23 | EXECUTED (re-run) | - | already executed in an earlier batch; re-run in 27a because the case was rewritten |
| SCL-24 | NEEDS-LONG | L | reports over 1 M customers / 5 M sales |
| SCL-25 | NEEDS-LONG | S | ranking at 100 k customers with a brute-force oracle |
| SCL-26 | EXECUTED | - | executed in an earlier batch (CASE_INDEX.csv) |
| SCL-27 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-28 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-29 | NEEDS-LONG | L | sales history at 100 k / 1 M / 5 M sales |
| SCL-30 | NEEDS-LONG | X | receipt/IMEI lookup at 5 M sales |
| SCL-31 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-32 | NEEDS-LONG | X | period reports at 5 M sales / 10 M lines |
| SCL-33 | NEEDS-LONG | S | product search at 100 k-500 k products |
| SCL-34 | NEEDS-MOBILE | - | mobile-only variant/image UI |
| SCL-35 | NEEDS-MOBILE | - | mobile-only variant/image UI |
| SCL-36 | EXECUTED | - | executed in an earlier batch (CASE_INDEX.csv) |
| SCL-37 | EXECUTED | - | executed in an earlier batch (CASE_INDEX.csv) |
| SCL-38 | EXECUTED | - | executed in an earlier batch (CASE_INDEX.csv) |
| SCL-39 | NEEDS-LONG | S | FTS maintenance over a 100 k-product bulk update |
| SCL-40 | NEEDS-LONG | L | needs 5 M sales and a 1 M-row import to measure commit p95 and per-index write amplification |
| SCL-41 | NEEDS-LONG | X | 10 M-row audit chain append/verify/export |
| SCL-42 | NEEDS-GATEWAY | - | concurrent writes from two devices |
| SCL-43 | EXECUTED | - | executed in an earlier batch (CASE_INDEX.csv) |
| SCL-44 | NEEDS-MOBILE | - | mobile Dexie/sync path |
| SCL-45 | EXECUTED | - | executed in an earlier batch (CASE_INDEX.csv) |
| SCL-46 | EXECUTED | - | executed in an earlier batch (CASE_INDEX.csv) |
| SCL-47 | EXECUTED | - | executed in an earlier batch (CASE_INDEX.csv) |
| SCL-48 | EXECUTED | - | executed in an earlier batch (CASE_INDEX.csv) |
| SCL-49 | NEEDS-LONG | L | planner stats after a 1 M import with 90 % skew |
| SCL-50 | EXECUTABLE-DESKTOP | - | 40 k sale ids is a ~3 s seed at the measured 5,000 rows/394 ms rate; promoted to 27b |
| SCL-51 | NEEDS-LONG | L | ORDER BY over 1 M rows with temp-B-tree spill |
| SCL-52 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-53 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-54 | EXECUTABLE-DESKTOP | - | no fixture size in the case text - it asks that opening the dashboard repeatedly never delays a sale; promoted to 27b |
| SCL-55 | NEEDS-LONG | X | 3-year projection fixture (sales/day x 365 x 3) |
| SCL-56 | NEEDS-MOBILE | - | mobile Dexie/sync path |
| SCL-57 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-58 | EXECUTED | - | executed in an earlier batch (CASE_INDEX.csv) |
| SCL-59 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-60 | NEEDS-LONG | S | 100 k products with deep price history |
| SCL-61 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-62 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-63 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-64 | NEEDS-LONG | L | duplicate detection over 1 M customers |
| SCL-65 | NEEDS-LONG | L | nightly jobs over 1 M customers |
| SCL-66 | NEEDS-GATEWAY | - | gateway/SMS integration |
| SCL-67 | NEEDS-LONG | L | import into a non-empty 1 M-customer table |
| SCL-68 | NEEDS-LONG | S | bulk anonymise of 100 k customers |
| SCL-69 | NEEDS-GATEWAY | - | second enrolled terminal |
| SCL-70 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-71 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-72 | NEEDS-LONG | X | 500 k products + 2 M IMEIs barcode namespace |
| SCL-73 | NEEDS-GATEWAY | - | three enrolled devices |
| SCL-74 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-75 | NEEDS-LONG | S | bulk price change on 100 k products |
| SCL-76 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-77 | EXECUTED | - | executed in an earlier batch (CASE_INDEX.csv) |
| SCL-78 | EXECUTED | - | executed in an earlier batch (CASE_INDEX.csv) |
| SCL-79 | EXECUTED | - | executed in an earlier batch (CASE_INDEX.csv) |
| SCL-80 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-81 | NEEDS-LONG | L | per-table/per-index size at every fixture size |
| SCL-82 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-83 | EXECUTED | - | executed in an earlier batch (CASE_INDEX.csv) |
| SCL-84 | EXECUTED | - | executed in an earlier batch (CASE_INDEX.csv) |
| SCL-85 | NEEDS-LONG | X | statement-count budget on the 5 M fixture |
| SCL-86 | EXECUTABLE-DESKTOP | - | derived-table rebuild + drift detector can be probed on the normal sandbox (SCL-27 already proved no rebuild command exists); 27b |
| SCL-87 | NEEDS-GATEWAY | - | cloud backend + volume fixture |
| SCL-88 | EXECUTED 27a | - | runs on the desktop sandbox (wdio.conf.ts, disposable DB copy) |
| SCL-89 | NEEDS-LONG | X | rebuild commands on a 5 M DB |

### 1a. Re-triage of the executables that were *not* in 27a

The pre-27a triage had 29 EXECUTABLE-DESKTOP cases. 24 of them ran here; the
remaining five were re-examined, and one case the first pass had parked in
NEEDS-LONG was promoted:

| Case | Was | Now | Why |
|---|---|---|---|
| SCL-01 | EXECUTABLE | **NEEDS-LONG (L)** | the case is a p95 *curve* from 1 k to 1 M rows plus stale-query cancellation; one size proves nothing, and the largest fixture this box has held is 1,006 customers |
| SCL-17 | EXECUTABLE | **NEEDS-GATEWAY** | it is about a migration on a *replicated* table converging across devices; with no gateway (`sync.gateway_url` unset → the drain idles) there is nothing to converge |
| SCL-40 | EXECUTABLE | **NEEDS-LONG (L)** | needs 5 M sales and a 1 M-row import to measure commit p95 against index count |
| SCL-50 | EXECUTABLE | **EXECUTABLE-DESKTOP** | 40 k sale ids is a ~3 s seed at the measured rate (5,000 rows / 366 ms); moved to 27b |
| SCL-54 | NEEDS-LONG | **EXECUTABLE-DESKTOP** | the case text gives no fixture size — it asks that opening the dashboard repeatedly never delays a sale. Parked in NEEDS-LONG by mistake; moved to 27b |
| SCL-86 | EXECUTABLE | **EXECUTABLE-DESKTOP** | derived-table rebuild + drift detector are probeable on the normal sandbox (SCL-27 already proved no rebuild command exists); moved to 27b |

---

## 2. How 27a was run

| Guard | What was done |
|---|---|
| Disposable DB | `POS_E2E_WIPE=1` wipes the sandbox app-data; every case works on that copy, never on a user DB |
| Snapshot + checksum | `SNAPSHOT … sha256=<before>` taken before seeding, re-hashed after the last case: `same=true` |
| Free disk | preflight `free_disk>=2GiB` measured **63.5 GiB** before starting |
| Per-case timeout | every case has an explicit `this.timeout()` (60 s – 300 s); a harness exception is recorded as an explicit FAIL, never a silent skip |
| Temp fixtures | seeded under `%TEMP%\pos-27a-<epoch>` (outside the repo tree), path logged |
| Machine specs | `MACHINE_SPECS` line: win32/x64, node v24.18.0, AMD Ryzen 5 8500G, 12 cores, 15.1 GiB RAM |
| Thresholds before measuring | `THRESHOLD …` lines are printed **before** the measurement they judge; where the case gives no number the threshold is marked "(case gives no number → PARTIAL if exceeded)" |
| Assertions | every verdict is on a state/measurement (row counts, decoded payload bytes, `EXPLAIN QUERY PLAN`, DOM geometry, wall-clock ms), never on "no error" |

One run was discarded mid-way: the first SCL-04 probe picked the tallest
scrollable `<div>` in the dialog (an inner strip) instead of the list scroller,
and SCL-06 measured the virtual canvas while the search box still held a
5,000-character query that matched nothing. Both were re-derived from a DOM
dump (`logs/probe-scl04.log`) and re-run; the numbers below are from the
corrected run.

---

## 3. Per-case verdicts

| Case | Verdict | Key evidence (raw) |
|---|---|---|
| SCL-27 | **FAIL** | `total_spent stored=500 ledger=500 drift=false; loyalty stored=10 ledger=0 drift=true` — a full refund leaves the loyalty counter at 10 while the ledger is 0; no rebuild-from-ledger command and no drift detector exists |
| SCL-31 | **FAIL** | `receipt=REC-20261026-5KQ5O-02-H2XK0 visible_rows_by_variant={"exact":0,"padded-space":0,"lowercase":0,"arabic-indic-digits":0,"leading-zeros":0}` — even the exact number returns 0 rows in that lookup; `transactionAdapter.ts:474` is `receipt_number = $1` with no trim/case/digit folding |
| SCL-61 | **FAIL** | `1/5 variants found` — `احمد`→`أحمد بن علي` 0, `محمد`→`مُحَمَّد أمين` 0, `سليم`→`سـلـيـم` 0, `زبون 123`→`زبون ١٢٣` 0; `foldForSearch` is duplicated 3× and folds no Arabic hamza/maqsura/harakat/tatweel/digits, while the product search already uses the real normaliser |
| SCL-02 | **FAIL** | `rows_loaded_by_list_query=1006`; plans `SCAN customers USING INDEX idx_customers_name`, suffix `SCAN customers`, contains `SCAN customers` — the term never reaches SQL (`customerAdapter.ts:223` loads every row, `CustomersModal.tsx:372-381` filters in JS) |
| SCL-03 | **FAIL** | `customer_list_limit=false rows_returned=1006; sales_history_limit=false rows_returned=2` — both reads are unbounded single queries |
| SCL-11 | **FAIL** | `customer_sales=5002 profile_open_ms=4098 badge="Achats (5002)"` — the profile loads and renders the entire history as one list; totals summed in JS, not SQL |
| SCL-23 | **FAIL** | `products_returned=2 json_payload_bytes=1020 bytes_per_row=510 hard_cap=false` — `productAdapter.ts:171` is `SELECT * … WHERE deleted = 0` with no LIMIT; the 1,300-row cap (P1-66) is a display cap, not a transport cap |
| SCL-88 | **FAIL** | `products_cols=26 transactions_cols=27 products_overflow_pages=0` — `SELECT *` on both hot tables; the customer list selects columns but still ships `json_payload` per row |
| SCL-71 | **FAIL** | app query plan `SCAN products USING INDEX idx_prod_stock_alert`, `app_query_bounded=false`. The hand-written probes *can* use `idx_prod_stock_alert`/`idx_products_brand`, but the app issues one unfiltered `SELECT *` and filters category/brand/price/stock/sort in JS (`ProductCatalog.tsx:475-492`) |
| SCL-74 | **FAIL** | `plan="SCAN products USING INDEX idx_prod_stock_alert"`; `low_stock_counts_by_default_reorder_point={"0":0,"3":0,"5":0,"10":0}`; `alert_once_state_table=false` — the index is `(category, stock, reorder_point)` so a category-less query cannot seek it, and four different JS defaults (3/5/5/10) disagree |
| SCL-04 | **FAIL** | `canvas_inline=100000px canvas_rendered_px=247 flex_shrink=1 scroller_scroll_height=1737 max_mounted_index=29 last_match_reachable=false` — see §5, new P1-83 |
| SCL-06 | **FAIL** | `empty_query_result_rows=503 virtual_canvas_px=100600 capped_at_50=false refine_hint=false`; `%`/`_`/`'`/`\` are literal (0 rows) and nothing froze, but the empty query holds the whole table with no cap and no "refine" hint |
| SCL-05 | **PASS** | `db_customers=1006 displayed_total="1006" sql_calls_during_7_keystrokes=0` — the count is the array length (`CustomersModal.tsx:715`), not a per-keystroke `COUNT(*)` (cheap only because the whole table is already in memory) |
| SCL-28 | **PASS-PARTIAL** | `deleted_row_visible_in_search=0` (tombstones filtered) but `partial_index_count=0` and the list still `SCAN customers USING INDEX idx_customers_name` |
| SCL-10 | **FAIL** | `sqlite_stat1_present=false has_analyze_after_bulk=false`; 4/5 hot queries are index hits, but `PRAGMA optimize` exists only inside the manual maintenance command and no migration or import runs `ANALYZE` |
| SCL-52 | **PASS** | `range_rows=11 distinct_ids=11 boundary={"at_from":1,"at_to":1,"before_from":0,"after_to":0}` — bounds pushed as `created_at >= $1 AND <= $2`, boundary row counted once, no `date(col)` wrapper |
| SCL-53 | **PASS** | `json_indexes=0 json_extract_in_where=0` — no JSON column filtered in a `WHERE` on the hot tables (payload reads are hydration-only) |
| SCL-80 | **PASS-PARTIAL** | `{"page_size":4096,"journal_mode":"wal","auto_vacuum":0}`; every connection sets `synchronous/cache_size/temp_store/mmap_size/WAL/foreign_keys/busy_timeout`, but `wal_autocheckpoint`, `journal_size_limit`, `analysis_limit` are never set and no 1 M benchmark justifies the values |
| SCL-82 | **PASS-PARTIAL** | `integrity_check_ms=7.7 foreign_key_check_ms=3.4` on 1.0 MB; on-demand check exists with a visible status, but startup runs no check and nothing schedules one with progress for a 5–10 GB DB |
| SCL-76 | **FAIL** | `expiry_column=false 2020_row_survived_boot=true` — `held_orders` has no expiry column and no cleanup job; the only reaper is `sync_outbox`'s `reap_stale_in_flight` |
| SCL-70 | **PASS-PARTIAL** | `bench_20000_inserts text_uuid_pk_ms=108 integer_pk_ms=49 ratio=2.21 time_ordered_ids=true`; ids are `<PREFIX>-<ms>-<seq>-<rand>`, but the case asks for a 1 M-insert benchmark with index size and fragmentation |
| SCL-57 | **FAIL** | `real_money_count=7 REAL_SUM(0.1,0.2,0.3)=0.6 exact_0.3=false` — every money column is `REAL`; ids are TEXT (good), but "totals equal Rust values" cannot hold for floats |
| SCL-59 | **PASS-PARTIAL** | `{"db_size_bytes":6864896,"wal_size_bytes":7362472,"page_count":1676,"free_disk_gib":63.4}` shown, but `alert_threshold_tables=0` — no attachments size, no growth/month, no threshold, no pre-failure alert |
| SCL-62 | **FAIL** | `probes={"Ben-Ali":1,"C++":1,"a:b":1,"\"":0,"AND":1,"+213":1,"B":2}` — `products_fts` exists but no app query uses `MATCH`; the FTS index is maintained on every write and never read |
| SCL-63 | **N/A** | `phone_is_plaintext=true blind_indexes=0` — the case is conditional on encryption at rest, which this build does not have |

---

## 4. Every verdict that moved

### 4a. SCL (this batch)

| Case | Before | After | Note |
|---|---|---|---|
| SCL-27 | REMAIN | FAIL | no rebuild / no drift detector; loyalty drift on refund |
| SCL-31 | REMAIN | FAIL | receipt lookup is exact-match, no normalisation |
| SCL-61 | REMAIN | FAIL | 1/5 Arabic variants found |
| SCL-02 | REMAIN | FAIL | search term never reaches SQL |
| SCL-03 | REMAIN | FAIL | unbounded list/history reads |
| SCL-11 | REMAIN | FAIL | 5,002-row history loaded and rendered at once |
| SCL-23 | FAIL | FAIL | re-run; evidence refreshed (was already FAIL) |
| SCL-88 | REMAIN | FAIL | `SELECT *` over IPC |
| SCL-71 | REMAIN | FAIL | filters applied in JS, not SQL |
| SCL-74 | REMAIN | FAIL | no seekable low-stock query, 4 defaults |
| SCL-04 | REMAIN | FAIL | collapsed virtual canvas (P1-83) |
| SCL-06 | REMAIN | FAIL | no result cap, no refine hint |
| SCL-05 | REMAIN | PASS | no per-keystroke COUNT |
| SCL-28 | REMAIN | PASS-PARTIAL | tombstones filtered, no partial index |
| SCL-10 | REMAIN | FAIL | no ANALYZE after bulk load |
| SCL-52 | REMAIN | PASS | UTC bounds pushed, boundary once |
| SCL-53 | REMAIN | PASS | no JSON in WHERE |
| SCL-80 | REMAIN | PASS-PARTIAL | pragmas applied, 3 unset + unbenchmarked |
| SCL-82 | REMAIN | PASS-PARTIAL | on-demand check, no scheduled check at scale |
| SCL-76 | REMAIN | FAIL | no expiry for transient rows |
| SCL-70 | REMAIN | PASS-PARTIAL | time-ordered ids, no 1 M benchmark |
| SCL-57 | REMAIN | FAIL | REAL money columns |
| SCL-59 | REMAIN | PASS-PARTIAL | numbers shown, no thresholds/alerts |
| SCL-62 | REMAIN | FAIL | FTS maintained, never queried |
| SCL-63 | REMAIN | N/A | precondition (encryption at rest) absent |

### 4b. Everything else re-opened after the PIN-gate blocker fell

| Case | Before | After | Note |
|---|---|---|---|
| TIM-09 | BLOCKED | **FAIL** | shop-day bucketing passes; every display formatter omits `timeZone` (see §6) |
| RCP-19 | BLOCKED | BLOCKED | blocker narrowed: the Android first-run/PIN gate is solved (`PROOF_RESULT=PASS`); only the Bluetooth ESC/POS printer is missing |

`P1-67` was the stated reason for both blocks. It is withdrawn (§5), so the
re-rating is: TIM-09 becomes executable and FAILs; RCP-19 stays blocked for a
hardware reason that was always the real one.

### 4c. Dashboard

| Metric | Before | After | Δ |
|---|---|---|---|
| Passed (full) | 171 | **174** | +3 |
| Passed (partial) | 15 | **20** | +5 |
| FAILED | 202 | **218** | +16 |
| N/A | 112 | **113** | +1 |
| Remaining | 124 | **100** | −24 |
| BLOCKED | 63 | **62** | −1 |
| **Total** | **687** | **687** | 0 |

`COVERAGE.md` now carries these numbers; `CASE_INDEX.csv` carries the per-case
verdict and evidence (27 rows updated: 25 SCL + TIM-09 + RCP-19).

---

## 5. P1-67 — withdrawn (it was a harness expectation, not a product defect)

**What P1-67 claimed:** "restored snapshot boots with an empty catalogue while
SQLite holds 1,307 rows".

**What was measured this time** (all in `logs/tim09-*.log`, `tools/schema-delta.mjs`,
`tools/mobile-read-path.mjs`):

1. A DB with a seeded product is pushed to `/data/data/com.mobi.pos/mobi_pos.db`.
   After boot the file has the **same inode, size and mtime** (`ino=344688
   mtime=1792978222` before and after) — the app does not replace or reset it.
2. Pulling it back shows `products=1` with the fixture row intact
   (`{"id":"T9-PROD-1","title":"T9 ARTICLE FRONTIERE","sync_status":"pending","device_id":"legacy"}`),
   while `p_products=0` and `projection_cursor=0`.
3. The UI still renders `0 articles trouvés`.

**Root cause:** the installed APK is a **companion**: its catalogue is fed by the
CRDT projection (`p_products`), which only the pairing/sync engine fills. A raw
push into `products` is therefore invisible by design, and an unpaired device
shows an empty catalogue no matter what is in the base table. Both earlier
hypotheses ("the seed is not re-applied", "the app resets the DB") are refuted
by (1) and (2).

**Disposition:** P1-67 is **withdrawn**. It is a harness artifact — the harness
assumed a base-table write would surface in the UI, which the companion
architecture does not do.

Two real, distinct findings survive that investigation:

| ID | Finding | Rate |
|---|---|---|
| **P2-84** | The installed APK (1.6.8, same version string as HEAD) is **schema-stale**: 37 tables vs HEAD's 73; `transactions` lacks `is_refund`, `original_transaction_id`, `shift_id`, `ledger_cogs_total`, `restored_cogs`; `customers` lacks `current_debt`, `whatsapp_opt_in`, `credit_score`, `credit_score_at`; the PIN rule is 4 digits where HEAD requires 6+. Refund/shift/credit features of this repo cannot run on it. | **P2** — a build/release artifact gap, not a wrong result inside a running feature |
| (evidence only) | `products_fts` and `vec_products` exist on desktop but not on the APK; the APK keeps `tax` on `transactions` where HEAD dropped it | — |

**Impact on the batch:** the two cases blocked "because P1-67" are now handled
honestly — TIM-09 is executed and FAILs on its own merits; RCP-19 is blocked by
the printer alone.

---

## 6. TIM-09 disposition

Case: *"Mobile in another timezone/VPN/roaming; warranty, quote and loyalty
expiry — evaluated in shop timezone, displayed consistently (WAR-03)."*

**Verdict: FAIL.** The evaluation half passes; the display half does not.

Method (`tools/tim09-timezone.mjs`, log `logs/tim09-timezone.log`): seed one sale
at `2026-10-26T00:30:00Z`, move the emulator to `Pacific/Midway`, read the app.

```
sale_instant=2026-10-26T00:30:00.000Z
shop_day_time=2026-10-26 01:30 (Africa/Algiers)
device_day_time=2026-10-25 13:30 (Pacific/Midway)
discriminating=true
device_date=Sun Oct 25 14:29:30 SST 2026
activity_screen=… | 2026-10-26 | …        <- date strip uses the SHOP day
```

- **Evaluation: PASS.** `todayLocalKey`/`toLocalDayKey` force the shop zone
  (`dateUtils.ts:11-28`), and the app's date strip rendered `2026-10-26` while
  the device believed it was 25 Oct.
- **Display: FAIL.** Every formatter renders device-local time because none of
  them passes `timeZone`: `i18n/index.ts:323-345` (fr/ar/pseudo
  `Intl.DateTimeFormat`), `types/pos.ts:1952-1965` (`toLocaleString('fr-DZ')`),
  `LiveActivityTab.tsx:866-875` (`toLocaleTimeString`/`toLocaleString`). For the
  instant above the same sale is `01:30` on the shop clock and `13:30` on the
  phone — 12 hours and a different date. WAR-03 requires "same date shown on
  receipt, desktop, mobile".

**Severity: P2** (per the Part A rubric): the underlying timestamps are correct
and the shop-day bucketing is correct, so this is a presentation gap rather than
a wrong stored result — but it is the presentation half of an explicitly stated
requirement.

**Honest limit:** the rendered sale row could not be photographed because the
unpaired companion renders no sales (see §5). The display half therefore rests
on the formatter source plus the measured 12 h divergence, not on a screenshot
of `13:30` next to `01:30`. Recorded that way in `CASE_INDEX.csv` rather than
claimed as an on-screen observation.

---

## 7. New findings

| ID | Finding | Rate | Evidence |
|---|---|---|---|
| **P1-83** | The customer directory's virtual canvas is flex-shrunk to ~247 px, so a 1,006-customer directory can only be scrolled to about row 16; the remaining ~984 are unreachable unless the user types a search that re-filters them to the top. | **P1** — the list silently hides almost all customers; "select the row you clicked" cannot even be exercised | `canvas_inline=100000px canvas_rendered_px=247 flex_shrink=1 scroller_scroll_height=1737 max_mounted_index=29 last_match_reachable=false`. Cause: `CustomersModal.tsx:1493-1499` sets `height: getTotalSize()` on a child of the `flex flex-col` scroll body (`:803`) with no `shrink-0`. |
| — | SCL-23/SCL-88 transport cap: reuse existing **P1-66** (1,300-row display cap) rather than minting a duplicate. The transport itself (`SELECT *`, no LIMIT) is unbounded, and the display cap is not a transport cap. | P1 (existing) | `products_returned=2 json_payload_bytes=1020 hard_cap=false` |

P1-83 is a one-line CSS fix (`shrink-0` on the canvas, or `min-h-0` on the
scroll body) but the effect today is that the directory is unusable past the
first screen for any merchant with more than ~16 customers.

---

## 8. Proposed next batches

**27b — desktop, ≤25, risk-ordered** (all 3 remaining EXECUTABLE-DESKTOP plus
the highest-risk NEEDS-LONG tier S that fit the box):

1. SCL-86 derived-table rebuild + drift detector (highest risk: SCL-27 already
   showed counters drift and no rebuild exists)
2. SCL-54 dashboard re-open latency / never delays a sale
3. SCL-50 40 k `IN (...)` list — chunking and the bound-variable limit
4. SCL-39 FTS maintenance over a 100 k-product bulk update (tier S)
5. SCL-33 product search at 100 k–500 k (tier S)
6. SCL-60 price history at 100 k products (tier S)
7. SCL-25 ranking at 100 k with a brute-force oracle (tier S)
8. SCL-68 bulk anonymise of 100 k customers (tier S)
9. SCL-75 bulk price change on 100 k products (tier S)
10. SCL-08 100 k CSV import with kill/resume (tier S)

**27c — the 1 M–5 M tier** (L/X): SCL-01, 15, 18, 19, 20, 24, 29, 30, 32, 40,
41, 49, 51, 55, 64, 65, 67, 72, 81, 85, 89. These need a fixture generator that
persists across runs (a 3-year projection plus 5 M sale lines), a disk budget,
and a multi-hour window. Recommend running them against a copied DB on a
dedicated machine with the thresholds frozen first.

**Gateway/mobile:** SCL-09, 17, 21, 42, 66, 69, 73, 87 (gateway) and SCL-16, 34,
35, 44, 56 (mobile) remain blocked on infrastructure that does not exist in this
repo — the gateway is loopback-only and the companion needs pairing.

---

## 9. Residuals

- TIM-09's on-screen display half rests on source + measured divergence (§6).
- SCL-06's "50 k matching rows" clause is **not** exercised; the largest fixture
  is 1,006. The verdict rests on the measured absence of a cap and of a refine
  hint at 1 k, which is the same code path.
- SCL-70 is a 20 k-insert benchmark, not the 1 M the case asks for → PARTIAL.
- The mobile DB used for the P1-67/TIM-09 probes was restored from the pull
  taken before each experiment, and the emulator timezone was returned to
  `Africa/Lagos`.
