# Batch Plan — 321 remaining edge cases (Batches 20–31)

Generated 2026-10-24 from `e2e-tests/CASE_INDEX.csv`.

## Queue source and reconciliation

- `CASE_INDEX.csv` did not exist anywhere under the repo's parent directory; the
  queue was derived from `e2e-tests/fixtures/cases.json` (687 active cases) plus
  the current `COVERAGE.md` verdicts. `CASE_INDEX.csv` now exists at the repo
  root of `e2e-tests/` with the resolved priority column (`P0`/`P1`/`P2`) and
  the current verdict (`PASS`, `PASS-PARTIAL`, `FAIL`, `N/A`, `BLOCKED`,
  `REMAIN`).
- 10 retired tax IDs (`MNY-08..10`, `MNY-12..15`, `REF-04`, `REP-17`,
  `RPT-02`) are in the index with `retired=1` and `N/A`; they are outside the
  687 and are never queued.
- Current active tally: **687 = 145 full PASS + 6 PASS-PARTIAL + 121 FAIL +
  93 N/A + 321 REMAIN + 1 BLOCKED**. The queue below is the 321 `REMAIN`
  cases; `LOY-11` is the separate BLOCKED case.
- Remaining by domain: DAT 89, SCL 89, SYN 30, MOB 25, RCP 24, I18 15, LBL 13,
  RPT 12, TIM 10, HW 8, PRF 6. Remaining by priority: P0 159, P1 150, P2 12.
- Order: **all P0 first**, then P1, then P2. Domains stay grouped inside a
  priority; only batch-boundary cases mix domains.

## Batch sequence

| Batch | Domain / priority | Cases | IDs |
|---|---|---|---|
| 20 | DAT P0 (1/3) | 29 | DAT-01, DAT-02, DAT-03, DAT-04, DAT-05, DAT-06, DAT-07, DAT-08, DAT-09, DAT-10, DAT-11, DAT-12, DAT-13, DAT-14, DAT-15, DAT-16, DAT-17, DAT-18, DAT-19, DAT-20, DAT-21, DAT-22, DAT-23, DAT-24, DAT-25, DAT-26, DAT-27, DAT-28, DAT-29 |
| 21 | DAT P0 (2/3) | 29 | DAT-30, DAT-31, DAT-32, DAT-33, DAT-34, DAT-35, DAT-36, DAT-37, DAT-38, DAT-39, DAT-40, DAT-41, DAT-42, DAT-43, DAT-44, DAT-45, DAT-46, DAT-47, DAT-48, DAT-49, DAT-50, DAT-51, DAT-52, DAT-53, DAT-54, DAT-55, DAT-56, DAT-57, DAT-58 |
| 22 | DAT P0 (3/3) | 29 | DAT-59, DAT-60, DAT-61, DAT-62, DAT-63, DAT-64, DAT-65, DAT-66, DAT-67, DAT-68, DAT-69, DAT-70, DAT-71, DAT-72, DAT-73, DAT-74, DAT-75, DAT-76, DAT-77, DAT-78, DAT-80, DAT-81, DAT-82, DAT-83, DAT-85, DAT-86, DAT-87, DAT-88, DAT-89 |
| 23 | SCL P0 + RCP P0 + I18 P0 + TIM P0 | 26 | SCL-07, SCL-12, SCL-13, SCL-14, SCL-23, SCL-26, SCL-36, SCL-37, SCL-38, SCL-43, SCL-45, SCL-46, SCL-47, SCL-48, SCL-58, SCL-77, SCL-78, SCL-79, SCL-83, SCL-84, RCP-04, RCP-06, RCP-20, I18-05, TIM-01, TIM-08 |
| 24 | SYN P0 | 30 | SYN-01 … SYN-30 |
| 25 | MOB P0 + MOB P1 | 25 | MOB-01 … MOB-10, MOB-13 … MOB-16, MOB-20, MOB-24, MOB-11, MOB-12, MOB-17 … MOB-19, MOB-21 … MOB-23, MOB-25 |
| 26 | SCL P1 (1/3) | 30 | SCL-01 … SCL-06, SCL-08 … SCL-11, SCL-15 … SCL-22, SCL-24, SCL-25, SCL-27 … SCL-35, SCL-39 |
| 27 | SCL P1 (2/3) | 30 | SCL-40 … SCL-42, SCL-44, SCL-49 … SCL-56, SCL-59 … SCL-75 |
| 28 | SCL P1 (3/3) + DAT P1 + RCP P1 (1/2) | 30 | SCL-76, SCL-80 … SCL-82, SCL-85 … SCL-89, DAT-79, DAT-84, RCP-01 … RCP-03, RCP-05, RCP-07 … RCP-19, RCP-21, RCP-22 |
| 29 | RCP P1 (2/2) + I18 P1 + LBL P1 | 29 | RCP-23, RCP-24, I18-01 … I18-04, I18-06 … I18-15, LBL-01 … LBL-13 |
| 30 | RPT P1 + TIM P1 + PRF P1 | 22 | RPT-01, RPT-03 … RPT-13, TIM-02 … TIM-07, TIM-09, TIM-10, PRF-05, PRF-06 |
| 31 | HW P2 + PRF P2 | 12 | HW-01 … HW-08, PRF-01 … PRF-04 |

Total queued: **321**. Separate BLOCKED: **LOY-11**.

## Per-batch method

1. Write one spec per domain/batch under `e2e-tests/specs/` with every `it()`
   tagged `[CASE-ID]`.
2. Execute the real app in wipe mode:
   `POS_E2E_WIPE=1 npx wdio run e2e-tests/wdio.conf.ts --spec <spec>`.
3. PASS requires a negative control; FAIL records expected vs actual with real
   ids/values and `file:line`; N/A requires an executed absence probe (schema,
   DOM, settings or `rg`); BLOCKED is not "remaining": it names the exact
   missing dependency in `CASE_INDEX.csv` (verdict=BLOCKED, `evidence` column).
4. Reconcile `COVERAGE.md`, `EDGE_CASE_VULNERABILITY_REPORT.md`,
   `results/summary.json`, `CASE_INDEX.csv` (the single verdict source), and the
   canonical logs; verify
   `pass + partial + fail + N/A + blocked + remain = 687` (REMAIN must be 0 at
   batch close; every row carries a verdict or a named blocker).
5. Re-run `git status --porcelain` and confirm the 65 pre-existing non-e2e
   entries are untouched.

## Invariants

The pre-batch controls are in
`specs/01-invariant-negative-controls.e2e.ts`. Invariant coverage stays at
**25/36** until the remaining 11 are implemented with their domains. The 11
not-yet-harnessed invariants will be added when their domain batch runs; any
that cannot be executed gets a written reason in the report.
