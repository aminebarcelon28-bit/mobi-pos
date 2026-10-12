# DISCOVERY — WDIO/Tauri POS test suite (Phase 0)

> PIN used all over the app: **`202020`** (manager). Source: `wdio.conf.ts:94` (`APP_PIN`), `test/helpers/common.ts:3`, `test/specs/smoke.spec.ts:17,111-118,324-331`, `scripts/run_hardest_cdp_smoke.mjs:7,12`, `scripts/production-gauntlet.mjs:72`.
> All selectors / commands / rules below were read from the repo. No invented names.

## 1. Stack map

| Field | Value | Evidence |
|---|---|---|
| Frontend | React `^19.2.8` + react-dom, Vite `^8.2.0` + `@vitejs/plugin-react ^6.0.4`, Tailwind `^4.3.3`, TS `~6.0.2` | `package.json:136-163`, `vite.config.ts:1-80`, `src/main.tsx:1-20` |
| Tauri | `2.12` both sides (comment enforces major.minor sync) | `src-tauri/Cargo.toml:16-19`, `package.json:121,149` |
| Identifier / product / version | `com.mobi.pos` / `MobiPOS` / `1.6.8` | `src-tauri/tauri.conf.json:3-6`, `src-tauri/Cargo.toml:2-3` |
| Binary | `mobi-pos` (lib `mobi_pos_lib`), `[[bin]]` via package name | `src-tauri/Cargo.toml:2,8-10`, `wdio.conf.ts:28` |
| Rust plugins / deps | `tauri-plugin-sql@2 (sqlite)`, `tauri-plugin-opener@2`, `rusqlite@0.31 (bundled,backup)`, `argon2@0.5`, `chacha20poly1305@0.10`, `ed25519-dalek@3`, `sqlite-vec@0.1`, `uuid`, `keyring+winreg` (desktop-only), `updater/process` (desktop-only), `tauri-plugin-wdio-webdriver@1` (**debug-only**, see below) | `src-tauri/Cargo.toml:22-79` |
| Entry / builder | `main.rs:4-6` → `mobi_pos_lib::run()`; plugins `opener`, `intents`, `scanner`, `tauri-plugin-sql (sqlite:mobi_pos.db+migrations)`, desktop-only `updater+process`, debug-only `wdio-webdriver` | `src-tauri/src/main.rs:1-6`, `src-tauri/src/lib.rs:1676-1694` |
| WebDriver gating (ACTUAL) | `#[cfg(debug_assertions)] builder.plugin(tauri_plugin_wdio_webdriver::init())` — **not** a Cargo feature `e2e`. There is no `tauri-plugin-wdio` (second plugin), no `withGlobalTauri`, no `tauri.e2e.conf.json`, no `src-tauri/src/e2e.rs` | `src-tauri/src/lib.rs:1693-1694`, `src-tauri/Cargo.toml:78-79`, glob `src-tauri/tauri.*.conf.json` → none |
| WDIO harness (ACTUAL) | Root `wdio.conf.ts` (not `e2e/wdio.conf.ts`): specs `./test/specs/**/*.ts`, binary `mobi-pos(.exe)` under `target/`, release→external driver / debug→embedded, `APP_PIN='202020'`, mocha 300 s, `maxInstances:1` | `wdio.conf.ts:28-94,101-167`, `package.json:115-116` (`build:e2e`, `test:e2e`) |
| DB location / engine | Live DB `mobi_pos.db` in `app_data_dir()`; dual engine: `tauri-plugin-sql` (sqlx pool, owns migrations v1→v112) for all TS reads/writes + `rusqlite` short-lived WAL connections for native commands; `journal_mode=WAL, busy_timeout=5000` | `src-tauri/src/lib.rs:319,348,363-385,932-1670`, `src-tauri/src/commands.rs:1-8,49-54`, `src-tauri/src/db.rs:68-74,113-117`, `src-tauri/src/refund.rs:426-428` |
| Migrations | v1–v112 via `tauri-plugin-sql`; `EXPECTED_MAX_DB_USER_VERSION=112`; v109 refund barrier (`refund_dedup` + `REFUND_BYPASS` trigger), v110–112 Tier-B device/sync columns | `src-tauri/src/lib.rs:247-269,843-866,932-1670` |
| `data-testid` coverage | **Only 22 hits repo-wide, ~zero on sale flow** (all in `DebtLedgerModal`, `WarrantyStatusChips`, `TradeInBuybackModal`, `MoneyInput` passthrough). Sale flow uses `#catalog-search`, `.pos-tile`, `aria-label`/`title` selectors | grep `data-testid` → `src/` (22 matches); `test/specs/smoke.spec.ts:127-313`, `test/specs/sell_checkout.e2e.ts:15-145`, `src/components/CartPanel.tsx`, `src/components/BottomBar.tsx:132-136` |

## 2. IPC surface (every `#[tauri::command]` in money scope)

> Finding: **checkout / cart / payments / discounts / shifts / Z-report / receipts have NO native command.** They go through generic `tauri-plugin-sql` (`sqlite:mobi_pos.db`) from TS. Only **refund** is native. TS bridge is `src/platform/invoke.ts:10` (`invoke` from `@tauri-apps/api/core`).

| Command | Args → Returns | File |
|---|---|---|
| `refund_sale_atomic` | `req: RefundRequest{ ticketId, refundId, itemsHash, receiptNumber, method, subtotal:i64, discountTotal:i64, totalNet:i64, costTotal:i64, cashTendered:i64, changeDue:i64, cashTenderedNet:i64, lines:RefundItemIn{id,productId,quantity:i64,…}, supervisor?, deviceId, audit{…} }` → `RefundOk{ refundId, receiptNumber, ticketStatus, ticketVersion }`, errors `ALREADY_REFUNDED / ZERO_REFUNDABLE / REFUND_EXCEEDS / CASH_CAP_EXCEEDED / OFFLINE_FOREIGN_TICKET / SUPERVISOR_PIN_REQUIRED / BUSY / DEVICE_IDENTITY_SPOOFED / SUPERVISOR_AUTH_EXPIRED|FUTURE_DATED` — all money `i64` | `src-tauri/src/refund.rs:93-245,1309-1342` |
| *(no `void_sale_atomic`)* | Voids = `inventory_ledger.reason VOID` via TS + refund path | `src-tauri/src/lib.rs:1139-1150`, handler list `1778-1832` has no void fn |
| `po_commit_stock_batch` (+ alias `commit_stock_batch`) | `payload{ supplierName, items{productId,quantity:f64,unitCost:f64,…} }` → `usize` | `src-tauri/src/commands.rs:176-191,363-395` |
| `po_process_raw_scan` (+ alias) | `ProcessRawScanRequest{…}` → `ProcessRawScanResponse{…}` (PO OCR only) | `src-tauri/src/commands.rs:73-89,157-170,381-387` |
| `audit_append` | `{ action≤128, details≤8KiB, user?, requiresPin?, deviceId?, idempotencyKey? }` → `{ eventId, entryHash? }` | `src-tauri/src/trust_core/audit_append.rs:51-75,903-960` |
| `audit_verify` / `audit_note_swallowed` | — / `{context}` → `AuditChainStatus` / `u64` | `src-tauri/src/trust_core/audit_append.rs:1084-1103` |
| `pin_verify` | `{userId, pin}` → `{ok,locked,lockedRemainingMs,mustRotate}` (Argon2id, persisted lockout) | `src-tauri/src/trust_core/pin.rs:782-803,1237-1382` |
| `pin_set` / `pin_lockout_remaining` | `{userId,newPin,…}` / `{userId}` → `{userId,format:"v2"}` / `{locked,remainingMs}` | `src-tauri/src/trust_core/pin.rs:805-829,1136-1424` |
| `get_gate_state`, `trust_sync_license`, `trust_report_revocation`, `trust_reanchor_challenge|time`, `ingest_signed_server_time`, `get_device_identity_info` | trust kernel / time anchor / device identity | `src-tauri/src/trust_core/ipc_authorizer.rs:618-639,1050-1078`, `reanchor.rs:279-297`, `time_anchor.rs:276-316`, `device_identity.rs:531-563` |
| `create_database_backup` / `list_database_backups` / `decrypt_snapshot_for_recovery` / `prune_snapshots` / `sqlite_check_db_version` / `sqlite_db_maintenance` | backup flow (no `restore_database_backup` — removed, `lib.rs:658-665`) | `src-tauri/src/lib.rs:338-866`, `src-tauri/src/snapshot_prune.rs:376-429` |
| `emergency_export_ledger` | `{pin, tables[]}` → `{exportDir, files, auditEventId, manifestMac?, integrityState,…}` (read-only, allowlist `sales_journal,sales_journal_lines,shift_sessions,shift_movements`) | `src-tauri/src/emergency_export.rs:52-174,671-739` |
| `fetch_next_outbox_batch` / `mark_outbox_synced` / `reap_stale_in_flight` | signed Tier-B drain (`seq_no IS NOT NULL`, contiguity cursor) | `src-tauri/src/sync_outbox.rs:357-403` |
| `sqlite_print_raw_escpos`, `sqlite_open_cash_drawer`, `hardware_scan_devices`, `hardware_update_vfd`, `launch_*`, `mobile_*`, `mobile_scan_document`, license/cloud credentials, SAV attachments | hardware / print / intents / creds | `src-tauri/src/lib.rs:33-241`, `hardware.rs:86-104,448-697`, `intents.rs:65-314`, `scanner.rs:67-99`, `sav_attachments.rs:82-309` |
| Full handler list (53 fns, **no checkout/cart/pay/discount/shift/zreport/receipt**) | assembled in one `generate_handler!` | `src-tauri/src/lib.rs:1778-1832` |
| TS money owners (not IPC) | `computeCartTotals`, `cashTerms`, `processPayment`, `shiftAdapter.closeShift`, `zReportSnapshot` | `src/utils/receiptMath.ts:356-418`, `src/utils/cashTerms.ts`, `src/store/slices/createOrderSlice.ts:268-1502`, `src/db/adapters/shiftAdapter.ts:588`, `src/utils/zReportSnapshot.ts:165` |

## 3. Money model (type + danger grep)

- Canonical kernel: **integer minor units DZD, exponent 2** (`1 DA = 100 minor`). `CURRENCY={code:'DZD',label:'DA',exponent:2}`. Entry parses decimal **STRING only**, display via int div/rem + zero-pad. Float-free by construction (`money.rs:9`, `money.ts:9-22`).
  - `src-tauri/src/money.rs:3,18-20,63-137,167-199`
  - `src/utils/money.ts:24-31,86-153,188-228`
- Live checkout (transitional, Stage E pending): **integer DA** (`toInt=Math.round`), cart-% is the only rounding point. `receiptMath.ts:245-247,328-331,376`, `cashTerms.ts:85-88`.
- `parseFloat` (13 hits): **all PO/settings/loyalty/SMS, NONE checkout** — `PoReviewScreen.tsx:1608,1639,1657,1685,1923,1933,1959,2270,2283`, `TradeInBuybackModal.tsx:816`, `SettingsModal.tsx:1948`, `loyaltyEngine.ts:1168`, `moneyInput.ts:4` (doc-only).
- `toFixed` (57 hits): **all display/analytics/margin-% strings, zero money arithmetic**. No `toFixed(2)` on money. e.g. `CartPanel.tsx:1360`, `MobileCheckoutTab.tsx:1465`, `DiscountModal.tsx:359`, `receiptMath.ts:208`, `sqlPluginAdapter.ts:1694,4190,4653`.
- `* 1.19` / `* 0.19`: **0 hits both trees** — confirms no-VAT product (§4).
- `Math.round`: canonical checkout `toInt`/`toCashAmount` to integer DA; single cart-% point `Math.round((base*pct)/100)`; per-line rounding explicitly forbidden (`cashTerms.ts:297-300` BUG-MONEY-01 fix, `createUISlice.ts:763` last-line-absorbs-residue). PO-only float lane `Math.round(q*c*100)/100`, `Math.round(cost*1.35)` never checkout (`PoReviewScreen.tsx:74-178,324-440,863-877`).
  - `src/utils/receiptMath.ts:328-330,376,284-285,344-351`, `src/utils/cashTerms.ts:87,99,130,138,143,348,382-386`, `src/db/sqlPluginAdapter.ts:959,1026,2113-2127`
- `f32/f64/as f64` (92 hits): money is `i64` (`contract.rs:13-39`, `refund.rs:98-241`); `f64` only in PO gate/OCR/geometry/embeddings/legacy-REAL reads. `money.rs:9` "float-free: no f64, no as f64".

## 4. Money rules as implemented

| Rule | Implemented behaviour | Source |
|---|---|---|
| Currency/decimals | `DZD`, label `DA`, exponent 2; display `130.50 DA`, grouping ASCII-space `45 000.00 DA`; fiscal ledgers centime-denominated Fixed 2dp | `src-tauri/src/money.rs:18-20,152-165`, `src/utils/money.ts:24-31,178-186`, `src/types/pos.ts:1732-1756`, `src-tauri/src/emergency_export.rs:230` |
| VAT | **NONE — no-TVA product.** No `ht/tva/ttc` tax block on receipts; `tax` column dropped (migration 108); no rate math | `src/utils/receiptMath.ts:241-243,394-397`, `src/store/slices/createOrderSlice.ts:479`, `src/utils/escpos.ts:279,296`, `src/components/modals/PaymentModal.tsx:79-81`, `src-tauri/src/lib.rs:1568` |
| priceMode / rounding | No inclusive/exclusive flag (HT-only: `ht=max(0,subtotalAfterDiscount)`, `ttc=max(0,ht-credits)`, `total=ttc`). Half-up via `Math.round` / `mul_div_half_up (rem*2>=d)`, **per-invoice single point** (cart-%) | `src/utils/receiptMath.ts:394-399,376`, `src-tauri/src/money.rs:186-199`, `src/utils/cashTerms.ts:297-300` |
| Discounts + order | Per-line `discount/discountAmount` + cart `%` (0–100) + promo `%`/`amount` (`SOLDES10 10%, FIDELITE15 15%, PROMO500/1000`, expiry/caps) + loyalty tier % (0/3/5/8/12). Order: `gross=Σ unit×qty(signed)` → `lineDisc` (sign-aware) → `base=gross-lineDisc` → `cartDisc=round(base×pct/100)` iff base>0 → `subtotal=gross-lineDisc-cartDisc` → `net=subtotal-credits`; credits are **payment, not discount** | `src/utils/receiptMath.ts:232-247,356-418`, `src/components/modals/DiscountModal.tsx:29-34,86-97`, `src/utils/loyaltyEngine.ts:126-166`, `src/store/slices/createCartSlice.ts:67-73,345-346` |
| Quantity | **Integer units.** `quantity INTEGER`, `z.number().int().positive`, `addQty=max(1,floor(q))`, `Math.abs(Math.round(quantity))`; `REAL` only for `stock_batches.quantity_remaining` and PO `quantity:f64`; refund line `quantity:i64` | `src-tauri/src/lib.rs:992`, `src/schemas/invoiceSchema.ts:5`, `src/store/slices/createCartSlice.ts:177,273`, `src-tauri/src/refund.rs:98`, `src-tauri/src/commands.rs:179,416` |
| Cash rounding | **None** (smallest 1 DA). No 5 DA/Swedish rounding. Quick bills `[500,…,5000]` | `PaymentModal.tsx:170`, `CartPanel.tsx:532,1540`, `shiftAdapter.ts:589` |
| Timbre fiscal | **Absent as fiscal rule.** Only OCR stoplist noise-skip | `src-tauri/src/geometry.rs:267-268` |
| Tender types | Closed enum, **7 values, NO CIB/Edahabia/SATIM**: `Espèces \| Avoir Client \| BaridiMob \| Chèque \| Crédit Client \| Reprise \| Autre` (`Autre→TPE/Carte`). Split = multi-leg `tenders[]` (`Espèces+Avoir+Reprise`). Dette = `Crédit Client` with debt-limit guard; store credit (`Avoir Client`) capped | `src/types/pos.ts:433-441`, `src/utils/receiptViewModel.ts:164-179`, `src/utils/cashTerms.ts:105-172`, `src/components/modals/PaymentModal.tsx:142-178,298-318`, `KredyTab.tsx:65,177,1024-1039` |
| Change | `reste=max(0,netToPay-cashGiven)`, `changeDue=max(0,cashGiven-netToPay)`; cash-in = `Σ Espèces legs − changeDue`; receipt `TOTAL PERÇU / Rendu` | `PaymentModal.tsx:167-168,280`, `MobileCheckoutTab.tsx:457-465,1574`, `src/utils/cashTerms.ts:17-19,91-102,342-350`, `src/utils/escpos.ts:313-314` |
| Refund/void | Void = `status VOIDED` excluded from revenue/cash; double-void `ALREADY_VOIDED`, refund-of-voided `ORIGINAL_VOIDED`. Refund = **native atomic barrier** `BEGIN IMMEDIATE` + `refund_dedup` FIRST + `REFUND_BYPASS` trigger; identity `REF→AVOIR-<hash>` deterministic; anti-arbitrage pro-rata `computeRefundFundingSplit`; tender clamp cumulative `cashOut ≤ cashTenderedNet − priorCashOut` excess→Avoir; eligibility `!isRefund, !VOIDED/REFUNDED, refundableBalance>0`; offline caps `cash 10000 DA / PIN threshold 5000 DA`; supervisor freshness 120 s / future 30 s; retry ONLY `BUSY` | `src-tauri/src/refund.rs:1-54,624-675,696,889`, `src-tauri/src/lib.rs:1594-1623`, `src/db/adapters/refundNative.ts:11-56,98-99`, `src/utils/receiptMath.ts:462-550,626-682`, `src/utils/cashTerms.ts:377-389`, `src/db/adapters/transactionAdapter.ts:164-229,389-453` |
| Receipt numbering | `TXN` + `REC` random IDs (`newId('TXN')`, `newReceiptNumber('REC')`); refund `AVOIR-<hash>`; Z `YYYYMMDD-SEQ(closedCount+1)`; index `idx_transactions_receipt`. **No sequential counter, no MAX query** | `src/store/slices/createOrderSlice.ts:655-656`, `src/db/sqlPluginAdapter.ts:1024,1068`, `src/db/adapters/refundNative.ts:54`, `src/utils/cashTerms.ts:314-318`, `src-tauri/src/lib.rs:986` |
| Shift/Z expected-cash | Authority `closeShift`: `expectedCash = openingFloat + cashSales + deposits − expenses − cashRefunds`; preview identical; variance `≥1000 DA → manager PIN + note; ≠0 → note`; double-open `SHIFT_ALREADY_OPEN`, phantom-close `NO_OPEN_SHIFT`. Note: ESC/POS fallback **omits refunds** (`escpos.ts:552-554`) | `src/db/adapters/shiftAdapter.ts:242-246,318-323,417-424,588-623`, `ShiftCloseModal.tsx:223-224`, `ReportsModal.tsx:355-357`, `src/utils/cashTerms.ts:1-25,200-236` |
| Price override | `0 DA → manager`, `price<cost (vente à perte) → manager`, `discount%>20 → manager`, else cashier; universal derogation key; force-sale out-of-stock needs manager PIN | `src/store/slices/createCartSlice.ts:401-424`, `CartPanel.tsx:322-343,1333-1409`, `MobileCheckoutTab.tsx:262-284`, `SettingsModal.tsx:2099`, `ProductCatalog.tsx:74-75,228,871` |

## 5. Security / roles relevant to money

- Roles: `manager 6–8 digits, cashier exactly 4 digits, digits-only`; `LOCKOUT_LADDER=[(5,60s),(10,15min),(15,60min)]`; rotation mandatory after legacy hash; `v1$→v2$ Argon2id`. `src-tauri/src/trust_core/pin.rs:26-66`, `LockScreenOverlay.tsx:77-79,397,494,531`, `AGENTS.md` PIN gates.
- Lock-screen login verifies natively (`pin_verify`); native verdict final, no local fallback. Manager-gate modals interim. `src/utils/pinGate.ts:1-25,163-206`, `src/api/pin.ts:63`.
- Step-up: journal gate `verifyManagerStepUp` (5-min in-memory window, cleared on lock/background, fail-closed); variance ≥1000 DA → `verifyManagerGate`; large offline refund `SUPERVISOR_PIN_REQUIRED` via `pin_verify`. `src/utils/auditGate.ts:9-32,146-192`, `shiftAdapter.ts:604-623`, `refund.rs:51-54,336-338,666-675`.
- Audit: native `audit_append` funnel (~30 call sites), `entry_hash=HMAC(audit-subkey, prev\|\|canonical(entry))`, side `audit_chain` table, head `{seq,hash,mac}` in keystore; TS export `SHA256` chain + manifest fingerprint; caps action 128 / details 8 KiB. `audit_append.rs:1-117`, `src/utils/auditExport.ts:113-144`.
- Cashier must NOT reach: journal/exports/price-override/refund/void/wipe/restore/PIN-role changes (manager + fresh PIN per owner rules). AGENTS.md: trust tables native-write-only; WebView SQL bypass is OPEN residual (`docs/webview-sql-residual.md`).

## 6. Offline-first behaviour

- Outbox `sync_outbox(status pending/inflight/synced/failed, idempotency_key UNIQUE, device_id/signature, seq_no, envelope)`; signed drain `fetch_next_outbox_batch/mark_outbox_synced/reap_stale_in_flight` under contiguity cursor `last_acked_seq` (`syncDrainWorker.ts` POSTs in order to merchant gateway, idles when unconfigured; legacy Turso lane yields signed rows only while armed). `sqlPluginAdapter.ts:66-73,128-129,252-399`, `sync_outbox.rs:357-403`, `syncDrainWorker.ts:4,91-174`, AGENTS.md Tier-B gates.
- Version clock `bumpEntityVersion`, `version+1` on void/refund; conflicts `causalVersion` tiebreak (version→device→fingerprint), `conflictWatch`, `payoutWatch`, `SyncManager GUARD-STALE`. Generic merge last-writer-wins at vN. `causalVersion.ts:7-34,111-247`, `conflictWatch.ts:2-108`, `SyncManager.ts:1667-1791`.
- Offline sale queued, survives restart, syncs once (idempotency key), no duplicate on reconnect. `AGENTS.md` suspension-key / revocation bounds.

## 7. i18n

- **Single locale `fr-DZ`, French copy, no i18n framework.** `DEFAULT_LOCALE fr-DZ`; `Intl.NumberFormat('fr-DZ',{currency DZD})`; `toLocaleString('fr-DZ'/'fr-FR')` everywhere. **RTL: exactly one `dir="rtl"`** (Arabic block in `RepairWorkOrderModal.tsx:1936`); no `document.dir`, no `useTranslation`. Arabic support = numeral/phone normalization + WinAnsi-safe PDF only.
- `src/constants/index.ts:14`, `src/types/pos.ts:1732-1744`, `PaymentModal.tsx:741,1005`, `ReportsModal.tsx:602`, `excel/sheets.ts:199-201`, `escpos.ts:506,512`, `auditExport.ts:102,225-226`, `money.ts:97-100`, `VendorDisputeModal.tsx:26`.

## 8. Existing tests + how to run them

| Layer | What | Run |
|---|---|---|
| Rust `#[test]` (~100+) | `lib(4)`, `refund(17+)`, `emergency_export(13)`, `snapshot_prune(10)`, `money(8)`, `hardware(7)`, `geometry(7)`, `gate(7)`, `snapshot_crypto(6)`, `db(3)`, `commands(2)`, device/time/sync/sav… | `cargo test --release -p mobi-pos --lib` (`package.json:15`), focused `cargo test --lib -p mobi-pos refund::` (`package.json:59`) |
| Node scripts (real gates) | `npm test` chains `test_pos_math, test_money_fixes, test_receipt_math, test_cloud_sync, test_sync_contract, test_offline_chaos, test_mobile_*` + `test:license/audit/sav-intake/boundaries/warranty`, `test:sync-e2e` (18/18 gateway loopback), `test:refund-race/migration/offline`, `test:device-identity/time-anchor/sync-drain`, FIFO/PO/batch props | `package.json:11-59` (see `test:money`, `test:refund-race`, `test:sync-e2e`, `test:fifo-*`, `test:po-*`) |
| WDIO (existing, read-only) | `test/specs/smoke.spec.ts` (auth→dashboard→modules→lock, PIN 202020), `test/specs/sell_checkout.e2e.ts` (empty-cart gate, search stress incl. `' OR '1'='1`, qty clamp, `Encaissement` modal) | `npm run test:e2e` → `wdio run wdio.conf.ts` (`package.json:116`) |
| Playwright (web) | `testDir '.'`, `testMatch e2e/**/*.spec.ts + tests/**/*.spec.ts`, chromium `1228` | `playwright.config.ts:1-61` |
| No vitest | Only `businessLogic.test.ts`, `loyaltyEngine.test.ts` (plain node asserts) | grep `*.test.* src/` (4 hits) |

## 9. Ambiguities for the owner (rule 6 — STOP, do not guess)

1. **VAT/rounding oracle has no VAT to model.** Brief §5 assumes 19%/9%, inclusive/exclusive, per-line vs per-invoice tax rounding. Code: no-TVA product, no tax field, single cart-% rounding point. → Confirm oracle = HT-only BigInt DA (minor units only in `Money` kernel), no `vatBp/taxRounding/priceMode` matrix.
2. **No card gateway exists.** Brief S7/S8 + §5.3 assume CIB/Edahabia/BaridiMob/SATIM + `e2e_set_gateway_mode (approve|decline|timeout|duplicate_callback|delayed)`. Code: tender enum has no CIB/Edahabia/SATIM; `Autre=TPE/Card` and `BaridiMob/Chèque` are manual records; no gateway client, no timeout/duplicate-callback/idempotency-guard path to test. → Confirm: drop gateway-chaos tests, or specify which tender/mode is the "card" under test and where the mock would hook.
3. **Checkout is TS-via-SQL, not IPC.** Brief §3.3 requires stress/money to drive "the same commands the UI calls" (native `CMD` names) with test-only commands for setup/read only. Code: sale creation/finalize is `processPayment`/`quickCashPayment` (TS) + `sqlPluginAdapter` writes; the only native money command is `refund_sale_atomic`. → Confirm: Tier-B "through IPC" = `refund_sale_atomic` only; sale-volume stress runs TS `processPayment` inside webview chunks (not `browser.tauri.execute` of a checkout command that doesn't exist).
4. **No trilingual RTL UI.** Brief S11 + §5.3 assume ar/fr/en switch with `document.dir==='rtl'` and Arabic-Indic digit rendering. Code: single `fr-DZ` French copy, one static `dir="rtl"` block, no language switcher. → Confirm: replace S11 with "fr-DZ formatting stable (`130.50 DA`, ASCII-space grouping)" and keep `displayedToMinor` Arabic-Indic parsing as parser-only unit test.
5. **Receipt numbers are not monotonic.** Brief §5.3 requires unique monotonic per-device numbers, no gaps, concurrent ordering. Code: `TXN`/`REC` random IDs, no counter. → Confirm: assert uniqueness only (via snapshot), drop monotonicity/gap tests — or approve adding a counter (schema change, out of test-branch scope per §9).
6. **Quantity is integer-only; no cash rounding, no timbre.** Brief edge matrix (§5.4) includes `0.5/1.5/0.333/12.345` qty, cash rounding, stamp duty. Code: qty `INTEGER` (fractional floored/rounded), no cash-rounding rule, no timbre rule. → Confirm: edge matrix runs integer qty only; timbre/cash-rounding invariants marked NOT-IMPLEMENTED.
7. **Harness gating is `debug_assertions`, not Cargo feature `e2e`.** Brief §3.2 requires `e2e = ["dep:tauri-plugin-wdio-webdriver", …]` + `tauri.e2e.conf.json` overlay (own identifier/data-dir, `withGlobalTauri`). Code: `tauri-plugin-wdio-webdriver` under `[target.cfg(debug_assertions)]`, no second plugin, release→external driver pairing documented in `wdio.conf.ts:13-25`. → Confirm before Phase 1: (a) keep `debug_assertions` gating and document the deviation, or (b) approve migrating to feature `e2e` + overlay + `e2e_reset_and_seed/e2e_ledger_snapshot/e2e_get_sale` commands (new native code, capability-file sharp edge in brief §3.2 applies).
8. **`browser.tauri.execute` / `mock` / `reloadSession` signatures unverified.** Repo has no `@wdio/tauri-plugin` dep and no frontend import; installed-typings check (brief §1) still pending. → Phase 1 will verify against `node_modules/@wdio/tauri-service` typings before writing `lib/invoke.ts`.
9. **ESC/POS Z fallback omits refunds** (`openingFloat+cashSales+deposits−expenses`, no `−cashRefunds`, `src/utils/escpos.ts:552-554`) vs authority formula (§4). → Confirm whether printed Z is in scope for the three-way equality check (§5.2) or snapshot-only.

---

## 10. Phase 1 build findings (2026-10-08, all with file:line evidence)

### 10.1 Harness as built (owner #7 + real-data direction 2026-10-08)
- `e2e = []` in `src-tauri/Cargo.toml:82-88`; webdriver dep + `e2e_*` IPC +
  cloud seal all gated `any(debug_assertions, feature = "e2e")`
  (`src-tauri/src/lib.rs`, `src-tauri/src/e2e.rs` � new module with
  `e2e_reset_db` / `e2e_seed_state` / `e2e_get_db_state`).
- `src-tauri/tauri.e2e.conf.json`: NO separate identifier (real-data mode) �
  only `withGlobalTauri: true` (specs invoke via
  `window.__TAURI__.core.invoke`, no extra npm dep) + `beforeBuildCommand`
  no-op (tauri-cli does not propagate caller env to it � proven by a build
  whose dist lacked the injected var; `scripts/build-e2e.mjs` builds the
  frontend itself first, then the binary with `CARGO_TARGET_DIR=target-e2e`).
- Single live-DB filename `mobi_pos.db` enforced on 3 sides (Rust `DB_URL`,
  TS `DB_PATH`, plugin 4.4 `validate_db_name`) with a build-time preflight
  (`scripts/build-e2e.mjs` fails the build on disagreement). Native
  `app_dir.join("mobi_pos.db")` sites (13: refund, PIN, audit x3, outbox,
  device, time-anchor, export, prune, lib x5) unified through
  `e2e::live_db_path()`.
- Login/setup `data-testid`s: `lock-screen`, `login-pin-input`,
  `login-pin-pad` (opacity-0 input needs tap-pad + `browser.keys`),
  `login-submit`, `setup-pin-root`, `setup-manager-name/new/confirm/save`.

### 10.2 Owner #8 amended: NO test filename (4.4 confinement wins)
`patches/tauri-plugin-sql/src/wrapper.rs:319-343` confines `load` to exactly
`mobi_pos.db` (pinned by `load_confined_to_exact_db_name`). A test filename
is rejected at `load` and the app boots degraded (proven: version-0 file,
5 lazy tables, no screens). Real-data mode (owner 2026-10-08, pre-launch)
made the point moot: same identifier, same file.

### 10.3 Cloud seal (proven live pull BEFORE the seal)
- Unsealed runs inherited the keyring token (`mobi-pos-cloud-sync`,
  `src-tauri/src/lib.rs:141`) and pulled merchant rows mid-run (80 real
  sales during one harness run; subset of prod 634 verified by id overlap).
- Seal: `get_cloud_credentials -> None`, set/delete -> denied, all
  `#[cfg(feature = "e2e")]` (`lib.rs`). Push is outbox-driven
  (`SyncManager.ts:1323`) and seeds never enqueue outbox rows, so Phase 1
  test rows could not have uploaded (no E2E ids among pulled rows).
- Ghost sequel: pulls had persisted into the WebView profile Dexie
  (`%LOCALAPPDATA%/com.mobi.pos.e2e/EBWebView`, never wiped); sealed runs
  re-mirrored them via `backfillAllToOutbox` (`device_id='backfill'`,
  `src/db/backfill.ts:99-172`, 104 orders + 106 items = 210 outbox rows).
  Lesson: clean-room = wipe BOTH dirs (roaming + local EBWebView);
  `e2e_reset_db` preserves backfill/remirror epoch flags + ledgers so a
  restart cannot resurrect, and fails closed on corrupt FTS.

### 10.4 Reset discipline (bugs caught by the harness itself)
- v1 wiped `_sqlx_migrations` (re-migration brick risk) and FTS shadow
  tables (destroys the index cookie -> `invalid fts5 file format`).
- v2: skips both ledgers + `products_fts_*` shadows, clears the index with
  `DELETE FROM products_fts`, runs an FTS `integrity-check`, all in ONE
  transaction; preserves `sync.backfill_v*`/`sync.remirror*` flags; sets
  per-row `idempotency_key` (`products`/`transactions`/`transaction_items`
  all have UNIQUE keys with `DEFAULT ''`).

### 10.5 Real-data observations (not defects in scope)
- sqlx ledger frozen at 106 (pre-0.8 shape, no `migration_type` col); the
  0.8 reversible migrator does not advance it, but the TS boot self-heal
  backfilled every money-path object � probed present: refund trigger,
  outbox device_id/signature/seq_no/envelope, txn identity cols. Only gaps:
  `imei_records.warranty_months` (SAV-only) + present-but-unused `tax` col.
  Specs assert ledger >= 106 (112 on fresh boots).
- `PRAGMA user_version` is always 0 (sqlx does not maintain it); the C6 boot
  gate reads a pragma nothing writes. Oracle tracks `_sqlx_migrations` max.
- Tauri setup path never persists `manager_pin` to app_settings (only the
  native keystore verifies), so the first-boot setup gate reappears every
  boot in the harness; specs handle setup-or-lock deterministically.
- Orphaned app/driver processes after WDIO runs hold the DB lock and make
  the next run "get stuck": `npm run e2e:clean` (processes only � never
  data) runs before every gate run. `wdio.conf.ts` explicit-binary profile
  detection fixed (last-segment match; was always mistaking debug for
  release -> external driver).
- Pre-existing breakage noted: `test/specs/smoke.spec.ts` imports
  `unlockScreen/isLockScreenVisible/isSetupGateVisible`, which
  `test/helpers/common.ts` does not export (suite cannot load).

---

## 11. Known defects (owner-triaged 2026-10-08 � log, do not fix in harness)

### D1 (P1): Tauri setup path never persists `manager_pin` to app_settings
- Symptom: first-boot setup (`FirstBootPinSetup`, `src/App.tsx:141-183`)
  reappears on EVERY boot in a test build, even right after completing it.
- Evidence: after a completed setup (native Argon2id rotation accepted, lock
  unlocks with 202020), `app_settings` holds `cashier_users` (with a
  `PENDING-�` skeleton PIN) but NO `manager_pin` key; the gate
  `managerPin === "" || KNOWN_DEFAULT_PINS.has(managerPin)`
  (`src/App.tsx:156`, store default `src/store/slices/createUISlice.ts:219`)
  therefore stays true. The Tauri branch (`src/App.tsx:294-322`) calls
  `setCashierUsers` + `rotatePinCredential` (native keystore) but never the
  `setManagerPin` mirror write the non-Tauri branch does (`src/App.tsx:327`).
  `refreshCredentialsFromAuthority` (`createUISlice.ts:346-398`) only reads
  the mirrors back � it cannot conjure a missing `manager_pin`.
- Impact on tests: harness boots go setup -> lock -> dashboard every run
  (handled deterministically by `hello.e2e.ts`); `e2e_reset_db` now
  preserves both mirror keys so post-reset boots skip setup.
- Production question for the owner: how do shipped tills avoid the setup
  loop � legacy-written `manager_pin`, or is this loop live in prod too?

### D2 (P2): sqlx migration ledger frozen at 106 (source knows 112)
- Symptom: `_sqlx_migrations` max stays 106 across boots on the upgraded
  database (15 rows, all success); a fresh database migrates to 112
  (21 rows). `PRAGMA user_version` is 0 in both (sqlx does not maintain it).
- Evidence: real-DB ledger `[1..8, 100..106]` vs source migrations up to
  `version: 112` (`src-tauri/src/lib.rs:1376-1712`); old ledger shape has NO
  `migration_type` column while the patched plugin maps
  `MigrationKind::Up => ReversibleUp`
  (`patches/tauri-plugin-sql/src/lib.rs:73-77`); the TS boot self-heal
  (`ensureLocalSyncColumns`, `src/db/sqlPluginAdapter.ts:42-60`) backfills
  columns/indexes itself ("22 doomed ALTERs" probe pass).
- Impact: NONE on money paths � probed present on the v106 file: refund
  barrier trigger, outbox device_id/device_signature/seq_no/envelope, txn
  identity columns. Gaps are SAV-only (`imei_records.warranty_months`,
  v107) and present-but-unused (`transactions.tax`, v108 drop pending).
- Recommended verification before release: surface the migrator error to
  the backend log on `load()` (today a stall is silent), or run the pending
  statements against a COPY and confirm idempotence; then decide whether
  107-112 need a repair migration for upgraded installs.
- Harness stance: ledger >= 106 is the prod baseline assertion (112 fresh).

---

## 12. Snapshot corruption incident (2026-10-08 � closed)

### Symptoms
- One wrapper snapshot (`live-pre-run-2026-10-08T18-36-27`, quarantined, never
  restore from it) failed `integrity_check` with freelist/ptrmap damage;
  a reset against the live file then failed with
  `database disk image is malformed` on `customer_debts`.
- All other snapshots, the manual 17:55 backup, and the live file verified
  clean throughout (`integrity ok`, counts exact).

### Root cause (forensic, high confidence)
- Damaged pages are the `products` indexes (roots 80-84, 112, 130);
  damaged file shows page_count 1820 / freelist 1580 (post-mass-delete
  shape) vs healthy 2076 / 2.
- Chain: a teardown `taskkill /F` landed mid-vacuum (or mid-checkpoint),
  tearing freelist/pointer-map pages. The damage is silent until the pages
  are touched � the next snapshot faithfully copied it (size checks pass on
  torn files), and the next reset touched a damaged products index.
- Contributing: snapshot/restore verified SIZES only (blind to structural
  damage); the reset had no integrity gate yet.

### Fixes landed
- Graceful shutdown first everywhere (`taskkill` without `/F` + 15 s wait,
  `/F` only on timeout; drivers always `/F`): `wdio.conf.ts`
  `stopAppGracefully`, `scripts/e2e-clean.mjs`.
- `e2e_reset_db` runs `PRAGMA integrity_check` FIRST and refuses damaged
  files instead of touching them.
- Header sanity (magic + size/page alignment) on every snapshot and every
  restore copy, in addition to size verification.
- Bad snapshot quarantined (`QUARANTINED-malformed-�`, excluded from
  pruning and restores).
- Future improvement (noted, not built): snapshot via SQLite `VACUUM INTO`
  (needs an engine in Node) or the in-app online-backup API for a
  single-file atomic image.

### D4 (P1): native PIN mint/rotate always fails (`pin.rs` missing `updated_at`)
- Symptom: `pin_set` (manager AND cashier) fails with
  `credential write: NOT NULL constraint failed: app_settings.updated_at`.
- Evidence: `write_app_setting_json` (`pin.rs:1066-1071`) inserts
  `(key, value_json)` without `updated_at` (NOT NULL, no default). Proven at
  three layers: direct IPC for a roster-known cashier, same-PIN re-mint on
  the real admin (side-effect-free � fails pre-commit), and the identical
  statement in isolation (SQLite upsert checks NOT NULL before conflict
  arbitration, so even existing rows cannot be updated this way).
- Impact: no native credential can be minted or rotated on this schema �
  cashier provisioning is impossible (roster row + legacy v1 hash leads to
  the forced-rotation gate, whose native rotation then fails: lockout by
  dead-end). Manager login is unaffected (reads work; existing `v1$local_`
  hashes verify). Matches the standing note that no new hashes are minted
  natively � the schema is a second lock on that door besides the dependency
  approval. One-line fix (add `updated_at`), owned by trust review, NOT made
  in the harness branch.
- Harness stance: Block B cashier sessions deferred until the fix; gates are
  tested with non-manager credentials under a manager session, and a
  defect-demonstration test pins the exact failure code.

### D5 (input defect, needs owner triage): fractional quantity maps to 10x units
- Symptom: typing "1.5" into the cart line quantity field commits **15**
  units (`qtyDigitsOf` strips non-digits: `src/components/CartPanel.tsx:28`);
  "0.25" would commit 25. No rejection, no truncation-to-integer.
- Evidence: C.1 in `test/specs/numeric-boundaries.e2e.ts` (15 stored,
  integer, total exact). Storage invariant holds (INTEGER column, never a
  float) � the defect is the silent 10x reinterpretation at entry.
- Asserted as observed so the behavior cannot drift silently; triage
  decides reject-vs-truncate-to-1. Never fix silently in a test branch.

### D6 (P1): UI shift lifecycle never mirrors to SQLite `cash_sessions` — production-path cash refunds die `NO_OPEN_SHIFT`
- Symptom: every cash refund through the real `RefundModal` fails at the
  native step-13 session gate (`refund.rs:1078-1093`) with `NO_OPEN_SHIFT`,
  surfacing the misleading "Ouvrez la caisse..." toast
  (`RefundModal.tsx:439-440`) while a shift is open. No legacy fallback
  (`createOrderSlice.ts:2653` maps it straight to failure).
- Mechanism: the slice sends `cashMove.sessionId = refundShift.id`, the
  Dexie shift UUID (`createOrderSlice.ts:2519-2532`, gate `:1958`), but the
  UI shift open writes Dexie only — proven at runtime (Dexie OPEN shift has
  no SQLite row even after a sale). Nothing populates SQLite
  `cash_sessions` in production: zero `INSERT`s in `src/**/*.ts` (only
  schema probes `sqlPluginAdapter.ts:108/232-234`), Rust-side only the e2e
  seed (`e2e.rs:445`); the boot remirror runs SQLite→Dexie only
  (`backfill.ts:499`). Bisected native-level with supervisor present for
  both `online=false/true`: `NO_OPEN_SHIFT` every time.
- Blast radius: every CASH refund via the production path (`cashMove`
  exists iff `cashOut > 0`). Pure-avoir refunds skip step-13 and survive;
  voids are TS-lane (`cart-void` green). Phases 2-3 stayed green only
  because `refundDirect` aims `cashMove` at the seeded SQLite shift — a
  test artifact, not the app path.
- Harness bridge (owner-directed 2026-10-09, NO production changes):
  `e2e_mirror_shift_open` (`e2e.rs`, registered in the e2e handler list in
  `lib.rs`) mirrors the UI-opened Dexie shift id + float into SQLite
  `cash_sessions` OPEN; `shift-lifecycle.e2e.ts` invokes it after
  `openShiftUi`. Permanent fix deferred to the native shift-IPC sprint
  (native `open_shift`/`close_shift`/`record_cash_movement` owning the
  authoritative SQLite write, adapter simplification, Turso pull parity).

### D7 (P1): desktop Z never renders — slice unmounts the close modal before its own snapshot lands
- Symptom: every desktop shift close books exactly (Dexie CLOSED,
  `expectedCash`/`discrepancy` exact) but the `shift-z-dialog` print view
  never appears; the close modal instead reopens fresh (blind step, count
  reset) and stays open. Proven across 3 consecutive closes (H0/H1/H2:
  expectedCash=18000, discrepancies 0/−500/+500, Z seen zero times).
- Mechanism: `createShiftSlice.closeShift` sets `activeShift: null,
  activeModal: null` on success (`createShiftSlice.ts:152-157`), unmounting
  `ShiftCloseModal` — then `handleFinalizeClosure`'s `setZSnapshot(...)`
  no-ops on the unmounted component and its `openModal('shift_close')`
  remounts a virgin modal (`ShiftCloseModal.tsx:449-470`). The author's own
  comment intends the opposite order ("freeze the Z identity BEFORE the
  slice nulls the session + modal", `:383-385`). The 1.6 s auto-dismiss
  effect (`:289-303`) never gets a snapshot to dismiss. Trace signature:
  close-dialog `false/false → false/true` ~100 ms after confirm, Z never
  `true` in 25 s of polling.
- Blast radius: desktop closes only (mobile path calls `closeModal()`
  directly and never snapshots). Money is unaffected — the booked figures
  are exact; only the Z visual + print handshake is lost (cashiers see a
  reset close dialog instead of their Z).
- Harness stance (owner-directed 2026-10-09, NO production changes):
  `shift-lifecycle.e2e.ts` accepts the booked close (Dexie CLOSED +
  figures) with an explicit `D7 bypass` log line when the Z visual is
  absent, and Escape-dismisses the remounted modal so cycles chain. The
  Z-render math itself stays covered by `test_escpos_z_parity.mts` (green)
  and the booked-row asserts. Real fix (snapshot before slice-null, or
  lift the snapshot above the modal) belongs to the production sprint.

---

## 13. Phase 3 execution notes (2026-10-09)

- Suites (serial, one --spec per run): smoke-pos 13/13, discount-money 7/7,
  refund-money 7/7, split-tender 3/3, cashier-rbac 4/4, numeric-boundaries
  2/2, cart-void 1/1. Repeated --spec flags spawn parallel workers that
  reset under each other (6-failure pile-up observed); wdio.conf.ts now
  documents one-spec-per-run.
- Stored `cash_tendered` = sum of non-Reprise tender legs by construction
  (createOrderSlice.ts:876-880), NOT drawer cash. Drawer truth is the
  tenders array (Esp�ces legs minus change); the oracle reads legs via
  `e2e_get_sale.tenders` (SQLite has no payments table).
- Store mirrors (Dexie) vs SQLite authority: catalog/shift/customers read
  mirrors at boot; seeds write SQLite. Specs project to Dexie the way the
  app does (refund/customer projections) or reload after seeding. Tile aria
  stock can go stale post-sale � money asserts use the ledger oracle.
- Sealed builds force the offline lane: UI refunds are refused at the
  native foreign-ticket gate (namespaces differ); kernel paths run direct
  with online:true (same commit lane as connected production).
- Native pin rotation is broken for all roles (D4); cashier sessions are
  unprovisionable until the trust fix � gates tested with non-manager
  credentials instead. Banal-PIN list rejects 1234/0000/1111; 1010 passes
  policy (used for denial probes).
- DEFECT-CQTY-01 (D5): qty field maps "1.5" to 15 units; storage stays
  integer (asserted), mapping reported for triage.

---

## 14. Phase 0 refresh (2026-10-10, Gate 0 — read-only; no source/test/config modified)

Scope per owner: full verification programme, no-tax product, isolated `.e2e`
direction. Sweeps are Brief §5.1; classification money/non-money below.
Counts from `rg` on a clean tree (commit SHA recorded in the Gate 0 reply).

### 14.1 Sweep raw counts

| Sweep | Command | Hits |
|---|---|---|
| S1 broad parse/format | `rg -n "parseFloat\|toFixed\|Math\.(round\|floor\|ceil\|trunc)\|Number\(\|parseInt\(" src src-tauri/src` | **1322** |
| S1a `parseFloat` | same trees, `parseFloat` only | **13** — all PO/settings/loyalty/SMS or doc-only, none checkout |
| S1b `toFixed` | same trees, `toFixed` only | **57** — all display/analytics/margin-% strings, zero money arithmetic |
| S1c VAT factors | `* 1.19 / * 0.19 / / 1.19` | **0** — confirms R-01 no-tax |
| S1d `f32/f64/as f32/as f64` | `src-tauri/src` | **119** — PO/OCR/geometry/embeddings + `e2e.rs` REAL-column DTOs; money kernel clean (see 14.2) |
| S2 money-column types | `\bREAL\|FLOAT\|DOUBLE\|NUMERIC\b` in `src-tauri` | **62** — legacy `REAL` money columns hold integer-valued floats (see 14.2) |
| S3 trunc casts | `as (i\|u)(8\|16\|32)` in `src-tauri/src` | **2** — `money.rs:83` (Arabic-Indic digit fold, non-money chars), `snapshot_prune.rs:176` (count compare) |
| S3b unwrap/expect | `\.unwrap\(\)\|\.expect\(` in `src-tauri/src` | **645** — money-adjacent hits (`money.rs:323-405`, `refund.rs:1457-1474`) are `#[cfg(test)]` asserts/fixtures only |
| S4 clock/randomness | `SystemTime::now\|Instant::now\|Date.now\|new Date\(\|Math.random\|rand::` | **548** — seams in 14.3 |

### 14.2 Classification (money vs non-money)

- `parseFloat` (13): `PoReviewScreen.tsx:1608,1639,1657,1685,1923,1933,1959,2270,2283`
  (PO qty/cost/price), `loyaltyEngine.ts:1168` (percent parse), `moneyInput.ts:4`
  (doc-only warning), `SettingsModal.tsx:1950`, `TradeInBuybackModal.tsx:816`
  (margin %). **Checkout files clean** (`receiptMath.ts`, `cashTerms.ts`,
  `money.ts`, `createOrderSlice.ts`, `PaymentModal.tsx`, `money.rs`,
  `refund.rs` money paths): only `receiptMath.ts:208` + `createOrderSlice.ts:1034`
  `toFixed(1)` for margin-% display, never arithmetic.
- `money.rs` float-free by construction (`money.rs:9`); `refund.rs` money is
  `i64` (`refund.rs:98-241`); `refund.rs` `f64` hits (`:124,935-941,1031-1062`,
  `:1647-2342`) are PO/stock-batch `quantity_remaining`/`unit_cost` REAL reads
  and test-only paths — flagged Q-02, not asserted as money-clean beyond `i64`
  contract.
- `REAL` (62): `transactions/subtotal/total/cash_tendered/change_due`,
  `transaction_items/applied_price/discount_amount`, `products/price/cost_price`,
  `stock_batches.quantity_remaining/unit_cost`, `cash_*` — e2e seeds write
  integer-valued floats (`e2e.rs:401,736`); TS writes `Math.round`'d integers
  (`sqlPluginAdapter.ts:966,1033`). Contract "integer-valued floats" recorded
  as Q-02 in `RULES.md`.
- `data-testid`: **104 hits** (was 22 in §1 — stale). Now in `App.tsx`,
  `BottomBar.tsx`, `CartPanel.tsx`, `Header.tsx`, `LockScreenOverlay.tsx`,
  `CustomersModal.tsx`, `DebtLedgerModal.tsx`, `DiscountModal.tsx`,
  `PaymentModal.tsx`, `RefundModal.tsx`, `ShiftCloseModal.tsx`,
  `ShiftMovementModal.tsx`, `ShiftOpenModal.tsx`, `TradeInBuybackModal.tsx`,
  `ProductCatalog.tsx`, `MoneyInput.tsx`, `PinDialog.tsx`, `WarrantyStatusChips.tsx`.
  Sale-flow coverage materially improved since §1; exact per-screen map is
  Phase 1 `selectors.ts` work (Q-08).
- Clock seams: native `SystemTime::now` concentrated in `hlc.rs:83`,
  `trusted_time.rs`, `time_anchor.rs:56,353`, `sync_outbox.rs`,
  `audit_append.rs`, `device_identity.rs:524`, `pin.rs`; TS `Date.now/new Date`
  in UI/sync/display paths (`App.tsx:185,305,712`, `BottomBar.tsx:30`,
  `bindings.ts:96,114`). No injectable `e2e_set_clock` exists yet (Q-08);
  money tests must not depend on wall-clock until the seam lands.

### 14.3 Deltas vs §§1-13 (all verified, none modified)

1. `e2e.rs` surface is `e2e_reset_db:136`, `e2e_seed_state:347`,
   `e2e_mirror_shift_open:609` (D6 bridge), `e2e_get_shift:632`,
   `e2e_get_db_state:674`, `e2e_get_product_stock:819`,
   `e2e_get_customer_ledger:881`, `e2e_get_sale:977` — the Brief's
   `e2e_ledger_snapshot/e2e_run_invariants/e2e_set_clock/e2e_crash_after/e2e_build_info/e2e_set_gateway_mode/e2e_get_printed`
   do **not** exist (Q-08).
2. Pragmas actual: `journal_mode=WAL`, `synchronous=NORMAL` (not FULL),
   `foreign_keys=ON`, `busy_timeout=5000` (`db.rs:113-117`, `refund.rs:428-431`,
   `e2e.rs:77-81`) — Q-03.
3. `tauri.e2e.conf.json:1-9` still no separate identifier (real-data mode);
   R-03 records isolated `.e2e` as owner-confirmed *direction*, migration in
   Phase 1.
4. Toolchain: Node `v24.18.0`, `cargo 1.96.1`, `tsc 6.0.3` (this run).
   `#[tauri::command]` count **84**; `invoke_handler` at `lib.rs:1870,1934`.

---

## 15. Gate 1 verification (2026-10-10, Phase 1 — isolated `.e2e` migration)

Work (all in the harness/test lane; `money.ts`/`money.rs` untouched and
`git status` clean for both; D1/D4/D6/D7 not fixed):
- `tauri.e2e.conf.json`: added `"identifier": "com.mobi.pos.e2e"`.
- `scripts/build-e2e.mjs`: preflight now REQUIRES the isolated identifier;
  stamps `E2E_GIT_SHA` into the binary (`e2e_build_info` serves it).
- `src-tauri/src/e2e.rs`: added `e2e_reset_and_seed` (smoke/money/stress/
  fault presets), `e2e_ledger_snapshot` (uses the app's own `audit_verify`),
  `e2e_run_invariants` (integrity/FK/receipt-uniq/negatives/orphans),
  `e2e_get_printed` (honest `captured:false` stub for 7.2),
  `e2e_build_info` (sha/profile/features/identifier/dataDir/sealed-mock/wall).
- `src-tauri/src/lib.rs`: registered the 6 new commands in the e2e branch
  only (production list byte-identical otherwise).
- `scripts/check-handler-parity.mjs` (new): production portions must match;
  passing (53 prod, 13 e2e-only).
- `wdio.conf.ts`: live snapshot/restore REMOVED; `.e2e` lifecycle
  (`POS_E2E_WIPE=1` clean-room), provenance guard (overlay id + prod
  `withGlobalTauri` absent + e2e-flavor binary), run manifest with git SHA.
  Auto-resolution now prefers `target-e2e` and defaults to debug.
- `e2e/lib/` (new): `oracle.ts` (HT-only BigInt, no tax), `money-parse.ts`
  (fr-DZ deterministic + Arabic-Indic), `invoke.ts`, `selectors.ts`
  (104-testids registry), `rng.ts`, `ledger.ts`.
- `test/specs/hello.e2e.ts`: assertions flipped to isolated mode + runtime
  `e2e_build_info` provenance check.

### 15.1 Gate 1 results

| Check | Result |
|---|---|
| `cargo check -p mobi-pos` / `--features e2e` | clean, both |
| `cargo build --release -p mobi-pos` | OK (1m59s) |
| `cargo clippy --all-targets` both flavors | 0 errors; 0 new warnings from Phase 1 code (2 `type_complexity` hits pre-existing; 1 `dead_code` `parse_tenders` pre-existing) |
| Release-clean: fresh 21.7 MB binary strings `wdio/webdriver/e2e_reset/e2e_seed/e2e_ledger/e2e_run_/e2e_get_sale/e2e_build/e2e_mirror` | **0 hits each** |
| `cargo tree -e features` (non-e2e) `wdio/e2e` | 0 mentions; `-i tauri-plugin-wdio-webdriver` unresolvable (not in graph) |
| `dist/` grep `wdio` | 0 hits (`__TAURI__` hits are pre-existing env-detection only) |
| `cargo test --release -p mobi-pos --lib` | **272/272** |
| Node `test_pos_math` / `test_money_fixes` / `test_receipt_math` | 135 + 13 + 18, all pass |
| `tsc -b` | clean |
| `npm run test:boundaries` | 21/23 — 2 failures PRE-EXISTING (tax-whitelist drift in `SettingsModal.tsx:1616-1620` + `test_zero_tax.mjs`; files untouched by Phase 1, fixing is out of scope) |
| Hello smoke vs isolated container (clean-room wipe, debug e2e + dev :1420) | **PASS** — setup→lock→dashboard; dbPath `com.mobi.pos.e2e\mobi_pos.db`; migrated **112**; integrity **ok**; `features=e2e`, `gatewayMode=sealed-mock`, `gitSha=03e62656…` == manifest |

### 15.2 Incident 2026-10-10 (wrong-binary shadowing — caught, hardened)

- Symptom: first hello attempt drove `target/release/mobi-pos.exe`
  (production, built minutes earlier for the strings proof) via the external
  driver; renderer disconnected in 28 s.
- Cause: auto-resolution preferred plain `target/` over `target-e2e/`, and
  the default wanted profile was `release`.
- Fixes: resolution prefers `target-e2e` first; default wanted profile is
  now `debug`; module-level hard throw on non-e2e binary without explicit
  override (in addition to the onPrepare provenance guard).
- Safety: real-DB forensics after the incident — `integrity_check ok`, zero
  `E2E-` transactions/receipts/shifts; the only 2 `E2E-` products
  (`E2E-N1/N9`) date to 2026-10-09 (real-data era, pre-existing).
  Lesson promoted: e2e flavor first in every resolver, never a production
  fallback.

---

## 16. Gate 2 verification (2026-10-10, Phase 2 — smoke S0–S15)

Suite: `test/specs/smoke/phase2-smoke.e2e.ts` (16 its, cumulative state with
delta assertions + `afterEach(assertLedgerClean)` + `clearCart`; documented
deviations: no per-test reseed — prohibitive with UI mirror reboots;
Autre/TPE/BaridiMob have NO selector in `PaymentModal.tsx:894-919`, so S7/S8
run on Espèces approve-once / underpay-refused; S12 is refresh (not kill);
S14 asserts the `captured:false` stub contract + stored-vs-oracle).

**3 consecutive greens, 0 retries** (`--bail 1`, `POS_E2E_WIPE=1` clean-room
each): 16/16, test-times 23.2 s / 22.5 s / 22.3 s; wall ~3.5 min/run
(boot+session dominated). Manifests (SHA `03e62656…` == HEAD) + logs in
`e2e/evidence/` (EV-001…003, INDEX.md). Bring-up fixes were spec-only
(S5 delta stock, S2 pad-clear + lock-absence proof, S11 `4\u202f000\u00a0DA`
regex, S13 D6-aware drawer composition). D7   observed both ways
(zSeen true once / false twice) — bypass log held.

---

## 17. Gate 3 verification (2026-10-10, Phase 3 — money correctness)

Artifacts: `scripts/generate-golden.mjs` → `e2e/golden/money-vectors.json`
v1 (11 display + 12 parse + 4 parseError + 28 invoice = 55 vectors, all
minor-unit strings); `e2e/lib/oracle.test.mts` (59 assertions);
`scripts/test_golden_parity.mts` (TS); `scripts/verify_golden_sample.py`
(Python Fraction); `src-tauri/tests/golden_parity.rs` (Rust integration,
frozen lib untouched); `test/specs/money/phase3-money.e2e.ts` (M1a–d, M2a/b,
M3, M4, M5, M6, M7); npm scripts `golden:generate`, `test:oracle`,
`test:golden`, `test:money:e2e`, `test:smoke`.

### 17.1 Parity results (Rust ≡ TS ≡ Golden, no exceptions)

oracle.test 59/59 · TS parity 55/55 · Python 50/55 (5 non-ASCII parse
vectors by design to Rust+TS only) · Rust harness 3/3. One near-miss
caught pre-harness: golden PE-02 expected reject of `"130.555"`, but BOTH
engines parse it as FR-grouped 130555 DA (pinned by `money.rs:334`) —
golden was wrong, engines agreed; fixed to P-012 + true-reject PE-02
(`"1.23.45"`). I-027 note: over-discount rejection lives at the app
boundary (asserted in e2e M6), not in Money arithmetic, on both sides.
`money.ts` / `money.rs` verified byte-frozen (`git status` clean).

### 17.2 WDIO money runs (2 consecutive 11/11, 0 retries)

EV-004/EV-005. Five-way per scenario (oracle ≡ UI echo ≡ stored ≡ printed
stub contract ≡ audit linkage+growth). Invariant→test map: ARITH-01→M1a–d,
ARITH-02→M2a, DISC-01→M2b, TENDER-01→M3, TENDER-02→M4, REFUND-01→M5,
ATOMIC-01→M6, CHAR-D2→M7. Could-not-test list: card-gateway paths (no
gateway in product), trilingual totals (single locale), fractional qty
(integer-only), printed-byte equality (stub until 7.2), head-anchored audit
in-container (shared keystore — §17.3).

### 17.3 Findings (app untouched; D-defects not fixed)

- F-AUDIT-SHARED-KEYSTORE: the OS keystore head (seq 674, production-sealed)
  can never anchor the `.e2e` container chain (8–9 links) — `audit_verify`
  reports `Broken("truncation suspected")` with FULL linkage (8/8, 9/9).
  `e2e_ledger_snapshot` maps Intact / Unsealed-full / truncation-suspected-
  full → ok (reason preserved); linkage-mismatch/partial → false. In-
  container safety = linkage-full + monotonic count + invariants.
  Head-anchored verification is a production/staging-gate activity.
- TI-REFUND-ONCE-REFUSED (transient, 1/5 money runs): one `refund_sale_atomic`
  refused with an unlogged code (logging landed after); the next 4 identical
  requests returned OK. Hypothesis: transient BUSY/lock at first post-boot
  refund. Bounded by code logging now in M5/M6; watch item for Phase 4.
- DOC drift corrected: cart-% manager gate is `>10%`
  (`DiscountModal.tsx:139`), not 20% (R-17 updated).
- M7 semantics pinned: 2×1-DA at 33.33% → ui=200 (per-line DA-unit
  `Math.round` zeroes sub-0.5-DA line discounts) vs single-shot 133 vs
  per-line-minor 134. Bounded [133,200], logged.

---

## 18. Pre-Phase-4 remediation: D6 and D4 (2026-10-10)

Both fixes were found PRESENT-but-unverified in the working tree (prior
session, uncommitted). This task verified them end-to-end; I changed no
production behavior (no money-file touches, D1/D7 still bypassed).

### D4 (pin_set updated_at) - VERIFIED, no new production code needed

`write_app_setting_json` (pin.rs:1063-1079) already upserts
`(key, value_json, updated_at=datetime('now','utc'))` with a comment
documenting the original omission; the test schema mirrors production DDL
(roster_db NOT NULL, no default). Plus an in-tree B4 boundary
(`supervisor_pin` step-up for manager re-key). Rust pin tests 28/28.
E2E proof: new `test/specs/pin-mint.e2e.ts` (EV-006) - legacy-hash roster
leads to `pin_set` minting `v2`, then `pin_verify` ok. The pre-fix symptom
(NOT NULL constraint failed: app_settings.updated_at) would fail the mint.

### D6 (shift open writes SQLite) - VERIFIED, no new production code needed

`shiftAdapter.startShift` is SQLite-first: device live-shift guard,
INSERT_SESSION_SQL + sessionParams, unique-index mapping to
SHIFT_ALREADY_OPEN, read-back verification, then Dexie + fireSync.
`logExpense` uses ensureSessionInSqlite + sync_parked_movements fallback;
close mirrors CLOSED. E2E proof: phase3 M5/M6 now pass the UI-opened Dexie
shift id as sqlShiftId (EV-008: refund OK, ALREADY_REFUNDED,
REFUND_EXCEEDS) - the seed shift and e2e_mirror_shift_open bridge are no
longer on the path. Regression: smoke 16/16 (EV-007), money 11/11
(EV-008), tsc -b clean. money.ts / money.rs confirmed byte-frozen.

---

## 19. Pre-Phase-4 remediation: D2, D5, D7 (2026-10-10, EV-009…012)

### D2 backfill (v107 + v113) — IMPLEMENTED + PROVEN

Code (`sqlPluginAdapter.ts`, `shiftAdapter.ts`, `App.tsx`):
- Probes: parked table, `warranty_months`, uq index via sqlite_master.
- Pass statements: warranty ALTER + parked CREATE (Rust-v113 byte shape) +
  parked index + uq index.
- Always-run loud `ensureShiftLedgerV113` (exported): the 3 DDL + warranty
  ALTER; duplicate-column warns, real failures console.error with a
  `schema.heal.v113.done` receipt latch (IPC-readable).
- `logExpense` parked fallback rewritten to the Rust envelope shape
  (`data_json`/`row_version`) — the old 12-column shape matched nothing
  and would have thrown against v113.
- Eager call in the App boot effect (after adoption): the backfill no
  longer depends on the lazy probe-gated heal or on surviving a BUSY
  abort mid-pass.

Findings that shaped it (all evidenced):
- The sqlx ledger LIES on upgraded DBs: old-shape table carrying rows
  1-113, so the migrator no-ops while v107 objects are absent. Object-
  existence probes (not ledger numbers) are the correct detector.
- The v113 migrator application was proven live (ledger 112→113, Rust-text
  parked DDL on a stripped fixture boot).
- Boot-heal verification needs a QUIESCED boot: 20 s bail-out runs die
  before the boot effect completes — the passing proof used a 100 s dwell
  (receipt `true` + `warranty_months` present, EV-012). Phase-4 suites must
  allow boot to complete before asserting (already the case).
- Open follow-up (no money impact): why the probe-gated pass appeared not
  to apply the warranty ALTER on short boots — likely BUSY-abort or
  never-reached; the eager loud block now covers it regardless.

### D5 — desktop PROVEN (C1 red→green, EV-009), mobile mask added

`MobileCheckoutTab handleApplyCustomQty` now hard-rejects `[.,]` like the
desktop mask (toast `Quantité invalide : entier uniquement`). Scanner
multiplier regex is digits-only (safe). No mobile e2e target exists to
prove the mask — flagged, same as before.

### D7 — S13 poll 100 ms (EV-010, Z seen)

Sampling-race mechanism from the audit stands (250–1600 ms view lifetime
vs 500 ms poll). No app change.

### Not committed this round

`test/specs/smoke/phase2-smoke.e2e.ts` remains untracked (Phase 3's money
spec was committed as 3fdd298 scope; smoke spec + D2/D5/D7 code edits above
are working-tree). `money.ts` / `money.rs` re-verified byte-frozen.

---

## 20. Gate 4 verification (2026-10-10, Phase 4 — stress/soak/fault)

Harness (all dep-free, no new dependencies): `scripts/test_money_properties.mts`
(Tier A node) · `src-tauri/tests/money_properties.rs` (Tier A Rust) ·
`src/main.tsx` `window.__posStress.runBatch` (VITE_E2E=1 only; prod dist
golf-proven absent) · `test/specs/stress/phase4-stress.e2e.ts` (B1/B2/B3/B4) ·
`phase4-close.e2e.ts` (T-B4s small-scale) · `phase4-race.e2e.ts` (isolated
parallel race) · `phase4-soak.e2e.ts` (C1 burst + C2 loop) ·
`scripts/sample-proc.mjs` · `phase4-fault.e2e.ts` + `scripts/fault-kill.mjs`
+ `scripts/fault-campaign.mjs` + `scripts/check-atomicity.mjs`.
New npm scripts: `test:smoke`, `test:money:e2e`, `golden:generate`,
`test:oracle`, `test:golden` (package.json still working-tree).

### Results (EV-013…017)

- Tier A: node 100k x P1-P7 green; Rust 4 x 100k green (seed 20260410).
- Tier B (N=1000, seed 20260410, DEBUG profile — functional signal only):
  B1 1000/1000, p50=480.8ms p95=509.4 p99=531.5, ledger exact, receipts
  unique, stocks non-negative; B2 5/8 sold, STOCK_EMPTY exact, stock 0;
  B3 1xOK + 5xREFUND_EXCEEDS, single refund row. B4@1000 STALLED (>25 min,
  defect below); B4s@60 green incl. NO_ACTIVE_SHIFT refusal.
- Tier C: 30/30 UI burst exact; 1021 soak sales/12 min, ledger clean every
  5th; sampler 25 samples, RSS 65.2→72.6 MB drift 11.4% PASS, handles
  614→616. Full 200-sale/60-min shape is nightly (same spec, POS_SOAK_MIN).
- Tier D: 12 cycles (seed 20260410), 9 survivors green, 3 kills landed,
  12/12 atomicity CLEAN (integrity ok, no headless/orphan/negative/dup).
- Race probe (isolated): 3 parallel native refunds → exactly one OK +
  2xREFUND_EXCEEDS, no stall, ledger clean.

### Defects / anomalies

- **P1 PERF (new): shift-close stall after volume.** Identical close flow
  greens at 60 sales (32 s, T-B4s) but never completes in 25 min after 1000
  sales (T-B4). Suspects: getInventoryValuation/getAllShifts scaling,
  close-modal live recompute over 1000 rows, mirror convergence. Needs
  profiling + a close-time budget before release. Logic itself proven.
- **Native contention stall (bounded, contained):** one 6-parallel refund
  execute unsettled (session wedged for later commands); fan-out-3 probe
  resolves cleanly. Refund bursts above ~3 parallel callers need backoff
  semantics or a documented concurrency limit — owner call.
- **Runner notes (fixed in-tree):** mocha ignores per-test timeout args in
  this runner (suite `this.timeout` wins); `tauri build` serves the bundled
  frontend, NOT devUrl (wdio.conf comment corrected — vite was never
  needed for e2e); VITE_E2E=1 stamps the e2e bundle (build-e2e.mjs).
- 10k-sale Tier B, 60-min soak, 100-cycle fault: nightly shapes, same
  harness (STRESS_SALES / POS_SOAK_MIN / --cycles).

## 21. Gate 4.4 re-verification (2026-10-12, EV-018/018b/019) — both P4 anomalies closed

Re-ran the Phase 4 Tier B gate after the harness fix below. SHA `f25d5b9` dirty,
seed `20260410`, `POS_E2E_WIPE=1`, DEBUG e2e profile (functional signal only).

### Root cause — `ALREADY_PROCESSING` storm at N≥100 (harness, not app)

The storm was **not** an app defect. `browser.execute` on an async callback that
runs longer than the WebDriver page **script timeout (~30 s)** is re-invoked by
the driver while the ORIGINAL async wrapper is still executing in the page.
Instrumented proof (`window.__batchDiag`, since reverted): two entries with the
identical wrapper stack `Object.runBatch ← async <anonymous>:55:42`, **30326 ms
apart**, overlapping (`__ppActive` reached 2); CALL1 ran clean sales 0→59, CALL2
restarted at sale 0 and raced all 100 against the single-flight guard still held
by CALL1 → every call denied at 1–7 ms. A 100-sale execute at ~0.47 s/sale ≈ 47 s
> 30 s, so it always tripped; a 30-sale run (≈14 s) never did (why T-B1@30 was
green). The result array returned to the test was nondeterministically CALL1's
(partial ok) or CALL2's (all denied) — explaining the 0/100 … 63/100 variance.
The app's guard behaved exactly as designed (fail-closed; no double-book; the
ledger stayed consistent — T-B4 variance was already 0 at N=30).

**Fix (harness only):** `phase4-stress.e2e.ts` `runBatch` and the close-spec
loop now chunk `browser.execute` to **20 sales per call** (~9 s), awaiting
between calls; order preserved by concatenation. Each execute stays well under
the script timeout, so one `processPayment` stream reaches the guard at a time.
No `src/` change was needed for the storm.

### Results (all green)

- **T-B1 1000/1000 ok**, p50=479.1 ms p95=517.6 p99=544.4 **`ms>5000=0`**,
  receipts unique, ledger exact, stocks ≥0 — 8 m 27 s (EV-018).
- **T-B2** oversell guard 5/8 sold, `STOCK_EMPTY`; **T-B3** 1×OK + 5×
  `REFUND_EXCEEDS`, single refund row (EV-018).
- **T-B4** booked `expected=6706500 counted=6706500` **variance=0**; post-close
  sale `NO_ACTIVE_SHIFT` (EV-018). ⇒ **P1 PERF shift-close stall CLOSED.**
- **T-B4s close isolation** (60 sales + UI close): 60/60 ok, **close duration
  124 ms** («10 s budget), post-close `NO_ACTIVE_SHIFT` (EV-018b).
- **Race probe, 6-parallel native refunds:** exactly one `OK` + 5×
  `REFUND_EXCEEDS:E2E-STR-A:requested=2:remaining=0`, **no stall**, 6 s
  (EV-019). ⇒ **native 6-way contention no longer wedges** (prior §20 note
  observed a 6-parallel stall; now resolves cleanly — the Rust BUSY-retry loop
  fixed it).
