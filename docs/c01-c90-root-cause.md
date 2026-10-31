# C90 — root cause, observed (not inferred)

Binary of record: `6C2ADD1BE5E03F5EF83AC61D2D391DDB285D22436DD817BB480B13EEC6248FE2`
(worktree `C:\Users\Click\AppData\Local\Temp\opencode\c01-wt`, HEAD `06d850e`).
Defective binary for the trace: `8ABEA1C3383E8D2144C90C200EF128188249AF80647C2CEC759B7F9AFE9387B0`
(same HEAD `c709407` + instrumentation only).

## Symptom

REF-28 (stacked discounts: line override + coupon 500 + loyalty 100) intermittently recorded
`total=800` with `tenders=[avoir 100, espèces 900]` — the customer's cash leg stayed at the
**pre-loyalty** payable. Expected `espèces 800`.

## Why reading the code did not settle it

`netAfterCredits()` (the D-C90 helper, `PaymentModal.tsx:216`) was already used by pay-exact and all
three credit handlers, and its inputs were visibly correct in the render. A trace was required.

## The trace (instrumented `window.__c90log`; every write to `cashTenderAmount` + the submit values)

```
w135         appliedCredit 0    cashTenderAmount 0    netToPay 900   -> writes 900 (modal open)
wApplyCredit appliedCredit 0    cashTenderAmount 900  netToPay 900   -> writes 800 (credit applied)
wPayExact    appliedCredit 100  cashTenderAmount 800  netToPay 800   -> writes 800
submit       appliedCredit 100  cashTenderAmount 900  netToPay 800   submitCash 900
             tenders [ {Avoir Client 100}, {Espèces 900} ]
```

Between `wPayExact` (cash 800) and `submit` (cash 900) **no instrumented writer ran**. The only
remaining writer is `MoneyInput`'s `onChangeMinor` (`PaymentModal.tsx:1198`).

## Mechanism (OBSERVED)

1. The modal autofocuses the cash field; `MoneyInput` keeps its own display `buffer` and only re-syncs
   it from `valueMinor` **while unfocused** (`MoneyInput.tsx:157-165`, `if (focused) return`).
2. The loyalty button is activated without moving focus (the spec clicks it programmatically; a
   cashier's mouse click blurs first, which is why this is intermittent, 1/3 before the fix).
3. While focused, the buffer keeps `"900"` although the due dropped to 800 and the state was set to
   800 by `handleApplyFullCredit`.
4. `pay-exact` then called `document.getElementById('payment-cash-input')?.focus()` — re-arming the
   stale buffer as the session baseline (`MoneyInput.tsx:194-204`).
5. On the confirm click the field blurs → `commit()` parses the stale `"900"`, sees it differ from the
   anchor, and emits `onChangeMinor(900)` (`MoneyInput.tsx:239-244`) → `setCashTenderAmount(900)`.
6. `processPayment` reads the re-rendered state: cash leg 900, credit leg 100 → the drawer records 1000
   against a due of 800, i.e. a **100 DA overage** (the `change_due` of 100 is computed from the cash
   leg alone, so the customer's wallet credit is not returned to them in the drawer arithmetic).

## Fix (editable file only, `PaymentModal.tsx`)

- `commitCashField()`: if the cash field is focused, blur it — flushing its own buffer BEFORE any
  programmatic write, so the stale value is committed first and then overwritten in the same batch.
- Called by `handleApplyFullCredit`, `handleApplyCustomCredit`, `handleRemoveCredit`, the `pay-exact`
  button and the quick-bill buttons.
- `pay-exact` and the quick bills no longer re-focus the field (that was what re-armed the stale
  buffer as the session baseline).

## Result on the rebuilt binary (E-0030)

Three isolated runs, identical shape:

```
sale total=800 subtotal=1400 discount_total=500 lineDisc=100
tenders=[{"amount":100,"method":"Avoir Client"},{"amount":800,"method":"Espèces"}]
refund cashDisbursed=800 total=900 ; wallet after refund: 400 (before=400)
```

`800 cash + 100 avoir = 900 = payable before the loyalty credit`; the refund returns 800 cash and
restores the 100 to the wallet. The overage is gone.

## Reproducing the trace

Instrument every write in the worktree copy (never in the committed tree):

```ts
// before each `setCashTenderAmount(...)`
try { (window as unknown as { __c90log: Array<Record<string, unknown>> }).__c90log =
  ((window as unknown as { __c90log?: Array<Record<string, unknown>> }).__c90log || []);
  (window as unknown as { __c90log: Array<Record<string, unknown>> }).__c90log
    .push({ tag: '<site>', netSubtotal, netToPay, appliedCredit, cashTenderAmount }); } catch {}
```
then read it from a throwaway spec with `browser.execute(() => window.__c90log)`. Browser
`console.log` is NOT forwarded to the wdio log; only `console.error`/`console.warn` are, via
`armConsoleTap` (`e2e-tests/lib/pos.ts`), which is why the window buffer was used.
