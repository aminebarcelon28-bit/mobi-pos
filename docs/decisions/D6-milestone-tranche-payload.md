# Decision D6 — the milestone tranche ledger is the payload ceiling (no fix in C01)

- **Status:** the PAYLOAD half is fixed (the sale no longer embeds the loyalty book: 24.8MB → 241B for the
  customer block, E-0108); the LATENCY half remains (an ~80MB customer ledger is still merged in Rust on a
  wallet refund, ~55s). REF-87 passes in isolation; the full batch still hits the 120s supervisor window
  (E-0109). Next: SQL-side `json_*` merge or tranche aggregation.
- **Measured:** a 4e9 DA sale writes **200 000** ledger rows (`<cust>:milestone:ms-20k:tranche:N`, 1 000 DA
  each) into the customer payload → transaction payload **138 742 528 B**, customer outbox row **79 797 580 B**
  (E-0079). The refund's native merge parses and re-serialises that payload, so the refund of such a ticket
  does not complete in any reasonable window.

## Options

| # | Option | Effect | Blocked by |
|---|---|---|---|
| A | Aggregate tranches: one ledger row per milestone award carrying a `tranches` count | payload O(1) per milestone | a schema/semantics change to `netMilestoneGrants`, clawback and `reconcileMilestoneTranches`, plus a **migration** — the guardrails forbid a migration without a backup and a dry run on real data |
| B | Store milestone balances as integers instead of per-tranche rows | smaller still | same migration class, and it rewrites loyalty history |
| C | Cap the payload (strip customer/milestones from the sale row) | smaller rows | loses audit data and breaks the refund's merge contract |
| **D** | **Keep the current model; prove the money path separately at 2³¹+1 / 4e9 / past 2³² (with earning disabled in the diag) and accept REF-87 as the documented ceiling** | honest, no data loss | — |

## Why D

The invariant under test (a refund credits each destination exactly once at the exact amount) is proven by
E-0080/E-0097/E-0098/E-0099 and 33 native tests. REF-87's failure is a **volume** defect: real tickets of
that size are rare, and the safe fix is a planned data-model migration, not a hotfix. Choosing A or B inside
a refund cycle would put a migration on a money path without a backup plan — the exact thing the guardrails
forbid.

## Exit criteria

Option A with: a dry-run migration on a copy, a backup step in the upgrade path, golden tests for
`netMilestoneGrants` / clawback, and REF-87 re-enabled unchanged. Then delete D9's acceptance.

## Update 2026-11-01 — the JSON round-trip is gone

The wallet and loyalty writes no longer parse/serialise the customer document in Rust: they use
`json_insert` / `json_set` inside the same transaction (`sql_append_customer_ledger`,
`sql_patch_customer_loyalty`, `sql_set_customer_credit`). A 200 000-row / ~80 MB ledger refund went from
**10.9 s to 4.4 s**, and all 34 refund tests still pass (E-0110).

The remaining batch failure for REF-87 is NOT this cost: the offline-cash-cap auto-switch closes the refund
dialog for a 2e9 cash refund, so the Avoir revalidation never runs. That is a `RefundModal` lifecycle bug,
tracked as the next step.

## Update 2026-11-01 (batch) — the residual is the modal lifecycle

REF-87 is green twice in isolation (ref87k, ref87m) with a clean invariant oracle, but the full batch still
fails it before any refund row: the offline-cash-cap re-render tears down the PIN field while the submit is
being prepared, and the run aborts at +16 s (E-0111). The money layer (payload size, JSON1 writes, loyalty
clamp) is not the blocker any more. Next change is product-side: keep the RefundModal's dialog and PIN field
mounted through the method switch (or re-submit automatically after the switch) instead of relying on the
test to catch the re-render.

## Update 2026-11-01 (withdrawn experiment)

An auto-resubmit of the Avoir refund after the cash-cap switch was tried and **withdrawn**: it regressed
REF-51 and left REF-87 red (E-0112). Reverted in full.

Measurement that now closes the diagnosis: the wallet/loyalty write no longer parses the document in Rust
(4.4 s for 200k rows), yet an app refund still takes ~45 s because **the same ~80 MB document is rewritten
five times** inside SQLite (loyalty json_set, credit json_set, two ledger json_inserts, TS mirror) — ~400 MB
of WAL, each with a Windows fsync. That is not a code-path bug; it is the size of the document.

**Therefore the only correct fix is D6 option A: aggregate the tranche ledger** (one row per milestone award
carrying a range/count), with a dry-run migration on a copy and a backup step, then REF-87 re-enabled
unchanged.

## Update 2026-11-01 (harness defect found)

The E2E matcher for the cash-cap prompt compared an **accented literal** (`basculée en Avoir Client`) against
the built bundle and never matched, so REF-87's second chunk was never revalidated — a harness bug that
masqueraded as a product timeout for several runs. Structural matching is in (E-0113). With it, the
revalidation fires (#1..#4) but every retry still returns through the cap switch and the dialog then closes
before a refund row lands: the revalidated request still carries the cash method (stale method in the retry
path) or is refused earlier.

Remaining work is therefore precise: make the revalidated submit use the switched method (Avoir) — the request
builder must read the CURRENT method, not the one captured at the first submit.

## Update 2026-11-01 (batch ref33u) — the modal closes mid-flight, not the cap branch

With the cap matcher fixed and the PIN retained across a same-ticket re-init, the run emits **no** cap
diagnostic at all: the native cap branch never runs. The modal is torn down at ~+18 s while the refund is in
flight and no row lands within the 180 s grace (E-0114). The remaining defect is the **RefundModal lifecycle**
(a sync-driven store update clears `selectedTransactionForRefund`, and the modal falls back to the ticket
list), not the money layer, the payload size, or a stale method closure.

Next step is evidence, not another blind patch: instrument the modal lifecycle (open / method switch / submit
start / submit result / `setSelectedTxn(null)` reason) into a ring buffer the harness can read, reproduce the
cap path once, and fix the exact teardown.

## Update 2026-11-01 (trace) — the dialog is closed by a store write, 12 ms after the switch

With the lifecycle ring buffer in place (E-0115) the sequence for the huge ticket is unambiguous:

```
submit:start Espèces           (t0)
submit:result ok=false OFFLINE_CASH_CAP_EXCEEDED   (+29-33 s on a 4e9 ticket; +2.4 s on small ones)
switch → Avoir Client                              (+0 ms)
modal:closed activeModal=null                      (+12 ms)   <-- the refund never reaches the native
```

Small tickets hit the same switch and **do not** close, so the teardown is tied to the long-running refusal path
(~30 s), i.e. something that reacts to the ticket's sync/version churn during that window and sets
`activeModal: null`. The zustand notification stack does not name the caller. Next attempt must tag the
`activeModal: null` **inside set() calls only** (the first brute-force tag broke an object literal and was
reverted), run one batch, and read the site tag.

## Update 2026-11-01 (per-site tags) — one close found, one remains

Per-site tags identified the first offender: the **late checkout completion** (`createOrderSlice`'s final
`set`) runs during a huge-ticket refund and used to close whatever modal was open. That is now guarded (it
only closes its own `payment` modal) — a correct fix that stays.

The dialog still goes null **172 ms later with no tag**, so a second, untagged site closes it:
`closeModal()` (an arrow-body `set`, deliberately skipped by the tagger) or `createCartSlice:765`.
Those two are the next tags to add (E-0116).

## Update 2026-11-01 (stop point) — lifecycle guards are necessary but not sufficient

The in-flight guard is proven (trace: `store:close-blocked`, the dialog survives the cap switch and the Avoir
submit starts). The refund still does not land: the settle budget expires at 240 s and a later close path
removes the dialog again (E-0117).

Three consecutive lifecycle fixes (checkout-close scope, in-flight guard, PIN retention) each removed a real
defect, but the case does not converge while every refund rewrites an ~80 MB ledger and takes 35–60 s. Per the
guardrails I am **stopping per-site patching**. The next cycle is a single, ordered piece of work:

1. **D6 aggregation** (one ledger row per award range + dry-run migration + backup) — refunds drop to ~1 s.
2. Then **one** final lifecycle pass with the ring buffer to confirm no close can interrupt a refund.
3. Re-run the full 33-ref for 18/18.
