# Worked examples

Three findings, end to end, in the order the procedure runs them: how the case was derived, what
was measured, what the verdict was, and what changed in the skill because of it. These were
removed from `SKILL.md` to keep it under its line cap - the facts are the same.

Read one when you are about to write a case in the same shape, or when you are unsure what
"evidence class" means in practice.

---

## 1. Export drift - `[RPT-05]`, two outputs describing the same money

**Derived by:** Gate 2 pass C (invariant: two outputs equal). The report screen and the exported
sheet both claim to describe the same 14 sales, so the case is "the export equals the screen", not
"the export runs".

**How it was tested:** `e2e-tests/tools/27d-rpt-checks.mts` imports the *shipped*
`generateProfessionalExcelXml` (`src/utils/excel/sheets.ts`), builds a fixed 14-row fixture, parses
the generated XML back with an independent parser, and compares three pairs (`27d-rpt-checks.mts:392-407`):

| Compared | Independent source |
|---|---|
| sheet net / cost / profit columns | `computeSalesMetrics` - the same helper the modal renders |
| row sums of the sales sheet | the headline totals in the same sheet |
| items sheet sum | CA Net |

**What it found:** the columns and the headline agree with each other but not with the screen, and
the row sums do not equal the headline:

- the per-row writer forces refund rows to `profit = 0` (`src/utils/excel/sheets.ts:160-161`);
- cost is read as `alloc ?? stored costTotal` with neither the exchange signed-cost branch nor the
  materialized `ledgerCogsTotal` (`sheets.ts:151-159` vs `receiptMath.ts:187-202`);
- the items sheet sums gross charged lines, so transaction-level discounts never reach it and
  refund vouchers (which carry no items) contribute nothing (`27d-rpt-checks.mts:461`).

**Verdict:** FAIL, evidence class BYTES (the parsed XML) + SOURCE (`sheets.ts:151-161`). Not
PASS-PARTIAL: the facet that was asserted is wrong, not unasserted.

**Same case, scale facet:** 100 000 rows -> wall time, heap delta, XML size, row count, last
receipt present, and `MAX_EXCEL_ROWS + 1` must throw the typed `TOO_LARGE` (`:452-463`). One case
carries the correctness and the scale measurement because they share the fixture; the verdict text
says which facet failed.

**Lesson copied into the skill:** assert the two outputs against *each other*, not each against
itself. A sheet that is internally consistent can still disagree with the screen - and the scale
number is worthless unless the same fixture also proves correctness.

---

## 2. Boot at 1M customers - `[PRF-05]`, the threshold came first

**Derived by:** Gate 2 pass D/E (scale interaction). The written pass condition, before any
measurement, was **"boot < 2 s at 1 000 000 customers"** - which is why the result is decidable at
all.

**Why Node-side:** seeding 1M rows through the UI/IPC blows the 300 s mocha timeout and the
WebView heap, so no WebView case may claim 1M coverage. `e2e-tests/tools/27e-prf-checks.mts:233`
seeds the rows directly into SQLite and times the **verbatim boot query**, copied from
`src/db/adapters/customerAdapter.ts:221-224` (`27e-prf-checks.mts:280`).

**Measured:** SQL 3 747 ms + row/JSON mapping 899 ms = **4 646 ms lower bound** (excludes the
`tauri-plugin-sql` IPC serialisation), **194.0 MiB** payload, **+858 MiB heap / +870 MiB RSS**.

**Root cause:** the customer lane is the only boot lane with no window. It selects every column of
every live customer, `ORDER BY name ASC`, with no supporting index (`src-tauri/src/lib.rs:1023-1025`
indexes phone, barcode and loyalty card only) and no `LIMIT`, and the store awaits it in the boot
`Promise.all` (`src/store/slices/createUISlice.ts:1990-2023`) while transactions, expenses and
shifts get bounded windows. The shell paints before wave 2, so the till is usable early - but every
customer surface (search, credit, loyalty) stays empty until this load finishes, and the whole
table stays resident.

**Verdict:** FAIL on desktop, evidence class RUNTIME (timings + heap) + SOURCE. The mobile facet is
BLOCKED (no device in the loop), named in the row - it is not folded into the FAIL and not dropped.

**Lesson copied into the skill:** a performance verdict is a *comparison against a number written
before the run*. And a lower bound must be labelled as one: 4 646 ms Node-side is not the same
claim as 4 646 ms in the app, and saying so is what keeps the case honest.

---

## 3. The refund dialog that threw - `[REF-*]`, why every spec installs the error trap

**Symptom:** opening the refund dialog threw a `ReferenceError` and the totals rendered blank. The
dialog still opened, so a case that only looked for the dialog passed.

**Derived by:** Gate 2 pass B (state x action) plus the standing rule that every spec installs the
error trap. `installErrorTrap()` in `before`, `expectNoUiErrors()` in `after`
(`e2e-tests/specs/30-ref-refunds.e2e.ts:544,564` - re-installed after a refresh, because a reload
wipes the JS context).

**What the trap bought:** the assertion that failed was "total is non-zero", but the trap named the
cause. Without it the report would have said "blank total" and the next person would have gone
looking for a formatting bug.

**Fix:** the missing symbol was restored in `a651768` (recorded in `references/bug-catalog.md` F2).
That commit is **not reachable in this clone** (`git log a651768` fails) - the row and the spec's
trap are the surviving evidence, so treat the commit id as provenance, not as something you can
diff here.

**Regression:** the refund spec asserts **no UI errors and a non-zero total**, both. An assertion
on the total alone would pass on a dialog that renders a stale value from a previous open.

**Lesson copied into the skill:** "no exception thrown" is not a PASS (non-negotiable 5), but the
converse matters too - a spec without the trap reports an unhandled `ReferenceError` as a UI-text
failure and hides the class. Same class is live today in `[MOB-23]`: a 13-digit EAN followed by
ENTER on the Caisse throws `ReferenceError: Cannot access 'y' before initialization`, 2/2
(`e2e-tests/EDGE_CASE_VULNERABILITY_REPORT.md:1236-1240`, `FAIL-EVIDENCE-TABLE.md:124`) - still
open, still a FAIL with RUNTIME evidence.

---

## What to copy from each

| Story | Copy this |
|---|---|
| RPT-05 | compare two independently produced outputs; one case may carry a correctness facet and a scale facet, but the verdict names which failed |
| PRF-05 | write the threshold before measuring; label a lower bound; split the unreachable facet into BLOCKED instead of averaging it into the FAIL |
| REF-* | install the error trap in every spec, and assert both "no UI errors" and the value the flow was supposed to produce |
