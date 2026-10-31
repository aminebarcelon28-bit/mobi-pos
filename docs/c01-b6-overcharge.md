# Addendum — B6 run, money-affecting defect found

## FIRST LINE OF THE REPORT: money-affecting defect found (E-0012, E-0013)

**S3 overcharge, PROVEN from persisted rows on binary `8A9AC95B…8FC4` (HEAD `e88136b`):**

| Fact | Value | Source |
|---|---|---|
| Ticket total (credits excluded) | 800 | `transactions.total` |
| Subtotal / discount | 1400 / 500 | columns |
| Avoir applied (wallet debited) | 100 | tender leg |
| Due after credit | **800** | 900 − 100 |
| Cash tendered / change | 1000 / 100 | columns |
| Cash retained by the drawer | **900** | 1000 − 100, `CASH_NET net=900` |
| Customer gave | 900 cash + 100 wallet = **1000** for a 900 ticket | E-0013 |

**=> 100 DA overcharge; the drawer closes 100 over.** This **withdraws** my B2/B3 "no phantom
cash" grade (it rested on the same columns without doing this arithmetic).

**PARKED** — blocker: the fix lives in the tender path (`PaymentModal` / checkout commit), which is
read-only in C01. Options: (A) `pay-exact` must tender `net after credits` (one pure helper, every
call site) — recommended; (B) spec-only change to compare `cash − change` (rejected: the drawer
100 over is real); (C) slice-level guard that re-derives an over-tendered credit ticket.
DONE when: REF-28 passes its sale premise 3/3 and `CASH_NET == due` on the S3 fixture.

## Run results (binary `8A9AC95B4410C8BEDBE38CB5979F31F027D48B3BACF374E8AF5D5F86B8958FC4`, HEAD `e88136b`)

| Case | k/N | Evidence | Note |
|---|---|---|---|
| REF-03 | **3/3** | E-0006 | PASS |
| REF-33 | **3/3** | E-0007 | PASS |
| REF-49 | **3/3** | E-0008 | PASS |
| MNY-26 | **2/3** | E-0009 | one FAIL; cause not captured in the log excerpt — flake or defect, UNKNOWN |
| MNY-30 | **3/3** | E-0010 | PASS |
| REF-28 | **0/3** | E-0011 | FAIL at the sale premise (the overcharge above) |

## Consequence for the plan

- C90 (tender representation) escalates to **P0 money defect** and is PARKED with the decision pack above.
- P0-b (S3 truth) is **DONE as a measurement** (E-0012, E-0013) and the answer is "overcharge", not "safe".
- MNY-26 at 2/3 is **not a PASS**; it needs a captured failure line before it can be classified.
- Everything else in the register is unchanged and still QUEUED.
