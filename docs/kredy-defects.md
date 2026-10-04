# KREDY ledger (DebtLedgerModal) — defect register

Status: **REPORTED**. Nine defects found while preparing
`src/components/modals/DebtLedgerModal.tsx` for E2E coverage. None are
fixed in the a11y/testability PR that accompanies this file: that PR adds
`role`/`aria-*`/`data-testid` only, so **no predicate, counter, label or
badge logic changed** (see the PR's review gate).

These IDs are a contract. `tests/debt-ledger.spec.ts` pins current
(shipped) behavior with a trailing `// I<n>` comment on every
characterization assertion, so a future fix PR flips exactly one assertion
per ID. Do not renumber — append.

Scope: plain-SQLite local store + zustand, Dexie `MobiPosDB` in the browser
preview. There is **no HTTP API** for customer data, so every finding below
is verified against the store/adapter path, never a request.

> **Line numbers drift.** `DebtLedgerModal.tsx` is under active work (a
> money-input migration rewrites its amount state and inputs), so `file:line`
> below is a snapshot. Re-anchor every ID with the table under
> [Evidence anchoring](#evidence-anchoring-survives-line-drift) before acting
> on it — the symbols, not the line numbers, are the contract.

## Evidence anchoring (survives line drift)

| ID | Grep anchor |
|---|---|
| I1 | `filterType === 'high_debt'` (`>= 20000`) next to the tab literal `Dettes Élevées (> 20k DA)` |
| I2 | `const overLimitCount`, `filterType === 'over_limit'`, `const isOver = debt >= limit`, badge text `Plafond Atteint` |
| I3 | tab literals `Tous les Débiteurs ({allIndebted.length})` / `Plafond Dépassé ({overLimitCount})` versus the count-less `Dettes Élevées (> 20k DA)` |
| I4 | `createCustomerSlice.ts`: `method === 'Espèces' && get().activeShift` → `createShiftSlice.ts`: `set({ activeShift: refreshedActive, activeModal: null })` |
| I5 | `maxLength={4}` in `DebtLedgerModal`, `verifyManagerGate(managerPin)` with no options, `pinGate.ts`: `reason: 'unavailable'` |
| I6 | the one-line `Escape` keydown effect, and the overlay `<div className="fixed inset-0 z-50 …` |
| I7 | `phoneUtils.ts`: the `a.target = '_blank'` browser branch returning `true`; modal: `Impossible d'ouvrir WhatsApp` |
| I8 | `foldForSearch` and `(c.phone \|\| '').includes(debouncedSearch.trim())` |
| I9 | `customerAdapter.ts`: `catch {` followed by `// ignore web mode fallback` |

---

## I1 — `Dettes Élevées` tab label contradicts its predicate

- **Severity:** medium (merchant reads a boundary that does not exist)
- **Symptom:** the tab is labelled `Dettes Élevées (> 20k DA)` but the
  predicate is inclusive: `list.filter((c) => (c.currentDebt || 0) >= 20000)`.
  A debtor owing **exactly 20 000 DA** appears under a filter that promises
  to exclude them.
- **Evidence:** `src/components/modals/DebtLedgerModal.tsx:409` (label
  `⏳ Dettes Élevées (> 20k DA)`) vs `src/components/modals/DebtLedgerModal.tsx:134`
  (`>= 20000`).
- **Impact:** trust. A cashier reconciling a 20 000 DA balance looks in the
  wrong tab; the ledger's own summary cannot explain what they see.
- **Recommended fix:** owner decision, two sane options —
  (a) relabel to `Dettes Élevées (≥ 20k DA)`, zero logic change, lowest
  risk; (b) switch the predicate to `> 20000`, which also changes what the
  tab counts and what the row list shows. **Do not** pick this implicitly:
  it is a product-visible boundary decision.
- **Status:** reported

## I2 — `Plafond Dépassé` treats "at the limit" as "over the limit"

- **Severity:** low-medium (internally consistent, label imprecise)
- **Symptom:** the tab, its counter and the row badge all use `>=`
  (`filterType === 'over_limit'` → `currentDebt >= debtLimit`,
  `overLimitCount` → `>= `, row `isOver` → `debt >= limit`), while the tab is
  named *Plafond Dépassé*. At `dette == plafond` the customer is counted as
  over the ceiling. The row badge text (`Plafond Atteint`) is the honest
  one; the tab label is the loose one.
- **Evidence:** `src/components/modals/DebtLedgerModal.tsx:399` (tab label),
  `:105` (counter), `:132` (filter), `:442` (row `isOver`), `:471` (badge
  text `Plafond Atteint`).
- **Impact:** mostly wording. The three code sites agree with each other, so
  no internal inconsistency exists — only the label. Note `debtLimit` falls
  back to `DEFAULT_CREDIT_LIMIT` (`src/store/slices/createCustomerSlice.ts:26`)
  when unset, so "no configured limit" silently becomes 100 000 DA.
- **Recommended fix:** relabel the tab/counter to match the badge
  (`Plafond Atteint / Dépassé`), or make all three sites strict `>` in one
  change. Prefer the relabel: `>=` is the safer money-flow predicate (a
  debtor exactly at the ceiling should stop borrowing).
- **Status:** reported

## I3 — `Dettes Élevées` tab has no count badge

- **Severity:** low
- **Symptom:** the two other filter tabs render `(<n>)`; the high-debt tab
  renders no count, so a cashier cannot size the result set before clicking
  and a stale tab cannot be spotted by reading it.
- **Evidence:** `src/components/modals/DebtLedgerModal.tsx:389` (`Tous les
  Débiteurs ({allIndebted.length})`), `:399` (`🚨 Plafond Dépassé
  ({overLimitCount})`) vs `:409` (no count).
- **Impact:** minor UX inconsistency; also blocks the natural E2E invariant
  "badge count === rendered row count" from holding for all three tabs.
- **Recommended fix:** add a memoized `highDebtCount` mirroring
  `overLimitCount` and render it in the tab. One line of logic, purely
  additive to what is already shown.
- **Status:** reported

## I4 — an `Espèces` settlement closes the ledger mid-payment

- **Severity:** high (data is saved; the cashier loses their place)
- **Symptom:** paying a debtor in cash while a shift is open writes the
  settlement correctly, then `logCashMovement` sets `activeModal: null`.
  `DebtLedgerModal` self-gates on `activeModal === 'debt_ledger'`, so the
  whole ledger unmounts at the moment of success and the success toast lands
  on the dashboard instead of the modal.
- **Evidence:** `src/store/slices/createCustomerSlice.ts:520` (`method ===
  'Espèces' && get().activeShift && appliedAmount > 0` → `logCashMovement`)
  → `src/store/slices/createShiftSlice.ts:116-119` (`set({ activeShift,
  activeModal: null })`); the modal's self-gate is
  `src/components/modals/DebtLedgerModal.tsx:142`.
- **Impact:** the cashier sees the ledger vanish and a toast with no visible
  context; the print-statement target is destroyed with it. Cash settlements
  are the most common flow in this modal, so this is the modal's happy path.
- **Recommended fix:** `logCashMovement` should not own modal state. Either
  drop `activeModal: null` from it (it is a drawer-bookkeeping action) or
  have it restore/preserve the caller's modal. Needs an owner ruling because
  other flows may rely on the current close-as-side-effect.
- **Status:** reported

## I5 — the manager PIN field cannot accept an owner-set manager PIN

- **Severity:** high for the ceiling-edit path, no impact elsewhere
- **Symptom:** the ceiling sub-modal caps the PIN input at 4 characters,
  while the owner-set policy requires a **6-digit minimum** for managers
  (AGENTS.md → *PIN migration + forced rotation (Phase 4.5)*, "manager new
  minimum 6 digits, cashiers 4"). A manager who follows the policy cannot
  type their PIN, so `verifyManagerGate` is called with a truncated value.
  Separately, outside Tauri the gate has no fallback at all, so the path is
  unreachable in the browser preview entirely.
- **Evidence:** `src/components/modals/DebtLedgerModal.tsx:760`
  (`maxLength={4}`), `:252` (`verifyManagerGate(managerPin)` — no options);
  `src/utils/pinGate.ts:173-176` (`if (isTauri()) … if (!options.allowWeakFallback)
  return { ok: false, reason: 'unavailable' }`).
- **Impact:** with the shipped 6-digit policy, credit-ceiling edits are
  effectively broken on desktop; the browser preview can only ever reach the
  `Code PIN Manager incorrect.` toast (`:256`).
- **Recommended fix:** raise `maxLength` to the manager minimum (6, or drop
  the cap and let the gate reject short input) and show the gate's real
  `reason: 'unavailable'` state instead of the wrong-PIN message. The
  no-fallback-outside-Tauri behaviour is **correct** fail-closed policy and
  must stay; only the messaging needs to change.
- **Status:** reported

## I6 — no focus trap, no backdrop dismissal, no focus restoration

- **Severity:** medium (WCAG 2.4.3 focus order / keyboard operability)
- **Symptom:** the modal closes only on Escape, the header `Fermer` button or
  the footer button. Focus is never moved into the dialog, Tab walks out of
  it into the dashboard behind, and on close focus is dropped on `<body>`
  instead of returning to the trigger.
- **Evidence:** `src/components/modals/DebtLedgerModal.tsx:140` (Escape-only
  `document` keydown listener); the root overlay `:290` has no
  `role`/`aria-modal`/focus handling and no `onClick` on the backdrop.
- **Impact:** keyboard and screen-reader users can tab into the inert page
  behind the modal and lose their place on close. Escape also fires while a
  sub-modal (payment / ceiling) is open, closing everything at once.
- **Recommended fix (partially landed in the companion PR):** the companion
  PR adds `role="dialog"`, `aria-modal`, a minimal Tab/Shift+Tab trap, focus
  on open and focus restoration on close. Still open here: backdrop-click
  dismissal, and deciding whether Escape should target the innermost sub-modal
  instead of the whole stack.
- **Status:** reported (partially addressed by the companion PR)

## I7 — `openWhatsApp` can never report a blocked popup

- **Severity:** low-medium (silent failure in the relance path)
- **Symptom:** in a browser the helper synthesizes an `<a target="_blank">`
  click and returns `true` unconditionally; only an unparseable phone number
  yields `false`. The modal's `Impossible d'ouvrir WhatsApp` error toast is
  therefore effectively dead outside Tauri, and a blocked popup is silent —
  the cashier believes the relance was sent.
- **Evidence:** `src/utils/phoneUtils.ts:245-275` (browser branch appends +
  clicks an anchor, `return true` in both the try and the catch);
  consumer at `src/components/modals/DebtLedgerModal.tsx:193-200`.
- **Impact:** a WhatsApp relance can be silently lost; the only user-visible
  proof is the browser's own blocked-popup indicator.
- **Recommended fix:** use `window.open(waUrl, '_blank', 'noopener')` and
  branch on the `null` return (with the anchor path as fallback), so the
  error toast becomes reachable and the failure is never silent. Note this
  changes `phoneUtils`, which is outside the modal — hence reported, not fixed.
- **Status:** reported

## I8 — debtor search has no phone normalization

- **Severity:** low
- **Symptom:** names and device names are matched through an NFD diacritic
  fold + lowercase, but the phone is matched with a raw
  `String.includes` on the trimmed query. Searching `0550 12 34 56`,
  `+213 550…` or `0550.12.34.56` finds nothing even though the stored number
  is `0550123456`.
- **Evidence:** `src/components/modals/DebtLedgerModal.tsx:5-6` (`foldForSearch`),
  `:126-129` — `foldForSearch(c.name).includes(q) ||
  (c.phone || '').includes(debouncedSearch.trim()) ||
  foldForSearch(c.registeredDevice).includes(q)`.
- **Impact:** a cashier who types the number the way it is printed (spaced,
  with `+213`) gets an empty ledger and may conclude the client has no debt.
- **Recommended fix:** run the phone branch through the same fold, or strip
  separators/`+213` before comparing. Reuse `normalizeAlgerianPhone`
  (`src/utils/phoneUtils.ts`) rather than adding a second normalizer.
- **Status:** reported

## I9 — web-mode persistence failures are swallowed silently

- **Severity:** medium (silent data loss risk; bounded by Dexie)
- **Symptom:** the durable write is the Dexie `put`; the SQLite `INSERT` that
  follows is wrapped in a bare `catch {}` with the comment
  `ignore web mode fallback`. In the browser that is the correct outcome,
  but it is indistinguishable from a real write failure (quota, blocked
  upgrade, corrupt record) — no log, no counter, no toast.
- **Evidence:** `src/db/adapters/customerAdapter.ts:286-288` (and the same
  shape at `:247-249`); the sibling `saveCustomer` rethrows when the store is
  Tauri or the DB is busy, which shows the swallow is deliberate but
  over-broad (`:119-129`).
- **Impact:** a genuine Dexie-side failure after the in-memory `set` would
  leave the cashier looking at a settled balance that no longer survives a
  reload. Bounded today because Dexie is written first, so the window is
  narrow — but it is invisible when it opens.
- **Recommended fix:** keep swallowing the web-mode rejection, but
  distinguish it from other failures (e.g. log the non-Tauri rejection at
  `debug` and rethrow anything else, or record a one-shot warning). This is
  an adapter change outside the modal — reported, not fixed.
- **Status:** reported

---

## Out of scope of this register

Backend/SQL-injection safety, DB-level concurrency control and exhaustive
rounding policy are not E2E-provable and are not covered here. Rounding is
owned by `formatDZD` (`src/types/pos.ts:1637-1661`, `Intl` `fr-DZ`
currency, 0 or 2 decimals, U+202F group separator) and by `MoneyInput`
(`src/components/ui/MoneyInput.tsx:73-108`, integer santeem), both of which
already have dedicated script coverage (`npm run test:boundaries`,
`npm run test:money`). Same-debt double payment across two tills is a
documented limitation in `src/store/slices/createCustomerSlice.ts:539-543`,
not a new finding.