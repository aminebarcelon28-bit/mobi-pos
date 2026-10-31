# Pre-existing failures found by the full `31-ref-refunds-part2` sweep

Measured on the same spec file, same machine, isolated runs, two builds:

| Build | HEAD | Binary | Result | Failing cases |
|---|---|---|---|---|
| baseline (pre-C90, pre-D-RND) | `e88136b` | `691F95D8771AEFE296DDA0968E91337144F83BAA5E8D8FE99779EE795D997869` | 12/15 pass, 4 fail | REF-13, REF-36, REF-65 |
| head (C90 fix + residue rule) | `b48bf72` | `D5ACE59973B2CEF3878142E424D1B1212B79B25860B03C8DE89101E9D9100B05` | 12/15 pass, 4 fail | REF-13, REF-36, REF-65 |

**Case-by-case comparison: 15 cases, 0 verdict differences.** These are pre-existing and are *not*
regressions from the C90 tender fix or the D-RND residue rule. (`REF-28` passed inside the head run.)

## 1. REF-13 — a void does not restock the unit it sold

```
[REF-13] post-void: toasts="Vente #REC-... annulée." stock=497 (base 498) audits=13 moves=5 refunds=0
Expected: 498   Received: 497          (31-ref-refunds-part2.e2e.ts:1309)
```

The void flips the status and writes the audit, but the stock counter is one unit short of the
pre-sale base. The same run also reports `G-07` (loyalty headline vs buckets) and `G-08/G-15/G-19`
invariant violations, so the void path desynchronises more than stock.

**Suspect (READ, not yet reproduced in isolation):** the void restitution block at
`createOrderSlice.ts:~1898-1940` restores FIFO batches and inventory deltas; for a line without
recorded `fifoAllocations` it relies on the REFUND-batch fallback, which is the documented
`500/400`-class leak. Needs its own item.

## 2. REF-36 — a write-off ("Rebut") with an empty free-text motive is accepted

```
[REF-36] 'Autre'-empty write-off submit → landed=true surface=
[REF-36] ACCEPTED with quarantine note "Autre" — operator authored no note (empty free-text)
Expected: false   Received: true      (31-ref-refunds-part2.e2e.ts:1760)
```

The spec asserts that choosing *Autre* and typing nothing must be refused
(`RESTOCK_REASON_REQUIRED`, cited in the spec header as `RefundModal.tsx:561-562`). The modal appears
to treat the *selected preset* "Autre" as a sufficient motive. Defect in the reason validation, not in
the money split.

## 3. REF-65 — credit-sale refund refused through the UI

```
[REF-65] credit-sale refund refused (Erreur lors du remboursement :: toast="Vente enregistrée avec solde Crédit ...")
```

The refund submission is refused for a sale paid on `Crédit Client`, even though the debt is recomputed
from the ledger. The spec calls this the REF-65/P1-3 class. Needs its own item.

## Status

All three are **QUEUED as newly discovered, measured pre-existing defects** with the evidence above.
None is inside the C90 / refund-allocation scope that this pass was closing, and none is caused by the
changes in this pass (identical verdicts on both builds).

---

## Update (end of this pass)

- **REF-13: FIXED** (commit `eb95527`) - 3/3, full spec green (docs/c01-ref13-void.md).
- **REF-36: FIXED** (commit `bf82e06`) - 3/3 (E-0040).
- **REF-65: FIXED** (commits `8819680` + `2b0440e`) - 3/3 (E-0041); routed only for debt-only tickets so
  REF-42's channel behaviour is unchanged.
- **NEW, OPEN, MONEY:** REF-42 card-funded refund delivers **1400 for a 700 DA ticket** on BOTH the
  pre-REF-65 build (`eb95527`) and the current one - pre-existing, not a regression, not fixed here
  (docs/c01-ref42-double-delivery.md, E-0042).
- Full `31-ref-refunds-part2`: **15/15 GREEN** on a fresh build of `2b0440e` (E-0043).
## Second sweep - 33-ref-refunds-part4 (18 cases)

| Build | Result | Failing cases |
|---|---|---|
| HEAD `2b0440e` (`0B7134D4`) | **14/18** | REF-35, REF-40, REF-42, REF-87 |
| pre-change `e88136b` (`32F31CBD`) | REF-35 **0/2**, REF-40 **0/2**, REF-87 **0/2** | same three fail without any of this pass's changes |

So every failure in this file is **pre-existing**; the C90/REF-13/REF-36/REF-65 work introduced none.

| Case | Assertion | What it looks like | Evidence |
|---|---|---|---|
| REF-35 | `Expected 500, Received 500.01` (33-ref:2358) | a 0,01 DA "display-only" gift line is charged on the **sale** (`sale total=500.01 subtotal=500.01`), before any refund runs | E-0045, E-0046 |
| REF-40 | `Expected 1, Received 0` | deleted-customer tombstone path leaves a count at 0 | E-0045, E-0046 |
| REF-42 | `Expected 700, Received 1400` | the oracle double-counts one mirrored wallet credit - decision pack `docs/c01-ref42-double-delivery.md` | E-0042, E-0044 |
| REF-87 | `Expected 500, Received 500.01` | same 0,01 shape at extreme values | E-0045, E-0046 |

**Queue for the next pass:** REF-35/REF-87 share one cause (the gift line's 0,01 reaching the cart total) and are
the cheapest pair to fix together; REF-40 is a separate tombstone path; REF-42 waits on the owner decision.