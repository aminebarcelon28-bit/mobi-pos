# D-REF86 — mega-refund latency and the D6 aggregation decision

**Date:** 2026-11-03 · **Case:** REF-86 (spec 32) · **Status:** PASS on the current tree; D6 not
triggered at product scale — documented, not built.

## Measurement (this tree, `f35f7e1`)

- REF-86 isolated: **1/1 PASS in 97 s** (7 refunds: 3 line-chunks asc + 4 unit-chunks desc).
- Full spec 32: **15/15 PASS in 459 s**, 0 money violations.
- Post-run sandbox DB: largest customer payload **7 039 B / 18 ledger entries**; total customer
  payload 22 KB across 10 rows; largest outbox payload 8 KB; DB 3.4 MB.

The earlier ~80 MB customer document was a **stress artifact** (E-0112/E-0117: the old sale payload
carried the customer's whole loyalty book, fixed in 8b59ebd to 241 B), not the realistic path. With
the payload in the KB range, the five-rewrites-per-refund cost is milliseconds and REF-86's former
flake is gone (the remaining failure mode was the submit/toast harness race, fixed in E-0160).

## Decision

1. **Do not aggregate the loyalty ledger now.** D6 (monthly/bucket aggregates) changes the loyalty
   data model that expiry buckets and milestone spend read; doing it without a reproducible
   merchant-scale failure would be a money-path change with no failing test — prohibited by the
   work rules and unjustified by the measurement.
2. **Bound the pathological case instead:** the renderer already skips the >4 MB mirror
   (createOrderSlice), and the native path writes through SQLite transactions. Add a diagnostic
   warning when a customer payload crosses **4 MB** so a real merchant-scale case is visible in the
   logs before it becomes a latency cliff.
3. **Re-open D6 only with a deterministic repro** (a seeded ledger of ≥50k entries) and a measured
   before/after; the aggregation design must preserve (a) the points balance, (b) per-bucket expiry,
   (c) milestone spend, (d) stable order and integer DA math, and (e) one source of truth (native).

## Rejected alternatives

- **Aggregate now** without a failing case: untestable money-path risk.
- **Increase harness retries/windows**: retries are not a fix (E-0112's lesson).
- **Shrink the ledger in the TS mirror only**: the native payload stays large; one source of truth
  is the native row.
