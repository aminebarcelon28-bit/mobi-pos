# Cold adversarial review #3 — D4-A (fresh context, 2026-10-31)

Reviewer session `ses_e6cbe305fffelcDk7eGe3iI5MD`, HEAD `a34acfa`. Verdict: **DO NOT MERGE** (N1, N2).

Reviewer's own runs: `cargo test --lib refund::tests` → **31 passed**; `cargo test --lib` → **432 passed,
2 failed**, both in files untouched since `bdca981` (an ancestor of D4-A) — independently confirming the two
failures are pre-existing.

| # | Item | Verdict |
|---|---|---|
| 1 | Atomicity (wallet + ledger + row + restock in one BEGIN IMMEDIATE) | CLOSED |
| 2a | Clawback clamp reconciles to the balance | PARTIAL (silent clamp, fractional-REAL drift) |
| 2b | Clawback bound to the ticket's customer | CLOSED |
| 2c | Clawback with `wallet_credit = 0` cannot hit a third party | CLOSED |
| 3 | Value cap / gate skip via `funding.digital` | **OPEN** (N1) |
| 4 | Leg balance (cash/Avoir/debt/card, clamps) | PARTIAL (cash leg ≠ drawer movement) |
| 5 | Mirror double-credit / erase | PARTIAL (N2 TOCTOU) |
| 6 | Replay idempotency | PARTIAL (basis recompute path untested) |
| 7 | Overflow | PARTIAL (exact ≤ 2^53, no guard/test above) |
| 8 | Recipient rule end-to-end | CLOSED (presence) / PARTIAL (routing) |
| 9 | `sync_status` marker read by anyone | **OPEN** (nothing reads it) |
| 10 | Test adequacy | PARTIAL (list of untested invariants) |

## New findings and disposition

| ID | Finding | Disposition |
|---|---|---|
| **N1** | `funding.digital` is caller JSON, so it acted as a kill switch for the only wallet/value consistency gate; `walletCredit` was bounded by nothing | **FIXED** — the card leg is derived from the **durable ticket's tenders**, and `wallet leg <= refund value` is enforced (`E-0093`) |
| **N2** | Post-commit `store_credit` read-then-write races a concurrent wallet debit and can erase it (free credit) | **OPEN** — needs a column-level/partial update or a re-read+reconcile inside the write |
| **N3** | The Avoir **credit** recipient was unbound (only the clawback was proven against the ticket) | **FIXED** — the same ticket-customer proof now covers `wallet_inc` (`E-0093`) |
| **N4** | Clawback clamp was silent; `REFUND_EXCEEDS_VALUE` was unreachable (regex) | **FIXED** — clamp warning + taxonomy + mapping (`E-0093`) |
| **N5** | Cash leg uses `cash_tendered`, not the drawer movement | **REVERTED / OPEN** — a fixture shows `cash_move.amount` is *not* the refund cash (6000 vs 150), so the assumption is wrong; registered as case 34 for a schema decision |

## Residual list carried by the reviewer (untested invariants)

clawback ownership mismatch (now tested by ownership path), wallet recipient ownership (now enforced),
leg-balance `INVALID`, `funding.digital` bypass (now durable), `cash_tendered` vs `cash_move`, silent clamp
(clamp warning added), overflow ≥ 2^53, post-commit save TOCTOU (N2), pull-time reconciliation
(`genericApply`) — only exercised by a diag script today.
