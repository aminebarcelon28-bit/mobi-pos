# REF-87 in-suite failure — offline cash-cap fallback vs the test helper (decision pack)

**Status: PARKED (owner decision).** The money path is correct; the failure is a race between a
deliberate two-step UX on the offline cash cap and the spec helper's re-validation loop.

## Proven sequence (OBSERVED, E-0054)

Full `33-ref` run on `ae36dff` (binary `CB2112A1…EDF9`), the lines in order:

```
[REF-87] A chunk1 preview=200000000000 (expect 200000000000)
[submitAndSettle REF-87-A1] post-submit probe: {"disabled":false,"text":"Valider le Remboursement","title":""}
[submitAndSettle REF-87-A1] +22s rows=0/1
[submitAndSettle] cash cap: switched to Avoir Client - revalidating #1
Error: element ("[data-testid="refund-pin"]") still not displayed after 10000ms
```

1. The 4 000 000 000 DA refund is a **cash** refund. The terminal is offline, so the offline cash cap
   applies; the app parks the request and switches the method to `Avoir Client` with the toast
   *"Plafond espèces hors-ligne atteint — méthode basculée en Avoir Client : vérifiez puis validez à
   nouveau."* (`RefundModal.tsx`, `OFFLINE_CASH_CAP_EXCEEDED` branch).
2. The spec helper treats that toast as "re-validate": it calls `submitRefund()` again, which **types the
   PIN first** (`33-ref:497-501`: `await typeRefundPin(pin); await clickRefundSubmit(...)`).
3. The re-submitted refund lands (it takes ~20 s on a 95 MB ticket) and the app closes the dialog — so
   the PIN field the helper is typing into is gone, and `waitForDisplayed(10000)` throws.

The refund itself is not lost and no money is double-paid; the case dies on a UI element that no longer
exists. Isolated, the same case passes (E-0053: **5/5** across two builds) because the landing usually
beats the re-validation click; in the suite the timing shifts and the race is lost.

## Why this is not something I should silently change

Two deliberate behaviours collide:

- **App side:** a refused cash refund is *not* silently re-routed — the cashier is asked to confirm the
  Avoir switch. That is the money-flow rule ("no silent sequential fallback for money").
- **Spec side (read-only):** the helper assumes the dialog stays open across its re-validation clicks.

Fixing it requires one of the two to bend.

## Options

| # | Change | Effect | Risk | Owner? |
|---|---|---|---|---|
| **A** | Spec helper: guard the re-validation with "dialog still open" and accept a landing that happens during it | case passes in-suite; no product change | test-side only — but it edits `e2e-tests/specs`, forbidden for C01 | **yes** (spec edit) |
| **B** | App: pre-check the offline cash cap *before* sending, and submit as `Avoir Client` on the first click with a visible notice | one click, no re-validation race | removes the explicit "validez à nouveau" confirmation for offline cash refunds — a money-flow UX decision | **yes** |
| **C** | Leave as-is | REF-87 passes alone (5/5) and flakes in-suite | suite stays red on this case | — |

**Recommendation: B** — it is the only option that removes the "send a request the app already knows will
be refused" step, which is also the step that creates the race. It must be an explicit owner call because
it changes a confirmation the cashier currently gives.

## Already landed for REF-87 (real defects found on the way, verified)

- `cb9f0c0` — the refund submit is re-entrancy guarded; a slow mega-refund could invoke `processRefund`
  twice in the same millisecond (observed, E-0052) and the second call surfaced a misleading
  `ALREADY_REFUNDED`.
- `d03e1f7` — `refundBasis` counts committed refunds **from SQLite**, so a legitimate second chunk can
  never reuse the first chunk's dedup hash when the in-memory union is blind to it.
- `d931f46` + `ae36dff` — a manager PIN authorises **exactly one** refund (cleared after every submit) and
  is cleared when a ticket is selected, so a PIN typed for an earlier refund can never authorise a later
  one (authorization replay).

## What would make REF-87 fully DONE

Decide A or B, then REF-87 **3/3 in-suite** (not only isolated), plus the full `33-ref` at 16/18
(REF-35 and REF-42 remain owner-parked) on a fresh worktree build.
