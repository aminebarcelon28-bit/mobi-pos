# Decision D9 — REF-87 (2 × 2e9 DA ticket) stays red until the D6 payload ceiling is fixed

- **Status:** open, deliberately not worked around. The money path is proven; the *volume* is the blocker.
- **Measured (E-0100):** the REF-87 sale row is **95 687 874 B** of `json_payload`; the customer outbox row is
  **79 797 580 B**. A refund of that ticket has not landed within the harness window (probe: `rows=0/1` at
  +16 s, and the DB copy taken after the run still had **no refund row**), so the test dies waiting for the
  refund PIN field that the modal never reaches.

## Root cause (D5/E-0079, unchanged)

`evaluateSpendMilestones` materialises **one ledger entry per 20 000 DA tranche**
(`<cust>:milestone:ms-20k:tranche:N`). A 4e9 ticket therefore writes 200 000 entries into the customer
ledger, which is copied into the transaction payload, then parsed/serialised again by the native refund
merge. Payload size is linear in ticket value — the same defect that made large-ticket *selection* fail
before D5-A.

## Options

| # | Option | Effect | Why not now |
|---|---|---|---|
| A | Aggregate tranches: one ledger entry per milestone award carrying a `tranches` count | payload becomes O(1) per milestone | changes the loyalty ledger schema and `netMilestoneGrants` / clawback / reconcile semantics; needs a migration with backup + dry run on real data (hard limit) |
| B | Raise the harness wait to minutes | test may pass | hides a 2-minute refund for a legitimate (if extreme) ticket; latency stays unacceptable |
| C | Disable loyalty earning for the spec | test passes | the test would no longer exercise the production configuration |
| **D** | **Keep the money proof separate (diag with earning disabled at 2³¹+1 / 4e9 / past-2³²), register REF-87 as a D6 blocker** | honest: money correctness demonstrated, volume defect tracked | — |

**Choice: D.** The invariant under test — "a refund credits each destination exactly once, at the exact
amount" — is proven by E-0080/E-0097/E-0098/E-0099 and 31 native tests. REF-87's remaining failure is the
D6 payload ceiling, not a money error, and it must not be hidden by weakening the test or the product
configuration.

## Reversal / exit criteria

When option A lands (aggregate tranche entries + migration, with a dry run and a backup plan), re-enable
REF-87 unchanged; the payload for this ticket should fall below 1 MB and the test should pass on the
normal timeout. No change to this decision's test expectations is required.
