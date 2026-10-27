**Batch 27b (2026-10-26):** the whole LBL (13) + HW (8) REMAIN bucket was
executed — 1 PASS, 2 PASS-PARTIAL, 9 FAIL, 4 N/A, 5 BLOCKED. Label byte checks
run the app's own modules under Node and verify them with independent EAN-13 /
Code128 decoders; the interactive half runs against the real WebView. New
findings: `P2-85` (a failed label print is reported as success) and `P2-86` (a
Tab-terminated HID scanner cannot sell). See `BATCH27B-LBL-HW.md`; canonical log
`logs/part0-27b.log` (21 verdict lines).

**Batch 27a (2026-10-26):** 24 previously-REMAIN SCL cases were executed on a
disposable DB copy, plus SCL-23 re-run; TIM-09 was re-opened after the Android
PIN-gate blocker fell. See `BATCH27A-SCL.md`. `P1-67` is withdrawn: it was a
harness expectation, because a pushed DB survives boot unchanged and the
companion reads the `p_products` sync projection rather than `products`. Its
replacement is `P2-84` (the installed APK is schema-stale vs HEAD at the same
version string).

**Verdict-source note (2026-10-27):** `CASE_INDEX.csv` is now the only place a
verdict lives. The old `fixtures/{fail,na,blocked}-cases.json` buckets were
retired: they lagged the CSV (107/112/63 vs 251/117/72) and any generator that
reads them silently re-emits old numbers. `coverage.mjs` reads the CSV, refuses
to run outside a batch, and proves its id set still matches `fixtures/cases.json`.

**SCL relabel (2026-10-27):** the last 45 REMAIN rows (SCL) are now BLOCKED with
their missing dependency recorded in the CSV `evidence` column (10M fixtures,
merchant sync gateway, or a second enrolled terminal). REMAIN now means
"executable in this environment today"; nothing else is parked there.

## Verdict rules

**N/A** — the case's precondition does not exist in the product at all. The harness probes confirm the absence (grep count = 0, component = 0, etc.). The case cannot be executed because there is nothing to test. Example: if the product has no gift-receipt builder, the case cannot be run.

**FAIL** — the case's precondition exists (the product has the broader capability, e.g., refunds exist → a gift-receipt variant should exist; warranty functionality exists → per-condition variants should exist). The harness confirms the feature is missing but the product *could* implement it. Example: gift receipts should exist but no builder is found → FAIL.

**BLOCKED** — the case is executable in principle but needs a dependency this
environment does not have (10M-row fixtures, the merchant sync gateway, a second
enrolled terminal, a real mobile device). The CSV `evidence` column names the
missing dependency; it is not a verdict on the product.

**REMAIN** — executable today with the existing harness and fixtures, not yet
run. This bucket must stay empty at batch close: everything either gets a
verdict or is relabelled BLOCKED with its dependency.

A verdict change from N/A to FAIL requires the case text to clearly assume the precondition exists (e.g., "the gift receipt variant" not "if a gift receipt variant exists").
