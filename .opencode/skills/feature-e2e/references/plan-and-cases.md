# Plan and cases - from a change to a case table

Phase 1 produces the brief, phase 2 produces the case table. This file is how to do both
without the two classic failures: a brief that says "seems low risk" and a case table that
tests the happy path five times.

## The brief

Use `.opencode/skills/e2e-testing/templates/risk-brief.md` as-is (do not fork it) and add
`Reachable` and `If wrong` for new features. The two lines that decide everything:

- **`Invariant that would break silently`** - if you cannot name one, either the feature does
  not touch persisted business state (rare in this app) or you have not read the write path
  yet. Go back to phase 0.
- **`Blast radius`** - the existing specs that import the same helper or write the same
  table. This is a grep, not a guess:
  `Select-String -Path e2e-tests/specs/*.e2e.ts -Pattern "lib/<helper>|<table>"`.

A brief that fills `Touches` with "none" for a feature that inserts into `transactions` is
wrong; check the table name against `lib/db.ts` `tableNames()`.

## The case table

```markdown
| id | prio | surface | given / when / then | oracle | assertion | new? |
|---|---|---|---|---|---|---|
| FEAT-01 | P0 | desk | sale of one unit with the new discount: total stored = 500 - 10 % | transactions.json_payload.total_da | db | new |
```

Four rules do most of the work:

1. **The oracle column must name a table+column, a command code, or a byte stream.** "UI shows
   the right total" is not an oracle. If the cell needs the word "and", split the case.
2. **One case per behaviour, not per screen.** Two screens showing the same fact is one case
   with two assertions, unless the *mirror* is the risk (then it is a separate case whose
   oracle is the mirror-vs-SQLite comparison, G-18 class).
3. **The negative case is mandatory** and its assertion is two-sided: the typed refusal
   arrives **and** the side effect did not happen (row count unchanged, stock unchanged).
   A refusal that still writes is a FAIL.
4. **The idempotency case exists whenever the action can be replayed** by a double-click, a
   retry, an offline replay or a sync re-delivery. Its oracle is the row count / `seq_no`
   after the second attempt, not the UI's "already done" message.

## Sizing

| Feature shape | Typical case count |
|---|---|
| New label, layout, translation | 1-2 (DOM + screenshot-free text assertion) |
| New read-only surface (report, list, search) | 2-4 (empty, populated, restricted role) |
| New write path, non-money | 3-6 (+ refusal, + replay) |
| New money path | 5-10 (+ rounding edge, + drawer/ledger effect, + reversal) |
| New trust / auth / lockout path | 4-8 (+ step-up required, + stale/future timestamp, + revoked) |

More than 12 usually means the change is several features. Say so in the report and split
the spec; one 800-line spec is harder to triage than three 250-line ones.

## Worked example (hypothetical, shape only)

Feature: *"take a deposit on a repair intake; the deposit reduces the balance owed at
delivery"*. Brief would read: `Touches: money`; `If wrong: drawer counted more than it holds,
or the customer is charged twice`; `Invariant: G-01 conservation + G-21 warranty binding`.

| id | prio | surface | given / when / then | oracle | assertion |
|---|---|---|---|---|---|
| REP-92 | P0 | desk | intake 5000 DA repair, take 2000 DA deposit → `sav_repairs` payload carries `deposit_da=2000`, balance 3000 | `sav_repairs.json_payload` | db |
| REP-93 | P0 | desk | delivery charges only the balance → transaction total = 3000 and `cash_sessions` expected = opening + 5000 | `transactions` + `cash_sessions` | db |
| REP-94 | P1 | desk | deposit refunded then repair cancelled → the deposit transaction is reversed once, no orphan row | `transactions` refund rows | db |
| REP-95 | P1 | data | replay the deposit command with the same idempotency key → second call refused, one deposit row | `nativeCodeOf` + row count | ipc-code + db |
| REP-96 | P1 | desk | deposit > repair price → typed refusal, no `sav_repairs` write, no cash row | `nativeCodeOf` + row counts | ipc-code + db |
| REP-97 | P2 | desk | no deposit taken → deliver charges the full price (regression guard) | `transactions` total | db |

Note what the table buys: REP-96 is the case that catches a fallback, REP-95 the one that
catches a replay, REP-93 the one that catches a drawer mismatch that the UI would happily
show as correct. None of them would be written by "test the deposit screen".

## Review checklist before phase 3

- [ ] every `oracle` cell names a real table/column, IPC symbol or byte stream
- [ ] at least one refusal case, and it asserts absence of the side effect
- [ ] at least one boundary or idempotency case for any numeric or replayable path
- [ ] ids allocated with `case-index.mjs next`, not typed
- [ ] no case duplicates an existing `CASE_INDEX.csv` title (grep the nouns first)
- [ ] the set fits one spec file, and the file name follows `NN-<dom>-<feature>.e2e.ts`
- [ ] any case that cannot run today is marked `BLOCKED` with the dependency named, not `N/A`
