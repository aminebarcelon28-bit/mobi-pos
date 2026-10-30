# `case-index.mjs` - the contract

`e2e-tests/CASE_INDEX.csv` is the single verdict source for the whole corpus: 697 rows,
`id,domain,priority,conditional_p0,title,section,line,retired,verdict,spec,evidence`. Both
gates read it (`reconcile.mjs` for parity + FAIL clustering, `delta.mjs` for regressions).
This script is the only tool allowed to *grow* it, because it derives the dashboard counts
instead of asking a human to type them and it appends without touching the existing bytes.

```powershell
node .opencode/skills/feature-e2e/scripts/case-index.mjs next <DOMAIN> [count]
node .opencode/skills/feature-e2e/scripts/case-index.mjs add <cases.json> [--write]
node .opencode/skills/feature-e2e/scripts/case-index.mjs check
```

Run it from the repo (or any directory under it): it walks up to the first
`e2e-tests/CASE_INDEX.csv`.

## `next` - allocate ids

Highest existing number for that domain, plus one, zero-padded to 2 digits. Domains may
contain digits after the first letter (`I18-16` is valid). An unused domain starts at
`01` (`NEWDOM-01`). `next` prints only; nothing is reserved, so allocate and use in the
same sitting.

## `add` - validate, then append

Input is a JSON array; one object per case. `--write` is the only thing that mutates.

| Field | Required | Rule |
|---|---|---|
| `domain` | yes | 2-4 chars, starts with a letter, upper-cased for you |
| `id` | no | allocated from `domain` when absent; if given, must match `^[A-Z][A-Z0-9]{1,3}-\d+$` and be unused |
| `priority` | yes | `P0` \| `P1` \| `P2` \| `N/A` |
| `verdict` | yes | `PASS` \| `PASS-PARTIAL` \| `FAIL` \| `N/A` \| `REMAIN` \| `BLOCKED` |
| `title` | yes | non-empty, **one line** (a newline would break the CSV row) |
| `evidence` | yes | one line: the artifact that justifies the verdict (`**FAIL** 3 of 8 assertions`, the IPC code, the table delta) |
| `spec` | no | file name only, must exist in `e2e-tests/specs/` |
| `conditional_p0` | no | free text, e.g. `discount > 0` |
| `section` | no | defaults to `domain` |
| `line` | no | left empty and auto-anchored on the spec line containing `[ID]`; a stale number is worse than none |
| `retired` | no | `0` (default) or `1`; retired rows keep their id so it is never reused |

Behaviour:

- **All-or-nothing.** Every row is validated before a single byte is written; one bad row
  means nothing is written and the exit code is 1.
- **Dry run by default.** Prints the allocated ids and the exact dashboard deltas it *would*
  apply (`FAIL: 251 -> 252`); read them before adding `--write`.
- **Append only.** The new rows are appended after the existing bytes (same line ending as
  the file, trailing newline ensured); the 697 existing rows are byte-identical afterwards.
- **Dashboard synced in the same step.** Only the counter rows of `COVERAGE.md` change:
  `Catalog cases`, `Passed (full)`, `Passed (partial…)`, `**FAILED**`, `N/A`, `Remaining`,
  `BLOCKED`. Labels are matched the same way `reconcile.mjs` parses them (bold markers
  stripped), so a bolded row like `**FAILED**` updates too. Counts are active-only: a
  `retired=1` row never moves `Catalog cases`.

## `check` - the local gate

Fails (exit 1) on: malformed or duplicate ids, an unknown verdict or priority, a `retired`
value that is not `0`/`1`, an empty `title`/`evidence` on a live row, or any dashboard counter
that disagrees with the CSV. Retired rows are exempt from the content checks on purpose -
they are owner-removed placeholders and legitimately carry no title (the 10 owner-retired tax
rows do exactly that).

On success it prints `case-index: ok (<rows> rows, <active> active, dashboard in sync)`.

`check` does **not** replace `reconcile.mjs`: reconcile additionally enforces the
FAIL -> root-cause-cluster mapping and the id uniqueness across the whole corpus. Run both.

## What a FAIL costs you

A new `FAIL` row without a matching row in `e2e-tests/FAIL-CLUSTERS.csv` makes
`reconcile.mjs` exit non-zero. Add, for each FAIL case:

```
case_id,cluster_id,cluster_key,class,evidence,money,priority,catalog
FEAT-02,C88,FEAT-REFUSAL-FALLTHROUGH,app,SQLite + IPC code,money movement,P0,NEW
```

`class` is `app` \| `test` \| `harness` \| `env` - classify before fixing. Reuse an existing
`cluster_id` when the root cause is already known; a new one needs a `cluster_key` that says
what the cause *is*, not where it was seen.

## Verified behaviour (fixture round-trip, 17/17)

Measured on a throwaway copy of the corpus, never against the real file: `check` clean on
the baseline; dry run writes nothing; `add --write` leaves the existing bytes untouched and
appends exactly N lines in the header's column order; only the affected counters change in
`COVERAGE.md` (bolded `**FAILED**` included, em dashes intact); `check` clean afterwards;
duplicate id / unknown verdict / missing spec each refused with exit 1; hand-editing one
counter is caught as `dashboard FAIL: file=… csv=…`.
