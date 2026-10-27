# Bug report - `<DOMAIN-NN>` / `<P-number if assigned>`

**Title:** one sentence, the user-visible wrongness, no cause.

**Severity:** P0 | P1 | P2 | P3  -  P1 = wrong result, P2 = missing but what runs is correct,
P0 = data/financial loss or no recovery, P3 = cosmetic or artificial-extreme only.

**Verdict:** FAIL | PASS-PARTIAL | BLOCKED  (PASS is not a bug report)

**Evidence class:** DB row | BYTES | RUNTIME | SOURCE | UI
(a UI-only evidence class on a non-text case is almost always a test bug)

## Observed

What the harness saw, quoted raw. Numbers, not adjectives.

```
collected = 90000
committed = 57900
stored    = 80000
```

## Expected

The rule, and where it comes from (case text, spec, or the other code path).

## Reproduce

```powershell
node .opencode/skills/e2e-testing/scripts/run.mjs --spec e2e-tests/specs/<file>.e2e.ts --wipe --tag <slug>
```

- fixture / seed:
- steps that matter:
- git SHA + binary:

## Root cause

`path/to/file.ts:123-130` - what it does, why that produces the observation.
If unknown, write "unknown" and list the two hypotheses you would test next.

## Blast radius

Which flows, which roles, which data. "Every sale with a stacked discount" beats "some sales".

## Fix

Commit / PR, or `open` with the proposed change and the trade-off.

## Regression

- spec: `<file>` / `it('[DOMAIN-NN] ...')`
- assertion: the exact comparison that would fail on the pre-fix tree
- flake check: `repeat-run.mjs --times 3` result

## Not asserted

Facets the harness cannot reach (physical print, second terminal, 1M rows). Name them so the
next reader does not over-trust the verdict.
