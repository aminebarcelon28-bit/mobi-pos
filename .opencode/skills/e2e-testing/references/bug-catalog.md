# Bug catalog

Every row was found by this harness against the real app. Columns: symptom -> root-cause
class -> how it was detected -> fix -> regression. Where the fix is still open, the row says
`open` - do not describe it as fixed.

## Cluster A - money arithmetic drifts between two code paths

| # | Symptom | Class | Detected by | Fix | Regression |
|---|---|---|---|---|---|
| A1 | A full refund of a stacked-discount sale returns less than was collected: 900 collected, 579 committed (cash 515, wallet share 0); the sale row itself stored `total 800` against 900 charged (CRT-05 / REF-28) | two totals computed from different bases | refund spec compares collected vs committed vs stored, all three quoted | open (P0) | `[CRT-05]` asserts `collected == committed == stored` on a stacked-discount fixture |
| A2 | Export sheet disagrees with its own headline: cost 54 200 vs 54 000, profit 29 300 vs 26 500, items 84 500 vs 78 500 | aggregation recomputed from line rows while the headline reads the ledger (`sheets.ts:151-161`) | `27d-rpt-checks.mts` runs the shipped `sheets.ts` on a fixed 14-row fixture and diffs cell vs headline | open (P1) | assert every export cell equals the headline total for the same fixture |
| A3 | Profit after FIFO consumption is off by the consumed layer | cost basis recomputed instead of read from the ledger | invariant spec recomputes FIFO independently and diffs | `a7ff091`, `0cd2cab` | `[INV-*]` FIFO reconciliation case |
| A4 | `1/234/567 DA` instead of `1 234 567 DA` on the ticket | U+202F narrow no-break space down-converted to `/` (0x2F) in the ESC/POS encoder (`escpos.ts:61-68`) | byte dump of the printed buffer, decoded and compared to the on-screen amount | open (P1-73) | assert the encoded byte sequence contains the separator the formatter emitted |

Rule that came out of A1-A4: **when two outputs describe the same money, assert they are equal
to each other.** A test that only checks one of them cannot see the drift.

## Cluster B - bytes disagree with the screen

| # | Symptom | Class | Detected by | Fix | Regression |
|---|---|---|---|---|---|
| B1 | Statement prints 5 of 8 movements and `13/450` | pagination computed on a truncated list | decode the printed buffer, count movement lines, compare to the DB count | open | count-based assertion, not "print called" |
| B2 | Receipt barcode encodes the transaction number, not the receipt number | wrong field bound to the encoder | decode the barcode payload from the byte stream | open (P1-69) | scan-to-lookup case: encode then look up by decoded value |
| B3 | Reprint is byte-identical to the original, no COPY marker | reprint re-renders the original payload | diff original vs reprint bytes | open (P1-70) | assert the two buffers differ in the marker and match elsewhere |
| B4 | Arabic cashier name is garbled on the ticket | encoding/codepage at the printer boundary | decode bytes back to text and compare with the DB name | open (P1-78) | round-trip a known Arabic name |
| B5 | A failed label print is reported as success | return value discarded by the caller | force a print failure, observe the toast and the return | open (P2-85) | assert the failure surfaces, not just that the call happened |
| B6 | 20 offline print jobs silently dropped, no queue, no retry | fire-and-forget spooler (`escpos.ts:394-406`) | count spooler invocations vs successful writes while offline | open (P1-81) | queue-length assertion after N offline prints |

B1-B6 share a detection trick: capture the **payload**, decode it with an independent decoder,
and compare with the DB. `tools/27b-lbl-checks.mts` uses hand-written EAN-13 L/G/R and Code128
tables whose anchors (0/103/104/105/106) are asserted first, so a table cannot cancel an
encoder bug.

## Cluster C - time, clock and timezone

| # | Symptom | Class | Detected by | Fix | Regression |
|---|---|---|---|---|---|
| C1 | Ticket time shifts with the device timezone; today's receipt can print yesterday's date | wall clock used in the render path | run the print builder under two TZ values and diff | `2141e97` (render-path `Date.now`), open for the ticket header (P1-76) | `tools/tim09-timezone.mjs` pattern: same fixture, two TZ, expected identical business day |
| C2 | Period report covers 16.2 h and 14 500 DA more than the selected period | inclusive/exclusive boundary plus local-midnight conversion | compare report sum with a hand-computed range query | open | assert report total == `SUM` over `[start, end)` computed in SQL |
| C3 | `SYSTEM_CLOCK_REGRESSION` after a wall clock change | wall clock behind the monotonic high-water | native anchor check on the money path | by design, fails closed | time-anchor spec |

C1's lesson: any `Date.now()` reachable from a render or print path is a defect candidate.

## Cluster D - cache/mirror staleness

| # | Symptom | Class | Detected by | Fix | Regression |
|---|---|---|---|---|---|
| D1 | Node-seeded product invisible in the catalog | UI reads the WebView mirror, not SQLite | seed, then assert the tile without a reload | `clearWebMirrors()` + reload in the helper | `[HARNESS-04]` |
| D2 | Shift opened in the UI missing from `cash_sessions` | write landed in the mirror only, or a different id | compare Dexie id vs SQLite id and log both | discovery logging in `[HARNESS-05]` | assert the row exists with the opening float |
| D3 | Deleted product's barcode still resolvable | soft-delete filter missing on one lookup path | create, delete, look up by barcode | open (LBL-08 facet) | assert lookup misses after delete |

## Cluster E - scaling cliffs

| # | Symptom | Class | Detected by | Fix | Regression |
|---|---|---|---|---|---|
| E1 | Catalog boot at 1M customers: 4 646 ms lower bound, 194 MiB payload, +858 MiB heap | `ORDER BY name` with no index (`customerAdapter.ts:221-224`; `lib.rs:1023-1025` indexes phone/barcode/loyalty only), awaited in `createUISlice.ts:1990-2023` | `27e-prf-checks.mts` seeds 1M rows and times the exact boot query | open (P1) | pre-written threshold: boot < 2 s at 1M |
| E2 | Catalog boot issues `SELECT *` with no `LIMIT` (`productAdapter.ts:171`); a 1-char search renders 100 000 hits unvirtualized | unbounded query + no virtualization outside `CustomersModal`/`InventoryManagerModal` | timed search at 1/2/3 chars, measured rendered node count | open | assert p95 and node count at a fixed fixture size |
| E3 | Export of 100k rows: 10 075 ms, +479 MiB, 180.7 MiB XML, hard `TOO_LARGE` at 200 001 | whole-document build in memory | timed export with heap sampling | open (cap is intentional, the memory profile is not) | assert cap error code and streaming behaviour |
| E4 | WebDriver `script timeout` storm under chunked stress | one giant in-page loop | chunked execution with an explicit budget | `cb65393` | chunk-stress spec |

E1/E2's lesson: performance cases need a **pre-written threshold** and a fixed fixture size,
or the result is an opinion.

## Cluster F - render and interaction

| # | Symptom | Class | Detected by | Fix | Regression |
|---|---|---|---|---|---|
| F1 | Virtualizer `measureElement` infinite update loop | measurement feedback loop | console error trap + render count | `845e913` | list-render spec asserts a bounded render count |
| F2 | Opening the refund dialog throws `ReferenceError`, totals render blank | symbol removed by a TS cleanup | `installErrorTrap()` + `expectNoUiErrors()` | `a651768` | REF spec asserts no UI errors **and** a non-zero total |
| F3 | Drawer opens on a card sale | drawer trigger not gated on tender type | tap/print counter after a card tender | open (P1-68) | assert zero drawer events for card, one for cash |
| F4 | A Tab-terminated HID scanner burst cannot complete a sale | scanner parser only accepts Enter | synthetic HID bursts with Enter and with Tab | open (P2-86) | both terminators must sell exactly one unit |
| F5 | Expired promo message renders green like an accepted one | single colour branch on `startsWith('Code')` (`DiscountModal.tsx:330`) | textual assertion passed, colour observed | open (P2, cosmetic) | keep the verdict textual; record the colour as a UI finding |

## Cluster G - validation and permissions

| # | Symptom | Class | Detected by | Fix | Regression |
|---|---|---|---|---|---|
| G1 | Decimal quantities/prices accepted in one entry point and rejected in another | parity gap between validators | same input through every entry point, diff the outcome | `f25d5b9` | table-driven parity case per entry point |
| G2 | Manager PIN accepted with 4 digits during setup | length rule applied on one screen only | type a 4-digit PIN, observe silent failure | enforced 6-8 digits in source | session helper asserts the gate actually advanced |
| G3 | A locked terminal can still be driven through a non-UI path | authorization enforced in the component, not the command | call the IPC directly with the UI locked | open residual, documented in `docs/webview-sql-residual.md` | negative-control spec per command |

## Cluster H - harness and infrastructure (these cost days, not minutes)

| # | Symptom | Class | Detected by | Fix | Regression |
|---|---|---|---|---|---|
| H1 | Next run "gets stuck"; DB locked | orphaned `mobi-pos.exe` after a crashed run | import-time `tasklist` check in `wdio.conf.ts` refuses to start (an `onPrepare` throw would be swallowed) | `npm run e2e:clean` (graceful first, force after 15 s) | preflight check |
| H2 | Freelist pages torn, snapshot quarantined | force-kill landing mid-VACUUM | integrity check after the incident | graceful close before force-kill (`scripts/e2e-clean.mjs`) | `integrityCheck()` in the smoke spec |
| H3 | Extensionless TS imports fail under Node | no resolver for the repo's import style | deterministic tool exits at import time | `269a95a`, `fb28c3b` (`scripts/ts-resolve-hook.mjs`) | any `tools/*.mts` run |
| H4 | `__name is not defined` inside `browser.execute` | esbuild `keepNames` emitted into a serialized callback | error trap on the first execute after reload | page shims re-installed after every refresh | smoke spec |
| H5 | A permitted `this.skip()` counted as a vulnerability | reporter treated `passed=false` with no error as fail | dashboard inflated | `afterTest` maps it to `skip` | reconcile script checks totals |
| H6 | `[HARNESS-07]` intermittently added 2 units for one scan (cart 246 800 instead of 123 400, two identical `pos:barcode-scanned` events) | **harness**, not the app: `scanCode()` fell back to a synthetic burst after a 1200 ms *cart-write* wait even though the real burst had decoded at ~100 ms; the second send lands outside the app's 400 ms duplicate-scan debounce | probe 2026-10-27: 2 dispatches 1.25 s apart → 2 events → `246800` in 6/6; 1 dispatch → 1 event → `123400` in 12/12 | fixed in `e2e-tests/lib/pos.ts`: wait on `pos:barcode-scanned`, fall back only on zero events, throw `HARNESS_SCAN_DOUBLE_DISPATCH` if one scan yields 2 | `[HARNESS-07]` stays the canary; no Gate 0 tolerance (a recurrence is a regression) |

## How to use this catalog

1. Triage: find the symptom, read the class, run the "detected by" step. If the class matches,
   you are probably looking at a known bug - confirm with the regression case before filing.
2. Writing a new case: pick the cluster the change touches and copy its assertion style.
3. Adding a row: only after a run you performed. One row, one fact, with `file:line` when known.
4. Retiring: after two batches without an observation, move the row to `anti-patterns.md`'s
   retired list rather than deleting it.
