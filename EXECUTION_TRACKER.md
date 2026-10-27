# Mobi-POS Autonomous Execution Tracker (Sprints 1 to 5)

## SPRINT 1: DATA AUTHORITY, SCHEMA SYNC & FINANCIAL MATH INTEGRITY

- [x] **Task 1.1 — Fix SQLite Version Drift & Remote Sync Schema:**
  - In `src-tauri/src/lib.rs:293`, update `EXPECTED_MAX_DB_USER_VERSION` from `112` to `113` to match Migration `113` (`lib.rs:1719-1748`).
  - In `src/sync/remoteSchema.ts:20-44`, add `'sale_batch_allocations'` to `ALL_REMOTE_SYNC_TABLES` and `GENERIC_SYNC_TABLES` so cloud pull/repair sync downloads FIFO batch allocations.
  - Delete the 0-byte orphan test `scripts/test_report_row_profit_6100.mts` and dead mock files `src/components/replenishment/mockData.ts` and `src/components/replenishment/ReplenishmentDemo.tsx` (updating any stray imports).

- [x] **Task 1.2 — Eliminate Dexie-Only Offline Data Evaporation (`operationsAdapter.ts` & `shiftAdapter.ts`):**
  - In `src/db/adapters/operationsAdapter.ts:64-108`, update `saveRepairOrder`, `savePurchaseOrder`, `saveTradeIn`, and `saveIMEIRecord` to write synchronously to local SQLite (`mobi_pos.db`) using `INSERT ... ON CONFLICT(id) DO UPDATE` before mirroring to `dexieDb` and calling `fireSync` (so `src-tauri/src/refund.rs:970-988` can locate `imei_records` in SQLite).
  - In `src/db/adapters/shiftAdapter.ts:276-314`, update `saveStoreExpense` and `saveCashDrop` / `getCashDrops` to persist and read from local SQLite (`store_expenses` and `cash_drops`) first under Tauri before mirroring to `dexieDb`.

- [x] **Task 1.3 — Invert Customer Cache Priority & Persist `pointBuckets` (`customerAdapter.ts`):**
  - In `src/db/adapters/customerAdapter.ts:217-224` (`getAllCustomers`), query local SQLite `customers` first when `isTauriEnv()` is true, updating `dexieDb.customers` as a derived cache.
  - Ensure `Customer.pointBuckets` (`src/types/pos.ts:369`) is serialized and restored in SQLite `customers` (`json_payload` / column) so FIFO loyalty point expiration survives app reloads.

- [x] **Task 1.4 — Fix Initial FIFO `stock_batches` Creation Across All Product & PO Entry Points:**
  - When creating a new product with `stock > 0` (`src/store/slices/createCatalogSlice.ts:191` / `src/db/sqlPluginAdapter.ts:2947`), insert an initial `stock_batches` row (`quantity_initial = stock`, `quantity_remaining = stock`, `unit_cost = costPrice`) inside the same transaction.
  - In `src/db/sqlPluginAdapter.ts:3078-3174` (`syncProductUpsertBulk` called by `ProductMatrixModal.tsx:292`), insert initial `stock_batches` rows for every new variant with `stock > 0`.
  - In `src/components/modals/InvoiceIngestionModal.tsx:586-594` (Tab 2 CSV import), persist batches to SQLite via `sqliteAdapter.insertStockBatch` (or route through `validateAndReceivePO`) instead of writing only to `dexieDb.stockBatches`.
  - In `src/components/PoReviewScreen.tsx:724-782` and `src-tauri/src/commands.rs:215-352` (`po_commit_stock_batch`), ensure committing a scanned batch increments `products.version`, enqueues `sync_outbox` entries, and refreshes Zustand `products` and Dexie on success (not only inside `catch`).

- [x] **Task 1.5 — Unify the 6 Divergent Cash Drawer & Profit Math Formulas:**
  - In `src/db/adapters/shiftAdapter.ts:624-679` (`closeShift`), fix `dailyNetProfit` (`line 679`) so cash `StoreExpense` is not subtracted twice (`expenses` + `storeExpensesTotal`) and safe `cashDrops` / capitalized `tradeIns` are not deducted as P&L losses.
  - In `src/components/modals/ReportsModal.tsx:259-275`, stop subtracting `'Achat Marchandises / Fournisseur'` (already in FIFO COGS) and `'Perte Stock / SAV'` (already in `netCogs`) inside `totalOperatingExpenses`.
  - Route `ReportsModal.tsx:310-359`, `ShiftCloseModal.tsx:132-172, 413-440`, `createShiftSlice.ts:226-254` (`printXReport`), and `ShiftZReportModal.tsx` (`cashTerms.ts:274-276`) through the unified `buildZSnapshot` logic (`zReportSnapshot.ts`), using `'SAV_ACOMPTE'` cash movements instead of raw `RepairOrder.depositAmount`.
  - In `src/components/receipt/ZReportPaper.tsx:96-111`, render `manualIn`, `manualOut`, and `exchangeOut` rows so printed lines sum exactly to `Total Espèces Attendu`.

- [x] **Task 1.6 — Add Missing Composite SQLite Indexes:**
  - Add an idempotent migration creating `idx_txn_cust_date`, `idx_txn_shift_status`, `idx_prod_stock_alert`, and `idx_outbox_signed_drain` (and bump `EXPECTED_MAX_DB_USER_VERSION` accordingly).

---

## SPRINT 2: P0 BROKEN CORE WORKFLOWS (CHECKOUT, REFUNDS, SAV, TRADE-INS & MODALS)

- [x] **Task 2.1 — Fix Modal Mount Collisions & Premature Unmounts:**
  - In `src/components/Header.tsx:796-799`, remove the duplicate `<ReplenishmentContainer />` mount and local state; route the header bell through `openModal('vendor_procurement')` (`GlobalModalHost.tsx:74`).
  - In `src/store/slices/createShiftSlice.ts:116`, remove `activeModal: null` from `logCashMovement` so `DebtLedgerModal.tsx` does not unmount mid-repayment.
  - In `src/components/modals/DebtLedgerModal.tsx:240-286, 844`, wire `"Valider & Imprimer Reçu"` (`handleConfirmRepayment`) to actually trigger thermal/A4 repayment receipt printing.

- [x] **Task 2.2 — Fix Checkout Credit Guardrail, Refund Collisions & Defective Write-Offs:**
  - In `src/components/CartPanel.tsx:1481-1488`, update the `"Appliquer Avoir"` button to use `calculateMaxAllowedCredit(cart, currentCustomer.storeCredit, 50, voucherCreditApplied)` so quick-cash bill checkout (`lines 623-689`) never aborts with `INSUFFICIENT_CASH`.
  - In `src/components/modals/RefundModal.tsx:48-50, 195-200, 225-240, 682-685`, key `selectedItemIds`, `refundQuantities`, and `restockMap` by unique line key (`saleItemId` / line index) instead of `item.product.id`, and pass actual active cashier & verified supervisor IDs instead of hardcoded `'Manager'` (`lines 386-388`).
  - In `src/store/slices/createOrderSlice.ts:2793, 2833-2944`, move the defective return `addStoreExpense({ category: 'Perte Stock / SAV', ... })` write-off so it executes in Tauri AND when `restocked.length === 0` (pure-defective returns).

- [x] **Task 2.3 — Close SAV Unpaid `'Livré'` Bypass & Fix SAV Deposit Accounting:**
  - In `src/components/modals/RepairWorkOrderModal.tsx:1114-1126, 2065-2076`, block selecting `'Livré'` directly via `updateRepairOrderStatus` when `remainingBalance > 0` (route through `markRepairDelivered` in `createRepairSlice.ts:366-372`).
  - In `RepairWorkOrderModal.tsx:642-662` (`handleZeroBalanceDeliver`), record a `SaleTransaction` when a 100%-prepaid repair is delivered so revenue and COGS are tracked.
  - In `src/store/slices/createRepairSlice.ts:198-344`, log cash movement deltas when `depositAmount` is edited and reverse/refund deposits when a repair is set to `'Annulé'`.
  - Fix the restitution QR payload in `RepairWorkOrderModal.tsx:983-986, 1183-1196` to encode `order.ticketNumber` (`SAV-...`) so `useBarcodeScanner.ts:171` recognizes it.

- [x] **Task 2.4 — Fix Trade-In Cost Inflation, Duplicate Serial Check & Catalog Visibility:**
  - In `src/components/modals/TradeInBuybackModal.tsx:274, 439`, pass base `buybackValue` (excluding the `+10%` standalone wallet bonus) as the inventory `costPrice` / `stock_batches.unitCost`, applying the `+10%` bonus only to the customer's `storeCredit`.
  - In `TradeInBuybackModal.tsx:254-260, 289-297`, enforce `imeiDuplicate` blocking even for non-15-digit serial numbers.
  - In `src/components/ProductCatalog.tsx:16-24` and `src/components/modals/ProductEditorModal.tsx:48-56`, include missing categories (`"Téléphones d'Occasion (Reprise)"`, `'Audio'`, `'Supports'`, `'Batteries Externes'`, `'Services'`).

- [x] **Task 2.5 — Fix Destructive UI Bugs in Product Editor, Hold Sales, Shift Open & Hardware Actions:**
  - In `src/components/modals/ProductEditorModal.tsx:280, 339, 356, 458, 508`, preserve existing `editingProduct.imageUrl` instead of overwriting with `''`, and pass the saved product ID when `autoPrintLabel` (`line 472`) opens `label_printer` (`LabelPrinterModal.tsx:78-86`).
  - In `src/components/modals/LabelPrinterModal.tsx:123-135`, pass `showModel` to `directPrintProductLabels`, and in `src/components/po/BarcodeStagingModal.tsx:81-87, 240-253`, replace the fake 42-bar SVG and `window.print()` with real barcode rendering and `directPrintProductLabels`.
  - In `src/components/modals/HoldSalesModal.tsx:164-230`, wire a Delete/Discard button to `deleteHeldSale`; in `src/store/slices/createCartSlice.ts:505-512`, save/clear `stagedTradeIn` and `voucherCode` on hold/resume; in `src/components/BottomBar.tsx:123-130`, open `openModal('hold')` when clicking `F6 Attente` with an empty cart and `heldSales.length > 0`.
  - In `src/components/modals/ShiftOpenModal.tsx:80-119`, add the missing `else if (amount === 30000)` branch in `handlePreset`.
  - In `src/components/Header.tsx:221-235` and `src/components/mobile/tabs/ManagementTab.tsx:115-132`, call `openCashDrawerViaSpooler()` / `openThermalCashDrawer()` on "No Sale" drawer open, and show the drawer pulse badge in `ReceiptModal.tsx:172-174` only when a drawer pulse actually fired.
  - In `src/components/modals/DatabaseMaintenanceModal.tsx:103-107, 267-293`, gate `loadStats()` on `maintUnlocked === true` and replace the broken `v1.5.8` export with `usePosStore.getState().exportDatabase()`.
  - In `src/components/modals/ReportsModal.tsx:1651-1656`, `await deleteStoreExpense(exp.id)` and check `res.reason === 'CLOSED_SESSION_IMMUTABLE'` before toasting.
  - In `src/components/replenishment/ReplenishmentContainer.tsx:107-161`, merge suppliers that have active `purchaseOrders` even when they have zero low-stock alerts, and in `src/components/modals/CommandTicketDashboardModal.tsx:413-422`, look up `vendorDirectory[po.vendorName]?.phone` instead of `'0550001111'`.

---

## SPRINT 3: NATIVE RUST ATOMIC CHECKOUT (`src-tauri/src/checkout.rs`)

- [x] **Task 3.1 — Implement Native `checkout_sale_atomic` in `src-tauri/src/checkout.rs`:**
  - Mirror `src-tauri/src/refund.rs` to execute oversell validation (via batched CTE), FIFO `stock_batches` depletion, `sale_batch_allocations` insertion, `transactions` & `transaction_items` insertion, `inventory_ledger` logging, customer debt/credit updates, and `sync_outbox` enqueueing inside a single native `rusqlite` `TransactionBehavior::Immediate` transaction (< 5ms lock time).
- [x] **Task 3.2 — Wire `sqlPluginAdapter.ts` (`writeCheckoutAtomicInner`) to `checkout_sale_atomic`:**
  - Replace the 50–100+ IPC round-trip loop in `src/db/sqlPluginAdapter.ts:1120-1670` with a single Tauri `invoke('checkout_sale_atomic', ...)` call while preserving existing replay/idempotency guarantees and test compatibility.

---

## SPRINT 4: P1 DAILY POS OPERATIONAL CAPABILITIES

- [x] **Task 4.1 — Multi-Tender Checkout (`CIB / Edahabia`, `BaridiMob`, `Chèque`) & Mobile Checkout Parity:**
  - Add `'CIB / Edahabia'`, `'BaridiMob'`, and `'Chèque'` tender types to `PaymentModal.tsx:900-925` and `MobileCheckoutTab.tsx:917-946`, and add UI controls in `MobileCheckoutTab.tsx:866-881` to apply customer `storeCredit` (`Avoir`), `CreditVoucher` (`Bon d'Avoir`), and stage a `TradeIn`.
- [x] **Task 4.2 — Scan-to-Refund Receipt Barcodes & In-Modal Scanner Routing:**
  - Update `src/hooks/useBarcodeScanner.ts:193-282` to match scanned `transaction.id` barcodes and open `RefundModal` with that sale loaded, and route scans when `RefundModal` or `VoucherModal` is active.
- [x] **Task 4.3 — SAV Spare Parts Inventory Consumption:**
  - Extend `RepairWorkOrderModal.tsx:1847-1853` and `createRepairSlice.ts` so technicians can select spare-part SKUs from `products`, deducting FIFO `stock_batches` and logging `inventory_ledger` entries on repair completion.
- [x] **Task 4.4 — Stock-IMEI Picker at Checkout & Serialized PO Receiving:**
  - Add an unsold `imei_records` dropdown/autocomplete in `CartPanel.tsx:1218-1240` and `PaymentModal.tsx:1118-1140`, and add IMEI capture + `supplierInvoiceNo` / `discrepancyReasons` persistence in `CommandTicketDashboardModal.tsx:356-361, 1096-1158`.
- [x] **Task 4.5 — Unified Customer 360 View & Credit Limit (`debtLimit`) Controls:**
  - Link `RepairOrder` to `customerId`, add tabs in `CustomersModal.tsx:754-923` for Repairs, Trade-Ins, Vouchers, Debt Ledger, and Loyalty Ledger, expose `debtLimit` editing (`lines 1184-1219`), and wire UI buttons for `issueStoreCredit`, `redeemLoyaltyPoints`, and `adjustCustomerPoints`.
- [x] **Task 4.6 — Interactive Sync Conflict Resolution Modal & Bulk Label Queue:**
  - Build `src/components/modals/ConflictResolutionModal.tsx` wired to `sync_conflicts` with side-by-side diffing, tiebreak status, single & batch arbitration, and filter controls. Added backend helpers in `src/sync/conflictWatch.ts`, registered modal in `GlobalModalHost.tsx`, and wired launcher button in `CloudSyncPanel.tsx`. Upgraded `LabelPrinterModal.tsx` to support multi-SKU batch label queues with quantity steppers, per-SKU removal, live queue counter, single vs queue mode toggling, and automated batch print loop.

---

## SPRINT 5: FRONTEND MONOLITH DECOMPOSITION, VIRTUALIZATION & P2 HARDENING

- [x] **Task 5.1 — Decompose `SettingsModal.tsx` (3,713 lines) & Wire Real Hardware/Settings:**
  - Split `SettingsModal.tsx` into modular tab components under `src/components/modals/settings/` (`GeneralSettingsTab`, `HardwareSettingsTab`, `SecuritySettingsTab`, `CloudSyncSettingsTab`, `DiagnosticsSettingsTab`, `LoyaltySettingsTab`, `BackupSettingsTab`, `UpdatesSettingsTab`).
  - Wired `scanHardwareDevices` (`hardware_scan_devices`), real printer routing configuration, real SQLite WAL/outbox/hardware/security probes (eliminating `Math.random()` simulation).
  - Exposed UI inputs for `baridimobRip`, `ccpAccount`, `bankBeneficiaryName`, `paperWidth`, `kickCashDrawerOnCash`, `storeSubheader`, `categoryMultipliers`, `activeCampaigns`, and `loyaltyVisible`.
  - Wired native encrypted backup APIs (`createDatabaseBackup`, `listDatabaseBackups`, `pruneSnapshots`, `decryptSnapshotForRecovery`) and `sqlite_db_maintenance` (WAL checkpoint + vacuum + optimize) into `DatabaseMaintenanceModal.tsx` and `BackupSettingsTab.tsx`.
  - Updated `ReceiptPaper.tsx`, `ReceiptModal.tsx`, `ImeiWarrantyInspectorModal.tsx`, and `Header.tsx` to honor `paperWidth` and `loyaltyVisible`.
- [x] **Task 5.2 — Virtualize High-Density Lists & Eliminate Cascading Render Warnings:**
  - Integrated `@tanstack/react-virtual` in `CustomersModal.tsx` (pair-row virtualization) and `InventoryManagerModal.tsx` (table spacer rows for Catalog and Stocktake modes).
  - Eliminated all `react(set-state-in-effect)` cascading render warnings across the entire codebase using React Compiler render-time state synchronization, async IIFE promise cancellation, and deferred timing.
  - Enhanced `ModalShell.tsx` with WCAG 2.1.2 focus trapping (`Tab`/`Shift+Tab` cycling) and `Escape` key dismissal.
- [x] **Task 5.3 — Blind Shift Close, Blind Stocktake & Manager PIN Hardening:**
  - Concealed expected cash KPIs in `ShiftZReportModal.tsx` behind locked blind physical count and wired direct shift closure and Z-ticket printing; persisted full DZD opening & closing denomination billetage in `ShiftOpenModal` / `ShiftCloseModal` (`closingDenominations` serialized to `cash_sessions` SQLite + Dexie).
  - Added option on `EXPENSE` drawer movements in `ShiftMovementModal.tsx` to auto-record linked `StoreExpense` (`paymentMethod: 'Espèces'`).
  - Added Manager-controlled "Blind Count / Inventaire à l'aveugle" mode in `InventoryManagerModal.tsx` concealing theoretical stock, variance, impact and `= Conforme` button until count submission, and upgraded header inventory valuation to compute FIFO `stock_batches` (`quantityRemaining * unitCost`).
  - Protected standalone `CreditVoucher` issuance in `VoucherModal.tsx` behind Manager PIN verification (`verifyManagerGate`) with drawer cash intake (`DEPOSIT` movement) or courtesy funding, and rendered real `<canvas>` barcode on preview ticket card.
  - Required Manager PIN on in-cart returns (`toggleCartItemReturn`), and restituted FIFO `stock_batches` in SQLite and Dexie on return cart items (`createOrderSlice.ts`).
  - Removed arbitrary SKU fallback in `KittingBundleModal.tsx` and locked bundle items in cart with `bundleGroupId` so removing or modifying a member revokes bundle discounts.
- [x] **Task 5.4 — Customer Display Route, Supplier AP & Final Audit Verification:**
  - Added dedicated `/customer-display` BroadcastChannel receiver view in `src/components/CustomerDisplayScreen.tsx` and lightweight router in `src/App.tsx`.
  - Added live store-level broadcaster in `src/App.tsx` publishing live cart state via `computeCartTotals` (supporting returns, trade-ins, and credits) and driving hardware 2-line VFD pole displays via `MobilePosRoutingEngine.routeVfdUpdate` (`hardware_update_vfd`).
  - Fixed completed purchase orders in `PurchaseOrderModal.tsx` to conditionally display `"Charge enregistrée"` only when `autoRecordExpense === true`, and render amber `"Crédit fournisseur (À payer: ...)"` with 1-click `"Régler charge"` action when false.
  - Added Supplier Accounts Payable (AP) aggregate KPI banner on the completed POs tab tracking total unpaid credit balance and pending invoice count.
  - Hardened `VendorDisputeModal.tsx` to resolve supplier phone numbers from `vendorDirectory` or procurement contacts, sync edited contacts back to `vendorDirectory`, and persist itemized dispute claims to `localStorage` and Dexie `appSettings` with a visible `"Litige Enregistré"` badge.
  - Updated `ReportsModal.tsx` to pass `dateRangeFilter` and `dateFilteredTransactions` into `<SalesAnalyticsCharts />`, and enhanced `SalesAnalyticsCharts.tsx` with a "Top Produits & Marges Réelles (FIFO)" performance table calculating product margins from historical `unitCostAtSale` and accounting for returns/refunds.
  - Executed full verification battery: `npx tsc --noEmit` (0 errors), `npx oxlint` (0 errors), `cargo test` (289/289 passed), `npm run test:money` (159/159 passed), `npm run test:audit` (passed), `npm run test:sync-e2e` (18/18 passed).

---

## 🏆 ROADMAP STATUS: 100% COMPLETED (SPRINTS 1 TO 5 FULLY DELIVERED & VERIFIED)
- **Total Sprints**: 5 / 5 Complete
- **Total Tasks**: 20 / 20 Complete
- **Self-Verifying Loop**: 100% passing across all TypeScript, Oxlint, Rust, Money, Audit, and Sync test suites.

