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
