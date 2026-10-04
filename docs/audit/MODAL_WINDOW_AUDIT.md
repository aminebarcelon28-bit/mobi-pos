# Exhaustive UI Window/Modal/Screen Audit — Mobi-POS Enterprise

> Generated from a screen-by-screen code audit. Machine registry: `scripts/audit-window-registry.mjs`
> (`node scripts/audit-window-registry.mjs`). Re-run after every refactor; the script exits
> non-zero on structural failures (missing guard/mount/close, invalid `z-60`, non-portaled menus).
> Audit date: 2026-09-29. Scope: **55 overlays** (40 in `src/components/modals/`, 15 shells/popovers/screens).

---

## 1. Global Window Architecture Overview

### 1.1 Mount system

- **Single-mount host.** Every modal renders in place via `src/components/GlobalModalHost.tsx`,
  wrapped in `Suspense` + `ErrorBoundary`, gated on the `activeModal` store key
  (`src/store/*` UISlice). Each modal self-guards with `if (activeModal !== '<key>') return null`
  (two files use the `const isOpen = activeModal === '<key>'` + `if (!isOpen) return null` form:
  `SecurityAuditModal.tsx:171,458`; `CloudPairingModal` relies on the host conditional alone).
- **No UI library.** No Radix/Headless UI. Overlays are hand-rolled `fixed inset-0` veils +
  flex column cards. The only two `createPortal(..., document.body)` usages in the repo are
  `Header.tsx:419` (tools menu) and `VendorProcurementModal.tsx:1491` (overflow menu).
- **Trigger fan-out.** `openModal('<key>')` originates from `Header.tsx` (tools grid + shift
  buttons + voucher shortcut), `BottomBar.tsx` (payment, customers, discount, hotkey guide,
  reports, inventory, refund, settings, db_maintenance), `CartPanel.tsx` (payment, customers),
  `ManagementTab.tsx` (20+ module entries), `CompanionHeader.tsx` (settings, procurement,
  ingestion), `useKeyboardHotkeys.ts` (payment, customers, discount, hold, hotkey_guide,
  custom_item, inventory_manager, refund, settings), plus modal-to-modal chains
  (procurement <-> purchase_order <-> command_tickets, repair_work_order, debt_ledger).
  A pre-existing connectivity checker lives at `src/utils/runModalAccessibilityAudit.cjs`
  (guard/mount/trigger/close only — no layout vectors; superseded by the registry script).

### 1.2 Universal presentation pattern (the good baseline)

~32 of 40 modals share one shell grammar (deviations are flagged per-window below):

```tsx
<div onClick={closeModal} className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center p-0 sm:p-4 ...">
  <div onClick={(e) => e.stopPropagation()} className="bg-pos-panel border ... rounded-t-3xl sm:rounded-2xl w-full max-w-* overflow-hidden flex flex-col h-[94vh] sm:h-[90vh] ...">
    <div className="... border-b bg-pos-card shrink-0">header + X right</div>
    <div className="flex-1 overflow-y-auto">body</div>
    <div className="... border-t bg-pos-card shrink-0">footer</div>
  </div>
</div>
```

Headers/footers stay pinned via flex `shrink-0` (not `sticky`) — correct as long as the card
is `overflow-hidden flex-col` with exactly one `flex-1` scroller.

### 1.3 Systemic bugs affecting multiple windows at once

| # | Defect | Blast radius | Fix (one-shot) |
|---|--------|--------------|----------------|
| S1 | **Invalid bare `z-60`** (no Tailwind utility → computes to `auto`). Files: `CommandTicketDashboardModal.tsx:1042`, `DebtLedgerModal.tsx:587,706`, `ExpenseManagerModal.tsx:430`, `ActivationGateScreen.tsx:310` | 4 nested dialogs silently fail to overlay their `z-50` parents | Replace-all `z-60` → `z-[60]` (4 files, 5 lines) |
| S2 | **Toast + PinDialog buried at `z-50`** (`Toast.tsx:104`, `PinDialog.tsx:108` == every modal veil) | Toasts fire invisibly under open modals; manager-PIN challenge renders behind the invoking modal | Raise to `z-[70]` both; document scale: veil 50 < nested 60 < toast/pin 70 < lock/update 100 |
| S3 | **`z-[100]` collision**: `LockScreenOverlay.tsx:194` vs `UpdateModal.tsx:29` | Update prompt can render under the lock screen (DOM order decides) | Lock screen → `z-[110]`, updater stays `z-[100]` |
| S4 | **Non-portaled absolute menus inside `overflow-hidden` cards**: `ShiftCloseModal.tsx:752` (`absolute bottom-full z-30 w-72`), `DateRangePicker.tsx:210` (`absolute bottom-full z-50 min-w-[520px]`) + `:347` multiselect, `CommandFilter.tsx:199` | Clipped popovers; the 520px calendar overflows 375px viewports outright | Portal all four to `document.body` with `position:fixed` + flip (copy `VendorProcurementModal.tsx:215-267,1491-1535`) |
| S5 | **`vh` instead of `dvh`** on ~35 shells (`h-[94vh]`, `max-h-[90/92vh]`) | iOS/Android URL-bar show/hide jumps and bottom-sheet cropping | Codemod shells to `h-[94dvh] sm:h-[90dvh]` / `max-h-[92dvh]` (full line list in §4) |
| S6 | **No Escape handling in 30 of 40 modals** (only 8 listen for `Escape`: CommandTicket, CustomItem, HoldSales, HotkeyGuide, ProductEditor, RepairWorkOrder, Settings, VendorProcurement) | Keyboard/a11y dead-end; mobile back-nav depends on `useMobileBackNavigation` alone | Add the template Escape effect (§5.3) to every modal |
| S7 | **No body scroll-lock primitive** (zero hits for `useLockBody`/body overflow) | Currently masked by global `overflow:hidden` (`index.css:62-68`), but any future scrollable page regresses all modals | Add `useBodyLock(activeModal !== null)` hook; rely on it instead of the global rule |
| S8 | **Close-button size drift**: 38px (`CommandTicket:429`, `Reports:653,682`, `Refund`, `Repair`, `ShiftClose`, `Customers:395-401`) vs 44px standard | Sub-44px touch targets, visual inconsistency | Normalize to the template close button (§5.2) |
| S9 | **Shell radius drift**: `rounded-t-3xl` (28px+) on ~30 shells vs mandated `rounded-t-2xl`; `rounded-none` full-bleed on `ExpenseManager`, `PurchaseOrder`, `Settings`, `InventoryManager`, `ProductMatrix` | Inconsistent sheet geometry | Codemod per §5.1 tier 1 |
| S10 | **Scroll-in-scroll without `overscroll-contain`** (VendorProcurement 6, Tickets/PO/Reports 4 deep; inner scrollers in Customers, InvoiceIngestion lack containment) | Nested wheel/touch traps, chain-scrolling into the parent list | Add `overscroll-contain` to every inner scroller; collapse where possible |

---

## 2. Master Window Registry (all 55 overlays)

Columns: shell line, z-tokens, portal, `#scroll`/`#sticky`, triggers = `openModal('<key>')` call sites.
Full machine output: `node scripts/audit-window-registry.mjs [--json]`.

### 2.1 Modals (`src/components/modals/`, 40 files)

| Component | Key | Presentation | Shell | z | Portal | Scr/Stk | Primary triggers |
|---|---|---|---|---|---|---|---|
| CloudPairingModal | cloud_pairing | bottom sheet / centered | :67 | z-50 | no | 2/0 | Header tools menu |
| CommandTicketDashboardModal | command_tickets | bottom sheet / centered | :400 | z-50 (+invalid z-60:1042) | no | 4/0 | Header, ManagementTab, procurement modal |
| CompatibilityModal | compatibility | bottom sheet / centered | :34 | z-50 | no | 2/0 | Header, CatalogSearchTab, ManagementTab |
| CustomItemModal | custom_item | centered | :229 | z-50 | no | 1/0 | Hotkey, BottomBar |
| CustomerDisplayModal | customer_display | bottom sheet / centered | :61 | z-50 | no | 1/0 | Header tools menu |
| CustomersModal | customers | bottom sheet / centered | :345 | z-50, z-[60] nested | no | 3/0 | BottomBar, CartPanel, hotkey, KredyTab, ManagementTab +6 |
| DatabaseMaintenanceModal | db_maintenance | bottom sheet / centered | :252 | z-50 | no | 1/0 | BottomBar, Header tools, ManagementTab |
| DebtLedgerModal | debt_ledger | bottom sheet / centered | :272 | z-50 (+invalid z-60:587,706) | no | 2/0 | Header, KredyTab, ManagementTab |
| DiscountModal | discount | bottom sheet / centered | :166 | z-50 | no | 0/0 | BottomBar, hotkey, MobileCheckoutTab |
| ExpenseManagerModal | expense_manager | centered (full-bleed mobile) | :196 | z-50 (+invalid z-60:430) | no | 2/0 | Header, ManagementTab |
| HoldSalesModal | hold | bottom sheet / centered | :114 | z-50 | no | 1/0 | Hotkey, MobileCheckoutTab |
| HotkeyGuideModal | hotkey_guide | bottom sheet / centered | :302 | z-50 | no | 1/0 | BottomBar, Header tools, hotkey |
| ImeiWarrantyInspectorModal | imei_inspector | bottom sheet / centered | :461 | z-50 | no | 2/0 | Header (+tools), ManagementTab |
| InventoryManagerModal | inventory_manager | centered (full-bleed mobile) | :229 | z-50 | no | 2/2 | BottomBar, hotkey, ManagementTab |
| InvoiceIngestionModal | invoice_ingestion | bottom sheet / centered (dual overlay) | :392/:413 | z-50 | no | 3/1 | Header tools, CompanionHeader, CatalogSearchTab, ManagementTab, MobileCheckoutTab |
| KittingBundleModal | kitting_bundle | bottom sheet / centered | :203 | z-50 | no | 2/0 | Header tools, ManagementTab |
| LabelPrinterModal | label_printer | bottom sheet / centered | :238 | z-50 | no | 2/0 | Header tools, ManagementTab |
| LicensingModal | licensing | bottom sheet / centered | :153 | z-50 | no | 1/0 | Header tools, ManagementTab |
| LoyaltyCardModal | loyalty_card | bottom sheet / centered | :68 | z-50 | no | 1/0 | Customer profile flow |
| PaymentModal | payment | bottom sheet / centered | :432 | z-50 | no | 1/0 | CartPanel, BottomBar, hotkey |
| ProductEditorModal | product_editor | bottom sheet / centered | :551 | z-50 | no | 2/0 | `setEditingProduct`, CatalogSearchTab |
| ProductMatrixModal | product_matrix | centered (full-bleed mobile) | :307 | z-50 | no | 2/0 | Matrix flow |
| PurchaseOrderA4Document | — | embedded print document (no overlay) | — | — | no | 0/0 | embedded in PO modal |
| PurchaseOrderModal | purchase_order | centered (full-bleed mobile) | :369 | z-50 | no | 4/1 | Procurement modal, tickets modal |
| ReceiptModal | receipt | bottom sheet / centered | :77 | z-50 | no | 1/0 | Payment flow, CompanionShell |
| ReceiptTemplateModal | receipt_template | bottom sheet / centered | :71 | z-50 | no | 1/0 | Header tools, ManagementTab |
| RefundModal | refund | bottom sheet / centered | :278 | z-50 | no | 2/0 | BottomBar, hotkey, Header tools, LiveActivityTab, ManagementTab +1 |
| RepairWorkOrderModal | repair_work_order | bottom sheet / centered | :553 | z-50 | no | 1/2 | Header, tickets modal, ManagementTab +1 |
| ReportsModal | reports | bottom sheet / centered | :634 | z-50, z-[60] nested, z-30 inner | no | 4/1 | BottomBar, Header tools, ManagementTab |
| SecurityAuditModal | security_audit | bottom sheet / centered (max-w-7xl, widest) | :461 | z-50 | no | 1/0 | Header tools, ManagementTab |
| SettingsModal | settings | centered (full-bleed mobile) | :1208 | z-50 | no | 1/0 | BottomBar, hotkey, CompanionHeader, ManagementTab |
| ShiftCloseModal | shift_close | bottom sheet / centered | :354 | z-50 | no | 1/0 | Header shift button, ManagementTab |
| ShiftMovementModal | shift_movement | bottom sheet / centered | :77 | z-50 | no | 0/0 | Header tools, ManagementTab |
| ShiftOpenModal | shift_open | bottom sheet / centered | :159 | z-50 | no | 1/0 | Header shift button, ManagementTab |
| ShiftZReportModal | shift_zreport | bottom sheet / centered | :171 | z-50 | no | 1/0 | LiveActivityTab, ManagementTab |
| TradeInBuybackModal | trade_in_buyback | bottom sheet / centered | :219 | z-50 | no | 1/0 | Header tools, ManagementTab |
| UpdateModal | — (self-managed via `useAppUpdater`) | bottom sheet / centered | :29 | z-[100] | no | 1/0 | auto (updater hook) |
| VendorProcurementModal | vendor_procurement | centered (full-bleed mobile) | :577 | z-50 | **YES** (:1491) | 6/4 | Header, CompanionHeader, tickets modal, ManagementTab |
| VoucherModal | credit_voucher | centered (always `p-4`, no sheet) | :128 | z-50 | no | 1/0 | Header voucher button |
| WhatsAppDispatchModal | whatsapp_dispatch | bottom sheet / centered | :131 | z-50 | no | 2/0 | Dispatch flow |

### 2.2 Shells, screens, popovers, system overlays (15)

| Component | Presentation | Shell | z | Notes |
|---|---|---|---|---|
| PinDialog (`ui/`) | centered dialog | :108 | z-50 (**buried — see S2**) | mounts in Header/ProductCatalog/ManagementTab, prop-driven |
| AuditInspectionDrawer (`audit/`) | slide-out drawer (right, 520px) | :180 | z-[60] | correct layer; mounts in SecurityAuditModal; no footer |
| M3CartProtectionModal (`mobile/`) | bottom sheet (M3 28px) | :45 | z-50 | mounts in CompanionShell; prop-callback close |
| MobileSimulatorModal (`mobile/`) | bottom sheet / centered | :13 | z-50 | hosts CompanionShell; no footer (uses bottom nav) |
| MobilePairingWizard (`mobile/`) | full-screen page (own scroll) | :311 | z-50 | footer actions not sticky — Save can scroll off |
| LockScreenOverlay | fullscreen gate | :194 | z-[100] (**collides — S3**) | PIN-gated via store |
| Toast (`ui/`) | stacked toast | — | z-50 (**buried — S2**); min-w-300px overflow risk on 320px | auto-dismiss |
| DateRangePicker (`ui/`) | dropdown popover | — | z-50 menu, **min-w-520px** | S4 clipping + mobile overflow; used by Reports/Expenses |
| CommandFilter (`audit/`) | dropdown popover | :199 | z-50, `absolute bottom-full` | S4 clipping |
| ActivationGateScreen (`licensing/`) | fullscreen gate | :299 | z-50 + invalid z-60:310 | own scroll; decorative 512px blur overflow risk |
| PoReviewScreen | review screen | — | z-30 | `max-h-[94dvh]` already dvh-correct — copy pattern |
| CompanionShell / AppScreenLayout | mobile shells | — | z-20/z-10 chrome | `h-[100dvh]` correct — copy pattern |
| CompanionHeader / Header | app headers | — | header z-30, tools menu z-[60] portaled | reference portal implementation |

---

## 3. Batch 1 — Deep Dives (5 heaviest windows)

### 3.1 VendorProcurementModal (`modals/VendorProcurementModal.tsx`, 1786 lines)

Already modernized (portaled `•••` menu :1491, single-row card actions :1012, sticky filter
bar :649, compact KPI strip). **Remaining deviations from the strict template:**
- **Heights:** shell `h-full sm:h-[92vh] h-dvh-shell` (:581) — drop `sm:h-[92vh]` → `sm:h-[92dvh]`;
  nested dialogs `max-h-[90vh]` (:1582, :1664) → `max-h-[90dvh]`.
- **Dead `sticky`:** header :585, filter :649, footer :1541 declare `sticky top-0/bottom-0` but
  their parent (:581) is not the scroller (sibling :757 is) — pinning works via flex, the
  `sticky` classes are misleading. Remove them OR move filter bar inside the scroll container.
- **Radius migration (per §5.1):** vendor card :831, item card :1223, toolbars :1066/:1134/:1346,
  empty state :759, candidate tile :1430 are `rounded-lg shadow-md` → must become
  `rounded-xl border-pos-border shadow-sm`; badges :596/:839/:856/:860 + :1258 `rounded-lg/md`
  → `rounded-full`; overflow menu :1504 `rounded-lg shadow-md` → `rounded-xl shadow-sm`.
- **Sub-44px touch targets:** info `i` :601 (20px), search :657 (40px), filter pills
  :675–:726 (40px), meatball :865 (32px — acceptable for meatballs only if siblings are 44px;
  here it is the sole header action: bump hitbox to 44px via `p-3 -m-2`), empty CTAs :766/:773,
  scope pills :1391/:1403 (36px), picker search/clear :1375/:1379.
- **Stacks left:** strategy toolbar :1066 + MOQ bar :1134 + WhatsApp dialog actions
  :1615/:1624 stack 2-wide on mobile — acceptable, but collapse MOQ total inline on `<sm`.
- **A11y:** info button :601 is `title`-only (no popover on tap); no `focus-visible` rings file-wide.

### 3.2 PurchaseOrderModal (`modals/PurchaseOrderModal.tsx`, 1472 lines) — highest blueprint count

- **Heights:** shell `h-full sm:h-[90vh]` (:373), zero `dvh` in file → `h-dvh-shell sm:h-[90dvh]`.
- **No pinned footer:** summaries :956/:1202 + CTAs :980/:1261 scroll away inside body :487.
  Add sticky footer bar with primary `Valider` (shorten label :1269, currently wraps).
- **No meatball in file; 4 wrap-prone clusters:** toolbar :583–629 (5 actions → keep Vérifier,
  portal Aperçu/Excel/Print), preview cluster :1345–1388 (same treatment), :1010–1034 and
  :1417–1446 trios (keep one primary each).
- **Filter row :735–769 overflows <360px** (no `overflow-x-auto`) → add scroll row.
- **A4 wrapper :1450** `overflow-x-auto flex justify-center` clips the left edge on mobile →
  `justify-start sm:justify-center`.
- **Table headers not sticky** (:859, :1049) inside `overflow-x-auto` tables; add `sticky top-0`.
- **Touch:** systematic sub-44px (tabs :415–477 at 36px, steppers/inputs `p-1/py-1`, 16px native
  checkbox :1221 → replace with 44px button checkbox per procurement pattern, icon buttons
  `p-1.5` :604/:612/:1361/:1369). Icon-only Excel/Print (:607/:615/:1364/:1372) are
  `title`-only — add visible labels or `aria-label` + always-visible caption.
- **Radius:** 13× `rounded-2xl` inner cards (:536/:1303/:641/:713/:828/:956/:996/:1037/:1202/:1399/:511/:1291/:1450)
  → `rounded-xl`; primaries/inputs `rounded-xl` (:622/:625/:980/:984/:1256/:1261/:1265/:667/:693/:706/:715…)
  → `rounded-lg`; status pills `rounded-md` (:544/:1000/:1310) + :388/:652/:1081/:1091 → `rounded-full`
  (inputs :1091 → `rounded-lg`); header icon :380 `rounded-xl` → `rounded-lg`.
- **Colors:** cyan Historique tab :476 + :1281 off-system → emerald; amber waiting semantic keep.

### 3.3 CommandTicketDashboardModal (`modals/CommandTicketDashboardModal.tsx`, 1301 lines)

- **Critical:** invalid `z-60` (:1042) → `z-[60]`; preview :1241 at `z-50` == root veil → raise to `z-[60]`.
- **Heights:** shell `h-[94vh] sm:h-[90vh]` (:401), reception `max-h-[90vh]` (:1043), preview
  `max-h-[92vh]` (:1242) → all `dvh`.
- **Density:** KPI grid :439 + filter stack :492 consume ~290px on mobile before content :572.
  Merge KPIs into the single-strip pattern (procurement) and make :492 single-row scroll.
- **Row actions :679–751 — 7 controls squeezed** (Réceptionner + 4× 32px icon buttons + trash +
  expand). Blueprint: keep `Réceptionner` primary; portal WhatsApp/Eye/Print/Download/Trash
  into a `•••` menu (first new portaled menu after procurement).
- **Reception footer :1172** 3-button row overflows 360px + header :1044/footer lack `shrink-0`
  → add `shrink-0`, demote `PV Réception` (:1203) to ghost.
- **Nested scroll trap:** items preview :866 `overflow-y-auto` inside body :572 without
  `overscroll-contain` → add containment or flatten.
- **Touch:** close :429 (38px), tabs :497/:509/:521 (40px), icon buttons :702–:747 (32px),
  pills :582, reception inputs :1076–:1158 → 44px pass; icon buttons are `title`-only → labels.
- **Radius:** shell `rounded-t-3xl` (:401) → `rounded-t-2xl`; cards :630/:840/:939/:602/:816/:921
  `rounded-2xl` → `rounded-xl` (+ add missing `shadow-sm` to :440/:452/:464/:476); controls
  :551/:558/:582/:611/:691–:747/:1203/:1211 `rounded-xl` → `rounded-lg`; pills
  :653/:665/:950/:956 `rounded-md/lg` → `rounded-full`.
- **Colors:** amber→orange gradient :410, blue :558/:642, teal :511/:844, cyan :459 → emerald
  system (keep amber/rose severity semantics).

### 3.4 ReportsModal (`modals/ReportsModal.tsx`, 2261 lines, largest file)

- **Heights:** shell `h-[94vh] sm:h-[90vh]` (:638), inspector `max-h-[85vh]` (:1834) → `dvh`;
  expense modal :2120 has **no** `max-h`/scroll cap → add `max-h-[90dvh] overflow-y-auto`.
- **Filter scroll-off:** search+3 selects :1238–:1294 sit **inside** body scroll :831 → extract to
  sticky filter bar; pagination :1444 → sticky footer.
- **Tabbar :730** nests a second horizontal scroller (:794 date filter) → flatten to segmented
  control + portaled date menu (also fixes the shared `DateRangePicker` 520px overflow).
- **Category pills :1517–1543 (11 pills, ~4 rows)** → `select` + CTA.
- **Inspector footer :2069–2110 (4 actions `justify-between`)** crowds mobile → keep `Réimprimer`
  primary, portal Void/Refund; inspector header :1837/footer :2069 lack `shrink-0` → add.
- **Invalid token:** `p-4.5` (:906/:984/:1067/:1148) does not exist in the default scale →
  `p-4`.
- **Touch:** close/back :653/:682 (38px), tabs :732–:790 (no min-h), pills :802/:820 (~26px),
  selects :1265–:1294, icon buttons :1419/:1426 (`p-1.5`), clear ✕ :1251 (~20px, no `aria-label`),
  inspector X :1854 (`p-1`).
- **Radius:** shell `rounded-t-3xl` → `rounded-t-2xl`; cards :839/:854/:869/:884/:906/:984/:1067/:1148
  `rounded-2xl` → `rounded-xl` (`:884 border-2` → `border`); controls :653/:714/:719/:1246/:1265–:1294/:1445
  → `rounded-lg`; pills `rounded` (:667/:927/:931/:936/:1165/:1177/:1368–:1386/:1412/:1790) → `rounded-full`.
- **Colors:** cyan→blue gradient :659, amber :692/:719/:772/:872, purple :1070, orange :1151,
  blue :909/:958 → emerald system.
- **Stacking:** inspector :1833 `absolute inset-0 z-30` confined to shell (intentional); expense
  :2119 `fixed z-[60]` correct syntax — use as the nested-dialog reference alongside portal pattern.

### 3.5 CustomersModal (`modals/CustomersModal.tsx`, customer-management window)

- **Heights:** shell `h-[94vh] sm:h-[90vh]` (:345) → `dvh`. Safe-area padding present. Good.
- **Nested dialogs :1169/:1265 `fixed inset-0 z-[60]`** inside `z-50 overflow-hidden` ancestor —
  clipped by zoom-in animation + double-`z-[60]` unordered → **portal both to `document.body`**;
  inner cards :1170/:1266 lack `max-h-[90dvh] overflow-y-auto` → add.
- **Profile actions :602–635 (3-across, long labels overflow)** → keep `Sélectionner`, portal
  `Modifier` + `Carte PVC`. Credit-card actions (:832–:847 icons + :877 footer) → single row or
  one `•••` per card (2–4 actions across 2 rows today).
- **Toolbar :748–783 (4 pills + 3 sorts + Add, no wrap)** → pills to scroll-x, sorts to dropdown.
- **Nested scroll traps:** recent-tx :724 (`max-h-40`) and ledger :1101 (`max-h-60`, bi-axial)
  inside body :491 without containment; ledger `thead` not sticky; toast :493 `absolute`
  scrolls with content → `sticky`/`fixed`.
- **Lost navigation:** `resetForm` (:228) always returns to `list`, dropping the profile
  return-stack → preserve `previousView`.
- **Touch:** close :395–401 (38px), pills :755–758 (~24px), sorts :767–773 (~22px), back :576
  (~16px), card icons :833/:840 (36px), footer/dialog buttons ~30–36px → 44px pass.
- **Hover-only:** card edit/delete `sm:opacity-0 sm:group-hover:opacity-100` (:832) invisible
  until hover with no `focus-within` fallback; `title=` tooltips (:836/:843/:890/:1075) without
  `aria-label`; `<kbd>F3</kbd>` hint inside a mobile button (:917).
- **Radius:** shell `rounded-t-3xl` → `rounded-t-2xl`; cards :943/:962/:981/:1014/:1028/:1088/:1170/:1266
  (+ avatar :583) `rounded-2xl` → `rounded-xl` (`:1028 border-2` → `border`); controls/inputs
  :353/:397/:516–:544/:603–:631/:953–:1328 (`rounded-xl`, sorts `rounded-md`) → `rounded-lg`;
  pills :389/:917/:1224 (`rounded`) → `rounded-full`.
- **Colors:** heaviest off-system file — blue tiers/KPI (:307–:308/:352–:353/:386/:408–:453/:620/:641–:672),
  amber debts (:631/:687–:706/:943–:1053), cyan (:718/:1091), slate Retail (:306) → map to
  emerald/amber/rose severity semantics; keep only 3 emerald CTAs (:562/:779/:1064) as reference.

---

## 4. Batch 2 — Archetype Sweeps (remaining 36 windows)

### Archetype A — Small confirms & forms (`max-w-md/lg`): Discount, HoldSales, Licensing, Receipt, ReceiptTemplate, ShiftMovement, ShiftOpen, ShiftZReport, Voucher, CustomItem, WhatsAppDispatch, ImeiWarrantyInspector, MobileSimulator, CustomerDisplay
Common shape: healthy (single scroller, pinned header/footer via flex). Prescriptions:
- `vh`→`dvh` on all shells (list: Discount :167, Hold :115, Licensing :154, Receipt :78,
  ReceiptTemplate :72, ShiftMovement :78, ShiftOpen :160, ShiftZReport :172, WhatsApp :132,
  Imei :462, CustomerDisplay :62 `sm:h-[80vh]`, MobileSimulator :14; CustomItem :243, Voucher :128).
- `rounded-t-3xl` → `rounded-t-2xl` (all except Voucher/CustomItem which are centered-only `rounded-2xl` — keep).
- Close buttons: audit each against the 44px template (ReceiptTemplate :84 and Licensing :167 already 44px — copy).
- Escape: none of these 14 listen for it → add template effect.
- Exceptions: **VoucherModal** never becomes a sheet (always `p-4` centered) — fine on phones but
  verify 320px; **ImeiWarrantyInspector** has no sticky footer bar (inline actions scroll off) → add;
  **CustomItemModal** is the only always-centered form — keep as reference.

### Archetype B — Catalog/table managers (`max-w-4/5xl`, full-bleed mobile): Compatibility, DatabaseMaintenance, InventoryManager, KittingBundle, LabelPrinter, ProductEditor, ProductMatrix, Refund, SecurityAudit, TradeInBuyback, CustomerDisplay
- `vh`→`dvh` (Compatibility :35, Database :253, Kitting :204, Label :239, ProductEditor :552,
  Refund :279, Security :462, TradeIn :220).
- Full-bleed members (`rounded-none`, `h-full` chains: Inventory :233, ProductMatrix :311,
  Database/others) → adopt shell token `h-dvh-shell sm:h-[88/90dvh]`; verify every `h-full`
  ancestor chain or the card collapses.
- Sticky `thead` present in Inventory (:396/:590) — propagate to Database/Kitting/Label tables.
- **SecurityAuditModal** (`max-w-7xl`, widest in app): add contained inner scroll for the 7xl grid
  on 1366px laptops; portal `CommandFilter` menu (S4).
- **RefundModal** footer (:~330) is a floating totals card (`rounded-2xl shadow-xl`) rather than an
  anchored bar → re-anchor per template.
- **CompatibilityModal** shell carries `border-emerald-500/50` accent — normalize to `border-pos-border`.

### Archetype C — Heavy dashboards (`max-w-5/6xl`, multi-scroller): ExpenseManager, SettingsModal, CloudPairing, LoyaltyCard, PaymentModal
- **ExpenseManager** (`h-full sm:h-[90vh]` :197, nested `z-60` :430 → `z-[60]`, CSV export uses
  `body.appendChild` — fine): 2 scrollers, centered-not-sheet; inner form modal :431
  `h-full sm:h-auto` without cap → `max-h-[90dvh]`.
- **SettingsModal** (5xl, tab-strip `overflow-x-auto`, footer status :~1319): healthy; add Escape
  (already has it — copy pattern), `h-full sm:h-[90vh]` :1212 → dvh.
- **CloudPairingModal**: no internal guard (host-gated — accepted); inner code box :286 second
  scroller → keep with containment; `max-h-[75vh]` :117 → dvh.
- **LoyaltyCardModal**: fixed 340×210px PVC preview (:135/:177) overflows 320px → wrap in
  `scale-[.9] sm:scale-100 origin-top` or `max-w-full overflow-x-auto`.
- **PaymentModal**: reference small-dashboard shape; footer `flex-col-reverse sm:flex-row` is the
  correct mobile CTA order — propagate to Discount/WhatsApp/Shift footers.

### Archetype D — Shift cluster (ShiftOpen/ShiftClose/ShiftMovement/ShiftZReport)
- Shared healthy shape; **ShiftCloseModal :752 variance tooltip is the clipping exemplar** —
  portal it (S4) and reuse for all explainers.
- ShiftClose primary CTA :732 + summary card :817 already 44px+ — copy across cluster.
- Standardize footers to `flex-col sm:flex-row` (ShiftClose already; ShiftMovement :205 uses
  `flex-2` — replace with `flex-1`).

### Archetype E — Drawers, sheets, fullscreen, screens
- **AuditInspectionDrawer** (`z-[60]`, right 520px, `max-w-full` — correct): add footer (currently
  none; long audits strand the user) + Escape close.
- **M3CartProtectionModal** (M3 `rounded-t-[28px]` — the only M3-compliant sheet; keep as the
  sheet reference): 3 stacked buttons intentional — keep.
- **MobilePairingWizard** (full page, own scroll :311): footer Save not sticky → anchor with
  `sticky bottom-0` + safe-area; camera box `h-72 overflow-hidden` fine.
- **MobileSimulatorModal**: thin host over CompanionShell — fine; no footer by design.
- **ActivationGateScreen**: fix `z-60` :310, cap decorative 512px blur (`overflow-hidden` on
  ancestor or `max-w-full`), own-scroll footer → anchor primary action.
- **PoReviewScreen / AppScreenLayout / CompanionShell**: already `dvh`-correct — **reference
  implementations** for the viewport-height codemod.
- **LockScreenOverlay**: resolve S3 (`z-[110]`), keep fullscreen gate; already the PIN reference.

### Archetype F — Popovers & toasts (shared components — fix once, heal everywhere)
- **DateRangePicker** (`min-w-[520px]` :210): portal + flip + mobile `w-[calc(100vw-16px)]`
  (copy procurement :1504); multiselect :347 same treatment. Heals Reports + Expenses + any
  future consumer.
- **CommandFilter** (:199 `absolute bottom-full z-50`): same portal treatment. Heals audit flows.
- **Toast** (`z-50`, `min-w-[300px]`): raise to `z-[70]`, cap width `max-w-[calc(100vw-32px)]`.
- **PinDialog** (`z-50`, dimmest veil `bg-black/50`, no `p`): raise to `z-[70]`, add `p-4` so the
  336px card never kisses 320px edges.

---

## 5. Standardized Modal/Window Design Template

### 5.1 Token tiers (strict — mandated by this audit)

| Tier | Usage | Classes |
|---|---|---|
| 1 — Shell | Outer modal card | `rounded-2xl` desktop / `rounded-t-2xl` mobile sheet; `border-pos-border`; `shadow-2xl`; heights `h-[94dvh] sm:h-[90dvh]` (tall) or `max-h-[92dvh]` (auto) |
| 2 — Inner cards | KPI boxes, item cards, toolbars, nested dialogs | `rounded-xl` + `border border-pos-border` + `shadow-sm`; NEVER `rounded-2xl`, never `border-2`, never bare `rounded` |
| 3a — Controls | Buttons, inputs, selects, search | `rounded-lg` (8px); primary `bg-emerald-500 hover:bg-emerald-400 text-slate-950`;secondary `bg-pos-bg border border-pos-border`; `min-h-[44px]` |
| 3b — Pills/badges | Statuses, counts, tags | `rounded-full`; tint `bg-<hue>-500/15 border-<hue>-500/30 text-<hue>-300/400` |
| Hues | Primary emerald; semantics amber (warn) / rose (danger) / blue-cyan (info links only) | No new arbitrary hex; print CSS keeps its documented palette |

### 5.2 Reference shell (copy-paste)

```tsx
{/* Veil — z-50 base; nested dialogs z-[60]; toasts/PIN z-[70]; lock/update z-[100/110] */}
<div onClick={closeModal}
  className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 select-none">
  <div onClick={(e) => e.stopPropagation()}
    className="bg-pos-panel border border-pos-border rounded-t-2xl sm:rounded-2xl w-full max-w-5xl overflow-hidden shadow-2xl flex flex-col h-[94dvh] sm:h-[90dvh] pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] sm:py-0">
    {/* Header — pinned by flex; sticky only when INSIDE the scroller */}
    <div className="px-3 py-2.5 sm:p-4 border-b border-pos-border bg-pos-card shrink-0 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-slate-950 shadow-md shadow-emerald-500/20 shrink-0">
          <Truck className="w-4 h-4" />
        </div>
        <h2 className="text-xs sm:text-base font-black text-pos-text tracking-wide truncate">TITLE</h2>
      </div>
      <button onClick={closeModal} aria-label="Fermer"
        className="min-h-[44px] min-w-[44px] flex items-center justify-center hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition shrink-0">
        <X className="w-5 h-5" />
      </button>
    </div>
    {/* Body — exactly ONE flex-1 scroller per modal; inner scrollers get overscroll-contain */}
    <div className="flex-1 overflow-y-auto overscroll-contain p-3 sm:p-5 space-y-4 bg-pos-bg">…</div>
    {/* Footer — anchored actions, never scrolling content */}
    <div className="p-3 border-t border-pos-border bg-pos-card shrink-0 flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2">
      <button className="min-h-[44px] px-5 rounded-lg bg-pos-hover font-bold">Fermer</button>
      <button className="min-h-[44px] px-5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black shadow-md shadow-emerald-500/20">Primary</button>
    </div>
  </div>
</div>
```

### 5.3 Mandatory behaviors (add to every modal)

- **Escape + backdrop close:** `useEffect` on `keydown Escape → closeModal` (32 modals missing it),
  veil `onClick={closeModal}` + card `stopPropagation` (already universal — keep).
- **Portaled menus:** any popover inside an `overflow-hidden` card renders via
  `createPortal(..., document.body)` with `position:fixed`, viewport clamp
  (`w-[calc(100vw-16px)] sm:w-72`), flip-up near the bottom edge, and outside/Escape/scroll/Resize
  dismissal — reference `VendorProcurementModal.tsx:215-267,1491-1535` and `Header.tsx:147-190,419`.
- **Single-row action rule:** card actions collapse to `[Voir] [Contact] [Primary →]`; overflow
  goes to a 32px `•••` (44px hitbox) in the card header — never a full-width `Plus d'actions` bar.
- **Density rule:** KPI grids merge into a divided single strip; filter bars are `sticky top-0`
  *inside* the scroller; footers carry totals + primary CTA only.

---

## 6. Remediation Roadmap (priority order)

1. **P0 — one-shot systemic fixes (S1–S4):** `z-60`→`z-[60]` (5 lines), Toast/PinDialog→`z-[70]`,
   lock→`z-[110]`, portal 4 menus. Unblocks clipping/overlay bugs everywhere. Estimable in isolation.
2. **P1 — Batch 1 blueprints (§3):** PurchaseOrder (largest count) → Customers (nav + dialogs) →
   Tickets (row actions + density) → Reports (filters + inspector) → Procurement (leftover radius/dvh).
3. **P2 — `vh`→`dvh` codemod (S5)** across §4 shell list + `rounded-t-3xl`→`rounded-t-2xl` (S9).
4. **P3 — Escape + 44px + `aria-label` sweep** (S6 + touch findings) per archetype.
5. **P4 — Archetype radius/color normalization** (§4 + §5.1 tiers).
6. **Gate:** keep `node scripts/audit-window-registry.mjs` green in CI (currently FAILs on the 7
   P0 items — intentional: the gate goes green as P0 lands).
