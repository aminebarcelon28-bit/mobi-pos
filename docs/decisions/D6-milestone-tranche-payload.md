# Decision D6 — the milestone tranche ledger is the payload ceiling (no fix in C01)

- **Status:** open, deliberately not fixed in this cycle; REF-87 is accepted on this basis (D9).
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
