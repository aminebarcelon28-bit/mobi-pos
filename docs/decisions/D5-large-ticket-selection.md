# Decision D5 — selection of very large tickets must not parse the whole payload

**Status: root cause measured; fix designed, not yet implemented.**

## Evidence

| Ticket | `total` | `length(json_payload)` |
|---|---|---|
| 2³¹+1 sale | 2 147 483 649 | **51 220 718 B** |
| 4e9 sale | 4 000 000 000 | **138 742 528 B** |

Payload composition of the 4e9 sale (E-0079):

| Key | Size |
|---|---|
| `customer` | **42 740 557 B** |
| `milestoneAwards` | **8 478 816 B** |
| `items` | 641 B |
| everything else | < 1 KB |

The customer block grows because the sale earns `floor(total × rate)` points (80 000 000 points on a 4e9 sale) and both `pointBuckets` and the milestone evaluator materialise per-point structures. So **payload size is proportional to ticket value**, which is why REF-87's 4e9 ticket is 95 MB and why every 4e9/2³¹ ticket is unselectable: the refund modal's fallback read is
`transactionAdapter.ts:467-478` → `SELECT *` → `mapTxRowsToSaleTransactions` → **JSON.parse of the full
payload on the main thread**, and the 9 s / 30 s selection windows expire.

## Options

| # | Option | Effect | Risk |
|---|---|---|---|
| **A** | Lightweight projection in the refund search path: `json_extract` only `items`, `refundedItems`, `customer.id`, `status`, `total`, `receipt_number` (SQL-side), never the whole payload | selection no longer depends on payload size | touches `transactionAdapter.ts` (read-only by default → narrow lift) |
| B | Stop materialising per-point structures (store balances as integers) | removes the bloat at the source | deep data-model change, migration on real data — forbidden without backup/dry run |
| C | Cap the payload (e.g., strip `customer`/`milestoneAwards` before writing the sale row) | smaller rows | loses audit data; changes the receipt contract |

**Choice: A now; B as a separate, planned decision (it needs a migration and an owner-approved backup
plan).** A is narrow, reversible, and does not touch money math.

## Reversal

Restore `SELECT *` + full mapping in the adapter. A revert is a single commit.

## Note on REF-87

REF-87's in-suite failure and this diag's selection failures share one cause. The owner's instruction was
to treat the fixture as the cause "until disproved"; the sizes above **disprove the fixture-only
hypothesis** — an anonymous 4e9 ticket was 95.7 MB, a customer-attached 4e9 ticket is 138.7 MB, and both
fail selection. The fixture added 43 MB of customer block, which is why the failure became consistent.
