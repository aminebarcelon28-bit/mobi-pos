# formatDZD caller inventory — staged for Stage E (C-5.2)

Status: INVENTORY ONLY. No callers migrated. `formatDZD` (`src/types/pos.ts:1652`,
Intl-based) stays canonical until Stage E migrates each site to `Money.format`.

## Why migration is mechanical but not trivial

1. **Grouping behavior differs.** `formatDZD` uses Intl grouping
   ("1 000 000 DA"-style with narrow spaces); `Money.format` renders plain
   digits ("1000000.00 DA"). Stage E decides per surface whether to add
   grouping to the formatter or keep plain — a product decision, default keep
   plain unless the owner asks otherwise.
2. **Whole-amount behavior differs (C-3).** `formatDZD` renders whole dinars
   with ZERO decimals ("100 DA"); PD-23 requires "100.00 DA". This is why the
   Gate 1 hardware check (post-1b-i) asserts only: no tax line + half-dinar
   "130.50 DA" + no visual regression — while the full PD-23 whole-amount
   check ("100.00 DA") is a Stage E EXIT check with a second hardware print.
3. **Values change unit.** Every site below currently receives FLOAT dinars;
   after Stage E it receives integer minor units. Swap = change the VALUE
   passed (minor) + the formatter (`Money.format`), never formatDZD(minor).

## Natural seam

`src/components/ui/MoneyDisplay.tsx` (1 call site) — the shared display
component. If all 59 files route through it by Stage E, the swap is one file.

## Per-file call counts (59 files, 675 sites — counted, not estimated)

Receipt / print paths (migrate first — paper truth):
`src/utils/mobileDocPrint.ts` 79, `src/utils/escpos.ts` 32,
`src/components/receipt/ReceiptPaper.tsx` 15, `src/components/receipt/ZReportPaper.tsx` 24,
`src/utils/tradeInVoucherBuilder.ts` 9, `src/utils/savRestitutionBuilder.ts` 7,
`src/utils/debtStatementTicketBuilder.ts` 3, `src/utils/productLabelBuilder.ts` 3,
`src/utils/savTicketBuilder.ts` 3, `src/utils/labelImageBuilder.ts` 1.

Checkout UI: `src/components/mobile/tabs/MobileCheckoutTab.tsx` 44,
`src/components/modals/PaymentModal.tsx` 39, `src/components/CartPanel.tsx` 30,
`src/components/mobile/M3CartProtectionModal.tsx` 1,
`src/components/modals/CustomItemModal.tsx` 1, `src/components/modals/HoldSalesModal.tsx` 1,
`src/components/ui/MoneyDisplay.tsx` 1, `src/components/Header.tsx` 1.

Reports / analytics: `src/components/modals/ReportsModal.tsx` 56,
`src/components/modals/ShiftZReportModal.tsx` 21, `src/components/modals/ShiftCloseModal.tsx` 17,
`src/components/reports/SalesAnalyticsCharts.tsx` 3,
`src/components/mobile/tabs/LiveActivityTab.tsx` 10.

Operations modals: `src/components/modals/CustomersModal.tsx` 28,
`src/components/modals/RepairWorkOrderModal.tsx` 23, `src/components/modals/DebtLedgerModal.tsx` 18,
`src/components/modals/RefundModal.tsx` 14, `src/components/ProductCatalog.tsx` 11,
`src/components/modals/PurchaseOrderModal.tsx` 10, `src/components/modals/TradeInBuybackModal.tsx` 10,
`src/components/modals/InventoryManagerModal.tsx` 9, `src/components/modals/ExpenseManagerModal.tsx` 6,
`src/components/modals/KittingBundleModal.tsx` 6, `src/components/modals/ProductEditorModal.tsx` 6,
`src/components/modals/ShiftOpenModal.tsx` 6, `src/components/modals/CustomerDisplayModal.tsx` 5,
`src/components/modals/VoucherModal.tsx` 4, `src/components/modals/DiscountModal.tsx` 3,
`src/components/modals/LabelPrinterModal.tsx` 3, `src/components/modals/PurchaseOrderA4Document.tsx` 3,
`src/components/modals/LoyaltyCardModal.tsx` 2, `src/components/modals/ProductMatrixModal.tsx` 2,
`src/components/modals/CompatibilityModal.tsx` 1, `src/components/modals/ShiftMovementModal.tsx` 1,
`src/components/modals/InvoiceIngestionModal.tsx` 1, `src/components/modals/SettingsModal.tsx` 4.

Slices / services (toast + log strings): `src/store/slices/createOrderSlice.ts` 6,
`src/store/slices/createProcurementSlice.ts` 4, `src/utils/savQuoteBuilder.ts` 4,
`src/utils/disputeGenerator.ts` 16, `src/components/po/VendorDisputeModal.tsx` 5,
`src/components/po/BarcodeStagingModal.tsx` 2,
`src/components/replenishment/SupplierCard.tsx` 3,
`src/components/replenishment/ReplenishmentContainer.tsx` 2,
`src/components/mobile/tabs/KredyTab.tsx` 4,
`src/components/mobile/tabs/CatalogSearchTab.tsx` 3,
`src/components/modals/CommandTicketDashboardModal.tsx` 15,
`src/utils/businessLogic.test.ts` 5 (test expectations — update with Stage E).

PoReviewScreen (29) is supplier-side; its tax lines delete in 1b-i (§10-B),
its remaining money lines migrate here.

## Exit rule (Stage E)

Zero `formatDZD(` calls outside `src/types/pos.ts` definition + this doc's
history. The C5 grep proof (zero tax refs) is extended with a formatDZD
zero-call proof at Stage F contract.
