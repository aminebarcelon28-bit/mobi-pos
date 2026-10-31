# MISSION DIRECTIVE: RUN TO REAL PASS (C01 / Stage B6)

**First action, before anything else:** save this file verbatim to `docs/c01-mission.md`, commit it (one concern per commit), then execute the Stage B6 plan under it.

**Precedence:** `docs/c01-standing-orders.md` > this directive > the B6 plan > your own judgment. If this directive and B6 conflict, **the STRICTER rule wins.** If two rules conflict and you cannot tell which is stricter, treat it as a blocker and PARK that item with the conflict quoted.

---

## 0. GOAL (the completion predicate)

> **GOAL:** Drive cluster C01 to a verified end state on a frozen git sha, such that every work item is in exactly one terminal state (DONE or PARKED), every DONE item has real-PASS evidence reproduced in a fresh worktree, every PARKED item has proof of its blocker plus concrete options, the tree is clean and committed, and `docs/c01-progress.md` lets a fresh session resume with zero other context.

**The goal is reached only when this predicate is true, and you can prove each clause with an evidence id:**

| # | Clause | Proof |
|---|---|---|
| G1 | Every item is DONE or PARKED (no third state) | status table generated from `docs/c01-progress.md` |
| G2 | Every DONE item meets section 4 (real PASS) | evidence ids in `docs/c01-evidence.ndjson` |
| G3 | Every PARKED item names the owner decision or gated file, with proof and options | decision pack per section 12 |
| G4 | Final proof re-run in a fresh worktree with a fresh build | worktree path, build log, evidence ids |
| G5 | Self-audit done: every report claim maps to an evidence id or was deleted/downgraded to HYPOTHESIS | audit table (section 15) |
| G6 | Working tree clean, all commits one-concern, no merge performed | `git status`, `git log` output |
| G7 | Final report delivered in the format of section 16 | the report |

Do not declare the goal reached, and do not end the session, while G1 to G7 are not all true, unless a stop condition in section 11 applies.

---

## 1. MISSION AND TERMINAL STATES

Every item ends in exactly one of two terminal states:

- **DONE** = real PASS (section 4), with evidence.
- **PARKED** = blocked by something only the owner can decide, or by a gated file, with proof of the blocker and concrete options.

There is no third state. "Mostly works", "should pass", "inferred", "not run", "likely fine" and "looks right" are not states. You do not end the session while any item is neither DONE nor PARKED and unblocked work exists.

Allowed *working* labels during the session (never terminal, never in the final status table): `QUEUED`, `IN_PROGRESS`, `RESEARCHING`, `RED`, `GREEN_UNVERIFIED`. Anything not terminal at session end is a defect in your process, not a status.

---

## 2. OPERATING MODES (skills you switch between)

Work as one agent, but deliberately switch between these modes. State the active mode in each progress-file entry. If sub-agents or Claude Code skills are available in the environment, delegate the matching mode to them; the **Adversary must never be the same context that wrote the fix** (use a sub-agent or a fresh pass that re-reads only the diff and the acceptance check).

| Mode | Job | Output |
|---|---|---|
| **Auditor** | Read the repo, establish what is true now. Money paths first. | file:line facts, consumer audit |
| **Researcher** | Resolve tool/framework/mechanism unknowns from primary sources (section 9). | `docs/c01-research.md` entries |
| **Test Engineer** | Write the acceptance check, show it RED for the stated reason. | failing test or measurement |
| **Builder** | Smallest diff inside the editable list. | one-concern commit |
| **Verifier** | Run the real-PASS protocol exactly as section 4 says. | evidence lines |
| **Adversary** | Try to break the result: seeds, boundaries, old code over new data, mutated fix, reordered runs. | attack log, killed or surviving mutants |
| **Money Reviewer** | For anything touching amounts: rounding, apportionment, atomicity, idempotency, currency minor units. | money checklist (section 8) |
| **Release Clerk** | Progress file, evidence index, commits, reviewer pack, final report. | paperwork |

---

## 3. TRUTH CONTRACT (no hallucination)

1. Every statement about this repo carries `file:line`, or the command and output that prove it.
2. Every number in any report is copied from tool output of **this session**. No number from memory, no number from a previous session, no rounded number that differs from the output.
3. Every statement about the outside world (library behavior, API, standard) carries **URL + version + access date** from a primary source. The version must match the lockfile.
4. If you do not know, write `UNKNOWN`, then go measure or research it. Never fill a gap with a plausible guess.
5. A web finding is a `HYPOTHESIS` until reproduced in this repo.
6. Keep `docs/c01-evidence.ndjson` (section 5). The final report may cite only ids that exist in that file.
7. Distinguish in every claim: `OBSERVED` (ran it, saw it), `READ` (read the code, did not run), `RESEARCHED` (external source, not reproduced), `HYPOTHESIS`. Only `OBSERVED` can support a PASS.
8. Before the final report, run the self-audit (section 15). Claims without an evidence id are deleted or downgraded to HYPOTHESIS.
9. Never describe a command's result you did not run. Never say "tests pass" without the command, the exit code, and the sha.
10. If a tool output is truncated, say so and re-run with narrower output. A truncated output cannot be the key output of an evidence line.
## 4. DEFINITION OF A REAL PASS

A row or test counts as PASS only if **ALL** hold:

- **a. Fresh and frozen.** It ran in this session on the frozen sha, and its evidence line is in the evidence file.
- **b. Specs untouched.** Spec files and tolerances are byte-identical to the baseline: `git diff --exit-code <baseline sha> -- e2e-tests/specs` is clean **at the time of the run**. Record the baseline sha in Step 0 and the diff result in the evidence line.
- **c. Stability.** Anything flaky before, or touched by money code, passed **N/N (N >= 3)** consecutive **isolated** runs, all outputs recorded. Retry-until-green is a failure. Report **k/N**, never "passed".
- **d. Property tests.** Unit and property tests are green on **at least 3 different seeds** (record the seeds), and mutation checks are still killed.
- **e. Fresh worktree.** The final proof is re-run in a fresh `git worktree` with a **fresh build**, not your incrementally built tree. Record worktree path, build command, binary sha.
- **f. No derived PASS.** A derived or inferred verdict is never PASS unless its anchor is itself a real PASS.
- **g. Right thing measured.** The test fails when the behavior is wrong. You showed it RED for the stated reason (section 6, RED) and, for money code, a mutation of the fix turned it red again.

### FORBIDDEN WAYS OF "PASSING"

Editing, skipping, or quarantining a spec or tolerance. Adding waits or retries that mask a race without a **proven** cause. Catching or swallowing errors. Mocking the unit under test. Narrowing a generator or fixture to dodge a failing shape. Deleting or weakening a mutation or invariant. Hand-editing any verdict, index, or dashboard. Changing how the pipeline counts. Reporting a subset as "all". Citing a run from a different sha. Citing a run from before the last code change. Loosening an assertion to match observed output. Disabling a lint, type, or gate check.

**If you feel pulled toward one of these: research instead. If still stuck: PARK.**

---

## 5. EVIDENCE SYSTEM

### 5.1 `docs/c01-evidence.ndjson` (append-only, one JSON object per line)

```json
{"id":"E-0001","ts":"<ISO8601 from the system clock>","item":"<item id>","mode":"Verifier",
 "command":"<exact command>","cwd":"<path>","worktree":"<path or main>",
 "git_sha":"<HEAD at run time>","baseline_sha":"<Step 0 sha>","spec_diff_clean":true,
 "binary_sha":"<sha256 of the built artifact>","seed":"<seed or null>",
 "run":"<k>/<N>","exit_code":0,"key_output":"<one verbatim line from the output>",
 "log_path":"<path to full log>","kind":"REAL_PASS|FAIL|INFO|RED|MEASUREMENT"}
```

Rules: ids are sequential and never reused. Failed and RED runs are recorded too (they are evidence). Never edit or delete a line; correct with a new line that references the old id. Full logs go to a log directory (path in Step 0); the line carries only the key line.

### 5.2 `docs/c01-progress.md` (the work queue and resume file)

Table columns: `item | priority | state | mode | next action | blocker | evidence ids | last updated (sha)`. Update at **every boundary** (after each item, each commit, each park). Top of file: current frozen sha, baseline sha, budget used/remaining, "resume here" pointer.

### 5.3 `docs/c01-research.md`

One entry per finding: `question | source URL | version | access date | what it says (own words) | meaning for this repo | what I verified here (evidence id) | status HYPOTHESIS/VERIFIED`.

---

## 6. THE LOOP (apply to every item)

| Phase | What you do | Must produce |
|---|---|---|
| **ORIENT** | Read the item, the code, the existing tests, the progress file. Check the item's files against the gated/read-only list. | The **exact acceptance check**, written down *before* touching anything |
| **RESEARCH** | Section 9. Whenever the item depends on a mechanism you cannot fully verify from the repo alone. | Research-log entry + a reproduction plan |
| **HYPOTHESIZE** | List >= 2 competing explanations. Design the cheapest measurement that separates them. | Hypothesis table: explanation, prediction, measurement |
| **RED** | Write the test or measurement that fails for the **stated reason**. Show it red. | Evidence line `kind:RED`; the failure message matches the hypothesis |
| **BUILD** | Smallest diff inside the editable list. Test-first for money code. | One-concern diff |
| **VERIFY** | Green, plus the full definition of real PASS (section 4). | Evidence lines `kind:REAL_PASS` |
| **ATTACK** | Try to break your own result: other seeds, boundary values (0, 1 minor unit, max, negative, fractional), old code over new data, a mutation of your fix, a different test ordering, interrupted/partial writes. Hand this to the Adversary. | Attack log: what was tried, what survived |
| **RECORD** | Evidence ids, progress file, **one commit**. | Commit hash in the progress file |

If RED does not fail for the stated reason, your understanding is wrong: go back to HYPOTHESIZE. Never proceed to BUILD on a test that fails for a different reason or that you have not seen fail.

---

## 7. PRIORITY ORDER (what comes before the edge cases)

| Tier | Scope | Rule |
|---|---|---|
| **P0 FOUNDATION** | E2E evidence on the current HEAD sha; S3 money truth (R1 vs R2); consumer audit of the funding payload | Nothing is built on an unverified base. |
| **P1 UNBLOCKERS** (research-driven) | WebView observability and the module-mock harness, so D4, H4, H3-b and C90 become measurable | Unlocks measurement for later items. |
| **P2 DECISION PACKS** for the owner | B-2, B-3, B-4, D4 (a) vs (b), under-refund policy | Each with evidence, options, a recommendation, and risk. |
| **P3 EDGE PIECES** | Fractional-original rule (bounded), REF-92, mixed fleet, extra mutations | Do not start while P0 or P1 has unblocked work. |
| **P4 PAPERWORK** | Reviewer pack, progress file, final report | Always last, always complete. |

Within a tier, order by: (1) money-affecting first, (2) unblocks the most other items, (3) cheapest to verify. A money-affecting defect found at any time jumps the queue and is reported as the first line of the final report.

---

## 8. MONEY CHECKLIST (Money Reviewer runs this on any item touching amounts)

- [ ] Amounts are integers in minor units end to end; no float arithmetic anywhere on the path (show the grep and the result).
- [ ] Apportionment/splitting uses a documented method (largest remainder / Hamilton or the repo's documented rule). The sum of parts **equals** the whole for every input in the property test.
- [ ] Rounding mode is explicit (half-up vs banker's) and matches the owner's documented rule; if no rule is documented, that is an owner decision: PARK with options.
- [ ] Refund, under-refund, over-refund, zero, one-unit, and fractional-original cases have tests.
- [ ] Wallet/balance writes are atomic: either all effects commit or none; analysis grounded in the **actual** SQLite/WAL and Dexie transaction semantics for the lockfile versions (research-log entry plus reproduction).
- [ ] Idempotency: replaying the same operation (outbox retry, double click, crash-restart) cannot double-apply.
- [ ] Every consumer of the funding payload is listed with file:line, and each was checked against the shape that is actually produced.
- [ ] Mutation checks exist for each invariant and are still killed after the change.
- [ ] Any contradiction between channels (e.g. the "refund:persist" channel) is explained by a measurement, not by assumption.

---

## 9. RESEARCH PROTOCOL (internet)

You are expected to research, not guess. Do it when the blocker is a **tool, framework, or mechanism** rather than business logic.

**First**, read exact versions from `package.json`, `Cargo.toml`, and lockfiles. Record them in the research log header. Documentation for a different major version is not evidence.

### Targets

| Target | Needed for | Verify in repo by |
|---|---|---|
| How to capture WebView/page console output and window state from the E2E driver that `run.mjs` uses | C90; the "refund:persist" channel contradiction | A minimal probe that prints a known console line from the page and window state, captured by the driver |
| Node ESM loader hooks, `module.register`, test-runner module mocks, to fake `customerRepository`, the Tauri invoke bridge, Dexie, and the outbox **without touching app code** | D4, H4, H3-b | A harness test that swaps each module and proves the unit under test (not a mock of it) ran |
| Correct apportionment methods for splitting money (largest remainder / Hamilton), half-up vs banker's rounding, known pitfalls | Cross-check of the split algorithm | A property test comparing the repo's split to a reference implementation you can explain line by line |
| SQLite transaction/WAL semantics and Dexie transaction behavior | Wallet-write atomicity analysis | A crash/interrupt test or an explicit transaction-boundary trace |
| Tauri command, error, and transaction behavior for the version in use | Error propagation and atomicity across the bridge | A probe command returning an error and a partial-failure case |

### Rules

- **Source ranking:** official docs and source repos > maintainer issues and discussions > reputable engineering write-ups > forums.
- Read targeted pages; do not bulk-scrape; respect site terms.
- **Privacy:** never put proprietary code, customer data, secrets, or real amounts in a query. Search with public API names and generic error text.
- **Supply chain:** do not add a dependency. If one is truly needed, PARK with a proposal: name, version, license, maintenance status, alternatives. Do not paste third-party code you cannot explain line by line; note its license.
- Log every finding in `docs/c01-research.md` (section 5.3). Status stays HYPOTHESIS until reproduced here.
- Research budget: stop researching a question once you have a reproducible probe in this repo. Research serves measurement, not reading.

---

## 10. RUN-TO-COMPLETION RULES

1. After each item, start the next one **immediately**. Ask the owner only when truly blocked on an owner decision, and keep working on independent items meanwhile.
2. **Park only the blocked item.** A failing test, a contradicted expectation, or a stuck mechanism means: research and re-hypothesize first, park second.
3. When you park, write the decision pack (section 12) **before** moving on.
4. Context hygiene: keep the progress file current so that losing your context costs nothing. At every boundary re-read `docs/c01-progress.md` and `docs/c01-standing-orders.md` rather than relying on memory of them.
5. If an unexpected failure appears on a previously verified item, that item reverts to `IN_PROGRESS`, the earlier evidence is marked superseded by a new evidence line, and it is re-verified.
6. Never run two builds or test suites that share state in parallel unless the harness isolates them; isolation is part of "isolated runs".
7. Any E2E run over **15 minutes is aborted** (standing order). Record the abort as evidence, then diagnose why it ran long.

---

## 11. STOP CONDITIONS AND BUDGET

End the session **only** when one of these is true:

- **(S1)** Every item is DONE or PARKED and G1 to G7 hold.
- **(S2)** Remaining budget is smaller than the next item's cap. **Show the numbers** (budget used, remaining, next item's cap, all copied from the budget table in Step 0 and from tool output).
- **(S3)** A hard-stop condition from `docs/c01-standing-orders.md` fires. Quote it.

On any stop: end at a **boundary** with a clean, committed tree, and a `docs/c01-progress.md` that lets a fresh session resume with no other context (frozen sha, baseline sha, queue, next action per item, open evidence needs, how to rebuild).

---

## 12. PARKING PROTOCOL (decision pack)

A PARKED item must contain, in `docs/c01-progress.md` or a linked file under `docs/`:

1. **Blocker type:** owner decision, or gated/read-only file.
2. **Proof of the blocker:** file:line, or command + output, or the quoted standing-order rule.
3. **What you already tried** (research and measurement), with evidence ids.
4. **Options** (>= 2 where a decision exists): what each changes, what it costs, what it risks (money risk first).
5. **Your recommendation** and why, labeled as recommendation, not as fact.
6. **What would make it DONE** (the exact acceptance check that will run after the decision).

For the owner-decision items in P2 (B-2, B-3, B-4, D4 (a) vs (b), under-refund policy), produce this pack **even if you could resolve them**, because they are owner decisions by definition.

---

## 13. COMMIT RULES

- One concern per commit. Test-first for money code (the RED test commit or the RED evidence precedes the fix).
- Only files on the editable list may change. A change to a gated/read-only file is a hard stop: PARK instead.
- Message format: `c01(<item id>): <what> [E-xxxx,E-yyyy]` (evidence ids in the message).
- No merge, no force-push, no history rewrite, no amending commits already referenced by evidence lines.
- Scratch files stay untouched.
- Gates (lint, type, build, unit) are green at every commit; record the gate run as evidence.

---

## 14. NEVER BENDS (`docs/c01-standing-orders.md`, unchanged)

Gated and read-only files. The editable list. No spec edits. No hand-edited verdicts. No merge. Scratch files untouched. One concern per commit. Test-first for money code. Gates green. E2E over 15 minutes aborted. The hard-stop list.

If this directive appears to permit something the standing orders forbid, the standing order wins.

---

## 15. SELF-AUDIT (mandatory before the final report)

1. Extract every factual claim from the draft report (one per row).
2. For each, fill: `claim | kind (OBSERVED/READ/RESEARCHED/HYPOTHESIS) | evidence id | frozen sha matches?`.
3. Check each cited id exists in `docs/c01-evidence.ndjson` and that its sha equals the frozen sha (or the final worktree sha).
4. Check each number against the key output of its evidence line, character for character.
5. Check every DONE item against section 4 a to g. Any miss: the item reverts to `IN_PROGRESS`.
6. Delete or downgrade every claim without an evidence id. Record how many you changed, from this audit's own output.
7. Confirm `git diff --exit-code <baseline sha> -- e2e-tests/specs` is clean at the final sha, and `git status` is clean.
8. List everything NOT run, with the reason.

Include the audit table in the reviewer pack.

---

## 16. FINAL REPORT (format)

**Line 1:** any money-affecting defect found (or "No money-affecting defect found", supported by the money checklist evidence ids).

Then, in this order:

1. **Status table:** every item, DONE or PARKED, with evidence ids and the commit hash.
2. **Real-PASS table:** item, test/row, run k/N, seeds, sha, worktree, evidence ids.
3. **PARKED items:** blocker, options, your recommendation, risk (from the decision packs).
4. **Research log summary:** question, finding, version, VERIFIED or HYPOTHESIS.
5. **Everything NOT run**, and why.
6. **Corrections to earlier claims** (any claim from earlier reports or earlier sessions now shown wrong, with the evidence).
7. **Budget:** used, remaining (from tool output).
8. **Resume instructions:** pointer to `docs/c01-progress.md`.

End with exactly:

> **Waiting for APPROVED (or change requests).**

---

## 17. KICKOFF SEQUENCE (do these in order, now)

1. Save this file verbatim to `docs/c01-mission.md`; commit it.
2. Read `docs/c01-standing-orders.md` and the Stage B6 plan in full. Note any conflict with this directive and apply the STRICTER rule.
3. **Step 0 (record in `docs/c01-progress.md` and the evidence file):**
   - frozen sha (`git rev-parse HEAD`), baseline sha for the specs diff, clean-tree proof (`git status`)
   - toolchain and dependency versions (from lockfiles)
   - gated/read-only list and editable list (quoted from the standing orders)
   - the work-item register (every item id from the B6 plan, with its priority tier)
   - budget table: per-item caps and total budget, copied from the B6 plan; if a cap is missing, write `UNKNOWN` and ask the owner only if it blocks the stop condition
   - log directory path
4. Create the empty `docs/c01-evidence.ndjson`, `docs/c01-research.md`, and `docs/c01-progress.md` skeletons; commit.
5. Start **P0**. Apply the loop (section 6) to the first item. Do not start P3 while P0 or P1 has unblocked work.
6. After every item: update the progress file, commit, start the next item.
7. At the end: run the self-audit (section 15), the fresh-worktree final proof (section 4e), then deliver the final report (section 16).
