# Phase 1c — Money Input Sweep (root cause + universal fix)

Status: IMPLEMENTED. Owner symptom (cannot enter 135.50 on product add) fixed
at the root for every money field in the app.

## 1. Root cause (evidence, not guess)

`src/components/modals/ProductEditorModal.tsx:1138` (pre-existing since
2026-09, `git blame a018c628/d0335e6a` — NOT our commits; our 3-line diff in
that file is CSS-only): every price field ran
`Math.max(0, Math.round(parseLocalizedAmount(e.target.value) || 0))` ON
KEYSTROKE inside a controlled `type="number"` input. Typing 135.50 →
parse → 135.5 → `Math.round` → **136 stored, field re-renders 136**.
The fraction is destroyed at entry; with FR-locale browsers the dot never
even reaches JS (`type="number"` sanitizes commas to `""`). `step="any"`
was present (hypothesis 2 exonerated); no schema/Rust rejection involved
(parse happens client-side before submit).

## 2. Inventory (before → after per field; uniform entry-bridge (b) except noted)

One parsing path after this phase: `MoneyInput` → `Money.fromUserInput`.
Parent engines stay float dinars (Stage E migrates them); handlers convert
via `toLegacyReal` at entry, `dinarsToMinor` for the `valueMinor` prop.
PD-24 grouping decision isolated in `fromUserInput` (flippable in one place).

Product catalog: ProductEditorModal price/semi/gros/cost/minPrice/tier-price
(round-on-keystroke → echo + exact); ProductMatrixModal cost/price/wholesale
(parseFloat → echo, comma fixed); CustomItemModal touch + custom price/cost
— variant (a): states converted to minor numbers, `Math.round` at save
removed (half dinar survives into cart); KittingBundleModal pack price;
PurchaseOrderModal draft + receive costs; CommandTicketDashboardModal
verified cost. Qty/stock/IMEI untouched.

Checkout: PaymentModal tendered + custom credit (string states → minor;
tender math unchanged); MobileCheckoutTab tendered keypad string + price
override; CartPanel price override. DiscountModal amount (percent untouched).

Counterparty: DebtLedgerModal payment + limit (max-cap clamp kept);
CustomersModal payment (max={debt} clamp kept); VoucherModal amount
(parseFloat truncation fixed); TradeInBuybackModal buyback (percent untouched);
ExpenseManagerModal + ReportsModal new-charge amounts.

Shifts/cash: ShiftOpen/ShiftClose direct floats + vrac coins (parseInt on a
DA amount replaced — 50-santeem coins now representable); ShiftZReportModal
counted + safe-drop; ShiftMovementModal amount. Denomination COUNTS untouched.

Config/SAV: SettingsModal loyalty DA fields (floor removed → exact; points,
percent, multiplier untouched); RepairWorkOrderModal labor/parts/deposit
(parseFloat → echo, comma fixed); InvoiceIngestionModal total + freight
(TVA field SKIPPED — 1b-i deletes it; :167 is OCR-derived, not human input);
PoReviewScreen 7 line/quick inputs (qty untouched).

Non-goals kept out: quantities, counts, percents, multipliers, points,
IMEI/phone/search/PIN/note/checkbox/select, `vatRate` reads, tender-math
engines (parse-only change), fractional-qty acceptance (Stage B).

## 5. Deferred: PoReviewScreen 7 inputs + DebtLedgerModal 2 inputs (explicit, tracked)

The card/table `unit_cost` / `selling_price` / `line_total` + quick-create
`quickCost` / `quickPrice` inputs (parseFloat) sit inside another lane's
in-flight viewport rewrite and cannot be committed without absorbing ~1300
foreign lines. They were migrated in-worktree, then reverted to keep the 1c
diff pure; the boundary registry pins `pf: 9` (7 money + 2 qty) so the
deferral is enforced, not silent. These inputs never destroyed decimals
(parseFloat preserves dots); comma support + echo arrive post-settle or at
Stage E. Redo recipe: replace each `parseFloat(e.target.value)` money input
with `MoneyInput` + entry-bridge (see §2 pattern); ~30 minutes.

DebtLedgerModal's 2 amount fields (`Montant du Versement`,
`Nouveau Plafond Autorisé`) are deferred for the same reason: the a11y lane
owns that file (focus trap + `kredy-*` testids), so it was reverted to
`parseLocalizedAmount` to keep zero footprint. Its registry row carries
`deferred: true` with `pla: 3` pinned, which the gate honours — a
re-introduced parser still fails. Redo recipe: the same §2 pattern; note the
visible delta when it happens — a half-dinar over-payment currently shows
change rounded to the whole dinar, and would then show it to the cent (the
store settles in integer dinars either way, `recordCustomerDebtPayment`
rounds the tendered amount).

Trivial behavior deltas (echo-visible, fail-obvious, documented in code):
empty quick-touch price now saves 0 ("0.00 DA" shown) instead of erroring;
optional semi-wholesale clears via onClear instead of empty-string state.

## 3. New shared pieces

- `src/components/ui/MoneyInput.tsx`: `type="text" inputMode="decimal"`,
  `Money.fromUserInput` only, live echo (`= 135.50 DA` / error message),
  blur canonicalization, caret-safe external re-sync, `onClear` for optional
  fields, `aria-label` = visible label text (AGENTS.md 2.5.3).
- `toLegacyReal` / `dinarsToMinor` (`src/utils/money.ts`, DEATH-MARKED at
  1b-ii B/C): the only float conversions in the codebase; boundary gate pins
  money.ts to its single dust-fallback line. `formatMinor` display helper.
- CI: `test_half_dinar_regression.mjs` added to the audit-money-gates lane
  (12/12: bug shape recorded, migrated mapping exact, SQLite round-trip,
  comma==dot, no silent truncation). Drill/rehearse/differencer stay
  execution-time tools (need the live DB, absent in CI by design).

## 6. Deferred audit fixes with ready diffs (deep-audit follow-up — DO NOT
apply while the a11y lane owns DebtLedgerModal; both touch the deferred file)

KREDY-01 (dual sub-panel trap scope, `DebtLedgerModal.tsx:168`): track open
order and trap the topmost panel instead of the fixed
`plafond ?? versement ?? modal` chain:
```tsx
const lastOpenedPanel = useRef<'plafond' | 'versement' | null>(null);
// set lastOpenedPanel.current = 'versement' in handleOpenPayment and
// = 'plafond' in the limit-adjust opener; clear both on close.
const panel =
  (lastOpenedPanel.current === 'versement' ? versementRootRef.current : null) ??
  (lastOpenedPanel.current === 'plafond' ? plafondRootRef.current : null) ??
  modalRootRef.current;
```
KREDY-02 (cross-device double-settle, `createCustomerSlice.ts:449-502`):
the slice already supports `entryId` idempotency — the modal just never
passes it. When DebtLedgerModal is back under our lane: capture
`const paymentEntryId = useRef('')`, set it to
`` `debt-pay-${customer.id}-${Date.now()}` `` in `handleOpenPayment`
(fresh per dialog open, stable across retries of the same intent), and pass
`{ entryId: paymentEntryId.current }` to `recordCustomerDebtPayment`.
Convergent retries then collapse instead of doubling.

## 4. Verification

Test J 77/77 (J8 bridges, J1b Arabic entry), boundary 68/68 (Rule 1b
render-crash guard, Rule 4 adoption registry: 24 files, per-file
legacy-parser caps), half-dinar 12/12, tsc clean
(baseline unchanged), oxlint 0 errors. Owner 5-minute check: 135.50 saves +
shows everywhere; 135,50 identical; 135.555 echoes the grouping read;
receipt prints "135.50 DA".
