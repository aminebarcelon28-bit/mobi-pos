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
