# Contributing

Read `AGENTS.md` first: it is binding for automated and human contributors
alike (storage topology, trust rules, gate policy).

## Ground rules

1. **Never fake green.** No skipped or weakened assertions, no hardcoded
   expectations, no `if (test)` branches in product code (configuration and
   injection seams are fine). A verdict exists only if it came from a real run
   stamped by `verdicts.mjs`.
2. **Fail closed.** Unknown states deny. No silent sequential fallbacks on money
   flows (checkout, refund, void, shift close).
3. **Money and fiscal changes need proof.** A failing-then-passing test (or a
   before/after equivalence) plus re-runs of the refund specs, in the same
   change.
4. **Gate/cap/allowlist changes need proof in the commit.** Say why the old
   limit no longer fits and that the change is behaviour-neutral or intended.
5. **Evidence IDs.** Every non-trivial change cites an `E-####` entry appended to
   `docs/c01-evidence.ndjson` (what ran, the verbatim result, where the log is).

## Workflow

1. Load the `e2e-testing` skill (`.opencode/skills/e2e-testing/SKILL.md`) before
   any feature, fix or test work — it owns the run/verdict/reconcile pipeline.
2. Branch, keep commits small and scoped, cite the evidence ID in the message.
3. Run the gates that your change can affect (the table in `README.md`). At
   minimum before a release tag: money, zero-tax, cash terms, `tsc`, `cargo test
   --lib`, selftest, reconcile.
4. UI work: accessibility is a gate, not a preference — WCAG 2.5.3 (Label in
   Name) rules are in `AGENTS.md`; every interactive control must be locatable by
   role + visible name.

## Code conventions

- TypeScript strict; no `any` without a narrow cast and a comment.
- Money is integer dinars; convert at the boundary, never in the middle of a
  computation.
- Native commands own privileged writes (trust tables, refunds, audit); the
  WebView asks, it does not assert.
- Printing: Arabic is a raster lane (`ADR-004`); never map non-Latin text into a
  single-byte code page.

## Tests and harnesses

- New harnesses must be hermetic: own ports/dirs, seeded, state-based waits, one
  headless command, failure artifacts, documented in `agent/dossiers/`.
- Hardware-dependent behaviour is `PASS-SIM` at best; say so and record the
  owner action needed (printer, gateway, credentials).
