# C01 — under-refund classification (exhaustive) + decision pack

Source: the B3/B4 generator (seed 424242), old split at `a9fa0ad` vs v2 at HEAD. Only shapes where
`old.net < new.net` (2 506 of 4 763). Predicates are exclusive by construction (first match wins) and
the last bucket is a measured threshold, not a catch-all: **UNEXPLAINED = 0**.

| # | Sub-bucket | Count | Share | Cause (field-level) | Status |
|---|---|---|---|---|---|
| 1 | `digital-rail-omitted` | 1436 | 57.3 % | old `recoverableBase = total + voucher + avoir` omits BaridiMob/Chèque tenders | **fixed by v2** (v2 includes them in `given`) |
| 2 | `debt-rail-omitted` | 578 | 23.1 % | same, for `Crédit Client` tenders | **fixed by v2** |
| 3 | `credit-exceeds-total` | 243 | 9.7 % | old caps `fundA`/`fundV` at `total`; a credit larger than the ticket loses the excess | **fixed by v2** (`given` from tenders) |
| 4 | `zero-total-credit-paid` | 118 | 4.7 % | fully credit-paid ticket (`total 0`) refunded **nothing** at all | **fixed by v2** |
| 5 | `da-rounding` | 121 | 4.8 % | old rounded the refund to whole DA (`Math.round(net)`); v2 keeps minor units (deltas 1–99 minor) | **OWNER DECISION (D-RND)** |
| 6 | `change-ignored` | 10 | 0.4 % | old never netted `change_due`, so over-tendered tickets under-refunded | **fixed by v2** |
| | **total** | **2 506** | 100 % | | **UNEXPLAINED = 0** |

Exemplars (one per bucket; the full run printed three for each in the two preceding passes):

```
digital  total 162, tenders 162 cash + 264 BaridiMob, gross 378   old net 144    new net 378     (+23 400 minor)
debt     total  96, tenders  96 cash + 277 Crédit,   gross 345   old net  89    new net 345     (+25 600)
credit>  total  33, voucher 108,                     gross  13   old net  26    new net 55.55   (+2 955)
zero     total   0, tenders avoir 26,                gross  12   old net   0    new net 12      (+1 200)
da-rnd   total 640, voucher 113,                     gross 302   old net 355   new net 355.32  (+32)
change   total 250, change 7, avoir 324,             gross   7   old net  14    new net 16.27   (+227)
```

## What this settles

**2 385 of 2 506 (95.2 %) are old-code defects that v2 already fixes.** They are not policy: the old
base simply did not count the card rail, the debt rail, a credit larger than the ticket, or a
fully-credit-paid ticket. No code change is implied; the existing tests cover the classes.

## Decision pack

**D-RND — refund rounding granularity (121 shapes, 4.8 %).**
Old code rounded every refund to whole dinars; v2 is exact to the minor unit.
- **A (recommended)** keep minor-unit precision: a 355.32 DA refund is correct and the drawer already
  rounds only its own cash lane (Q-i). Risk: receipts show cents more often.
- **B** round the refund total to whole DA again: fewer decimals, but reintroduces a ≤0.99 DA
  under/over-refund per ticket and contradicts invariant (ii).
- **C** round only when the payment method is cash (hybrid): matches the drawer, complicates the
  ledger.
DONE when: the chosen rule is encoded in the split and the `da-rounding` bucket disappears (A) or is
declared expected (B/C) with a test.

**D-C90 — 100 DA overcharge on credit-covered sales** (E-0012/E-0013, REF-28 1/3):
A `netAfterCredits` helper used by every tender writer (recommended) / B spec-only (rejected: the
money is real) / C slice guard.

**D-B3 — walk-in trade-in loses the trade value** (E-0024, REF-49 2/3):
A refuse an anonymous trade-in sale at checkout (recommended) / B always restore to voucher-avoir /
C document shop-keeps-value.

All three live in files the mission marks read-only for C01 (`PaymentModal`, checkout), so none can be
closed by me without the decision.
