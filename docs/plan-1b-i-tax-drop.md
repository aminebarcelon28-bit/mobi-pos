# Plan 1b-i — POS `transactions.tax` contract drop (plan document, no execution)

Status: PLAN ONLY. No migration executed. STOP gates in §8 must clear first.
Gate decision: Phase 1a+1a′ accepted; 1b split into 1b-i (this doc) and 1b-ii
(REAL→INTEGER type migration — BLOCKED on `Currency = ___, decimals = ___`).

## 1. Objective

Drop the POS-side `transactions.tax` column everywhere in lockstep and delete
every sales-TVA shim/branch left transitional by 1a′. Per Addendum B (§10),
supplier-side tax fields are DELETED too (not relabeled) — after 1b-i, zero
tax references remain repo-wide except the §10-B2 OCR noise-skip whitelist
and history docs.

**Cost-basis invariant (PD-11, documented): unit_cost is always the full
amount actually paid; no tax is ever separated, added, or computed.**
Structurally true today: the PO commit path carries `unit_cost` verbatim
(`commands.rs:212-216,278-288`) and `reported_tax` was never persisted (§4).

Non-goals: type migration (1b-ii), FIFO allocator change, Test B gold vectors,
currency decision. 1b-i is valid under any currency.

## 2. Evidence — complete touchpoint inventory (verified, not assumed)

### 2.1 Column writes (all currently write 0 under the no-TVA engine)

| # | file:line | action in 1b-i |
|---|---|---|
| 1 | `src/db/sqlPluginAdapter.ts:1462,1489-1492,1510-1512,1523-1525` — 3 INSERT variants + `tax ?? 0` param | Remove `tax` from column lists + params (all 3 variants incl. pre-`shift_id` / pre-`ledger_cogs_total` fallbacks) |
| 2 | `src/db/sqlPluginAdapter.ts:770-771,789-790` — `ORDER_MONEY_KEYS` incl. `'tax'` | Remove `'tax'` entry (normalization loop stays for the rest) |
| 3 | `src/sync/SyncManager.ts:131` — `PULL_COLUMNS` incl. `tax` | Remove `tax` (bump remote version, §6) |
| 4 | `src/sync/SyncManager.ts:1934-1945` — `applyRemoteRow` order lane + `payload.tax` | Remove column + value; old-format payloads → §7 mixed-version rule |
| 5 | `src/sync/SyncManager.ts:2620-2640` — pull-apply INSERT + `tax=excluded.tax` upsert + `Number(r.tax ?? 0)` push | Remove all three; push maps old `tax` → dropped with warning (§7) |
| 6 | `src/sync/migrationManager.ts:202,224-226,234-243` — Dexie→SQLite `tax \|\| 0`, REPLACE, cloud push chunk | Remove column + values on all three statements |
| 7 | `src/sync/restoreManager.ts:229-238` — restore INSERT + `Number(r.tax ?? 0)` | Remove column + value |
| 8 | `src/db/backfill.ts:115-121` — backfill INSERT hardcodes `0` in tax position | Remove column + the hardcoded `0` |
| 9 | `src/db/adapters/maintenanceAdapter.ts:1034-1056` — import derives `tax = total−subtotal−discount` (≡ 0) + INSERT | Remove derivation comment + column + param |
| 10 | `src-tauri/src/lib.rs:975` — base DDL `tax REAL DEFAULT 0` | Contract-step `ALTER TABLE transactions DROP COLUMN tax` migration (expand→migrate→contract, §6); `orders` VIEW at `lib.rs:1170` (`SELECT *`) needs no change but is re-verified |
| 11 | `src/sync/remoteSchema.ts:105` + `turso/remote-schema.sql:20` — remote DDL | Remote schema v13 (LATEST 12 → 13, §6) drops `tax` in both files |
| 12 | `src-tauri/src/emergency_export.rs:96,957` — locked-state sales-journal SELECT + in-memory test DDL | Remove `tax` from SELECT + test DDL; update seed at `:985-986` (`tax=19.0` → row without tax; expected totals re-pinned) |
| 13 | `src/sync/payloadHygiene.ts:39` — `SYNC_PROTECTED_KEYS` incl. `'tax'` | Remove `'tax'`; update `scripts/test_h24_payload_hygiene.mjs:43-60` (currently asserts `tax: 499 → 499` passthrough — rewrite to assert `tax` is shed) |

### 2.2 Shim / type / dead-branch deletion (1a′ transitionals — hard deadline)

| # | file:line | action |
|---|---|---|
| 14 | `src/utils/taxEngine.ts` (whole file, zero shim) | DELETE file; `receiptMath.ts:22` import removed; `computeTax` call at `:420-422` replaced by inline `ht = max(0, subtotalAfterDiscount)` |
| 15 | `src/store/slices/createCartSlice.ts:66-71,154` — `readVatRate` stub + call | DELETE function; remove `vatRate:` opts at `:154`, `createOrderSlice.ts:332,1458`, `CartPanel.tsx:127`, `PaymentModal.tsx:273,282`, `MobileCheckoutTab.tsx:345,549,557` (pass nothing; `CartTotalsOptions.vatRate` deleted) |
| 16 | `src/types/pos.ts:1503-1504` — `vatRate?` field | DELETE field |
| 17 | `src/utils/receiptMath.ts:85-102,277,338-345` — `TvaSplit`, `tvaSplitFromTotal`, `vatRate?`, `tva`/`tax` fields, comments | DELETE split + `vatRate?`; KEEP `CartTotals.tva/tax/ht` fields ONLY if checkout writers still need them removed in the same changeset — decide at execution: delete fields + `createOrderSlice.ts:478,924,940` (`taxAmount`, `tax:`) together (preferred, single changeset) |
| 18 | Dead UI branches (all 6 verified guarded-unreachable) | DELETE branches: `CartPanel.tsx:1296-1301`, `PaymentModal.tsx:591-593` (+ now-unused `vatRate` reads `:72-73`, `:165-166`, `:136-137`), `MobileCheckoutTab.tsx:824-829`, `ReceiptPaper.tsx:229-240` (+ `:51` split call), `escpos.ts:296-306` (+ `:301`), `mobileDocPrint.ts:161-166` |
| 19 | `src/db/sqlPluginAdapter.ts:993` — `189.81 VAT-style` comment | Reword (no VAT-style floats exist anymore) |
| 20 | Persisted `receiptSettings.vatRate` (legacy rows: Dexie `mobi_pos_receipt_settings`, SQLite `app_settings` via `genericApply.ts:551-571`, `createUISlice.ts:297`) | Settings-cleanup migration: on load, strip `vatRate` key if present (log once); `DEFAULT_RECEIPT_SETTINGS` (`createUISlice.ts:126-147`) already has no `vatRate` — unchanged |

### 2.3 Tests / harnesses / fixtures

| # | file:line | action |
|---|---|---|
| 21 | `scripts/test_h24_payload_hygiene.mjs:43-60` | Rewrite tax assertions → shed-assertion (see #13) |
| 22 | `scripts/test_cloud_sync_and_migration.mjs:101,280,378,385`, `scripts/test_e2e_two_device_sync.mjs:49,225,425,507` | Remove `tax` from mirror DDLs, INSERTs, fixtures (`tax: 0` fixtures deleted) |
| 23 | `tests/tradein-harness/main.tsx:114-119` — `__harnessSetVatRate` | DELETE harness fn; `tests/tradein-extreme-chaos.spec.ts:213-234` VAT cases rewritten to no-TVA (or deleted if purely VAT-behavioral — decide at execution, list in diff) |
| 24 | `scripts/test_sync_matrix.mjs:189` — profile `{vatRate: 19}` | Change to no-`vatRate` profile (lane still converges storeName) |
| 25 | `tmp-*.db` artifacts with `transactions` rows (4 files, all `tax = 0`) | Regenerable test outputs — delete, re-run suites to regenerate post-drop |
| 26 | `src-tauri/src/geometry.rs:1017` (`"TVA 0% : 0,00 DA"` fixture) | KEEP — supplier-OCR parsing fixture (§4), not sales schema. (Gate-decision §5 assumed sales-side; evidence corrects this.) |
| 27 | `p_*` projections (`lib.rs:1369-1375`, `reducers.ts:110-116`) | Already tax-free — no action, cited as the target shape |

## 3. Precondition counts (run at dry-run, §8 gate 2)

```sql
-- live mobi_pos.db AND merchant remote Turso: expect 0, halt otherwise
SELECT COUNT(*) FROM transactions WHERE CAST(tax AS REAL) != 0;
-- schema sanity (both sides): expect 1 row showing the column pre-drop
SELECT name FROM pragma_table_info('transactions') WHERE name = 'tax';
```

Fixture counts already taken (all zero): `tmp-conv-a`, `tmp-conv-cloud`,
`tmp-e2e-sync-cloud`, `tmp-h28-authority`. Fixture zeros are necessary, not
sufficient — live + remote counts are the gate.

## 4. Supplier-side `reported_tax` — DELETE per Addendum B (replaces KEEP)

Chain verified end-to-end: `InvoiceIngestionModal.tsx:100,279-280,331-336,411-416,470-475`
→ `PoReviewScreen.tsx:46,61,160-183,454,711-714` → `api/po.ts:12-34` →
`commands.rs:73-79,120-130,175-190,192-353`. Findings (safety proof for deletion):

- `reported_tax` NEVER reaches `stock_batches.unit_cost` or COGS: it is
  structurally absent from `CommitStockBatchRequest` (`po.ts:74-86`,
  `commands.rs:175-190`) and from all four `commit_batch_inner` writes
  (`stock_batches`, `inventory_ledger RECEIVE`, `products.stock/cost_price`,
  `vendor_aliases`). FIFO reads `unit_cost` only. Deleting the display field
  cannot change recorded cost — the §1 cost-basis invariant holds by construction.
- It is stored NOWHERE: no `reported_tax` column exists in any table
  (`scan_audit_log` has `grand_total`/`delta` only; `purchase_orders` untouched
  by recon). `SELECT sql FROM sqlite_master WHERE sql LIKE '%reported_tax%'`
  → 0 rows. Hence NO `reported_tax != 0` count is possible; the reconciliation
  report states this negative result instead of a number.
- It enters only `mathState.calculatedTotal` (review display) and the Rust
  gate grand-total passthrough (generic fee addition, no rate math), plus the
  JSON export (`PoReviewScreen.tsx:711-714`, download only, not DB).

Deletion inventory (§10-B): `PoReviewScreen.tsx:46,61,177,183,454,458,714,902,2062`
(prop + math + export + both labels incl. hardcoded `TVA (19%)`),
`InvoiceIngestionModal.tsx:100,279-280,334,414,473,497,640-646`
(state + scan call sites + prop + label/input),
`src/types/po.ts:54,69` + `ProcessRawScanRequest` tax field,
`commands.rs:73-79,125-130` (request field + gate call),
`gate.rs:43,69-76,174-178` (param + sanitize + grand-total addition),
`scanAccuracyEngine.solveAccountingConstraints` (`scanAccuracyEngine.ts:209`;
zero callers, zero script assertions — delete function; rest of file KEEP:
`UniversalCameraScannerModal.tsx:13` uses its other exports).
`documentScanner.ts:180,205` demo payloads already `reported_tax:0` — delete key.
The earlier relabel plan is CANCELLED. `scanAccuracyEngine` remainder and the
B2 parser carve-out (§10) are the only survivors.

## 5. Localization / receipt-template sweep — confirmed

- No locale system exists: `public/locales`, `src/i18n`, `*.json` locales,
  `*.arb`, `*.ftl` all absent; `*.properties` are 3 Android-gen files (clean);
  `ضريبة` 0 hits; `Taxe/taxe` 0 hits (only `syntaxe` false positives).
  Sweep coverage is vacuous — stated explicitly per gate-decision §5.
- `PurchaseOrderA4Document.tsx:243` already renders grand-total-only (clean).
- Supplier-OCR references: only the §10-B2 noise-skip whitelist survives
  (`geometry.rs:256-257` line matchers + `:286-287` skip-extraction with
  `noise-skip, not a tax feature` comment, `:734` footer-exclusion comment).
  `geometry.rs:60` `detected_tax` field, `:243` doc comment, and the gate
  supplier-fee path are DELETED per §10-B. `geometry.rs:1017` fixture KEEP:
  verified skip-assert (rows==5, total 128000, zero tax assertions).

## 6. Migration mechanics (expand → migrate → contract)

Remote version: `LATEST_REMOTE_VERSION = 12` (`remoteSchema.ts:349`, v12 =
`shift_id` at `:341`). 1b-i adds **v13**: `ALTER TABLE transactions DROP
COLUMN tax` (SQLite ≥ 3.35 supports DROP COLUMN; floor version verified at
dry-run — if the floor is older, v13 rebuilds the table via
create-copy-drop in a single txn instead).

- Expand: writers stop emitting `tax` first (code ships, column still present;
  `SELECT *` readers unaffected), sync payload v+1 omits `tax`.
- Migrate: local `DROP COLUMN` migration + remote v13 + adapter/SELECT
  updates (#1–#13) + backfill p_* untouched (already clean).
- Contract: shims/branches/types deleted (#14–#20), fixtures regenerated (#25).
- Rollback: contract is a code revert + `ADD COLUMN tax REAL DEFAULT 0`
  (data-trivially restorable: every dropped value was proven 0 by §3 counts;
  rollback script asserts the §3 count on the pre-drop backup and refuses to
  proceed if non-zero).

## 7. Mixed-version window policy (C1 answered — verified behavior)

Verified old-build behavior (no version gating exists today:
`remoteSchema.ts:349` LATEST=12 passes v13 as ready; `ensureRemoteSchemaOnly`
forward-migrates; no MINIMUM_SUPPORTED constant in `src/`):

- PULL, old build vs v13 remote: pull uses explicit `PULL_COLUMNS` incl. `tax`
  (`SyncManager.ts:129-134,156-158,2145,2150`) → `SELECT … tax …` throws
  `no such column` → per-table catch (`:2175-2181`) warns
  `pull query failed [transactions]` and continues other tables; cursor not
  advanced, retried every cycle. Per-table stall, no crash, no skipped rows.
- PUSH, old build → v13 remote: explicit INSERT incl. `tax` (`:1934-1945`)
  fails `no such column` → heal attempt (`ensureRemoteSchemaOnce`, ADD-only,
  cannot heal a DROP) → retry fails → row stays `pending`, after 10x
  `failed [QUARANTINE]` (`:1556-1575`). Sales wedge light-water: never marked
  `synced`, never silently lost.
- New-build apply of old-format payloads: `Number(payload.tax ?? 0)` sites
  (`:1945`, `:2640`, migrationManager, restoreManager) drop `tax` WITH a
  logged warning (`console.warn` + sync-health counter); `tax != 0` on an old
  payload logs at error level but is still dropped (column gone; §3 gate
  guarantees no live exceptions).

Cutover (ships WITH v13, both directions): new builds carry
`MIN_SUPPORTED_REMOTE_VERSION = 13` and `KNOWN_MAX = 13`, checked right after
`checkRemoteSchemaStatus` and BEFORE any `cursorQueries`/`toRemoteUpsert`:
`appliedVersion < floor` (local too old) → block writes, upgrade prompt;
`appliedVersion > KNOWN_MAX` (old build facing newer remote) → block the
`transactions` pull/push lanes with an upgrade prompt instead of the
column-error stall/quarantine above. This is the declared rehearsal for
1b-ii, where an old device writing REAL money against the new INTEGER schema
is the dangerous case. Anything structurally unconvertible fails closed
(`LEDGER_COGS_MISMATCH` posture unchanged).

## 8. STOP gates (no destructive step before ALL clear) + C-1b baseline pin

BASELINE (measured, path-normalized — C-1b): parent base `ce9460d` vs audit
HEAD `5447d1e` → tsc errors 53 == 53, all other-lane (committed consumers
reference uncommitted lane modules: `pinGate`, `auditGate`,
`technicianRecovery`, `emergencyExporter`, missing security exports; ZERO
from audit commits — proven by set-diff ignoring worktree paths). oxlint:
0 errors (warnings pre-existing). Audit CI lane
(`check-money-boundary`, Test J, `test_zero_tax`, Rust `money::`) green from
a clean worktree. Full `test:boundaries` is red at the first licensing script
(pre-existing, unrelated files) — hence the isolated audit lane (C-1a).

**1b-i exit criterion:** from a clean worktree — tsc error count == 53
(normalized method above), oxlint 0 errors, audit CI lane green. No merge to
any protected branch while the baseline is non-zero unless the owner
explicitly waives (other lanes must land or revert their half-work first).

1. Owner approves this plan doc as amended (§10 Addendum B + C1–C5;
   §2.3 test rewrite-or-delete choices left to execution).
2. Live + remote §3 counts delivered = 0 (owner runs or provides access).
   Any non-zero → HALT, root-cause before any drop (a writer emitting tax
   post-1a′ would itself be a P0).
3. Currency answer (`Currency = ___, decimals = ___`) is NOT required for
   1b-i execution but remains the 1b-ii unblock; 1b-i states no minor-unit
   assumption anywhere (all values dropped were proven 0, unit-free).

## 9. Execution verification (post-drop, before merge)

`tsc --noEmit`, `oxlint`, `cargo test -p mobi-pos --lib gate`,
`test_zero_tax.mjs` (extended: assert `SELECT sql` has no `tax` in
`transactions` DDL + static grep `vatRate` zero hits in `src/` outside the
§10-B2 whitelist), money/receipt/tradein suites, h24 rewrite, cloud/e2e sync
suites, receipt print eyeball (escpos path — paper check per watch-list).

## 10. Amendment — C1–C5 answers (verified, with file:line)

**C1 — old build vs v13 rows:** answered in §7 (verified pull-stall +
push-quarantine paths with exact lines). Cutover: `MIN_SUPPORTED_REMOTE_VERSION
= 13` + `KNOWN_MAX = 13`, checked after `checkRemoteSchemaStatus`, before any
`cursorQueries`/`toRemoteUpsert`. Both directions covered; no silent loss in
any direction (stall/quarantine today, upgrade-prompt block after cutover).

**C2 — p_* / triggers / views:** no p_* projection, trigger, or view names
`transactions.tax`. `p_transactions(id,total_cents,ts,row_hlc,device_id)`
(`lib.rs:1369-1375`, `reducers.ts:110`) and `p_transaction_items`
(`reducers.ts:116`) are tax-free. Only triggers in the DB are
`trg_products_fts_{insert,update,delete} ON products` (`lib.rs:1245-1265`);
zero triggers ON `transactions`. `orders` view (`lib.rs:1170`) is
`SELECT *` — names nothing explicitly; migration drops + recreates it
verbatim (cheap insurance against stored expansion). `order_items`
(`lib.rs:1172`) depends on `transaction_items`, untouched unless the child is
rebuilt. Sole direct `tax` reader outside adapters is the locked-state export
`emergency_export.rs:96` (handled in §2.1 #12).

**C3 — Dexie mirror + typed records:** `database.ts:72-216` (max `version(9)`
at `:213`) defines `transactions: 'id, receiptNumber, createdAt'` — PK is
string `id`, entries are query-only indexes; Dexie stores full objects, so
there is NO column to drop and NO Dexie version bump for `transactions`.
`SaleTransaction` (`pos.ts:451-459`) has NO `tax` field (has
`ledgerCogsTotal` at `:470-471`); `ReceiptSettings.vatRate` (`pos.ts:1504`)
is optional + deprecated — nothing REQUIREs it. Deletion sweep: the `vatRate`
field + persisted-value cleanup (§2.2 #20); no store redefinition.

**C4 — create-copy-drop rebuild list:** 8 indexes, all in `lib.rs` (none in
`sqlPluginAdapter.ts`, whose CREATE INDEXes cover other tables):
`idx_transactions_receipt` (:982), `idx_transactions_status` (:983),
`idx_transactions_created_at` (:984), `idx_transactions_customer` (:985),
`uq_transactions_idem` UNIQUE (:1120), `idx_transactions_updated` (:1124),
`idx_transactions_sync` (:1125), `idx_transactions_deleted` (:1281). No
triggers to port. FKs: none outbound from `transactions` (`customer_id`
has no REFERENCES); inbound `transaction_items(transaction_id) REFERENCES
transactions(id) ON DELETE CASCADE` (`lib.rs:990`) survives a RENAME
(SQLite retargets on rename) but if the fallback rebuilds the child table the
FK is re-declared; `imei_records.sale_transaction_id` has no FK (index only,
`:1283`). Views: recreate `orders` (and `order_items` iff child rebuilt).
ORDERING LAW (rehearsal-caught, `scripts/rehearse-1b-i-local.mjs`): with FK
enforcement ON (the app sets it at boot), `ALTER TABLE ... RENAME` aborts
with "error in view orders: no such table" if a dependent view dangles
mid-swap. The fallback MUST drop dependent views FIRST (before CREATE new),
then swap, rebuild indexes, recreate views, commit — verified end to end
on the live-DB copy (603/603 rows, 8/8 indexes, 3/3 views).

**C5 — post-drop proof method (executed post-drop, stated here):** repo-wide
grep for `tax` (case-insensitive, whole-word + `vatRate` + `tva`) returns
zero hits outside (a) the §10-B2 whitelist lines (each carrying the
`noise-skip, not a tax feature` comment), (b) history docs (`docs/`,
changelogs), (c) the `syntaxe` false positive. CI extends `test_zero_tax.mjs`
E4 into a blocking grep gate with exactly this whitelist. Any hit outside →
build fails.

## 11. Amendment — Addendum B consolidated deletion scope

(Replaces the cancelled §4 relabel. B3 cost-basis invariant lives in §1.)

- B-PO1 `PoReviewScreen.tsx`: prop `:46,61`, math `:177,183,454,458`,
  JSON export `:714`, labels `:902` (incl. hardcoded `TVA (19%)`), `:2062`.
- B-INV `InvoiceIngestionModal.tsx`: state `:100`, OCR→state `:279-280`,
  scan call sites `:334,414,473`, prop `:497`, label+input `:640-646`.
- B-TYPES `src/types/po.ts:54,69` + `ProcessRawScanRequest` tax field;
  `api/po.ts` passes the request object through (no separate tax handling —
  verify at execution, one line).
- B-GATE `commands.rs:73-79` (request struct) + `:125-130` (gate call —
  `reported_freight` stays: freight is a real fee, not tax);
  `gate.rs:43` (param), `:69-76` (sanitize), `:174-178` (grand-total
  addition). `reported_freight` + `safe_freight` + `freight_cents`
  throughout are KEEP (freight ≠ tax; PoReviewScreen freight lines stay).
- B-SCAN `scanAccuracyEngine.ts:209` `solveAccountingConstraints` deleted
  (zero callers, zero script assertions — verified); rest of file KEEP.
  `documentScanner.ts:180,205` demo `reported_tax:0` keys deleted.
- B2 carve-out (whitelist, `noise-skip, not a tax feature` comment REQUIRED
  on each): `geometry.rs:256-257` (`tva `/`t.v.a` summary-line matchers),
  `:286-287` (skip-extraction into `detected_tax` so the line is excluded
  from product rows), `:734-738` (footer-exclusion comment+branch).
  Totals are read directly from labeled rows (`:275-283`: TOTAL TTC / NET A
  PAYER / TOTAL FACTURE → `detected_grand_total`), so the skip grammar is
  defensive depth, not load-bearing. `geometry.rs:60` `detected_tax` field
  survives ONLY as the skip-bin; `:243` doc comment trimmed to skip
  terminology. Fixture `:1017` KEEP (verified skip-assert: rows==5 at
  `:1049-1053`, total 128000 at `:1046`, subtotal at `:1104-1105`, zero tax
  assertions). If execution finds totals need no skip grammar at all →
   prefer full removal, whitelist stays empty, fixture rewritten without the
   TVA line.

## 12. Tracked items R-1..R-3 + §3 local rehearsal (record)

- R-1 (external debt — other lanes): audit CI lane's full-crate Rust step
  cannot pass on clean checkout until they land `snapshot_prune.rs`
  (committed `lib.rs` declares the module; E0583 + 2 cascade E0433 + proc-macro
  panic) and `hardware::native_hwid_hash` (E0425 from an uncommitted hunk).
  File-level proof, zero intersection with audit diff. Close-out: lanes land
  → full-crate step verified green on clean checkout → flip `continue-on-error`
  off. Checked at the next gate.
- R-2 (closed): `crates/money-gate` re-hosts `src-tauri/src/money.rs` by
  `#[path]` (self-contained: zero `crate::` refs, serde/serde_json/std only)
  with its in-module tests incl. the C-4 fixture. `cargo test -p money-gate`
  8/8 green incl. `--offline`; runs in the audit CI lane as the blocking Rust
  step. If money.rs ever gains a `crate::` dep, the gate crate fails to
  compile BY DESIGN.
- R-3 (closed): `origin/feature/tradein-exchange` pushed through `c315508`
  and follow-ups (network flaky — retry or owner-push if a commit is left
  local-only at any gate).
- §3 rehearsal (`scripts/rehearse-1b-i-local.mjs`, 22/22 on a VACUUM INTO
  copy of the live 603-transaction DB; live data untouched): pre-counts
  (total 603, tax!=0 = 0, tax SUM = 0); Path A native DROP COLUMN (indexes
  survive, counts/sums/view intact; ADD COLUMN rollback restores all-zero);
  Path B create-copy-drop with the §C4 ordering law (views dropped FIRST —
  the naive order aborts mid-RENAME under FK enforcement; caught and fixed
  here, not in production); rollback B verified. Reconciliation: every
  mutation ran on temp copies; workdir retained in report output.
