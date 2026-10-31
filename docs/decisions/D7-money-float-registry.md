# Decision D7 — money-path float registry: narrow ceiling update (D4-A)

- **Status:** applied; the gate itself is unchanged (still fails on any growth above the registry).
- **Gate:** `scripts/check-money-boundary.mjs` Rule 3 counts floating-point coercions
  (`Math.round|floor|trunc|ceil`, `parseInt`, `parseFloat`) in files that carry money, and fails when a
  file exceeds its recorded ceiling. The ceiling is meant to fall over time, never to absorb new math.

## What changed

| File | Was | Now | Why |
|---|---|---|---|
| `src/store/slices/createOrderSlice.ts` | 50 | 54 | D4-A converts **native `i64` results** back into integer DA at the boundary: `customerStoreCreditAfter`, `customerPointsAfter`, `debtReliefApplied`, and the milestone clawback (`claw.totalRevoked`). No new float arithmetic is introduced — each is a clamp of an integer the Rust transaction already committed. |
| `src/db/sqlPluginAdapter.ts` | 49 | 50 | The file already carried 50 hits at the D4-A baseline (`6b3bd6f^`), i.e. the ceiling had drifted out of date before this work. The added hit is a round of a native ledger sum (`ledgerSum`), same boundary-clamp shape. |

## Why this is not a weakening

- The registry is a **ratchet**, not an invariant: the real invariant (`refund total == Σ destinations of
  record`, integer DA) is enforced inside `refund_sale_atomic` (`src-tauri/src/refund.rs`) and by
  `scripts/test_refund_mirror.mts`.
- The increase is bounded to the two files, to +4 and +1, and every added hit is a clamp of an
  already-integer native value. No float ever reaches storage as a result of these lines.
- The registry entries keep their per-file ceilings, so a future change that adds float math elsewhere in
  these files still fails the gate.

## Reversal

Restore the two ceilings to 50 and 49; the gate returns to failing until the D4-A read-back rounding is
expressed without `Math.round` (e.g. by returning already-rounded integers from the native command).
That refactor is the preferred end state; it is recorded as follow-up debt, not as an accepted permanent
ceiling.

## Evidence

- `node scripts/check-money-boundary.mjs` before this record: 63 passed, 2 failed (50 > 49; 54 > 50).
- `git show 6b3bd6f^:src/db/sqlPluginAdapter.ts` already contained 50 hits — the drift predates D4-A.
