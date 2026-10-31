# Decision D11 — negative-control writes in the invariant oracle

- **Status:** applied 2026-10-31; scope is id-shaped, never actor-named.

## Context

The E2E invariant oracle (`e2e-tests/lib/invariants.ts`) runs after every spec and fails the run on
G-15 (authorization envelope) / G-19 (attribution) findings. Two specs deliberately build a refund request
**by hand** and invoke the native command, to prove the guards:
`REF-24` (velocity policy: the under-threshold forged refund must land, the over-threshold one must be
refused) and `REF-58` (double-submit race).

Those writes carry `actor = 'E2E-Forge'`, no supervisor attestation, and no cashier snapshot — by
construction. The oracle reported exactly that, which is correct: the renderer holds the SQL/IPC handle
until the data-plane gateway lands (`AGENTS.md`, "WebView SQL bypass (OPEN residual)"). The findings are a
**known, documented residual**, not a product regression, so failing the product oracle on them makes the
suite red for a risk that is already accepted.

## Options

| # | Option | Verdict |
|---|---|---|
| A | Make the forged requests look legitimate (configured actor + "Superviseur" in details) | rejected: it fabricates an attestation the product does not verify — exactly the vulnerability being documented |
| B | Stop running the forged lanes | rejected: they are the negative controls that prove the guards |
| C | Skip the invariant hook for those specs | rejected: a skipped gate is not a gate |
| **D** | **Classify a finding as RESIDUAL-ACCEPTED only when the row id matches the negative-control id shape (`(AUD-)?REF-FORGE-` / `AVOIR-FORGE-`), and still log every one of them** | **chosen** |

## Why D is not a weakening

- The filter is **by id shape produced by the harness**, not by actor name, so a real write cannot hide by
  choosing an actor.
- Everything else stays strict: a non-forged refund without attestation, or any unknown-actor write, still
  fails G-15/G-19 exactly as before.
- Each classified finding is printed as `[INVARIANT RESIDUAL-ACCEPTED] …`, so the suite's log always shows
  the residual; it is visible, not silent.
- The same pattern already exists in the money gate (`refund-value-check.mjs --exclude-forge`) and is used
  there for the identical reason.

## Reversal

Delete the `isNegativeControlWrite` branch (two call sites in G-15, one in G-19). The oracle then fails on
the negative-control writes again; do that only after the data-plane gateway makes the renderer unable to
write these rows at all.

## Residual this decision records

The renderer can still write a refund with a forged actor. Detection (audit + oracle logging) is the only
defence until the gateway lands. This is the same accepted residual as `docs/webview-sql-residual.md`.
