# C01 reviewer pack — refund allocation (human review required)

**This money code was authored and verified by the same agent. It needs human review before merge.**
Commit `a9fa0ad` (the previous session's MNY/CRT work) has only been agent-reviewed; `c9118c4`
(this batch's split) has unit proof plus E2E evidence but no human sign-off. Nothing here has been
reviewed by a second pair of eyes.

---

## 1. The money functions and where they live

| Function | File | What it decides |
|---|---|---|
| `computeRefundFundingSplit(orig, gross, priorRecovery, priorLanes)` | `src/utils/receiptMath.ts` | how much of a refund goes back through each funding source (cash / avoir / voucher / debt / digital), in integer minor units |
| `refundLaneTotalsOf(refundRow)` | `src/utils/receiptMath.ts` | reads the per-lane amounts a previous refund already returned (new rows: `funding` in the JSON payload; legacy rows: derived from columns, never throws) |
| `computeRefundFundingSplit` callers | `src/store/slices/createOrderSlice.ts` (commit), `src/components/modals/RefundModal.tsx` (preview) | both pass the same prior lanes, so preview == commit |
| `clampCashRefund` / `physicalCashTendered` | `src/utils/cashTerms.ts` | caps drawer cash at what was physically tendered (unchanged this batch) |
| `computeCartTotals` / `lineProfitNet` | `src/utils/receiptMath.ts` | sale-side totals — **untouched** (proof: the diff hunks start after line 520; no hunk covers these functions) |

The refund row now persists:

```json
"funding": { "version": 1, "basis": "explicit|derived|legacy",
             "anomalies": ["cumulative-cap", "legacy-no-funding-object", "..."],
             "cash": 800, "avoir": 100, "voucher": 0, "debt": 0, "digital": 0, "gross": 900 }
```

## 2. Invariants (the property tests)

- **(i)** Σ lane refunds over all partials of a ticket never exceeds the lane's original amount.
- **(ii)** after a full refund every lane is exactly its original amount (0 minor drift).
- **(iii)** no lane is ever negative.
- **(iv)** each refund's lanes sum exactly to that refund's total.
- **(v)** after any prefix of partials, each lane is within 1 minor unit of its proportional share.
- **(vi)** a lane's cumulative refund never decreases.

(i)–(vi) are asserted in `scripts/test_refund_root_invariants.mts` (§I4b), including a 400-sequence
random sweep, a 5 000-shape single-refund sweep, S3 and trade-in fixtures, and **three deliberately
broken allocators** (cash-first, floor-only, overdraw-last-lane) that the checker kills.

## 3. How to run everything

```powershell
npm run build:e2e
npm run test:refund-root                      # 138 checks, 0 failed (unit; the money proof)
node .opencode/skills/e2e-testing/scripts/preflight.mjs
node .opencode/skills/e2e-testing/scripts/lint-specs.mjs
node .opencode/skills/e2e-testing/scripts/selftest.mjs     # pipeline scripts
node .opencode/skills/e2e-testing/scripts/reconcile.mjs    # dashboard == CSV

# isolated evidence runs (~1 min each, --grep keeps it to one case)
node .opencode/skills/e2e-testing/scripts/run.mjs --spec e2e-tests/specs/30-ref-refunds.e2e.ts --grep REF-03 --wipe --tag r03
node .opencode/skills/e2e-testing/scripts/run.mjs --spec e2e-tests/specs/32-ref-refunds-part3.e2e.ts --grep REF-33 --wipe --tag r33
node .opencode/skills/e2e-testing/scripts/run.mjs --spec e2e-tests/specs/31-ref-refunds-part2.e2e.ts --grep REF-28 --wipe --tag r28
```

## 4. BEHAVIOR CHANGES (need owner sign-off)

- **B-1 trade-in ticket.** Old: refund paid 900 cash on a ticket where 600 cash + 400 avoir + 300
  Reprise were tendered (the trade value left the drawer, and cash exceeded the cash taken).
  New: 600 cash + 400 avoir, and the trade value is restored separately by
  `computeTradeRestoreQuota` (300 to the wallet). Row total stays 1300. Customer receives
  600 cash + 700 wallet; the trade device stays with the shop. E2E `MNY-26` PASS.
- **B-2 voucher-only ticket.** Old: a ticket paid 500 by voucher refunded **0**. New: 500 on the
  voucher lane, `refund.rs:1684-1728` credits `credit_vouchers.remaining_amount` back with a CAS —
  **but only when the sale carries `voucherCode`** (`createOrderSlice.ts:2808`). Without a code the
  lane would be reported and nothing restored: recorded in the RFC as a residual, not fixed here.

## 5. Known gaps

- `REF-28` is FAIL/UNPROVEN: it fails at a **sale-side** assertion (cash tender 900 vs due 800) in
  5/5 isolated runs. That is cluster `C90`, not the refund split.
- Fractional-DA cash lanes: the split can emit e.g. 333.33 cash; `clampCashRefund` rounds to 333 and
  the 0.33 is lost to both drawer and wallet (audit §3 of the report). Rule change not applied.
- `wallet=300` (the original REF-28 failure) is not explained; H4 (read between the native commit
  and the wallet save) is SUPPORTED by code path, H3-b (stale whole-row writer) is HYPOTHESIS,
  H5 (write failure) is KILLED.
- D4: the wallet write is not atomic with the refund (documented in `c01-d4-atomic-credit-rfc.md`).
- `REF-92` (three partials E2E) was **not built**.
- The full suite was not re-run; only the impacted specs (list in the batch report).

## 6. Commits in this batch

| Commit | Purpose |
|---|---|
| `f56d0d5` | Q-D: invariant events land under e2e-tests/results; artifact untracked |
| `0f4e5b1` | Q-C: flaky-aware ledger, `cluster.mjs` selftested, C89 restored |
| `3169fba` | hard cap + legacy history + prefix invariants + 3 mutation kills |
| `323db88` / `9d40d7d` | C90 diagnostic added, then reverted (unobservable, mechanism stays UNKNOWN) |
| `c9118c4` | the v2 split (B2, reviewed here) |
| `5d6e6e2` | S3 / trade-in fixtures, minor-unit comparisons |
| `ead6009` | `cluster.mjs` + partial-run selftest |
| `8250175` | tender + D4 RFCs |
| `97fc1d8`, `6a00714` | pipeline verdicts / provenance |

## 7. What a reviewer should check first

1. `computeRefundFundingSplit` — the cumulative-gross formula and the largest-lane correction.
2. `refundLaneTotalsOf` — the legacy fallback, especially the cash-residual-to-avoir rule.
3. `createOrderSlice` — the `funding` object written to the refund payload and the prior-lane fold.
4. That the sale path (`computeCartTotals`, `lineProfitNet`) is byte-identical (diff hunks).
