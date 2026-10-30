# Conventions and templates

The harness is self-contained under `e2e-tests/`. It never imports from `src/` at run time
except deliberately, in the deterministic Node checks, where executing the shipped module is
the point.

## Layout and naming

```
e2e-tests/
  wdio.conf.ts                 runner config, sandbox, reporter hook
  lib/                         the only place logic lives
    env.ts                     SANDBOX, DB_PATH, WEBVIEW_DIR, APP_PIN
    db.ts                      better-sqlite3 out-of-band access (all/one/scalar/run/tx)
    seed.ts                    seedProducts / seedCustomers / seedShift / resetData
    pos.ts                     UI helpers (cart, refund, dialogs, shims, traps)
    invoke.ts                  window.__TAURI_INTERNALS__.invoke wrappers
    session.mjs                setup + login for desktop AND Android (single source)
    rng.ts                     mulberry32 seeded PRNG for long-session walks
    invariants.ts, sav.ts, campaign.ts
  specs/NN-domain-name.e2e.ts  specs, numbered by domain block
  tools/                       node-only checks, log builders, reconcilers
  fixtures/                    cases.json + verdict buckets + feature-map.json
  logs/                        canonical per-batch verdict logs (VERDICT= lines)
  results/                     events.ndjson, screenshots, per-run sidecars
  test-logs/                   raw WDIO logs + manifest.json
```

Spec file naming: `NN-<domain>-<topic>.e2e.ts`, `NN` matching the domain block (10 money,
20 data, 30 refunds, 40 shifts, 50 security, 60 identity, 65/66 drawer, 70 customers, 71 cart,
75 loyalty, 80 trade-in, 82 inventory, 84 repair, 86 warranty). Probes are prefixed `9x-` and
must never carry a catalog ID.

Test title **must** start with the case ID in brackets: `it('[MNY-01] price 0.01 ...')`.
`tools/coverage.mjs` and `scripts/lint-specs.mjs` extract IDs with
`/\bit\(\s*['"`]\[([A-Z][A-Z0-9]{1,3}-\d{2,3})\]/` (1-4 letter domains, 2-3 digit suffixes);
anything else is invisible to the dashboard and fails the lint. A title built from a variable
(`it(id, ...)`, or the local `harness('LBL-11', ...)` helper) is fine as long as the id appears in
the file as code - `lint-specs.mjs` checks the code, not only the title. Harness self-tests use
`[HARNESS-nn]` on purpose so they are not counted as catalog cases.

## Helper API you should use instead of writing your own

| Need | Use | Note |
|---|---|---|
| locate by testid | `tid('cart-total')` | returns a selector string |
| first *displayed* match | `shown(id)`, `shownX(xpath, timeout)` | mobile/desktop twins share testids |
| parse money text | `displayedToMinor(text)` | handles Arabic-Indic digits, U+2212 minus, U+00A0/U+202F separators |
| add a product | `addSku('name', { expectTitle })` | waits for the line to land |
| barcode wedge | `scanCode(code)` + `readScanEvents()` | asserts exactly one unit added and search cleared |
| cart state | `cartLineCount()`, `cartTotalMinor()`, `cartLineTexts()` | BigInt minor units |
| pay | `payExactFlow()`, `payTenderedFlow(da)` | exact vs change paths |
| shift | `openShiftUi(da)`, `ensureShiftOpen(da)`, `readOpenShiftDexie()` | |
| dialogs | `listDialogs()`, `closeDialogs(maxRounds)` | call before blaming a click |
| IPC | `invoke(cmd, args)`, `invokeRaw()`, `nativeCodeOf(err)` | raw preserves `CODE:detail` |
| DB | `all/one/scalar/count/run/tx/integrityCheck/tableCounts/waitForSchemaSettled` | Node side, same WAL file |
| seed | `seedProducts/seedCustomers/seedCustomerFull/seedCreditVouchers/seedImeiRecords/seedBundles/seedShift/seedSettings` | then `clearWebMirrors()` |
| reset | `resetData()`, `clearOutbox()` | `resetData` returns `{tables, rowsDeleted}` |
| errors | `installErrorTrap()`, `readErrors()`, `expectNoUiErrors(ctx)` | run in `before` / `after` |
| counters | `armPrintCounter/readPrintCalls`, `armConsoleTap/countConsoleMatching`, `armInvokeCounter/readInvokeWrapStatus` | |
| refunds | `openRefund`, `refundSearch`, `selectRefundTicket`, `setRefundQty`, `selectRefundMethod`, `clickRefundSubmit` | returns typed states, not booleans where ambiguous |
| determinism | `makeRng(seed).int/pick/weighted/chance` | failure reproducible from (seed, step) |

If a helper is missing, add it to `lib/`, not to the spec. Two specs duplicating a flow is the
signal that the helper belongs in `lib/pos.ts`.

## Selectors

1. `data-testid` first, always. `tid('...')` is the only sanctioned constructor.
2. `shown()` because `$()` returns the first match in document order, and hidden mobile twins
   routinely precede the visible desktop node.
3. Structural selectors only when no testid exists: `shownX("//button[normalize-space()='...']")`.
   XPath over visible text is acceptable; XPath over DOM position is not.
4. Accessibility rules from `AGENTS.md` are binding for anything you add: never replace
   visible text with an `aria-label` synonym (WCAG 2.5.3). If you add dynamic context, prefix
   with the visible label verbatim: `aria-label="${visibleText} - ${context}"`. Glyph-only
   controls (`x`, arrows, backspace) get `aria-hidden="true"` on the glyph and keep the
   descriptive label. If you change an accessible name, update the dependent
   `getByRole(role, { name: /visible/i })` locators in the same change.
5. Never assert on CSS classes or colours unless the case is explicitly visual. `TIM-05` is
   the cautionary tale: the expired promo renders green like an accepted one, but the verdict
   is textual on purpose.

## Waiting

- Wait on **state**, not time: `browser.waitUntil(() => count('transactions') > before)`.
- Every `waitUntil` carries a `timeoutMsg` that names what never happened.
- No `browser.pause()` / `sleep()` in specs. The single exception is inside shim installation
  where the page is being re-instrumented after a reload.
- For a UI value that must settle, poll the parsed value, not the raw string:
  `waitUntil(async () => displayedToMinor(await el.getText()) === 0n)`.
- `retries: 0` in `wdio.conf.ts`. A test that needs a retry is a finding, not a config tweak.

## Money and assertions

- Integer minor units as `BigInt` end to end: `expect(await cartTotalMinor()).toBe(5400n)`.
- Parse display text with `displayedToMinor`; never `parseFloat` / `Number`.
- Assert the highest rung available: captured bytes > SQLite row > IPC return > DOM state >
  visible text.
- Quote the raw observation in the failure message, e.g.
  `expect(exported.cost).toBe(headline.cost)` with both numbers logged first.
- Negative assertions need a positive control. "Discount absent after expiry" is only
  meaningful next to "discount present before expiry" in the same test.

## Test data

- Seed out-of-band (`lib/seed.ts`), then `clearWebMirrors()` and reload so the UI re-reads
  SQLite. A seed that only updates the mirror passes and loses data on the next boot.
- Fixtures are fixed and named: `E2E-HARNESS-1`, `E2E Gerant`, `PROMO500`. Never random IDs in
  a catalog case - the canonical log must be reproducible.
- Every seeded product carries an explicit `priceDa`, `stock` and `barcode`; implicit defaults
  hide rounding bugs.
- Deleting data mid-spec is allowed only when the case is about deletion; otherwise reset in
  `before` and leave the sandbox for inspection after the run.
- Large fixtures (100k+) are generated in a transaction with `tx()` and a documented row count
  and rate. At the measured 5 000 rows / ~394 ms, 40k sale ids is a ~3 s seed; 1M customers is
  minutes, so opt into `WDIO_MOCHA_TIMEOUT`.

## Isolation and what to mock

| Layer | Rule |
|---|---|
| App under test | real binary, real WebView, real SQLite. Never stub the app. |
| Cloud | sealed by the `e2e` feature; do not attempt network sync |
| Printing | `stubPrint()` replaces `window.print` so modals do not hang; `armPrintCounter()` counts calls |
| ESC/POS bytes | captured through the builder and the call path. `__TAURI_INTERNALS__.invoke` is **non-writable** in this build, so `armInvokeCounter` reports `wrap-failed` - you cannot intercept the raw bytes at the IPC boundary. State that limitation instead of claiming byte-level proof of the physical print. |
| Time | the money path reads the durable monotonic anchor (`time_anchor.rs`); wall-clock cases use `tools/tim09-timezone.mjs` patterns, not `Date.now()` stubs |
| Gateway | loopback verifier only (`proxy/gateway.mjs` + `test:sync-e2e`), test keys gated by `ALLOW_TEST_KEY=1` |

## Evidence logging

Every case logs one machine-parsable line:

```
console.log(`[RPT-06] headline=${JSON.stringify(h)} exported=${JSON.stringify(x)}`);
```

Batch logs are assembled from these lines by `tools/build-27X-log.mjs`, which writes
`VERDICT=<ID> <VERDICT> <reason>` lines to `e2e-tests/logs/part0-27X.log`. The log is the
canonical artifact; the spec is the generator. Never edit a log by hand to change a verdict -
re-run the case.

## Severity, evidence class, fix authority

**Severity** is the priority field in `CASE_INDEX.csv`. It describes the consequence, not the
effort to fix:

| Severity | Means | Examples from this repo |
|---|---|---|
| P0 | data or financial loss, or no recovery path | stacked-discount refund returns 579 of 900 collected (CRT-05); a hardware-wedge scan crashes the till (MOB-23) |
| P1 | the feature runs but produces a wrong result | export cell != headline (RPT-05); boot at 1M customers takes 4.6 s (PRF-05); Arabic name garbled on the ticket (B4) |
| P2 | missing or incomplete, but what runs is correct | Tab-terminated scanner burst cannot complete a sale (F4); failed label print reported as success (B5) |
| P3 | cosmetic, or only reachable with artificial extremes | expired promo message renders green (F5); a 67-character product name overflows its column |

**Evidence class** goes in the verdict text and in the `evidence` column. Pick the strongest class
the case actually produced:

| Class | What it is | Allowed to carry a FAIL alone? |
|---|---|---|
| DB | a SQLite row or a SQL aggregate read out-of-band | yes |
| BYTES | a captured byte stream decoded by an independent decoder (receipt, label, export XML/CSV) | yes |
| RUNTIME | a timing, heap figure, invoke/tap/print count, or an error message | yes |
| SOURCE | a `file:line` that explains the cause | yes, as the cause; the observation still needs one of the three above |
| UI | visible text only | no, unless the case is *about* the text. A FAIL with UI-only evidence is almost always a TEST BUG. |

**Assertion ladder** - prefer the highest rung the case allows:

```
captured bytes > SQLite row > IPC return value > rendered DOM state > visible text
```

Two rules make the ladder enforceable: (a) a case may use a lower rung only when the higher one is
unreachable, and the report says which rung it used; (b) `__TAURI_INTERNALS__.invoke` is
non-writable in the e2e build, so "byte-level proof of the physical print" is not claimable from a
spec - capture the builder's buffer and say so.

**Fix authority** - what may be changed without asking:

| Auto-fix | ASK FIRST (report, do not change) |
|---|---|
| UI crash / unhandled rejection | money arithmetic or rounding |
| validator parity (the same rule in every entry point) | migrations, schema, column types |
| TEST BUG, but only with a fresh observation (re-read log line, screenshot, DB row) proving the assertion is wrong | sync protocol, outbox ordering, gateway contract |
| cosmetic (copy, spacing, colour branch) | auth, PIN, lockout, roles |
| a missing `await`, a wrong selector, a stale testid | anything that rewrites stored data |

An ASK FIRST finding is reported with its evidence and left open; it is never "fixed quietly" and
never closed by weakening the case. The full loop (triage -> fix -> rebuild -> regression case ->
adjacent specs -> delta -> sibling sweep, three attempts max) is Gate 6 in `SKILL.md`.

## Review checklist (use on your own diff before running)

- [ ] Title carries `[DOMAIN-NN]`
- [ ] Pass condition was written before the run and is quoted in a comment
- [ ] No `sleep`, no `retries`, no `try/catch` that swallows an assertion
- [ ] Waits on state with a `timeoutMsg`
- [ ] Money compared as `BigInt` from `displayedToMinor`
- [ ] Seed goes through `lib/seed.ts`, followed by `clearWebMirrors()`
- [ ] `installErrorTrap()` + `expectNoUiErrors()` present
- [ ] Failure message would let a stranger reproduce without re-running
- [ ] If an accessible name changed, dependent locators updated in the same diff
- [ ] Raw observation logged with the case ID, and a `VERDICT=` line when the verdict is not the mocha outcome
- [ ] `node .opencode/skills/e2e-testing/scripts/lint-specs.mjs` exits 0
- [ ] The finding's sibling search from `references/bug-catalog.md` was run and its result recorded

## Templates

- `templates/spec-skeleton.e2e.ts` - copy this for a new spec.
- `templates/bug-report.md` - one per finding, with the evidence class.
- `templates/risk-brief.md` - Gate 1 output, five lines.
