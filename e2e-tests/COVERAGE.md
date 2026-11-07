# COVERAGE — POS Edge Case Encyclopedia vs. executed MobiPOS tests

Generated: 2026-11-07T12:26:34.537Z  
Batch: `sweep-i`  
Verdict source: `e2e-tests/CASE_INDEX.csv` (single source of truth)  
Source cases: `POS_EDGE_CASE_ENCYCLOPEDIA_and_LONG_SESSION.md` (local, not in repo)

## Summary dashboard

| Metric | Count |
|---|---|
| Catalog cases (table rows) | 687 |
| Passed (full) | 284 |
| Passed (partial — unasserted facets listed) | 18 |
| Passed (full, excluding flaky rows) | 283 |
| FLAKY (pass, order-dependent - excluded from the headline) | 1 |
| **FAILED** | 198 |
| N/A (absent or unobservable in harness) | 70 |
| Remaining (doable today, not yet executed) | 0 |
| BLOCKED (missing dependency — see Evidence) | 117 |
| Global invariants (G-01…G-36) executed | 25/36 |

> The catalog tables contain 687 active rows (incl. 15 I18 + 8 HW) + 36 G invariants.
> Additionally, 10 owner-retired tax IDs (§0.2.6) sit OUTSIDE the 687; they are the
> `retired=1` rows of `CASE_INDEX.csv` and are listed separately below.

**Batch 27b (2026-10-26):** the whole LBL (13) + HW (8) REMAIN bucket was
executed — 1 PASS, 2 PASS-PARTIAL, 9 FAIL, 4 N/A, 5 BLOCKED. Label byte checks
run the app's own modules under Node and verify them with independent EAN-13 /
Code128 decoders; the interactive half runs against the real WebView. New
findings: `P2-85` (a failed label print is reported as success) and `P2-86` (a
Tab-terminated HID scanner cannot sell). See `BATCH27B-LBL-HW.md`; canonical log
`logs/part0-27b.log` (21 verdict lines).

**Batch 27a (2026-10-26):** 24 previously-REMAIN SCL cases were executed on a
disposable DB copy, plus SCL-23 re-run; TIM-09 was re-opened after the Android
PIN-gate blocker fell. See `BATCH27A-SCL.md`. `P1-67` is withdrawn: it was a
harness expectation, because a pushed DB survives boot unchanged and the
companion reads the `p_products` sync projection rather than `products`. Its
replacement is `P2-84` (the installed APK is schema-stale vs HEAD at the same
version string).

**Verdict-source note (2026-10-27):** `CASE_INDEX.csv` is now the only place a
verdict lives. The old `fixtures/{fail,na,blocked}-cases.json` buckets were
retired: they lagged the CSV (107/112/63 vs 251/117/72) and any generator that
reads them silently re-emits old numbers. `coverage.mjs` reads the CSV, refuses
to run outside a batch, and proves its id set still matches `fixtures/cases.json`.

**SCL relabel (2026-10-27):** the last 45 REMAIN rows (SCL) are now BLOCKED with
their missing dependency recorded in the CSV `evidence` column (10M fixtures,
merchant sync gateway, or a second enrolled terminal). REMAIN now means
"executable in this environment today"; nothing else is parked there.

## Verdict rules

**N/A** — the case's precondition does not exist in the product at all. The harness probes confirm the absence (grep count = 0, component = 0, etc.). The case cannot be executed because there is nothing to test. Example: if the product has no gift-receipt builder, the case cannot be run.

**FAIL** — the case's precondition exists (the product has the broader capability, e.g., refunds exist → a gift-receipt variant should exist; warranty functionality exists → per-condition variants should exist). The harness confirms the feature is missing but the product *could* implement it. Example: gift receipts should exist but no builder is found → FAIL.

**BLOCKED** — the case is executable in principle but needs a dependency this
environment does not have (10M-row fixtures, the merchant sync gateway, a second
enrolled terminal, a real mobile device). The CSV `evidence` column names the
missing dependency; it is not a verdict on the product.

**REMAIN** — executable today with the existing harness and fixtures, not yet
run. This bucket must stay empty at batch close: everything either gets a
verdict or is relabelled BLOCKED with its dependency.

A verdict change from N/A to FAIL requires the case text to clearly assume the precondition exists (e.g., "the gift receipt variant" not "if a gift receipt variant exists").

## Retired / out-of-scope IDs (§0.2.6 — no tax in scope)

| ID | Verdict |
|---|---|
| MNY-08 | N/A — removed (no tax) |
| MNY-09 | N/A — removed (no tax) |
| MNY-10 | N/A — removed (no tax) |
| MNY-12 | N/A — removed (no tax) |
| MNY-13 | N/A — removed (no tax) |
| MNY-14 | N/A — removed (no tax) |
| MNY-15 | N/A — removed (no tax) |
| REF-04 | N/A — removed (no tax) |
| REP-17 | N/A — removed (no tax) |
| RPT-02 | N/A — removed (no tax) |

## CRM (12)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| CRM-01 | P1 | Duplicate customers (same phone, different spelling), merge | — | N/A — Feature not implemented — no customer merge/redirect lane: duplicate customers remain sepa |
| CRM-02 | P1 | Phone number formats (+213, 0xx, spaces) normalization | 70-crm-customers.e2e.ts | PASS |
| CRM-03 | P1 | Customer deletion/GDPR-like erase vs legal retention of invoices | 70-crm-customers.e2e.ts | FAIL |
| CRM-04 | P1 (cond. P0) | Credit limit, aging, repayment allocation to oldest invoice first; overpay → credit | 70-crm-customers.e2e.ts | PASS |
| CRM-05 | P1 | Blacklisted customer (fraud) blocked from trade-in/credit | — | N/A — Feature not implemented — no blacklist/fraud flag or enforcement. The customer form/type c |
| CRM-06 | P1 | One phone shared by several customers (family) | 70-crm-customers.e2e.ts | FAIL |
| CRM-07 | P1 | Walk-in sale later given a phone/name matching an existing customer | — | N/A — Feature not implemented — no after-sale customer attach/merge prompt: a completed ticket c |
| CRM-08 | P1 | Customer merged on device A while device B adds a sale/repair/inspection to the merged-awa | — | N/A — Feature not implemented — no merged_into redirect/merge job: sync upserts customers by id/ |
| CRM-09 | P1 | Role-based customer visibility (cashier vs manager vs inspector): debts, ID numbers, notes | — | FAIL |
| CRM-10 | P1 | Customer attachments (ID photo, signed contract) | — | N/A — Feature not implemented — no customer attachments (ID photo/signed contract). Attachments  |
| CRM-11 | P1 | Customer note/tag fields with Arabic/emoji/long text; free-text search in notes | — | N/A — Feature not implemented — no customer note/tag fields: Customer has no notes/tags, the cre |
| CRM-12 | P1 | Customer created offline on 3 devices with the same phone, then sync | — | N/A — Feature not implemented — no duplicate-detection/merge queue after multi-device convergenc |

## CRT (22)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| CRT-01 | P1 | 1, 7, 50, 200, 1000 lines | 71-crt-cart.e2e.ts | PASS |
| CRT-02 | P1 | Same product added twice (merge vs separate lines) | 71-crt-cart.e2e.ts | PASS |
| CRT-03 | P1 | Quantity 0, negative, decimal on integer-only item, huge | 71-crt-cart.e2e.ts | PASS |
| CRT-04 | P0 | Line discount % > 100, fixed > line, negative discount | 71-crt-cart.e2e.ts | PASS |
| CRT-05 | P1 | Stacked discounts (line + invoice + coupon + loyalty redemption) in every order the UI all | derived:REF-28 | FAIL |
| CRT-06 | P1 | Invoice-level discount allocation across lines (needed for correct refunds) | derived:REF-03 | PASS |
| CRT-07 | P1 | Buy-X-get-Y / bundle / happy-hour promotion edge: qty exactly at threshold, threshold−1, + | — | N/A — Feature not implemented - no buy-X-get-Y, BOGO, gift-with-purchase or happy-hour promotion |
| CRT-08 | P1 | Price override by cashier vs manager | 71-crt-cart.e2e.ts | PASS |
| CRT-09 | P1 | Park/hold sale, resume next day after price/stock change | 71-crt-cart.e2e.ts | PASS |
| CRT-10 | P1 | Cancel sale after items added, after partial payment | 71-crt-cart.e2e.ts | PASS |
| CRT-11 | P1 | Barcode scan: unknown barcode, duplicate barcode on two products, scanner fast input (13 c | 71-crt-cart.e2e.ts | PASS |
| CRT-12 | P1 | Product with 0 stock, negative-stock allowed/forbidden | 71-crt-cart.e2e.ts | PASS |
| CRT-13 | P1 | Deleting a product/customer referenced by old sales | 71-crt-cart.e2e.ts | PASS |
| CRT-14 | P1 | Serial/IMEI-tracked item sold without selecting a serial | 71-crt-cart.e2e.ts | PASS |
| CRT-15 | P1 | Add item while payment dialog open / double-click Add / hold-key repeat | 71-crt-cart.e2e.ts | PASS |
| CRT-16 | P1 | Shelf/label price differs from cart price (stale label, LBL-04) | — | N/A — Feature not implemented - there is no separate shelf/label price source. Product has one c |
| CRT-17 | P1 | Phone + accessories at one bundle price (e.g. free screen protector) | derived:REF-33 | PASS |
| CRT-18 | P0 | Same IMEI added to two carts (two cashiers, desktop + mobile) or twice in one cart | 71-crt-cart.e2e.ts | PASS |
| CRT-19 | P1 | Scan of a model/SKU barcode vs scan of the IMEI itself for an IMEI-tracked item | 71-crt-cart.e2e.ts | PASS |
| CRT-20 | P1 | Delete a line / undo after a discount, promotion or loyalty redemption was applied | 71-crt-cart.e2e.ts | PASS |
| CRT-21 | P1 | Park a cart on mobile, resume it on desktop (and reverse) | — | N/A — N/A for this single-device build: there is no mobile hold/resume or cross-device cart hand |
| CRT-22 | P1 | 200-line cart on a low-RAM phone | 71-crt-cart.e2e.ts | PASS |

## DAT (89)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| DAT-01 | P0 | Kill process at random points during sale/refund/trade-in/ticket/close-shift (hundreds of  | 20-dat-data-integrity-part1.e2e.ts | BLOCKED — **BLOCKED** - no random-point process-kill/fault-injection harness; batch20-dat.log |
| DAT-02 | P0 | Power loss simulation (hard kill of process + OS-level where possible) with WAL on | 20-dat-data-integrity-part1.e2e.ts | BLOCKED — **BLOCKED** - no OS power-cut/VM hard-off harness; batch20-dat.log |
| DAT-03 | P0 | Disk full / read-only DB file / permission denied | 20-dat-data-integrity-part1.e2e.ts | BLOCKED — **BLOCKED** - no disk-full/read-only/ACL fixture; batch20-dat.log |
| DAT-04 | P0 | DB locked by concurrent writers (`busy_timeout`) | 20-dat-data-integrity-part1.e2e.ts | PASS |
| DAT-05 | P0 | `PRAGMA foreign_keys` enabled on every connection (SQLite default is per-connection OFF) | 20-dat-data-integrity-part1.e2e.ts | PASS |
| DAT-06 | P0 | Migrations: upgrade from each previous released schema with realistic data; downgrade atte | 20-dat-data-integrity-part1.e2e.ts | BLOCKED — **BLOCKED** - no historical schema/interrupted-migration fixtures; batch20-dat.log |
| DAT-07 | P0 | Backup → restore on clean machine; restored numbering continues without collisions | 20-dat-data-integrity-part1.e2e.ts | PASS |
| DAT-08 | P0 | Auto-backup runs during heavy use; backup of a DB in WAL mode is consistent | 20-dat-data-integrity-part1.e2e.ts | FAIL |
| DAT-09 | P0 | DB growth: 1M sale lines, 100k audit rows: query/report time, VACUUM, startup time | 20-dat-data-integrity-part1.e2e.ts | BLOCKED — **BLOCKED** - no 1M-line/100k-audit fixture; batch20-dat.log |
| DAT-10 | P0 | Corrupt DB file at startup | 20-dat-data-integrity-part1.e2e.ts | FAIL |
| DAT-11 | P0 | Two app instances on same DB (double-click launch) | 20-dat-data-integrity-part1.e2e.ts | FAIL |
| DAT-12 | P0 | Update/upgrade of the app while shift open | 20-dat-data-integrity-part1.e2e.ts | BLOCKED — **BLOCKED** - no installer/updater artifact; batch20-dat.log |
| DAT-13 | P0 | Uninstall/reinstall keeps/handles data per policy | 20-dat-data-integrity-part1.e2e.ts | BLOCKED — **BLOCKED** - no installer/uninstaller artifact; batch20-dat.log |
| DAT-14 | P0 | Data retention/purge job (old audit, old tickets): does not delete rows needed for refunds | 20-dat-data-integrity-part1.e2e.ts | PASS |
| DAT-15 | P0 | Migration adds a column/index to a 1 M-row table, or rebuilds the table for a new constrai | 20-dat-data-integrity-part1.e2e.ts | BLOCKED — **BLOCKED** - no 1M-row pre-migration fixture; batch20-dat.log |
| DAT-16 | P0 | DB file placed in a cloud-synced/network folder (OneDrive, Dropbox, SMB) or antivirus lock | 20-dat-data-integrity-part1.e2e.ts | BLOCKED — **BLOCKED** - no cloud/SMB/AV lock fixture; batch20-dat.log |
| DAT-17 | P0 | Wrong database opened (second Windows account, restored copy, test vs production data dir) | 20-dat-data-integrity-part1.e2e.ts | BLOCKED — **BLOCKED** - no second profile/restored copy fixture; batch20-dat.log |
| DAT-18 | P0 | `VACUUM INTO`/backup while a write is in progress and sync is running | 20-dat-data-integrity-part1.e2e.ts | BLOCKED — **BLOCKED** - no configured sync gateway + concurrent load; batch20-dat.log |
| DAT-19 | P0 | Soft-delete accumulation (customers, products, tickets) | 20-dat-data-integrity-part1.e2e.ts | FAIL |
| DAT-20 | P0 | Durability settings audit: journal mode, `synchronous`, per-platform full-fsync, on every  | 20-dat-data-integrity-part1.e2e.ts | FAIL |
| DAT-21 | P0 | Acknowledged-but-lost test: harness logs every id the UI confirmed (success screen, printe | 20-dat-data-integrity-part1.e2e.ts | BLOCKED — **BLOCKED** - no VM power-off + external acknowledged-id log; batch20-dat.log |
| DAT-22 | P0 | Order of side effects: card charge, printing, drawer kick, SMS vs DB commit | 20-dat-data-integrity-part1.e2e.ts | PASS |
| DAT-23 | P0 | Hard power cut during WAL checkpoint, `VACUUM`, migration, backup, sync apply, bulk import | 20-dat-data-integrity-part1.e2e.ts | BLOCKED — **BLOCKED** - no power-cut/mid-checkpoint kill harness; batch20-dat.log |
| DAT-24 | P0 | `-wal`/`-shm` file deleted, quarantined by antivirus, or only the `.db` file copied (by ha | 20-dat-data-integrity-part1.e2e.ts | BLOCKED — **BLOCKED** - no -wal/-shm/AV quarantine fixture; batch20-dat.log |
| DAT-25 | P0 | Large transaction killed at 90 % (import of 1 M rows, mass edit, merge, purge) | 20-dat-data-integrity-part1.e2e.ts | BLOCKED — **BLOCKED** - no 1M-row import/90% kill fixture; batch20-dat.log |
| DAT-26 | P0 | Disk full during sale commit, WAL growth, backup, log write, photo save | 20-dat-data-integrity-part1.e2e.ts | BLOCKED — **BLOCKED** - no disk-full quota fixture; batch20-dat.log |
| DAT-27 | P0 | Failing disk/SD card, USB drive pulled, DB on a network share that drops, I/O errors on re | 20-dat-data-integrity-part1.e2e.ts | BLOCKED — **BLOCKED** - no failing-medium/SMB I/O-error fixture; batch20-dat.log |
| DAT-28 | P0 | Silent corruption detection: `quick_check` at startup and daily, hash-chain verify, ledger | 20-dat-data-integrity-part1.e2e.ts | FAIL |
| DAT-29 | P0 | Corrupt DB at startup → recovery path | 20-dat-data-integrity-part1.e2e.ts | FAIL |
| DAT-30 | P0 | Backup completeness: DB (consistent snapshot), attachments/photos/ID scans, settings, prin | 21-dat-data-integrity-part2.e2e.ts | FAIL |
| DAT-31 | P0 | Backup rotation: daily/weekly/monthly retention, destination full, clock rollback, same-se | 21-dat-data-integrity-part2.e2e.ts | FAIL |
| DAT-32 | P0 | Every backup is verified by restoring into a temp DB | 21-dat-data-integrity-part2.e2e.ts | FAIL |
| DAT-33 | P0 | Off-machine copy: second disk, USB (drive letter changes), cloud; backup only on the same  | 21-dat-data-integrity-part2.e2e.ts | FAIL |
| DAT-34 | P0 | Encrypted backups and key loss | 21-dat-data-integrity-part2.e2e.ts | FAIL |
| DAT-35 | P0 | Restore procedure on a live shop | 21-dat-data-integrity-part2.e2e.ts | FAIL |
| DAT-36 | P0 | Disaster recovery from the sync backend, and the reverse: new PC pulls everything; backend | 21-dat-data-integrity-part2.e2e.ts | FAIL |
| DAT-37 | P0 | Measure RPO and RTO: lose the desktop at a random moment | 21-dat-data-integrity-part2.e2e.ts | BLOCKED — No VM/power-cut harness to measure RPO/RTO at a random commit moment. Needed: hard-off VM  |
| DAT-38 | P0 | Automatic restore point before destructive operations: bulk price change, import, merge, p | 21-dat-data-integrity-part2.e2e.ts | FAIL |
| DAT-39 | P0 | Cascading deletes: deleting a customer, product, category, user, device or shop | 21-dat-data-integrity-part2.e2e.ts | PASS |
| DAT-40 | P0 | `INSERT OR REPLACE` / `REPLACE INTO` and upserts | 21-dat-data-integrity-part2.e2e.ts | FAIL |
| DAT-41 | P0 | Row-id reuse: integer ids without `AUTOINCREMENT` can be reused after deleting the highest | 21-dat-data-integrity-part2.e2e.ts | PASS |
| DAT-42 | P0 | Mass delete, "delete all", "clear data", factory reset | 21-dat-data-integrity-part2.e2e.ts | N/A — No UI caller reaches requestDataWipe/clearAllData/factory reset (wipeUiCallers=[], factory |
| DAT-43 | P0 | Trash/soft-delete and recovery of products, customers, tickets | 21-dat-data-integrity-part2.e2e.ts | FAIL |
| DAT-44 | P0 | CSV/Excel import that overwrites: empty cells wiping price/stock/phone, "replace all" mode | 21-dat-data-integrity-part2.e2e.ts | PASS |
| DAT-45 | P0 | Bulk edit mistakes: price × 100, wrong category for 100 k products | 21-dat-data-integrity-part2.e2e.ts | N/A — No bulk price/category editor (bulkPriceUi=[], bulkCategoryUi=[]); ProductMatrixModal only |
| DAT-46 | P0 | Merge of customers/products/IMEIs picked wrongly | 21-dat-data-integrity-part2.e2e.ts | N/A — No customer/product/IMEI merge UI or API (mergeUi=[], mergeApi=[]); cloud merge is sync re |
| DAT-47 | P0 | Unsaved work: cart, parked sales, half-filled trade-in/repair intake, inspection notes and | 21-dat-data-integrity-part2.e2e.ts | FAIL |
| DAT-48 | P0 | Two users edit the same note/ticket text/customer field | 21-dat-data-integrity-part2.e2e.ts | FAIL |
| DAT-49 | P0 | Truncation and mangling on save: long names, emoji, newlines, zero-width characters, Arabi | 21-dat-data-integrity-part2.e2e.ts | PASS |
| DAT-50 | P0 | Settings/config loss: printers, receipt templates, loyalty rules, users/PINs, shop identit | 21-dat-data-integrity-part2.e2e.ts | FAIL |
| DAT-51 | P0 | App update and schema migration safety | 21-dat-data-integrity-part2.e2e.ts | BLOCKED — No previous-version installer/signed update/frozen old-schema fixture or interrupted-migra |
| DAT-52 | P0 | Uninstall, reinstall, "clear app data", moving the app folder, cloned disk, new Windows pr | 21-dat-data-integrity-part2.e2e.ts | BLOCKED — No installer/uninstaller, second Windows profile, cloned-disk image or Android profile. Ne |
| DAT-53 | P0 | OS protections and updates: Windows Controlled Folder Access blocking writes, antivirus qu | 21-dat-data-integrity-part2.e2e.ts | BLOCKED — No CFA/AV/forced-reboot harness. Needed: disposable Windows VM with CFA/AV policy and forc |
| DAT-54 | P0 | Ransomware, theft or fire of the shop PC | 21-dat-data-integrity-part2.e2e.ts | BLOCKED — No physical/security drill or ransomware simulator; local backup is broken. Needed: drill/ |
| DAT-55 | P0 | Clock-driven deletion: wrong or far-future clock triggers retention purge or backup rotati | 21-dat-data-integrity-part2.e2e.ts | FAIL |
| DAT-56 | P0 | Retention/purge job safety | 21-dat-data-integrity-part2.e2e.ts | FAIL |
| DAT-57 | P0 | Export-before-delete | 21-dat-data-integrity-part2.e2e.ts | FAIL |
| DAT-58 | P0 | Audit/log loss: log rotation, audit purge, audit write failure | 21-dat-data-integrity-part2.e2e.ts | FAIL |
| DAT-59 | P0 | Connection-pool hygiene: error or panic in the middle of a transaction leaves a connection | 22-dat-data-integrity-part3.e2e.ts | PASS |
| DAT-60 | P0 | A sale written through several connections or statements outside one transaction; `SQLITE_ | 22-dat-data-integrity-part3.e2e.ts | PASS |
| DAT-61 | P0 | Sync causing loss: remote state overwrites local unsynced rows; replica re-bootstrap or "r | 22-dat-data-integrity-part3.e2e.ts | BLOCKED — no configured merchant gateway (sync.gateway_url=null) and no second device/remote replica |
| DAT-62 | P0 | Mass deletes or corrupted tombstones propagating to every device | 22-dat-data-integrity-part3.e2e.ts | BLOCKED — single-device sandbox (outbox pending=13, gateway=null); no second enrolled device to rece |
| DAT-63 | P0 | "Last copy" risk: one PC holds days of unsynced sales | 22-dat-data-integrity-part3.e2e.ts | FAIL |
| DAT-64 | P0 | After any recovery (restore, salvage, resync): reconciliation | 22-dat-data-integrity-part3.e2e.ts | BLOCKED — restore/swap is removed from the native handler (removed=true; src-tauri/src/lib.rs:705-71 |
| DAT-65 | P0 | Files outside the DB (photos, ID scans, PDFs): backup, restore on another machine, orphan  | 22-dat-data-integrity-part3.e2e.ts | PASS |
| DAT-66 | P0 | Canary records: a synthetic sale/product with known id written daily | 22-dat-data-integrity-part3.e2e.ts | PASS |
| DAT-67 | P0 | Full export on demand (SQL dump or CSV, open format) | 22-dat-data-integrity-part3.e2e.ts | PASS |
| DAT-68 | P0 | Backup destination limits: FAT32 USB stick (4 GB file limit), exFAT/NTFS, long paths, ille | 22-dat-data-integrity-part3.e2e.ts | PASS |
| DAT-69 | P0 | Online backup of a busy DB: SQLite's backup API restarts when another connection writes; ` | 22-dat-data-integrity-part3.e2e.ts | PASS |
| DAT-70 | P0 | Cross-version restore: backups made by every older release restored into the newest app; a | 22-dat-data-integrity-part3.e2e.ts | BLOCKED — no previous-version installer or frozen old-schema backup artifact (backups=0). Needed: th |
| DAT-71 | P0 | Multi-file atomicity: audit log, outbox, archive or ledger kept in a separate database fil | 22-dat-data-integrity-part3.e2e.ts | PASS |
| DAT-72 | P0 | External tools on the live DB: DB Browser for SQLite, `sqlite3` CLI, Excel/ODBC, backup ag | 22-dat-data-integrity-part3.e2e.ts | BLOCKED — no DB Browser/Recuva/WAL-forensics harness in the sandbox; the harness only opens copies w |
| DAT-73 | P0 | Image-level copies: Windows VSS/Veeam-style backups, VM snapshots, hibernation, disk clone | 22-dat-data-integrity-part3.e2e.ts | BLOCKED — no VSS/VM snapshot or disk-clone harness; the sandbox is a single directory, not a block d |
| DAT-74 | P0 | Duplicate device identity: cloned disk/VM, restored PC image, copied app-data folder, Andr | 22-dat-data-integrity-part3.e2e.ts | FAIL |
| DAT-75 | P0 | Owner/admin lockout: forgotten owner PIN, lost recovery code, departed administrator, unre | 22-dat-data-integrity-part3.e2e.ts | PASS |
| DAT-76 | P0 | Licence, subscription or backend lapses: licence expired/revoked, sync plan quota exceeded | 22-dat-data-integrity-part3.e2e.ts | BLOCKED — no licence server/provider configured (url=null, settings=[]) and no subscription state to |
| DAT-77 | P0 | Retention shorter than the longest offline period: tombstones, idempotency keys, outbox ac | 22-dat-data-integrity-part3.e2e.ts | PASS |
| DAT-78 | P0 | Selective restore: recover 5,000 deleted customers (or one day of edited products) from la | 22-dat-data-integrity-part3.e2e.ts | FAIL |
| DAT-79 | P1 | Near-zero RPO option: continuous copy of changes to another disk or the cloud, or the sync | 27c-i18-checks.mts | FAIL |
| DAT-80 | P0 | External witnesses of lost sales: card-terminal/gateway settlement files, mobile-top-up pr | 22-dat-data-integrity-part3.e2e.ts | BLOCKED — no card terminal, bank or gateway settlement file in the sandbox; only local transactions  |
| DAT-81 | P0 | Mass wipe by update: a buggy migration, import or bulk edit on one device blanks or zeroes | 22-dat-data-integrity-part3.e2e.ts | BLOCKED — the sandbox has 4 products, not a 1M-row fixture, and no migration/update harness to run a |
| DAT-82 | P0 | Ledger immutability inside the database: an application bug or injected SQL runs `DELETE`/ | 22-dat-data-integrity-part3.e2e.ts | FAIL |
| DAT-83 | P0 | Destructive migrations: dropping or renaming a column or table that older clients, sync, r | 22-dat-data-integrity-part3.e2e.ts | BLOCKED — only the current migration chain exists (21 rows); no frozen historical schema or destruct |
| DAT-84 | P1 | "Data safety" screen for the owner: last backup (age, verified, off-machine), last restore | 27c-i18-checks.mts | FAIL |
| DAT-85 | P0 | Staff-error scenarios: closing the window mid-sale, pulling the plug, holding the reset bu | 22-dat-data-integrity-part3.e2e.ts | BLOCKED — no OS-level lid/power/UPS harness and no second data-dir profile; the sandbox runs one pro |
| DAT-86 | P0 | Android-specific loss: "clear storage", cleaner apps, SD-card storage removed, factory res | 22-dat-data-integrity-part3.e2e.ts | BLOCKED — no Android device/emulator or adb harness; the app under test is the Windows desktop build |
| DAT-87 | P0 | Bit rot and partial copies of backups: checksum mismatch, truncated cloud upload, silently | 22-dat-data-integrity-part3.e2e.ts | FAIL |
| DAT-88 | P0 | Identifiers as text end to end: IMEI, phone, receipt/ticket numbers, ids above 2^53, dates | 22-dat-data-integrity-part3.e2e.ts | PASS |
| DAT-89 | P0 | Gap finder: a "what could be missing?" report | 22-dat-data-integrity-part3.e2e.ts | PASS |

## DRW (30)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| DRW-01 | P0 | Cashier A logs in with PIN on desktop and opens the drawer (float 50,000.00 DA) | 65-drw-drawer-part1.e2e.ts | FAIL |
| DRW-02 | P0 | Desktop closes the drawer (counted cash entered) | 65-drw-drawer-part1.e2e.ts | FAIL |
| DRW-03 | P0 | Open and close initiated from mobile | 65-drw-drawer-part1.e2e.ts | PASS |
| DRW-04 | P0 | Desktop and mobile press Open on the same drawer at the same instant (and again with a 2-d | 65-drw-drawer-part1.e2e.ts | FAIL |
| DRW-05 | P0 | Desktop and mobile press Close at the same instant with different counted amounts | 65-drw-drawer-part1.e2e.ts | PASS |
| DRW-06 | P0 | Drawer closed on desktop while mobile is offline and still shows open; mobile sells during | 65-drw-drawer-part1.e2e.ts | N/A — No second device and no offline sale queue: the companion (?mode=mobile) is the same Tauri |
| DRW-07 | P0 | Mobile offline/stale when desktop opens; mobile user tries to open its own | 65-drw-drawer-part1.e2e.ts | N/A — No stale second-device mobile state: the mobile shell reads the same local rows in the sam |
| DRW-08 | P0 | Mobile app backgrounded or killed while desktop opens/closes; user returns | 65-drw-drawer-part1.e2e.ts | PASS |
| DRW-09 | P0 | State events arrive duplicated, delayed, out of order, or dropped (open event after close  | 65-drw-drawer-part1.e2e.ts | N/A — No drawer event/command log to duplicate, delay, reorder or drop: drawer state is a row (c |
| DRW-10 | P0 | Realtime channel down (WebSocket/SSE drop, captive portal, backend 429/500, push unavailab | 65-drw-drawer-part1.e2e.ts | N/A — No realtime drawer channel exists to take down: SyncManager only transports rows; the mobi |
| DRW-11 | P0 | Mobile or desktop clock skewed ±5 min / ±1 day | 65-drw-drawer-part1.e2e.ts | FAIL |
| DRW-12 | P0 | Cashier A opened the drawer; cashier B logs in with PIN on the same desktop | 65-drw-drawer-part1.e2e.ts | FAIL |
| DRW-13 | P0 | A on desktop and B on mobile each hold their own open drawer; also A tries to open a secon | 65-drw-drawer-part1.e2e.ts | N/A — No register/drawer entity: a "drawer" is only cash_sessions.device_id with a partial uniqu |
| DRW-14 | P0 | Logout, auto-lock, PIN user-switch, app restart while drawer is open | 65-drw-drawer-part1.e2e.ts | FAIL |
| DRW-15 | P0 | Manager force-closes a cashier's forgotten drawer from mobile or desktop | 65-drw-drawer-part1.e2e.ts | N/A — No force-close workflow or command exists: the only close is the normal reconciliation (bl |
| DRW-16 | P0 | Opening float: Arabic digits, 0, huge, negative, edit after open | 66-drw-drawer-part2.e2e.ts | FAIL |
| DRW-17 | P0 | Physical cash-drawer kick vs session state: sale on mobile with no drawer attached; "no sa | 66-drw-drawer-part2.e2e.ts | FAIL |
| DRW-18 | P0 | Mobile shows live drawer totals while desktop sells (cash sales, refunds, payouts, expecte | 66-drw-drawer-part2.e2e.ts | FAIL |
| DRW-19 | P0 | Cash sale taken on mobile (no physical drawer) | 66-drw-drawer-part2.e2e.ts | PASS |
| DRW-20 | P0 | Backend restarted, restored from an older backup, or a device restored an old DB while the | 66-drw-drawer-part2.e2e.ts | N/A — No backend restore/epoch concept in the store: cash_sessions has a version column but no e |
| DRW-21 | P0 | Several drawers/registers (desktop 1, desktop 2, mobile till); rename; remove a device | 66-drw-drawer-part2.e2e.ts | PASS |
| DRW-22 | P0 | Drawer left open for days / across business-day change / > 24 h | 66-drw-drawer-part2.e2e.ts | FAIL |
| DRW-23 | P0 | Close barrier: another device still has unsynced/parked sales, unfinished payment or pendi | 66-drw-drawer-part2.e2e.ts | FAIL |
| DRW-24 | P0 | Z-report after close printed on desktop, viewed on mobile, reprinted from mobile | 66-drw-drawer-part2.e2e.ts | PASS |
| DRW-25 | P0 | Audit of drawer events (open, close, force-close, handover, reopen, failed attempts) | 66-drw-drawer-part2.e2e.ts | FAIL |
| DRW-26 | P0 | Phone lost or user disabled while that phone holds the open drawer | 66-drw-drawer-part2.e2e.ts | N/A — No server-issued revocation touches the drawer: device revocation is a SyncManager gate on |
| DRW-27 | P0 | Mistaken close; reopen within N minutes | 66-drw-drawer-part2.e2e.ts | N/A — No reopen/reverse-close command or UI: a CLOSED session is terminal (no UPDATE back to OPE |
| DRW-28 | P0 | Counting cash by denominations on mobile vs desktop, Arabic digits, small screens | 66-drw-drawer-part2.e2e.ts | PASS |
| DRW-29 | P0 | Two devices change the same drawer's metadata (note, float correction) at once | 66-drw-drawer-part2.e2e.ts | N/A — No editable drawer-metadata lane to race: the only editable field at close is the free-tex |
| DRW-30 | P0 | Open a drawer while a gateway approval from the previous drawer is still pending | 66-drw-drawer-part2.e2e.ts | N/A — No gateway approval in the close path: the close is a local SQLite transaction (blind coun |

## HW (8)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| HW-01 | P2 | Barcode scanner: USB HID wedge vs serial; scan during modal; scan with trailing Enter vs T | 27b-lbl-hw.e2e.ts | FAIL |
| HW-02 | P2 | Customer display / second screen [if any] shows same totals | 27b-lbl-checks.mts | BLOCKED — VFD path exists (hardware_update_vfd); no serial VFD/second screen on a COM port |
| HW-03 | P2 | Scale integration [if any]: unstable weight, zero, negative, unit g/kg | 27b-lbl-checks.mts | N/A — no scale integration — weighingScale is only a discovered-device type |
| HW-04 | P2 | Hot-plug printer/scanner/drawer during a sale | 27b-lbl-checks.mts | BLOCKED — no device-attach listener (hotplug hits=0); needs USB printer/scanner/drawer on the bench  |
| HW-05 | P2 | Touch vs mouse vs keyboard-only operation; high-DPI; window resize/minimize/multi-monitor | 27b-lbl-hw.e2e.ts | PASS-PARTIAL |
| HW-06 | P2 | Android USB-OTG/Bluetooth receipt and label printers; paired-device list changes | 27b-lbl-checks.mts | BLOCKED — mobilePrinter BT/Wi-Fi code exists; needs Android + bonded BT/OTG printer (emulator has no |
| HW-07 | P2 | Phone camera as barcode scanner vs dedicated scanner: speed, double reads, torch, permissi | 27b-lbl-checks.mts | BLOCKED — MobileCameraScanner exists; needs a phone camera + real barcodes (emulator camera is synth |
| HW-08 | P2 | Physical cash drawer attached to the desktop only; mobile asks the desktop to kick | 27b-lbl-checks.mts | N/A — no cross-device drawer request channel |

## I18 (15)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| I18-01 | P1 | Switch ar↔fr↔en mid-sale, mid-payment, mid-ticket | 27c-i18-ui.e2e.ts | FAIL |
| I18-02 | P1 | RTL layout: cart, dialogs, tables, numeric columns, icons, scroll bars, tooltips | 27c-i18-ui.e2e.ts | PASS |
| I18-03 | P1 | Mixed-direction strings (Arabic name + Latin model "iPhone 15 Pro" + digits) display/print | 27c-i18-ui.e2e.ts | FAIL |
| I18-04 | P1 | Search: Arabic with/without diacritics, hamza/alef variants (أ/ا/إ), ta marbuta, Latin acc | 27c-i18-checks.mts | FAIL |
| I18-05 | P0 | Numeric input with Arabic-Indic, Persian digits, comma/point, NBSP, RLM/LRM marks, paste | 23-scl-rcp-tim-i18.e2e.ts | PASS |
| I18-06 | P1 | Sorting/collation by language; case-insensitive Latin; Arabic order | 27c-i18-checks.mts | FAIL |
| I18-07 | P1 | Very long strings, emoji, zero-width chars, RTL-override chars in names | 27c-i18-ui.e2e.ts | PASS |
| I18-08 | P1 | CSV/Excel export & import round-trip in each language (BOM/encoding, separators ; vs ,) | 27c-i18-checks.mts | FAIL |
| I18-09 | P1 | Keyboard layouts (AZERTY/Arabic) with scanner "keyboard wedge" input | 27c-i18-ui.e2e.ts | FAIL |
| I18-10 | P1 | Translations complete: no missing keys, no key names visible, no overflow in any language | 27c-i18-ui.e2e.ts | PASS-PARTIAL |
| I18-11 | P1 | Name-variant search: Mohamed/Mohammed/Muhammad/Mhamed/محمد/محمّد, Abdelkader/Abd El Kader/ | 27c-i18-checks.mts | FAIL |
| I18-12 | P1 | Name order and parts: family name first/last, single-name customers, titles, "Ep."/"Vve" | 27c-i18-checks.mts | FAIL |
| I18-13 | P1 | Phone formats: `0555…`, `+213 555…`, `00213…`, `(0)`, landlines `021…`, 9 vs 10 digits, Ar | 27c-i18-ui.e2e.ts | PASS |
| I18-14 | P1 | Mobile keyboards (Arabic/French) with autocorrect, suggestions, composition, voice input | 27c-i18-checks.mts | BLOCKED — needs a real Android soft keyboard (Gboard ar/fr) with a learned dictionary and cloud sugg |
| I18-15 | P1 | Pasting from WhatsApp/Excel (invisible marks, NBSP, line breaks) into IMEI, phone, name, a | 27c-i18-ui.e2e.ts | PASS |

## IDN (22)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| IDN-01 | P0 | PIN login → header shows user → open drawer → sale → receipt | 60-idn-identity.e2e.ts | FAIL |
| IDN-02 | P0 | Two cashiers with the same display name ("Mohamed") | 60-idn-identity.e2e.ts | FAIL |
| IDN-03 | P0 | Cashier renamed after sales | 60-idn-identity.e2e.ts | FAIL |
| IDN-04 | P0 | Cashier disabled/deleted after sales | 60-idn-identity.e2e.ts | FAIL |
| IDN-05 | P0 | PIN uniqueness: creating a PIN already used by another user | 60-idn-identity.e2e.ts | PASS |
| IDN-06 | P0 | A logs out and B logs in with a cart open; or B takes over A's cart | 60-idn-identity.e2e.ts | FAIL |
| IDN-07 | P1 | Cashier names in Arabic, French, mixed, very long, diacritics, emoji, RTL marks on 58 mm a | 60-idn-identity.e2e.ts | FAIL |
| IDN-08 | P0 | Reprint by another cashier; refund receipt; exchange | 60-idn-identity.e2e.ts | FAIL |
| IDN-09 | P0 | Manager step-up approves a cashier's refund/discount | 60-idn-identity.e2e.ts | FAIL |
| IDN-10 | P0 | Auto-lock then a different PIN is typed | 60-idn-identity.e2e.ts | FAIL |
| IDN-11 | P0 | Wrong PIN ×N on desktop then immediately on mobile | 60-idn-identity.e2e.ts | FAIL |
| IDN-12 | P0 | PIN changed or user disabled on desktop; mobile (online and offline) | 60-idn-identity.e2e.ts | FAIL |
| IDN-13 | P0 | PIN storage on mobile | 60-idn-identity.e2e.ts | PASS |
| IDN-14 | P0 | Who may open/close/force-close/hand over a drawer, per role | 60-idn-identity.e2e.ts | FAIL |
| IDN-15 | P0 | Same cashier on desktop and mobile | 60-idn-identity.e2e.ts | FAIL |
| IDN-16 | P0 | Client tries to send another `user_id`, `drawer_id` or `device_id` in a request (forged IP | 60-idn-identity.e2e.ts | FAIL |
| IDN-17 | P0 | Sale created offline on mobile by a user disabled meanwhile | 60-idn-identity.e2e.ts | FAIL |
| IDN-18 | P1 | Cashier name on Z-report, handover sheet, trade-in contract, repair slip, warranty certifi | 60-idn-identity.e2e.ts | FAIL |
| IDN-19 | P0 | Commission/targets/refund counts per cashier; refund attributed to original seller vs proc | 60-idn-identity.e2e.ts | PASS |
| IDN-20 | P0 | Switch user fast (A → B → A) 50 times with sales in between | 60-idn-identity.e2e.ts | FAIL |
| IDN-21 | P0 | Session on a device removed from the shop (revoked) | 60-idn-identity.e2e.ts | FAIL |
| IDN-22 | P1 | Display-name edge cases: leading/trailing spaces, duplicate after trim, name with only RTL | 60-idn-identity.e2e.ts | FAIL |

## INV (17)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| INV-01 | P0 | Concurrent sale of last unit on two terminals | 82-inv-inventory.e2e.ts | PASS |
| INV-02 | P1 | Stock adjustment (count) vs in-flight sales | 82-inv-inventory.e2e.ts | PASS |
| INV-03 | P0 | Purchase receipt: cost change, average-cost recalculation, partial receipt, supplier retur | 82-inv-inventory.e2e.ts | FAIL |
| INV-04 | P1 | Transfer between locations/shops [if exists]: in-transit state, receive partial | 82-inv-inventory.e2e.ts | PASS |
| INV-05 | P1 | Decimal-quantity items (weight, meters, liters) unit conversion (box ↔ pieces) | 82-inv-inventory.e2e.ts | PASS |
| INV-06 | P1 | Phone variants (color/storage) each with own barcode/IMEI; duplicates | 82-inv-inventory.e2e.ts | FAIL |
| INV-07 | P0 | Serial item lifecycle state machine: purchased → in stock → sold → returned → refurbished  | 82-inv-inventory.e2e.ts | PASS |
| INV-08 | P1 | Negative stock after refund-then-resale sequence | 82-inv-inventory.e2e.ts | PASS |
| INV-09 | P1 | Reorder alerts/low-stock notifications | 82-inv-inventory.e2e.ts | PASS |
| INV-10 | P1 | Product merge / barcode reassign | 82-inv-inventory.e2e.ts | PASS |
| INV-11 | P1 | Expiry/batch items [if relevant] FEFO | 82-inv-inventory.e2e.ts | PASS |
| INV-12 | P1 | Importing 10,000 products (CSV): bad rows, duplicates, Arabic names, price formats | 82-inv-inventory.e2e.ts | PASS |
| INV-13 | P0 | Receiving 500 phones from a supplier: scan IMEIs vs supplier file; missing, duplicate, ext | 82-inv-inventory.e2e.ts | FAIL |
| INV-14 | P0 | IMEI stocktake by mobile scanning (offline, 2,000 units, two counters at once) | 82-inv-inventory.e2e.ts | PASS |
| INV-15 | P1 | Reservation/hold of a phone for a customer (with deposit), expiry | 82-inv-inventory.e2e.ts | PASS |
| INV-16 | P0 | Phone moved between sales floor, repair bench, supplier RMA, other shop | 82-inv-inventory.e2e.ts | PASS |
| INV-17 | P0 | Same repair ticket's parts edited from two devices (double-decrement risk) | 82-inv-inventory.e2e.ts | FAIL |

## LBL (13)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| LBL-01 | P1 | EAN-13 generation: check digit correct for every internal code; round-trip scan | 27b-lbl-checks.mts | PASS |
| LBL-02 | P1 | Code128/QR/DataMatrix for IMEI/serial/ticket numbers; very long values | 27b-lbl-checks.mts | FAIL |
| LBL-03 | P1 | Label size/gap/offset calibration; different label rolls; printer dpi (203/300) | 27b-lbl-checks.mts | BLOCKED — needs label printer + >=2 label rolls; GAP hardcoded "2 mm, 0 mm", no dpi/offset calibrati |
| LBL-04 | P1 | Price on label = DB price at print time; price changed afterwards → reprint prompt; label  | 27b-lbl-checks.mts | FAIL |
| LBL-05 | P1 | Batch print 1, 50, 500 labels; copies > 1; abort midway; printer error mid-batch | 27b-lbl-checks.mts | FAIL |
| LBL-06 | P1 | Long Arabic/French product names, mixed scripts, diacritics | 27b-lbl-checks.mts | FAIL |
| LBL-07 | P1 | Variable-weight barcodes (price- or weight-embedded EAN) [if used] | 27b-lbl-checks.mts | N/A — conditional [if used]; no variable-weight/embedded-price barcode support |
| LBL-08 | P1 | Duplicate barcodes across products / reused after product deletion | 27b-lbl-checks.mts | FAIL |
| LBL-09 | P1 | Repair ticket label stuck on device: ticket no., IMEI barcode, date, name | 27b-lbl-checks.mts | FAIL |
| LBL-10 | P1 | Label template editor [if any]: missing field, huge font, empty template | 27b-lbl-checks.mts | N/A — conditional [if any]; no label-template editor — layout fixed in productLabelBuilder |
| LBL-11 | P1 | Printing labels while a sale is in progress | 27b-lbl-hw.e2e.ts | PASS-PARTIAL |
| LBL-12 | P1 | Shelf/price label for phones with IMEI last digits and warranty type | 27b-lbl-checks.mts | FAIL |
| LBL-13 | P1 | Label job sent from mobile to the desktop's label printer | 27b-lbl-checks.mts | FAIL |

## LOY (20)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| LOY-01 | P1 | Earn points at tier boundaries (amount just below/at/above step), rounding of fractional p | 75-loy-loyalty.e2e.ts | PASS |
| LOY-02 | P1 | Points on discounted amount vs gross; on tips/fees or not | 75-loy-loyalty.e2e.ts | FAIL |
| LOY-03 | P1 (cond. P0) | Redeem points: exact balance, balance+1, more than order total, partial | 75-loy-loyalty.e2e.ts | PASS |
| LOY-04 | P1 (cond. P0) | Redeem + refund: full, partial, multi-quantity partial | 75-loy-loyalty.e2e.ts | PASS |
| LOY-05 | P1 (cond. P0) | Refund of a sale whose earned points were already spent | — | FAIL |
| LOY-06 | P1 (cond. P0) | Campaign multiplier (x2/x3) sale then refund | 75-loy-loyalty.e2e.ts | PASS |
| LOY-07 | P1 | Points expiry at boundary (day before/at/after) and timezone | 75-loy-loyalty.e2e.ts | FAIL |
| LOY-08 | P1 | Tier upgrade/downgrade after refund drops spend below threshold | 75-loy-loyalty.e2e.ts | FAIL |
| LOY-09 | P1 | Customer merge/duplicate phone numbers/typo phone | — | N/A — Feature not implemented - no customer-account merge or points-transfer lane. Customer sync |
| LOY-10 | P1 | Anonymous sale later attached to customer (retroactive points) | — | N/A — Feature not implemented - points are awarded only during checkout for the attached current |
| LOY-11 | P1 (cond. P0) | Same loyalty balance used on two devices offline then sync | — | BLOCKED — needs a second enrolled terminal (or a native peer-writer hook) sharing the same merchant  |
| LOY-12 | P1 (cond. P0) | Points transfer/adjust by manager | 75-loy-loyalty.e2e.ts | FAIL |
| LOY-13 | P1 | Loyalty disabled/enabled mid-day; program rule change | 75-loy-loyalty.e2e.ts | FAIL |
| LOY-14 | P1 | Redeemed points + coupon + discount together producing total < 0 or 0 | 75-loy-loyalty.e2e.ts | FAIL |
| LOY-15 | P1 | Points display vs stored (fractions) in ar/fr/en | — | N/A — Feature not implemented - points are integer-only at every boundary. Earn, redeem, adjust, |
| LOY-16 | P1 | Loyalty balance seen on mobile vs desktop right after a sale/redeem on the other device | 75-loy-loyalty.e2e.ts | FAIL |
| LOY-17 | P1 | Points on warranty/free repair tickets and zero-revenue lines | — | N/A — Feature not implemented - repair/SAV tickets do not accrue or redeem loyalty points. The r |
| LOY-18 | P1 | Customer merge with points, tiers and different expiry dates on both | — | N/A — Feature not implemented - no loyalty-account merge or household consolidation. Same absenc |
| LOY-19 | P1 | Campaign starts/ends at midnight; sale started before the boundary and paid after | 75-loy-loyalty.e2e.ts | FAIL |
| LOY-20 | P1 | Customer lookup for loyalty by phone/QR at 1 M customers | 75-loy-loyalty.e2e.ts | PASS |

## MNY (23)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| MNY-01 | P0 | Price 0.01 DA, qty 1; 0.01 DA with a 10 % discount | 10-mny-money.e2e.ts | PASS |
| MNY-02 | P0 | Rounding boundaries: x.005, x.015, x.025, x.035… (half-up vs half-even per rule) | 10-mny-money.e2e.ts | PASS |
| MNY-03 | P0 | 3 × 33.33, 7 × 14.29, 0.1+0.2 style sums | 10-mny-money.e2e.ts | PASS |
| MNY-04 | P0 | Per-line vs per-invoice rounding on a 20-line basket with mixed percentage discounts | 10-mny-money.e2e.ts | PASS |
| MNY-05 | P0 | Weight item: qty 0.333 kg, 12.345 kg, 0.001 kg | 10-mny-money.e2e.ts | PASS |
| MNY-06 | P0 | Max values: unit 999,999,999.99; qty 99,999; line total near i64/DB limits | 10-mny-money.e2e.ts | PASS |
| MNY-07 | P0 | Zero-priced line (free gift) and negative line (return in same basket) | 10-mny-money.e2e.ts | PASS |
| MNY-11 | P0 | Cash rounding (if exists, e.g. to 5/10 DA) on cash only | — | N/A — Feature not implemented — no cash rounding / rounding-adjustment feature (change is exact  |
| MNY-16 | P0 | Currency formatting in fr/ar/en (space/NBSP/comma/point/Arabic-Indic digits, "DA"/"د.ج") | 10-mny-money.e2e.ts | PASS |
| MNY-17 | P0 | Entering price with 3 decimals, comma, trailing spaces, pasted "1 234,50", letters | 10-mny-money.e2e.ts | PASS |
| MNY-18 | P0 | Percentage with decimals (33.333%) and basis-point precision | 10-mny-money.e2e.ts | PASS |
| MNY-19 | P0 | Σ of line totals vs invoice total vs payment total vs report total on 10,000 random basket | 11-mny-money-part2.e2e.ts | PASS |
| MNY-20 | P0 | Daily Z totals summed over a month vs monthly report | 11-mny-money-part2.e2e.ts | PASS |
| MNY-21 | P0 | Display of negative amounts (refunds) in all 3 languages and on receipts | 11-mny-money-part2.e2e.ts | PASS |
| MNY-22 | P0 | Margin/profit calc: cost price with 4 decimals × qty, average cost updates | 10-mny-money.e2e.ts | PASS |
| MNY-23 | P0 | Price history: price changed while item is in an open cart / parked sale | 10-mny-money.e2e.ts | PASS |
| MNY-24 | P0 | Multi-currency/foreign cash (if supported): EUR/USD rate change mid-day | — | N/A — Feature not implemented — single-currency (DZD) app: no foreign-currency tender, no exchan |
| MNY-25 | P0 | Sale on instalments / تقسيط [if exists]: schedule rounding, last instalment takes the rema | 11-mny-money-part2.e2e.ts | PASS |
| MNY-26 | P0 | Everything at once: promo price + line discount + coupon + loyalty redemption + trade-in c | 11-mny-money-part2.e2e.ts | PASS |
| MNY-27 | P0 | Sale below cost / negative margin (e.g. 100 DA typed instead of 100,000 DA) | 10-mny-money.e2e.ts | PASS |
| MNY-28 | P0 | Amount in words on the invoice ("arrêtée la présente facture à la somme de …" / المبلغ بال | — | N/A — Feature not implemented — amount-in-words absent (receipt view model carries numeric amoun |
| MNY-29 | P0 | Fat-finger magnitude: price or payment typed 100× or 1000× too large/small (misplaced sepa | 10-mny-money.e2e.ts | PASS |
| MNY-30 | P0 | Pack/bundle pricing where unit price × qty does not divide evenly | 11-mny-money-part2.e2e.ts | PASS |

## MOB (25)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| MOB-01 | P0 | Same 10,000 random baskets computed by the desktop build and the mobile build | mobile/25-mob-mobile.mjs | BLOCKED — DEP: mobile baseline not in repo, rebuild from a device (see COVERAGE.md). BLOCKED - one U |
| MOB-02 | P0 | App sent to background mid-sale, mid-payment, mid-print; return after 1 s / 5 min / 2 h | mobile/25-mob-mobile.mjs | PASS-PARTIAL |
| MOB-03 | P0 | OS kills the app (low memory, "don't keep activities", swipe-away) at random points | mobile/25-mob-mobile.mjs | FAIL |
| MOB-04 | P0 | Doze, battery saver, OEM background killers (Xiaomi/Huawei/Samsung "sleeping apps"), no Go | mobile/25-mob-mobile.mjs | PASS-PARTIAL |
| MOB-05 | P0 | Network changes: Wi-Fi ↔ 4G ↔ none, captive portal, VPN, IPv6-only, shop router reboot; th | mobile/25-mob-mobile.mjs | PASS-PARTIAL |
| MOB-06 | P0 | How the phone learns about changes: WebSocket, SSE, FCM push, polling | mobile/25-mob-mobile.mjs | PASS |
| MOB-07 | P0 | User changes phone clock/timezone, disables automatic time, roams/VPN | mobile/25-mob-mobile.mjs | FAIL |
| MOB-08 | P0 | Phone storage full / photo storage full / DB write fails | mobile/25-mob-mobile.mjs | FAIL |
| MOB-09 | P0 | App update gap (desktop newer than mobile), forced-update gate; uninstall/reinstall; Andro | mobile/25-mob-mobile.mjs | FAIL |
| MOB-10 | P0 | Lost/stolen phone | mobile/25-mob-mobile.mjs | FAIL |
| MOB-11 | P1 | Layout: orientation change mid-entry, soft keyboard covering totals/pay button, font scale | mobile/25-mob-mobile.mjs | FAIL |
| MOB-12 | P1 | Camera scanning: IMEI barcode on box (several codes: IMEI1, IMEI2, serial, EID), EAN-13, Q | mobile/25-mob-mobile.mjs | PASS-PARTIAL |
| MOB-13 | P0 | Bluetooth printer: pairing lost, several paired, Android 12+ Bluetooth permissions, print  | mobile/25-mob-mobile.mjs | BLOCKED — DEP: mobile baseline not in repo, rebuild from a device (see COVERAGE.md). BLOCKED - bluet |
| MOB-14 | P0 | Outbox: 5,000 unsynced items, ordering, idempotency keys, app update/kill during upload | mobile/25-mob-mobile.mjs | PASS-PARTIAL |
| MOB-15 | P0 | Desktop changes data the mobile is currently showing: product price, customer name, stock, | mobile/25-mob-mobile.mjs | BLOCKED — DEP: mobile baseline not in repo, rebuild from a device (see COVERAGE.md). BLOCKED - gatew |
| MOB-16 | P0 | Concurrent writes: UI save + background sync worker + push handler hit the DB | mobile/25-mob-mobile.mjs | PASS |
| MOB-17 | P1 | Session on phone: remember login, auto-lock, biometric/PIN re-entry, screenshots/screen re | mobile/25-mob-mobile.mjs | FAIL |
| MOB-18 | P1 | 8-hour shift on a mid-range phone: memory, WebSocket keep-alive, wakelocks, battery drain, | mobile/25-mob-mobile.mjs | BLOCKED — DEP: mobile baseline not in repo, rebuild from a device (see COVERAGE.md). BLOCKED - needs |
| MOB-19 | P1 | Mobile data use: first sync, photo uploads, metered connection | mobile/25-mob-mobile.mjs | BLOCKED — DEP: mobile baseline not in repo, rebuild from a device (see COVERAGE.md). BLOCKED - uid=1 |
| MOB-20 | P0 | Offline receipt/ticket/inspection numbers on mobile | mobile/25-mob-mobile.mjs | FAIL |
| MOB-21 | P1 | Low-end device (2 GB RAM, Android Go) with 100 k+ customers/products | mobile/25-mob-mobile.mjs | FAIL |
| MOB-22 | P1 | Permissions denied (camera, Bluetooth, notifications, storage): each independently | mobile/25-mob-mobile.mjs | PASS |
| MOB-23 | P1 | Hardware scanner paired to the phone (BT HID keyboard wedge) vs on-screen keyboard (IME) | mobile/25-mob-mobile.mjs | FAIL |
| MOB-24 | P0 | Install/upgrade path: fresh install, upgrade over old version with unsynced data, schema m | mobile/25-mob-mobile.mjs | PASS-PARTIAL |
| MOB-25 | P1 | iOS (if shipped): background limits (no long background tasks), push permission, Keychain, | mobile/25-mob-mobile.mjs | N/A — DEP: mobile baseline not in repo, rebuild from a device (see COVERAGE.md). N/A - absence p |

## PAY (22)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| PAY-01 | P0 | Cash exact / over (change) / under (blocked or partial per rule) | 20-pay-payments.e2e.ts | PASS |
| PAY-02 | P0 | Tendered with Arabic-Indic digits/comma decimals/very large (1e9) | 20-pay-payments.e2e.ts | PASS |
| PAY-03 | P0 | Split tender: cash+card, card+card, card+store credit, 3-way | 20-pay-payments.e2e.ts | PASS |
| PAY-04 | P0 | Overpay by card (card amount > due) | 20-pay-payments.e2e.ts | PASS |
| PAY-05 | P0 | Gateway approve / decline / timeout / error / duplicate callback / late callback after can | — | N/A — Feature not implemented — no payment-gateway integration exists. Card/BaridiMob/Chèque ten |
| PAY-06 | P0 | App killed after gateway approval but before DB commit | — | N/A — Feature not implemented — presupposes a gateway approval step ('killed after gateway appro |
| PAY-07 | P0 | Pay pressed twice / Enter held / double-tap on touch | 20-pay-payments.e2e.ts | PASS |
| PAY-08 | P0 | Payment while offline for tenders needing network | 20-pay-payments.e2e.ts | PASS |
| PAY-09 | P0 | Deposit/advance payment then final payment on same document | 34-ref-refunds-part5.e2e.ts | PASS |
| PAY-10 | P0 | Credit sale ("dette"/client account) [if exists]: limit exceeded, partial repayment, overp | 20-pay-payments.e2e.ts | PASS |
| PAY-11 | P0 | Store credit / gift card: partial use, expiry, refund to store credit, negative balance at | 20-pay-payments.e2e.ts | PASS |
| PAY-12 | P0 | Cheque/bank transfer tender [if exists]: unpaid cheque reversal | 20-pay-payments.e2e.ts | PASS |
| PAY-13 | P0 | Tip/service fee [if exists] | — | N/A — Feature not implemented — no tip / service-fee tender: no tip field in the payment modal,  |
| PAY-14 | P0 | Payment method disabled mid-day / terminal config changed during open cart | — | N/A — Feature not implemented — payment methods are a static, always-enabled tab list; there is  |
| PAY-15 | P0 | Currency/amount sent to gateway in wrong unit (centimes vs DA ×100 error) | — | N/A — Feature not implemented — no gateway, therefore no currency/amount unit is ever 'sent' to  |
| PAY-16 | P0 | Manual card entry/"approval code" typed by cashier [if exists] | 20-pay-payments.e2e.ts | PASS |
| PAY-17 | P0 | Terminal/gateway payment started on mobile; network switch or backgrounding before approva | — | N/A — Feature not implemented — no terminal/gateway payment can be started from the mobile compa |
| PAY-18 | P0 | Receipt printed or sent before payment is confirmed, then payment fails | 20-pay-payments.e2e.ts | PASS |
| PAY-19 | P0 | Cashier chose the wrong tender (card instead of cash) and wants to correct it | 20-pay-payments.e2e.ts | PASS |
| PAY-20 | P0 | Quick-cash buttons (1,000 / 2,000 / 5,000 DA) and "exact" button pressed, then a discount  | 20-pay-payments.e2e.ts | PASS |
| PAY-21 | P0 | Payment taken while the drawer is closed, belongs to another cashier, or does not exist | 20-pay-payments.e2e.ts | PASS |
| PAY-22 | P0 | Trade-in value used as one tender among cash/card in the same sale | 33-ref-refunds-part4.e2e.ts | PASS |

## PRF (6)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| PRF-01 | P2 | Add-to-cart latency with 100k products; search-as-you-type | 27e-prf-checks.mts | FAIL |
| PRF-02 | P2 | 8-hour and 72-hour sessions: memory, handles, WebView leaks, DB size, log size | 27e-prf-checks.mts | BLOCKED — an 8-hour and a 72-hour session need 72 h of wall clock plus handle/memory sampling of the |
| PRF-03 | P2 | Low-spec machine (2 GB RAM / old CPU) with throttling | 27e-prf-checks.mts | BLOCKED — no 2 GB / old-CPU machine exists here: the host is a Ryzen 5 8500G with 15.1 GiB RAM (12 c |
| PRF-04 | P2 | Low-end phone: 100 k customers scrolling, search and photo capture together | 27e-prf-checks.mts | BLOCKED — no low-end Android device is attached and the mobile shell is only reachable as a WebView  |
| PRF-05 | P1 | Startup/restore time with 1 M customers on desktop and on mobile | 27e-prf-checks.mts | FAIL |
| PRF-06 | P1 | Sync of 1 M customer changes and of 5,000 sales at once on mobile data | 27e-prf-checks.mts | BLOCKED — syncing 1 M customer changes plus 5 000 sales on mobile data needs a configured merchant g |

## RCP (24)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| RCP-01 | P1 | Arabic-only, French-only, mixed Arabic+French+numbers on one line, in ESC/POS text mode vs | 26-rcp-tim.e2e.ts | PASS |
| RCP-02 | P1 | Paper widths 58 mm / 80 mm (32/42/48 chars) with long product names, long Arabic names, 30 | 26-rcp-tim.e2e.ts | PASS |
| RCP-03 | P1 | Receipt with 1, 7, 50, 200 lines; very long receipt | 26-rcp-tim.e2e.ts | PASS |
| RCP-04 | P0 | Required content present: shop identity, document number, date/time, cashier, payment line | 23-scl-rcp-tim-i18.e2e.ts | PASS |
| RCP-05 | P1 | Reprint: marked as copy; same number; no new sale | 26-rcp-tim.e2e.ts | FAIL |
| RCP-06 | P0 | Printer offline / paper out / cover open / buffer full mid-receipt | 23-scl-rcp-tim-i18.e2e.ts | PASS |
| RCP-07 | P1 | Print queue: 20 receipts rapidly; app closed with jobs pending; printer reconnect | 26-rcp-tim.e2e.ts | FAIL |
| RCP-08 | P1 | Print call blocks UI (hung USB/Bluetooth/network printer) | 26-rcp-tim.e2e.ts | PASS-PARTIAL |
| RCP-09 | P1 | Two printers (receipt + label + A4 invoice): wrong printer routing, printer renamed/remove | 26-rcp-tim.e2e.ts | PASS |
| RCP-10 | P1 | Cash drawer kick pulse on cash sale, not on card-only; kick on "no sale" requires permissi | 26-rcp-tim.e2e.ts | FAIL |
| RCP-11 | P1 | QR code/barcode on receipt (document number) scannable; fits width | 26-rcp-tim.e2e.ts | FAIL |
| RCP-12 | P1 | Logo/header image, footers, promo text in ar/fr; special characters (œ, é, ç, ً diacritics | 26-rcp-tim.e2e.ts | FAIL |
| RCP-13 | P1 | Amount formats on paper: negative amounts, thousands separators, Arabic-Indic vs Latin dig | 26-rcp-tim.e2e.ts | PASS |
| RCP-14 | P1 | A4/PDF invoice (if exists): page breaks with 100+ lines, totals on last page, RTL layout,  | 26-rcp-tim.e2e.ts | N/A — N/A: A4 document components=["src\\components\\modals\\CommandTicketDashboardModal.tsx:33" |
| RCP-15 | P1 | Gift receipt (no prices), refund receipt, trade-in contract, repair intake slip, Z-report, | 26-rcp-tim.e2e.ts | FAIL |
| RCP-16 | P1 | Date/time on paper vs DST/timezone/clock changes | 26-rcp-tim.e2e.ts | FAIL |
| RCP-17 | P1 | Printing from a second language than UI language (customer wants French receipt on Arabic  | 26-rcp-tim.e2e.ts | N/A — N/A: uiLocaleForcedToArabic=false receiptLanguageSettingHits=0 receiptStillFrench=true har |
| RCP-18 | P1 | Receipt header shows cashier name, drawer/register, device, reprint marker | 26-rcp-tim.e2e.ts | FAIL |
| RCP-19 | P1 | Same sale printed from desktop (USB) and from mobile (Bluetooth) | 26-rcp-tim.e2e.ts | BLOCKED — BLOCKED: needs a Bluetooth ESC/POS printer. The Android half is no longer blocked - first- |
| RCP-20 | P0 | Receipt number assigned before print vs after commit; print fails | 23-scl-rcp-tim-i18.e2e.ts | PASS |
| RCP-21 | P1 | Mixed-direction header line: "Caissier: محمد" and "الكاشير: Mohamed" in each receipt langu | 26-rcp-tim.e2e.ts | PASS |
| RCP-22 | P1 | IMEI/serial lines: 15–16 digits + barcode on 58 mm; two IMEIs; long serials | 26-rcp-tim.e2e.ts | FAIL |
| RCP-23 | P1 | Warranty terms footer variants (new / refurbished / as-is / extended) in ar and fr | 26-rcp-tim.e2e.ts | FAIL |
| RCP-24 | P1 | Remote print jobs: mobile finalizes a sale, desktop prints it (or the reverse) | 26-rcp-tim.e2e.ts | BLOCKED — BLOCKED: BLOCKED: needs a second enrolled terminal (or a healthy Android build) plus the d |

## REF (90)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| REF-01 | P0 | Full refund, same tender | 30-ref-refunds.e2e.ts | PASS |
| REF-02 | P0 | Partial refund by line, by qty, then second and third partial until fully refunded | 30-ref-refunds.e2e.ts | PASS |
| REF-03 | P0 | Refund line that had a share of invoice-level discount | 30-ref-refunds.e2e.ts | PASS |
| REF-05 | P0 | Refund > paid / cumulative refunds > paid / refund of an already-refunded line | 30-ref-refunds.e2e.ts | PASS |
| REF-06 | P0 | Refund when original paid by card/BaridiMob | 30-ref-refunds.e2e.ts | PASS |
| REF-07 | P0 | Cash refund when drawer lacks cash | 31-ref-refunds-part2.e2e.ts | PASS |
| REF-08 | P0 | Refund after shift closed / next day / next month / after Z printed | 31-ref-refunds-part2.e2e.ts | PASS |
| REF-09 | P0 | Refund with receipt missing (lookup by customer/phone/amount) | 31-ref-refunds-part2.e2e.ts | PASS |
| REF-10 | P0 | Refund of serial/IMEI item | 31-ref-refunds-part2.e2e.ts | PASS |
| REF-11 | P0 | Refund of item whose stock was already adjusted/sold again | 30-ref-refunds.e2e.ts | PASS |
| REF-12 | P0 | Exchange (return A, buy B) with price difference both directions | 31-ref-refunds-part2.e2e.ts | PASS |
| REF-13 | P0 | Void vs refund (same day pre-close) | 31-ref-refunds-part2.e2e.ts | PASS |
| REF-14 | P0 | Refund concurrency: two cashiers/devices refund same sale simultaneously | 31-ref-refunds-part2.e2e.ts | PASS |
| REF-15 | P0 | Refund with loyalty points redeemed in original sale | 32-ref-refunds-part3.e2e.ts | PASS |
| REF-16 | P0 | Refund of a cash-rounding adjustment [if cash rounding exists] | — | N/A — N/A — conditional case (cash rounding does not exist): same absence as MNY-11. Refund math |
| REF-17 | P0 | Refund approval step-up PIN, wrong PIN, PIN lockout | 30-ref-refunds.e2e.ts | PASS |
| REF-18 | P1 | Refund receipt printed twice / reprint | 31-ref-refunds-part2.e2e.ts | PASS |
| REF-19 | P1 | Refund reasons required; "other" free-text with Arabic/emoji/very long | 30-ref-refunds.e2e.ts | PASS |
| REF-20 | P0 | Goodwill flat refund not tied to a line | — | N/A — Feature not implemented — goodwill/flat refunds not tied to a line do not exist: the nativ |
| REF-21 | P0 | Refund/return of a phone with an open or approved warranty claim | 34-ref-refunds-part5.e2e.ts | PASS |
| REF-22 | P0 | Return of a phone whose IMEI differs from the one sold | 33-ref-refunds-part4.e2e.ts | PASS |
| REF-23 | P0 | Refund by a different cashier than the seller, or by a cashier whose drawer is closed/none | 33-ref-refunds-part4.e2e.ts | PASS |
| REF-24 | P0 | Refund velocity: many small refunds, refunds just under the step-up threshold | 33-ref-refunds-part4.e2e.ts | PASS |
| REF-25 | P0 | Return window by product class (sealed phone, opened phone, accessory, refurbished); day b | — | N/A — Feature not implemented — no return window by product class: zero occurrences of return-wi |
| REF-26 | P0 | Refund started on mobile while desktop closes the drawer; cash refund with no cash in this | 34-ref-refunds-part5.e2e.ts | PASS |
| REF-27 | P0 | Original sale paid by several tenders (cash + card + store credit); refund of one line or  | 30-ref-refunds.e2e.ts | PASS |
| REF-28 | P0 | Refund of a sale that used line discount + invoice discount + coupon + loyalty redemption  | 31-ref-refunds-part2.e2e.ts | PASS |
| REF-29 | P0 | Refund of a sale that was paid partly by earlier deposit/advance (repair deposit, reservat | 34-ref-refunds-part5.e2e.ts | PASS |
| REF-30 | P0 | Cash sale where the customer handed more than due and received change | 30-ref-refunds.e2e.ts | PASS |
| REF-31 | P0 | Fractional quantities (0.333 kg, meters) refunded in parts | — | N/A — Feature not implemented — sale quantities are integer-only: the cart quantity field reject |
| REF-32 | P0 | Refund quantity input: 0, negative, decimal on an integer item, more than remaining after  | 32-ref-refunds-part3.e2e.ts | PASS |
| REF-33 | P0 | Refund of one item from a buy-X-get-Y / bundle promotion | 32-ref-refunds-part3.e2e.ts | PASS |
| REF-34 | P0 | Refund of an item sold with a manual price override or a price below catalog | 31-ref-refunds-part2.e2e.ts | PASS |
| REF-35 | P0 | Refund of a free-gift / zero-price line, or a line fully covered by points | 33-ref-refunds-part4.e2e.ts | PASS |
| REF-36 | P0 | Returned item goes back to sellable stock vs defective/write-off vs supplier RMA | 31-ref-refunds-part2.e2e.ts | PASS |
| REF-37 | P0 | Restocking fee / deduction (opened phone, missing accessories, damaged box) | — | N/A — Feature not implemented — no restocking fee / condition deduction: the refund request carr |
| REF-38 | P0 | Refund after the product's cost changed (average cost recalculated since the sale) | 33-ref-refunds-part4.e2e.ts | PASS |
| REF-39 | P0 | Refund after the product was deleted, merged, renamed or its barcode reassigned | 32-ref-refunds-part3.e2e.ts | PASS |
| REF-40 | P0 | Refund after the customer was merged, deleted or anonymized | 33-ref-refunds-part4.e2e.ts | PASS |
| REF-41 | P0 | Refund to store credit: issue, spend part, refund the same sale again, expiry, negative at | 33-ref-refunds-part4.e2e.ts | PASS |
| REF-42 | P0 | Card refund impossible (card expired/closed, terminal offline, refund window passed, gatew | 33-ref-refunds-part4.e2e.ts | PASS |
| REF-43 | P0 | Gateway refund result unknown (timeout, app killed, late callback) | — | N/A — Feature not implemented — no payment gateway, so a gateway refund result cannot be unknown |
| REF-44 | P0 | Order of side effects on a cash refund: drawer kick, printing, gateway call, DB commit | 30-ref-refunds.e2e.ts | PASS |
| REF-45 | P0 | Refund of a sale created on another device that has not synced yet (or made offline on mob | 34-ref-refunds-part5.e2e.ts | PASS |
| REF-46 | P0 | Over-refund attempt through forged IPC/API, a second device, or a stale screen | 31-ref-refunds-part2.e2e.ts | PASS |
| REF-47 | P0 | Same refund request replayed (retry after timeout, double-click, held Enter) vs a *new* re | 30-ref-refunds.e2e.ts | PASS |
| REF-48 | P0 | Void or refund right after the receipt was printed and the customer left; card already cap | 33-ref-refunds-part4.e2e.ts | PASS |
| REF-49 | P0 | Refund of a sale that included a trade-in credit | 32-ref-refunds-part3.e2e.ts | PASS |
| REF-50 | P0 | Refund of a repair invoice (labor + parts), with deposit and used parts | 34-ref-refunds-part5.e2e.ts | PASS |
| REF-51 | P0 | Cashier refund limits: per refund, per shift cumulative, just under the step-up threshold  | 33-ref-refunds-part4.e2e.ts | PASS |
| REF-52 | P0 | Device clock wrong when refunding (before the original sale time, in a closed period, far  | 33-ref-refunds-part4.e2e.ts | PASS |
| REF-53 | P0 | Extreme amounts: 0.01 DA refund, 999,999,999.99 DA refund, 10,000 partial refunds of 0.01  | 33-ref-refunds-part4.e2e.ts | PASS |
| REF-54 | P0 | Refund of a sale whose total was 0 (fully discounted/points/free repair) | 32-ref-refunds-part3.e2e.ts | PASS |
| REF-55 | P0 | Return into a stock location that was removed/closed, or of an inactive/archived product | — | N/A — N/A — the branch 'stock location removed/closed' is structurally impossible in this single |
| REF-56 | P1 | Refund reporting: by day, cashier, tender, reason, product; refund of a previous-period sa | 33-ref-refunds-part4.e2e.ts | PASS |
| REF-57 | P0 | Finding the sale to refund (at 5 M sales): receipt number with typo/transposed digits, Ara | 32-ref-refunds-part3.e2e.ts | PASS |
| REF-58 | P0 | Two refund screens open for the same sale (two tabs/devices), one completes first | 33-ref-refunds-part4.e2e.ts | PASS |
| REF-59 | P0 | Mistaken refund needs undoing | — | N/A — Feature not implemented — refunds cannot be undone/reversed: the Reports void pathway expl |
| REF-60 | P0 | Exchange chain: A → B → C, then refund of B or of the whole chain | 33-ref-refunds-part4.e2e.ts | PASS |
| REF-61 | P0 | One IMEI sold, returned, resold, returned again | 32-ref-refunds-part3.e2e.ts | PASS |
| REF-62 | P0 | Refund interrupted by lock, auto-logout, app update restart, language switch or crash whil | 32-ref-refunds-part3.e2e.ts | PASS |
| REF-63 | P0 | Refund of a sale older than the local history window, or moved to the archive | 32-ref-refunds-part3.e2e.ts | PASS |
| REF-64 | P1 | Refund slip content: original receipt number, amounts per tender, reason, cashier (origina | 32-ref-refunds-part3.e2e.ts | PASS |
| REF-65 | P0 | Refund of a credit sale / client-account invoice [if exists] that is unpaid or only part-p | 31-ref-refunds-part2.e2e.ts | PASS |
| REF-66 | P0 | Refund inside an instalment plan [if exists]: after 1 of N instalments, after the last, on | 32-ref-refunds-part3.e2e.ts | PASS |
| REF-67 | P0 | Sale paid by cheque or transfer [if exists]: refund asked before the cheque clears, after  | 34-ref-refunds-part5.e2e.ts | PASS |
| REF-68 | P0 | Gift-card / store-credit product sold, then refunded or partly used (selling the card itse | — | N/A — Feature not implemented — gift-card-as-product does not exist: no gift_cards table anywher |
| REF-69 | P0 | Dispute/chargeback or issuer reversal arrives after the shop already refunded the same sal | — | N/A — Feature not implemented — no card-network/issuer exists, so no chargeback or issuer revers |
| REF-70 | P0 | Multi-shop [if exists]: a sale made in shop A is returned in shop B | — | N/A — Feature not implemented — single-shop installation: no shops/branches/store-locations tabl |
| REF-71 | P0 | Negative-line loophole: a return rung as a negative line inside a *new* sale (MNY-07, REF- | 31-ref-refunds-part2.e2e.ts | PASS |
| REF-72 | P0 | Cash rounding (to 5/10 DA) with several partial refunds on one sale (MNY-11, REF-16) | — | N/A — N/A — conditional case (cash rounding does not exist, same as MNY-11/REF-16): there is no  |
| REF-73 | P1 | Foreign-currency cash [if supported]: refund after the rate changed, partial refunds in th | — | N/A — Feature not implemented — single-currency (DZD) app: no foreign-currency cash, no exchange |
| REF-74 | P0 | Service/digital lines [if exists]: mobile top-up (Flexy/recharge), SIM activation, voucher | 34-ref-refunds-part5.e2e.ts | PASS |
| REF-75 | P0 | Item sold before it became serial/IMEI-tracked (or tracking was switched off later) | 34-ref-refunds-part5.e2e.ts | PASS |
| REF-76 | P1 | Batch/expiry items [if relevant]: return of a perishable or date-limited item | — | N/A — N/A — conditional case ('if relevant': perishable/date-limited items do not exist): stock_ |
| REF-77 | P0 | Return window expired but warranty still valid (or the reverse); customer asks for a refun | 34-ref-refunds-part5.e2e.ts | PASS |
| REF-78 | P0 | Forged, photocopied or altered receipt: amounts or lines edited, valid receipt number with | 34-ref-refunds-part5.e2e.ts | PASS |
| REF-79 | P0 | Gift return: the person returning is not the buyer, or a gift receipt (no prices) is used | 32-ref-refunds-part3.e2e.ts | PASS |
| REF-80 | P0 | Approver unavailable: manager's device offline, approval needed on mobile, approval at the | 34-ref-refunds-part5.e2e.ts | PASS |
| REF-81 | P0 | Acknowledged cash refund lost after a restore, power cut or sync rollback (cash left the d | 34-ref-refunds-part5.e2e.ts | PASS |
| REF-82 | P0 | Credit-note numbering: refunds created on several devices or offline, after a restore, aft | 34-ref-refunds-part5.e2e.ts | PASS |
| REF-83 | P0 | Loyalty rate, campaign, points value or expiry rule changed (or the points already expired | 34-ref-refunds-part5.e2e.ts | PASS |
| REF-84 | P0 | Sale made at a wrong price (100 DA instead of 100,000 DA) and discovered later | 34-ref-refunds-part5.e2e.ts | PASS |
| REF-85 | P1 | Price-drop adjustment / price-match request after the sale | — | N/A — Feature not implemented — no price-drop adjustment / price-match workflow: refunds are str |
| REF-86 | P0 | Order-independence property: a sale with ≤ 8 lines (random qty, discounts, rounding); refu | 32-ref-refunds-part3.e2e.ts | PASS |
| REF-87 | P0 | Overflow in the allocation maths: invoice discount × line amount at maximum values (MNY-06 | 33-ref-refunds-part4.e2e.ts | PASS |
| REF-88 | P0 | Refund guard under SQLite concurrency: read "remaining refundable", then write — two conne | 31-ref-refunds-part2.e2e.ts | PASS |
| REF-89 | P1 | Refund of a very large basket (200 lines; wholesale 5,000 lines) | 34-ref-refunds-part5.e2e.ts | PASS |
| REF-90 | P0 | Refund destination tampering: refund to another card, another BaridiMob account/phone, or  | 33-ref-refunds-part4.e2e.ts | PASS |
| REF-91 | P1 | Serial returner / wardrobing: the same customer (phone, ID) with many refunds or repeated  | 32-ref-refunds-part3.e2e.ts | PASS |

## REP (24)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| REP-01 | P1 | Ticket intake: device, IMEI (validated), accessories, condition checklist, photos, problem | 84-rep-repair.e2e.ts | FAIL |
| REP-02 | P1 | Status machine: allowed vs illegal transitions (e.g. Collected → Diagnosing), skipping sta | 84-rep-repair.e2e.ts | FAIL |
| REP-03 | P0 | Deposit taken at intake; deposit > estimate; deposit then cancel | 84-rep-repair.e2e.ts | PASS |
| REP-04 | P1 | Estimate approved then final cost exceeds estimate by X% | 84-rep-repair.e2e.ts | FAIL |
| REP-05 | P0 | Parts consumed: stock decrement exactly once; part swapped; part returned unused | 84-rep-repair.e2e.ts | PASS |
| REP-06 | P0 | Part out of stock / ordered with deposit / arrives later | 84-rep-repair.e2e.ts | FAIL |
| REP-07 | P0 | Final payment: deposit + remaining by split tender; discount at pickup; unpaid pickup atte | 84-rep-repair.e2e.ts | FAIL |
| REP-08 | P1 | Warranty: starts at "Repaired/Completed"; claim inside/at boundary/after expiry; claim on  | 84-rep-repair.e2e.ts | FAIL |
| REP-09 | P1 | Abandoned device after N days: reminders, storage policy [RULE?] | 84-rep-repair.e2e.ts | PASS |
| REP-10 | P0 | Customer passcode / sensitive data on ticket | 84-rep-repair.e2e.ts | PASS |
| REP-11 | P0 | IMEI changed/unreadable after board swap; device swapped with a different one at pickup | 84-rep-repair.e2e.ts | FAIL |
| REP-12 | P1 | Multi-device ticket; technician reassign; technician commission | 84-rep-repair.e2e.ts | FAIL |
| REP-13 | P0 | Edit ticket after invoice issued | 84-rep-repair.e2e.ts | FAIL |
| REP-14 | P0 | Ticket cancelled after parts used | 84-rep-repair.e2e.ts | FAIL |
| REP-15 | P1 | Repair of a device we sold (warranty vs paid) and of a trade-in stock device (internal job | 84-rep-repair.e2e.ts | FAIL |
| REP-16 | P1 | SMS/WhatsApp status notification [if exists]: duplicate send on retry, wrong number, ar/fr | 84-rep-repair.e2e.ts | FAIL |
| REP-18 | P0 | Unclaimed-cash/forfeited deposit accounting | 84-rep-repair.e2e.ts | PASS |
| REP-19 | P1 | Intake on mobile, work on desktop, pickup on mobile (attachments, deposit, status changes) | 84-rep-repair.e2e.ts | PASS |
| REP-20 | P1 | Customer approval link/SMS code [if exists]: replay, expiry, wrong number, approval after  | 84-rep-repair.e2e.ts | PASS |
| REP-21 | P0 | Pickup by a third party | 84-rep-repair.e2e.ts | FAIL |
| REP-22 | P1 | Data-loss consent / backup-before-repair checkbox and liability text per language | 84-rep-repair.e2e.ts | FAIL |
| REP-23 | P1 | Repair price list per model/part changes mid-ticket | 84-rep-repair.e2e.ts | PASS |
| REP-24 | P1 | Same IMEI returns within N days for the same defect | 84-rep-repair.e2e.ts | FAIL |
| REP-25 | P1 | Scan a ticket QR/barcode on mobile for a ticket of another tenant, an old or cancelled tic | 84-rep-repair.e2e.ts | FAIL |

## RPT (12)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| RPT-01 | P1 | Sales by day/product/cashier/tender/category all sum to the same grand total | 27d-rpt-checks.mts | FAIL |
| RPT-03 | P1 | Profit report with refunds, trade-in cost basis, repair labor/parts, discounts | 27d-rpt-checks.mts | PASS |
| RPT-04 | P1 | Period filter boundaries (23:59:59/00:00:00, timezone, business day) | 27d-rpt-checks.mts | FAIL |
| RPT-05 | P1 | Export (PDF/CSV/XLSX) equals screen; huge export (100k rows) | 27d-rpt-checks.mts | FAIL |
| RPT-06 | P1 | Report while sync in progress / during sales | 27d-rpt-checks.mts | PASS-PARTIAL |
| RPT-07 | P1 | Customer statement (credit account, loyalty, repairs) | 27d-rpt-checks.mts | FAIL |
| RPT-08 | P1 | Dashboard KPIs vs raw ledger | 27d-rpt-checks.mts | PASS |
| RPT-09 | P1 | Sales/refunds per cashier equal the sum of documents bearing that cashier id; rename/merge | 27d-rpt-checks.mts | FAIL |
| RPT-10 | P1 | Drawer-session report: variance by cashier/drawer/device, handovers, force-closes | 27d-rpt-checks.mts | FAIL |
| RPT-11 | P1 | Warranty/inspection report and claim cost vs revenue | 27d-rpt-checks.mts | FAIL |
| RPT-12 | P1 | Same report on desktop and on mobile | 27d-rpt-checks.mts | FAIL |
| RPT-13 | P1 | Customer segments (VIP, inactive, debtors) at 1 M rows | 27d-rpt-checks.mts | FAIL |

## SCL (89)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| SCL-01 | P1 | Search-as-you-type by name and by phone at every fixture size | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-02 | P1 | `LIKE '%abc%'` / contains-search / phone-suffix search ("last 4 digits") | 27a-scl-batch.e2e.ts | FAIL |
| SCL-03 | P1 | Customer list pagination: page 1 vs page 20,000; rows inserted/deleted by another device w | 27a-scl-batch.e2e.ts | FAIL |
| SCL-04 | P1 | Virtualized list: scroll to the end, jump with scrollbar, select a row after fast scroll,  | 27a-scl-batch.e2e.ts | FAIL |
| SCL-05 | P1 | Total count display / "N customers" while typing | 27a-scl-batch.e2e.ts | PASS |
| SCL-06 | P1 | Pathological queries: empty, 1 char (`م`, `a`, `0`), only spaces, `%`, `_`, `'`, `\`, 5,00 | 27a-scl-batch.e2e.ts | FAIL |
| SCL-07 | P0 | Create customer with same phone on two terminals at once at 1 M rows | 23-scl-rcp-tim-i18.e2e.ts | FAIL |
| SCL-08 | P1 | Bulk import 100 k customers (CSV, Arabic, bad rows, duplicates) | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-09 | P1 | Bulk duplicate merge (10 k pairs) | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-10 | P1 | Index health: every hot query has an index; indexes survive each migration; `ANALYZE`/`PRA | 27a-scl-batch.e2e.ts | FAIL |
| SCL-11 | P1 | Customer detail screen for a customer with 5,000 sales / 300 repairs / 2,000 loyalty rows | 27a-scl-batch.e2e.ts | PASS |
| SCL-12 | P0 | Customer picker inside sale / payment / trade-in / repair / warranty dialogs at 1 M rows | 23-scl-scale-customers.e2e.ts | FAIL |
| SCL-13 | P0 | Cold start and warm start with the 1 M DB; low-spec PC | 23-scl-scale-customers.e2e.ts | FAIL |
| SCL-14 | P0 | Long read (customer export, big report) while sales are committed | 23-scl-rcp-tim-i18.e2e.ts | FAIL |
| SCL-15 | P1 | DB growth: file size, free pages, `VACUUM`/auto-vacuum, page cache; backup/restore time at | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-16 | P1 | New device bootstrap (new tablet/phone/PC joins sync) with 1 M customers + 2 M IMEIs | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) + mercha |
| SCL-17 | P1 | A migration rewriting every customer row (e.g. phone normalization) on a replicated table | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) + mercha |
| SCL-18 | P1 | Collation/sort: custom Arabic/French collation on 1 M rows; collation registered on every  | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-19 | P1 | Export 1 M customers (CSV/XLSX); cancel midway; low RAM | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-20 | P1 | Aggregate screens: "top customers", "customers with debt", "inactive 12 months", loyalty l | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-21 | P1 | Erase/anonymize one customer in the 1 M DB | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-22 | P1 | Growth curve for other big tables: products 100 k, sale lines 5 M, IMEI table 2 M, audit 1 | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-23 | P0 | IPC payload size: backend returns 100 k rows to the webview | 23-scl-scale-customers.e2e.ts | FAIL |
| SCL-24 | P1 | Reports on 1 M customers / 5 M sales (monthly, by customer, by cashier) | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-25 | P1 | Search ranking at 100 k: exact phone first → exact name → prefix → fuzzy; transliteration  | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-26 | P0 | Hot-row problem: the walk-in customer (or any customer) with a counter column (`total_spen | 23-scl-rcp-tim-i18.e2e.ts | FAIL |
| SCL-27 | P1 | Denormalized customer counters (`total_spent`, `visits`, `points_balance`, `last_visit`) a | 27a-scl-batch.e2e.ts | FAIL |
| SCL-28 | P1 | Customer table contains many soft-deleted/anonymized rows | 27a-scl-batch.e2e.ts | PASS-PARTIAL |
| SCL-29 | P1 | Sales history screen with filters (date range, receipt no., customer, cashier, tender, IME | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-30 | P1 | Find one old sale for a refund/warranty claim by receipt no., QR/barcode scan, IMEI, phone | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-31 | P1 | Receipt-number input robustness: spaces, Arabic-Indic digits, leading zeros, lower/upper c | 27a-scl-batch.e2e.ts | FAIL |
| SCL-32 | P1 | Period reports (day / month / year / by cashier / by product / by tender) at 5 M sales and | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-33 | P1 | Product search by name, barcode, SKU, model, Arabic with/without diacritics at 100 k–500 k | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-34 | P1 | Product images/attachments | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) (image/a |
| SCL-35 | P1 | Variant explosion: 50 k products × 10 variants (color/storage), stock per variant per loca | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-36 | P0 | Stock on hand from 10 M stock movements; a best-seller with 100 k movements; per-product h | 23-scl-scale-ledger.e2e.ts | FAIL |
| SCL-37 | P0 | IMEI table with 2 M rows: lookup, state change, per-IMEI event history, duplicate-insert r | 23-scl-scale-db.e2e.ts | FAIL |
| SCL-38 | P0 | Checkout commit time on the 1 M-sale DB with a 200-line cart | 23-scl-scale-db.e2e.ts | PASS |
| SCL-39 | P1 | FTS index maintenance: bulk update of 100 k product names/prices, crash during update, pro | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-40 | P1 | Write amplification: each extra index slows inserts — commit latency and import throughput | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-41 | P1 | Audit log with 10 M rows and hash chain: append latency, verify time, export, reading the  | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-42 | P1 | Audit chain under concurrent writers/devices (20 writes/s) | — | BLOCKED — needs merchant sync gateway + second enrolled terminal (concurrent writers) |
| SCL-43 | P0 | Archiving old sales (e.g. older than 2 years) to an archive file/table | 23-scl-rcp-tim-i18.e2e.ts | N/A — N/A: no sales archive table/setting/source; archiveTables=[], archiveSettings=[], sourceHi |
| SCL-44 | P1 | Slow or cold storage: 5400 rpm HDD, SD card on Android, first query after reboot, small pa | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-45 | P0 | Disk space preflight before VACUUM, backup, migration, export, import, sync bootstrap | 23-scl-rcp-tim-i18.e2e.ts | FAIL |
| SCL-46 | P0 | Cancelling a search/report/export and the connection pool under load | 23-scl-rcp-tim-i18.e2e.ts | PASS |
| SCL-47 | P0 | Heavy query while the UI is used (Rust async runtime blocked, huge JSON serialized to the  | 23-scl-scale-customers.e2e.ts | PASS |
| SCL-48 | P0 | Document-number counters at scale and across devices (receipt, invoice, ticket) | 23-scl-rcp-tim-i18.e2e.ts | FAIL |
| SCL-49 | P1 | Query-planner statistics and skew: no `sqlite_stat1`, stale stats after a 1 M import, 90 % | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-50 | P1 | Very large `IN (...)` lists (40 k sale ids for a report/refund batch) | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-51 | P1 | `ORDER BY` on a non-indexed column over 1 M rows (e.g. customers by total spent, products  | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-52 | P1 | Date filters: UTC-stored timestamps vs shop business day, "today/this month" screens, func | 27a-scl-batch.e2e.ts | PASS |
| SCL-53 | P1 | JSON/blob columns filtered in `WHERE` on hot paths | 27a-scl-batch.e2e.ts | PASS |
| SCL-54 | P1 | Dashboard KPIs and counts opened repeatedly | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-55 | P1 | 3-year projection fixture `scale-3y`: owner's sales/day × 365 × 3, lines/sale, products, I | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-56 | P1 | Mobile keeps only a recent window of history (e.g. last N months) and queries older data o | — | BLOCKED — needs real mobile device + 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M |
| SCL-57 | P1 | Large IDs and totals crossing IPC/JSON to the webview: 64-bit ids, sums near 2^53 minor un | 27a-scl-batch.e2e.ts | FAIL |
| SCL-58 | P0 | Burst ingest: 5,000 offline sales arriving at once from sync or import | 23-scl-rcp-tim-i18.e2e.ts | FAIL |
| SCL-59 | P1 | Storage usage page and alerts: DB size, WAL size, attachments, free disk, growth per month | 27a-scl-batch.e2e.ts | PASS-PARTIAL |
| SCL-60 | P1 | Price history: 100 k products with many price changes; "current price" lookups and price-a | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-61 | P1 | Search normalization pipeline at 1 M: NFC vs NFD accents, Arabic presentation forms, tatwe | 27a-scl-batch.e2e.ts | PASS |
| SCL-62 | P1 | FTS5 behaviour for names and phones: tokenizer choice (`unicode61` vs `trigram`, trigram n | 27a-scl-batch.e2e.ts | FAIL |
| SCL-63 | P1 | Searching encrypted fields: if ID-card numbers or phones are encrypted at rest, equality s | 27a-scl-batch.e2e.ts | N/A — N/A: sample_phone="0551999999" phone_is_plaintext=true blind_indexes=0; phones and ID numb |
| SCL-64 | P1 | Duplicate-detection job at 1 M customers | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-65 | P1 | Nightly jobs over 1 M customers: points expiry, tier recalculation, segment refresh | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-66 | P1 | Bulk SMS/WhatsApp campaign to 100 k customers [if exists] | — | BLOCKED — needs 100k-customer fixture + SMS/WhatsApp provider lane |
| SCL-67 | P1 | Import into a non-empty 1 M customer table (CSV whose phones already exist) | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-68 | P1 | Bulk anonymize/erase of inactive customers (retention policy, 100 k at once) | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-69 | P1 | The walk-in customer holding ~4.5 M sales | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-70 | P1 | Primary-key choice at scale: random UUIDv4/TEXT keys vs time-ordered ULID/UUIDv7 vs intege | 27a-scl-batch.e2e.ts | PASS-PARTIAL |
| SCL-71 | P1 | Catalog filters at 500 k products: category + brand + in-stock + price range + sort by nam | 27a-scl-batch.e2e.ts | FAIL |
| SCL-72 | P1 | Barcode namespace collisions at 500 k products + 2 M IMEIs: EAN-13, internal codes, produc | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-73 | P1 | Full stocktake at 100 k SKUs (counts from 3 devices, partial counts, variances) | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) + second |
| SCL-74 | P1 | Reorder alerts and low-stock lists at 500 k SKUs | 27a-scl-batch.e2e.ts | FAIL |
| SCL-75 | P1 | Bulk price/cost change on 100 k products (supplier price list) | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-76 | P1 | Accumulating transient data: 50 k parked carts, drafts, expired IMEI reservations, outbox  | 27a-scl-batch.e2e.ts | FAIL |
| SCL-77 | P0 | `VACUUM`, table rebuilds and stored rowids: FTS external-content tables, sync/outbox curso | 23-scl-rcp-tim-i18.e2e.ts | FAIL |
| SCL-78 | P0 | Column typing: SQLite is dynamically typed — a non-`STRICT` `INTEGER` column can hold text | 23-scl-rcp-tim-i18.e2e.ts | FAIL |
| SCL-79 | P0 | SQLite/libSQL feature and version matrix per platform (Windows desktop, Android, iOS) and  | 23-scl-rcp-tim-i18.e2e.ts | FAIL |
| SCL-80 | P1 | Scale pragmas and page settings (distinct from the durability pragmas of DAT-20): `page_si | 27a-scl-batch.e2e.ts | PASS-PARTIAL |
| SCL-81 | P1 | Where the space goes: per-table and per-index size (`dbstat` if compiled in, otherwise `sq | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-82 | P1 | `integrity_check` / `quick_check` / `foreign_key_check` duration on a 5–10 GB database | 27a-scl-batch.e2e.ts | PASS-PARTIAL |
| SCL-83 | P0 | Startup after a crash with a very large `-wal` (hundreds of MB to GB), and one giant write | 23-scl-scale-wal.e2e.ts | FAIL |
| SCL-84 | P0 | Archive across attached databases in WAL mode (move old sales to `archive-YYYY.db`, delete | 23-scl-rcp-tim-i18.e2e.ts | N/A — N/A: only main/temp attached; dbDirFiles=[mobi_pos.db], attachHits=[]; no archive-YYYY.db  |
| SCL-85 | P1 | N+1 and statement-count budget: open sales history, customer detail, product list, checkou | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-86 | P1 | Summary and derived tables (daily/product/cashier summaries, stock balances, customer coun | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |
| SCL-87 | P1 | Backend quota and cost at 3-year volume (Turso/libSQL plan): database size, rows written/r | — | BLOCKED — needs merchant sync gateway (real Turso plan/quota) + 10M-scale fixture (scale-3y: 1M cust |
| SCL-88 | P1 | Wide-row hygiene: notes, JSON, attachment metadata and long descriptions on `customers`, ` | 27a-scl-batch.e2e.ts | FAIL |
| SCL-89 | P1 | Rebuild commands (FTS, stock balances, customer counters, summaries, planner statistics) o | — | BLOCKED — needs 10M-scale fixture (scale-3y: 1M customers / 5M sale lines / 10M audit rows) |

## SEC (20)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| SEC-01 | P0 | Cashier attempts every manager-only action by UI and by direct IPC invoke | 50-sec-authorization.e2e.ts | PASS |
| SEC-02 | P0 | PIN wrong ×N → lockout/throttle; lockout survives restart; timing | 50-sec-authorization.e2e.ts | PASS |
| SEC-03 | P0 | Step-up PIN expiry window; reuse after window; step-up on exports/wipe/retention/PIN-role  | 50-sec-authorization.e2e.ts | PASS |
| SEC-04 | P0 | Secondary admin with cashier PIN receives the four-digit lock pad | 50-sec-authorization.e2e.ts | PASS |
| SEC-05 | P0 | Audit entry for every mutation (G-08); tamper one byte → verifier fails; delete a row → ve | 50-sec-authorization.e2e.ts | PASS |
| SEC-06 | P0 | Audit log growth, export, retention/purge with step-up | 50-sec-authorization.e2e.ts | PASS |
| SEC-07 | P0 | PINs hashed with salt (no plaintext in DB, logs, memory dumps in e2e artifacts) | 50-sec-authorization.e2e.ts | PASS |
| SEC-08 | P0 | Customer personal data (phones, IDs, repair passcodes) not in logs/crash reports/e2e scree | 50-sec-authorization.e2e.ts | PASS |
| SEC-09 | P0 | IPC surface: forged invoke args (negative qty, huge, wrong types, other user's IDs) | 50-sec-authorization.e2e.ts | PASS |
| SEC-10 | P0 | Webview content-security: no remote content, no eval; e2e tooling absent in release | 50-sec-authorization.e2e.ts | PASS |
| SEC-11 | P0 | Inactivity auto-lock; lock during payment; unlock restores cart | 51-sec-hardening.e2e.ts | PASS |
| SEC-12 | P0 | Backup file encrypted; restore requires step-up; restoring old backup flagged | 51-sec-hardening.e2e.ts | PASS |
| SEC-13 | P0 | Licence/activation (if any): clock rollback, expired mid-sale | 51-sec-hardening.e2e.ts | N/A — Feature not implemented (executed probes) — no client-reachable licence-mutation or clock/ |
| SEC-14 | P0 | Stolen/lost phone: token revocation, remote wipe, last-seen | 51-sec-hardening.e2e.ts | PASS |
| SEC-15 | P0 | Sync token scope: mobile credentials limited to this shop and role; token in secure storag | 51-sec-hardening.e2e.ts | PASS |
| SEC-16 | P0 | Device registration: PIN works only on registered devices | 51-sec-hardening.e2e.ts | PASS |
| SEC-17 | P0 | Least-privilege data on role-limited devices (inspector phone) | 51-sec-hardening.e2e.ts | N/A — Feature not implemented (executed probes) — no role-limited device/replica class: every te |
| SEC-18 | P0 | Audit entries include user, device, drawer, app version and source (UI / IPC / sync) for e | 51-sec-hardening.e2e.ts | PASS |
| SEC-19 | P0 | Mass viewing/exfiltration: a cashier pages through the entire customer list, searches ever | 51-sec-hardening.e2e.ts | PASS |
| SEC-20 | P0 | Screen capture, screenshots, clipboard of customer PII on mobile; notification previews | 51-sec-hardening.e2e.ts | PASS |

## SHF (13)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| SHF-01 | P0 | Open shift with float; close with exact / over / short cash | 40-shf-shifts.e2e.ts | PASS |
| SHF-02 | P0 | Payout (supplier/trade-in/expense), drop, pay-in, no-sale open | 40-shf-shifts.e2e.ts | PASS |
| SHF-03 | P0 | Close shift with unfinished/parked sale or pending gateway approval or pending print | 40-shf-shifts.e2e.ts | PASS |
| SHF-04 | P0 | Two cashiers on one drawer / one cashier on two terminals | 40-shf-shifts.e2e.ts | PASS |
| SHF-05 | P0 | Shift spans midnight / business-day vs calendar-day | 40-shf-shifts.e2e.ts | PASS |
| SHF-06 | P0 | Z-report twice, after refunds, after backdated corrections | 40-shf-shifts.e2e.ts | PASS |
| SHF-07 | P0 | App crash during close | 40-shf-shifts.e2e.ts | PASS |
| SHF-08 | P0 | Close during Ramadan-style late-night operation (past midnight, long shifts > 12 h) | 40-shf-shifts.e2e.ts | PASS |
| SHF-09 | P0 | Currency count (denominations) input in ar/fr | 40-shf-shifts.e2e.ts | PASS |
| SHF-10 | P0 | Handover between cashiers mid-day (blind count) | — | FAIL |
| SHF-11 | P0 | Payouts, trade-ins and refunds happen on mobile or on a second desktop | 40-shf-shifts.e2e.ts | PASS |
| SHF-12 | P0 | Variance patterns: repeated shortages per cashier/day; variance exactly equal to a known s | 40-shf-shifts.e2e.ts | PASS |
| SHF-13 | P0 | Cashier handover: unlock is attributed to B while receipt seller remains the shift opener | 40-shf-shifts.e2e.ts | PASS |

## SYN (30)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| SYN-01 | P0 | Which mode? embedded replica (remote writes) vs offline-sync vs `turso.sync` push/pull; do | 24-syn-sync.e2e.ts | PASS |
| SYN-02 | P0 | Two terminals generate receipt/invoice/ticket numbers while offline | 24-syn-sync.e2e.ts | PASS |
| SYN-03 | P0 | Same sale ID pushed twice (retry after timeout) | 24-syn-sync.e2e.ts | PASS |
| SYN-04 | P0 | Edit-vs-edit conflict on a non-money row (product name, customer phone) | 24-syn-sync.e2e.ts | FAIL |
| SYN-05 | P0 | Conflict on money rows: same refund on two devices; same loyalty redemption on two devices | 24-syn-sync.e2e.ts | BLOCKED — BLOCKED: needs a second enrolled terminal and a configured merchant gateway; sandbox has g |
| SYN-06 | P0 | Stock as counter column vs ledger: two devices decrement offline | 24-syn-sync.e2e.ts | BLOCKED — BLOCKED: needs a second enrolled terminal; local control is clean (localSaleOk=true, local |
| SYN-07 | P0 | Delete vs edit conflict (product deleted on A, sold on B) | 24-syn-sync.e2e.ts | BLOCKED — BLOCKED: needs a second enrolled terminal and a real stale cart; the out-of-band tombstone |
| SYN-08 | P0 | Sync interrupted at 50% (kill app/network cut/laptop sleep) | 24-syn-sync.e2e.ts | BLOCKED — BLOCKED: needs a network fault injector or kill-at-50% harness; gatewayUrl=null and signed |
| SYN-09 | P0 | Large backlog (5,000 offline sales) then reconnect | 24-syn-sync.e2e.ts | BLOCKED — BLOCKED: needs a configured gateway plus a 5,000-sale signed backlog; pendingOutbox=12, si |
| SYN-10 | P0 | Clock skew between devices (±5 min, ±1 day) | 24-syn-sync.e2e.ts | BLOCKED — BLOCKED: needs a second enrolled terminal with an independent clock; enrolledDevices=1 and |
| SYN-11 | P0 | Schema/app version mismatch between devices (one updated, one not) | 24-syn-sync.e2e.ts | BLOCKED — BLOCKED: needs a second app build at a different schema version; fleetVersions=1, migratio |
| SYN-12 | P0 | Auth token expired/revoked/offline for days | 24-syn-sync.e2e.ts | BLOCKED — BLOCKED: needs a configured remote with an expiring/revocable token; gatewayUrl=null and c |
| SYN-13 | P0 | `readYourWrites` on/off: sale then immediate refund lookup, immediate report | 24-syn-sync.e2e.ts | PASS |
| SYN-14 | P0 | Sync during checkout/payment/printing | 24-syn-sync.e2e.ts | BLOCKED — BLOCKED: needs a configured gateway, signed rows and a checkout-overlap harness; gatewayUr |
| SYN-15 | P0 | Backend returns errors (500/429/timeouts/partial JSON) | 24-syn-sync.e2e.ts | BLOCKED — BLOCKED: needs signed outbox rows and a fault-injecting mock gateway; gatewayUrl=null, sig |
| SYN-16 | P0 | Restore an old backup on one device then sync | 24-syn-sync.e2e.ts | N/A — N/A: no restore command exists (restoreCommandOk=false, error "Command restore_database_ba |
| SYN-17 | P0 | Multi-shop: shop A cannot read/write shop B data; admin aggregation right | 24-syn-sync.e2e.ts | N/A — N/A: no multi-shop model (shopTables=[], shopColumns=[], shopSettings=[]). |
| SYN-18 | P0 | Sync credentials/URL stored securely, not logged, not in e2e artifacts | 24-syn-sync.e2e.ts | PASS |
| SYN-19 | P0 | After all devices settle: G-12 convergence on ledger totals, row counts, hash-chain heads | 24-syn-sync.e2e.ts | BLOCKED — BLOCKED: needs a second enrolled terminal and a gateway to observe convergence; enrolledDe |
| SYN-20 | P0 | Database encrypted file + sync (if used) key rotation/loss | 24-syn-sync.e2e.ts | N/A — N/A: database encryption is not used (cipherVersion="", keyPragmaHits=0, journal=wal). |
| SYN-21 | P0 | Propagation SLA: time for a change to appear on another device (idle, under 1,000 sales/h, | 24-syn-sync.e2e.ts | BLOCKED — BLOCKED: needs a second terminal and a configured gateway to measure propagation; gatewayU |
| SYN-22 | P0 | Mutable state rows (drawer, ticket, inspection, claim status): two devices transition at o | 24-syn-sync.e2e.ts | BLOCKED — BLOCKED: needs a second enrolled terminal; enrolledDevices=1 and gatewayUrl=null. |
| SYN-23 | P0 | Tombstones and redirects: customer/product deleted or merged on A while B edits or sells | 24-syn-sync.e2e.ts | BLOCKED — BLOCKED: needs a second enrolled terminal plus a merge/redirect lane; tombstones exist (cu |
| SYN-24 | P0 | Bandwidth/payload budget: initial sync, 1 M-row change set, photos | 24-syn-sync.e2e.ts | BLOCKED — BLOCKED: needs a configured remote and a 1M-row change set; gatewayUrl=null, pendingOutbox |
| SYN-25 | P0 | Blobs: ID scans and inspection photos | 24-syn-sync.e2e.ts | N/A — N/A: no blob sync lane (attachmentTable=false, blobEntity=false; outbox entity types are c |
| SYN-26 | P0 | Replica exposure: what a phone's local DB contains | 24-syn-sync.e2e.ts | FAIL |
| SYN-27 | P0 | Ordering of state rows and money rows by version/hybrid logical clock, not wall clock | 24-syn-sync.e2e.ts | FAIL |
| SYN-28 | P0 | Echo/ping-pong: a device applies a remote change and its own triggers write again | 24-syn-sync.e2e.ts | BLOCKED — BLOCKED: needs a configured remote to apply a real remote change; remoteConfigured=false,  |
| SYN-29 | P0 | Schema migration while a device is offline for days; mixed versions on one backend | 24-syn-sync.e2e.ts | BLOCKED — BLOCKED: needs a second app build at an older schema plus a multi-day offline window; flee |
| SYN-30 | P0 | Per-device settings (language, theme, printer, last drawer) vs shop settings | 24-syn-sync.e2e.ts | PASS |

## TIM (10)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| TIM-01 | P0 | System clock moved backward/forward 1 h / 1 day / 1 year during session | 23-scl-rcp-tim-i18.e2e.ts | FAIL |
| TIM-02 | P1 | Timezone change on device (Algeria currently has no DST, but tablets/VMs change) | 26-rcp-tim.e2e.ts | FAIL |
| TIM-03 | P1 | Date boundaries: 31 Dec→1 Jan, leap day 29 Feb, month-end reports, week start (Saturday/Su | 26-rcp-tim.e2e.ts | PASS-PARTIAL |
| TIM-04 | P1 | Hijri/Gregorian display if offered | 26-rcp-tim.e2e.ts | N/A — N/A: hijriReferences=0 probe: no Hijri calendar anywhere in src (no Intl islamic calendar, |
| TIM-05 | P1 | Loyalty/warranty/quote expiry exactly at boundary instant | 26-rcp-tim.e2e.ts | PASS |
| TIM-06 | P1 | Scheduled jobs (expiry, reminders, backups) missed because app was closed/off for days | 26-rcp-tim.e2e.ts | PASS-PARTIAL |
| TIM-07 | P1 | NTP resync jump during a sale | 26-rcp-tim.e2e.ts | FAIL |
| TIM-08 | P0 | Business-day boundary across devices (drawer opened 22:00, sales after midnight on mobile) | 23-scl-scale-customers.e2e.ts | BLOCKED — BLOCKED: needs a second enrolled terminal/mobile with the same merchant clock and business |
| TIM-09 | P1 | Mobile in another timezone/VPN/roaming; warranty, quote and loyalty expiry | 26-rcp-tim.e2e.ts | BLOCKED — FAIL: mobile in Pacific/Midway (device Sun Oct 25 14:29 SST) vs shop Africa/Algiers for th |
| TIM-10 | P1 | Device asleep for days, then jobs and token refresh resume | 26-rcp-tim.e2e.ts | BLOCKED — BLOCKED: BLOCKED: needs a multi-day sleep window on the mobile build plus a token-refresh  |

## TIN (21)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| TIN-01 | P0 | IMEI validation: 15 digits, Luhn check, 14-digit, letters, spaces, dual-IMEI phones | 80-tin-tradein.e2e.ts | FAIL |
| TIN-02 | P0 | Same IMEI bought twice / already in stock / already sold by us | 80-tin-tradein.e2e.ts | PASS |
| TIN-03 | P0 | IMEI blacklist/stolen check (local list or GSMA-type service, mocked): clean / blacklisted | 80-tin-tradein.e2e.ts | PASS |
| TIN-04 | P0 | Seller identity capture: ID number, name, address, ID photo/scan; retention | 80-tin-tradein.e2e.ts | FAIL |
| TIN-05 | P0 | Seller is a minor / ID expired / ID number reused with different name | 80-tin-tradein.e2e.ts | PASS |
| TIN-06 | P0 | Condition grading changes quote after inspection | 80-tin-tradein.e2e.ts | FAIL |
| TIN-07 | P0 | Payout by cash: drawer expected cash decreases; payout over drawer balance; payout cap per | 80-tin-tradein.e2e.ts | PASS |
| TIN-08 | P0 | Trade-in used as credit toward a new sale (net payment) | 80-tin-tradein.e2e.ts | FAIL |
| TIN-09 | P0 | Trade-in cancelled after payout / seller returns money | 80-tin-tradein.e2e.ts | PASS |
| TIN-10 | P0 | Trade-in device goes to refurbish → stock → sold: cost basis = purchase price + parts + la | 80-tin-tradein.e2e.ts | PASS |
| TIN-11 | P0 | Police/“sell-hold” on an IMEI (flag) [UNVERIFIED-LAW] | 80-tin-tradein.e2e.ts | PASS |
| TIN-12 | P0 | Locked device (iCloud/Google FRP/MDM) flagged at intake | 80-tin-tradein.e2e.ts | PASS |
| TIN-13 | P0 | Trade-in price edited after payout | 80-tin-tradein.e2e.ts | PASS |
| TIN-14 | P0 | Printing the purchase contract/receipt for seller in ar/fr with IMEI + ID reference | 80-tin-tradein.e2e.ts | FAIL |
| TIN-15 | P0 | Bulk trade-in (10 devices one seller) | 80-tin-tradein.e2e.ts | PASS |
| TIN-16 | P0 | Seller ID photo/scan captured on mobile and sent to desktop for approval | 80-tin-tradein.e2e.ts | PASS |
| TIN-17 | P0 | Same seller (ID/phone) brings many phones in a short period | 80-tin-tradein.e2e.ts | FAIL |
| TIN-18 | P0 | IMEI on box vs device screen (`*#06#`) vs tray vs system record mismatch | 80-tin-tradein.e2e.ts | PASS |
| TIN-19 | P0 | Cash payout while the drawer is closed or belongs to another cashier; payout made from mob | 80-tin-tradein.e2e.ts | PASS |
| TIN-20 | P0 | Seller signature captured on tablet/phone and on the printed contract | 80-tin-tradein.e2e.ts | PASS |
| TIN-21 | P0 | Quote validity (e.g. 24 h) vs price-list change; quote started on mobile, finished on desk | 80-tin-tradein.e2e.ts | PASS |

## WAR (30)

| ID | Prio | Title | Spec | Verdict |
|---|---|---|---|---|
| WAR-01 | P0 | Lookup by IMEI: sold by us / never sold / in stock / in repair / returned / sold twice | 86-war-warranty.e2e.ts | FAIL |
| WAR-02 | P0 | IMEI input: 15 digits with Luhn, 14 digits, 16-digit IMEISV, MEID, spaces/dashes/slashes,  | 86-war-warranty.e2e.ts | FAIL |
| WAR-03 | P0 | Warranty period boundaries: sold 23:59 vs 00:01; 12 months vs 365 days; sold 31 Jan + 1 mo | 86-war-warranty.e2e.ts | PASS |
| WAR-04 | P0 | Warranty start event: sale date vs delivery vs activation vs "repair completed" | 86-war-warranty.e2e.ts | PASS |
| WAR-05 | P0 | Sale refunded/returned, then the device resold | 86-war-warranty.e2e.ts | PASS |
| WAR-06 | P0 | Trade-in device refurbished and resold; open-box/as-is items | 86-war-warranty.e2e.ts | PASS |
| WAR-07 | P0 | Extended/paid warranty plan: sold with the phone, sold later, refunded, overlapping plans | 86-war-warranty.e2e.ts | PASS |
| WAR-08 | P1 | Inspection checklist: physical damage, liquid-contact indicator, broken seals, screen crac | 86-war-warranty.e2e.ts | FAIL |
| WAR-09 | P1 | Manager overrides the inspector's decision; customer disputes; second inspection | 86-war-warranty.e2e.ts | PASS |
| WAR-10 | P0 | Claim limits: max claims per period, repeat claim for the same defect, claim exactly at ex | 86-war-warranty.e2e.ts | FAIL |
| WAR-11 | P0 | Approved claim creates a repair ticket linked to the original sale | 86-war-warranty.e2e.ts | FAIL |
| WAR-12 | P0 | Replacement (DOA) under warranty: IMEI A returned to supplier/scrapped, IMEI B issued | 86-war-warranty.e2e.ts | PASS |
| WAR-13 | P0 | Device presented has a different IMEI than the sale (swapped, counterfeit, board swap, box | 86-war-warranty.e2e.ts | FAIL |
| WAR-14 | P0 | IMEI blacklist check at claim intake: clean / blacklisted / service down / timeout (mocked | 86-war-warranty.e2e.ts | PASS |
| WAR-15 | P0 | No receipt: lookup by IMEI + customer phone/ID | 86-war-warranty.e2e.ts | FAIL |
| WAR-16 | P0 | Inspector permissions | 86-war-warranty.e2e.ts | FAIL |
| WAR-17 | P1 | Inspection photos on mobile: 5–10 MB each, 10 per inspection, offline, low storage, upload | 86-war-warranty.e2e.ts | PASS |
| WAR-18 | P1 | Inspection started on mobile, finished on desktop (and reverse); same inspection edited on | 86-war-warranty.e2e.ts | PASS |
| WAR-19 | P0 | Inspector offline: lookup from local data; sale refunded or warranty voided on desktop mea | 86-war-warranty.e2e.ts | PASS |
| WAR-20 | P1 | Warranty certificate/label: ar/fr, IMEI barcode, period, terms, shop identity, cashier/ins | 86-war-warranty.e2e.ts | FAIL |
| WAR-21 | P0 | Verification endpoint/QR for third parties [if exists]: IMEI enumeration, rate limits | 86-war-warranty.e2e.ts | PASS |
| WAR-22 | P1 | Warranty reports: expiring in 30 days, claims by model/supplier, warranty cost vs revenue | 86-war-warranty.e2e.ts | PASS |
| WAR-23 | P0 | Retention/purge job | 86-war-warranty.e2e.ts | PASS |
| WAR-24 | P0 | Dual-SIM phone: two IMEIs, one device; claim scanned with IMEI 2 | 86-war-warranty.e2e.ts | FAIL |
| WAR-25 | P1 | Accessories with their own warranty (charger, battery, screen) | 86-war-warranty.e2e.ts | PASS |
| WAR-26 | P1 | 2 M IMEIs: exact lookup, partial (last 6 digits) lookup | 86-war-warranty.e2e.ts | FAIL |
| WAR-27 | P1 | Manufacturer coverage lookup [if used]: down, timeout, rate-limited, wrong region, cached  | 86-war-warranty.e2e.ts | PASS |
| WAR-28 | P1 | Inspector decisions and photos in ar/fr/en; free-text notes with emoji, RTL, 5,000 chars | 86-war-warranty.e2e.ts | FAIL |
| WAR-29 | P0 | Claim on a sale made by a now-disabled cashier or at another drawer/shop | 86-war-warranty.e2e.ts | FAIL |
| WAR-30 | P0 | Concurrent claims for the same IMEI from two devices | 86-war-warranty.e2e.ts | FAIL |

## G invariants

> G-01…G-36 are asserted inside spec afterEach batches (`lib/invariants.ts` →
> `results/invariant-events.ndjson`); *fail* = the last finalize pass of a spec family
> recorded violations, *pass* = harnessed with none.

| ID | Executed | Text |
|---|---|---|
| G-01 | pass | Ledger balance: Σ finalized sale totals − Σ refunds = Σ net tender movements (per tender type). |
| G-02 | pass | Cash drawer: expected cash = opening float + cash sales − cash refunds − payouts (incl. trade-in payouts, supp |
| G-03 | pass | Totals: per document Σ line totals − discounts = document total exactly; Σ document totals = report totals. |
| G-04 | **fail** | Stock: opening + purchases − sold + returned (restocked) ± adjustments = on-hand, per product and per serial/I |
| G-05 | **fail** | Serial uniqueness: each IMEI/serial exists in exactly one place/state (in stock, sold, in repair, with custome |
| G-06 | pass | Numbering: receipt/invoice/ticket numbers unique; sequence per rule (gapless or gaps logged). |
| G-07 | pass | Loyalty: balance = Σ earned − Σ redeemed − Σ reversed − Σ expired (≥ 0 unless the owner allows negative); no p |
| G-08 | pass | Audit: every money/stock/loyalty/role mutation has an audit entry; hash chain verifies; entries immutable. |
| G-09 | pass | Idempotency: replaying any request with the same idempotency key creates no second effect. |
| G-10 | — | Atomicity: after crash/kill at any point, each business transaction is fully present or fully absent (sale+lin |
| G-11 | pass | Three-way equality: UI value = stored value = printed/exported value = oracle value (integer minor units). |
| G-12 | — | Sync convergence: after all devices sync and settle, every device has identical ledger totals and identical ro |
| G-13 | pass | Referential integrity: `PRAGMA foreign_key_check` empty; `PRAGMA integrity_check` = ok. |
| G-14 | pass | No float money: no non-integer value ever stored or computed for money/qty-in-milli. |
| G-15 | pass | Permissions: no action succeeds for a role that must not have it (checked via attempted-forbidden actions in t |
| G-16 | — | Resource budget: memory/handle/DB-size growth stays within budget; p95 latency not degrading > 2× from baselin |
| G-17 | pass | One open drawer session per drawer: at most one `open` session per drawer id across all devices; every open/cl |
| G-18 | pass | Cross-device freshness: drawer/shift/ticket status shown on any device equals the server state within the conf |
| G-19 | pass | Attribution: every document (sale, refund, payout, trade-in, ticket, inspection, drawer event) stores `user_id |
| G-20 | **fail** | Session integrity: no mutation is accepted without a valid session; after logout, lock, user switch or disable |
| G-21 | **fail** | Warranty: each active warranty is bound to exactly one device (all IMEIs of a dual-SIM phone) and one source d |
| G-22 | — | Query-plan guard: every hot query (search, list page, lookup by IMEI/phone/ticket) uses an index (`EXPLAIN QUE |
| G-23 | **fail** | Customer identity: the normalized phone is unique among active customers (or the duplicate is flagged); a merg |
| G-24 | — | Outbox: every locally created, unsynced record sits in a persisted outbox with an idempotency key; the count i |
| G-25 | — | Platform parity: the same inputs give identical money results, names and statuses on desktop and mobile builds |
| G-26 | **fail** | Blob/reference integrity: every photo/scan reference resolves to a stored file or is explicitly "pending uploa |
| G-27 | — | Acknowledged = durable: any sale, refund, payout or drawer event the user was told succeeded (screen confirmat |
| G-28 | — | Recoverability: the newest backup restores into a DB that passes `integrity_check`, equals the source ledger t |
| G-29 | pass | Refund conservation: for every sale line Σ refunded qty ≤ sold qty and Σ refunded amount ≤ net paid share; for |
| G-30 | pass | No destructive cascade: deleting or merging a customer/product/user/device never deletes or edits ledger rows  |
| G-31 | — | Scale budget: hot-path latency, DB size, WAL size and backup/restore time stay within owner-agreed budgets at  |
| G-32 | pass | Account balance: per customer (credit sales, instalments, deposits, store credit) balance = Σ sales − Σ paymen |
| G-33 | pass | Type discipline: money, quantity and counter columns hold integers; IMEI, phone, receipt/ticket numbers and id |
| G-34 | pass | Derived data is rebuildable: every derived table or column (counters, stock balances, summaries, FTS, normaliz |
| G-35 | — | Destructive-change guard: an operation that deletes or overwrites more than N rows, or touches a ledger table, |
| G-36 | — | Unique device identity: each live `device_id` appears once; ID and document-number ranges of different devices |

## Duplicate ID warnings

- SCL-36 implemented in multiple spec files: 23-scl-scale-ledger-probe.e2e.ts, 23-scl-scale-ledger.e2e.ts
- SCL-83 implemented in multiple spec files: 23-scl-scale-wal.e2e.ts
