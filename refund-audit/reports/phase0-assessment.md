# Phase 0 — Historical E2E Test Archaeology & Reuse Decision

## 0.1 Discovered test artifacts

### Root-level WebdriverIO harness (`wdio.conf.ts` + `test/` )
- `wdio.conf.ts` — resolves the e2e-flavor Tauri binary (`target-e2e/debug/mobi-pos.exe`, fail-closed if not the `com.mobi.pos.e2e` flavor), runs `@wdio/tauri-service`, `maxInstances: 1` (serial money tests), provenance guard, `POS_E2E_WIPE=1` container wipe, `onPrepare`/`onComplete` lifecycle.
- `test/helpers/common.ts` — `APP_PIN = '202020'`, `handlePinGateIfPresent()`, `dismissAllModals()`, `addProductToCart()`, `assertZeroCrashes()`.
- `test/helpers/pos.ts` — `tid()` testid locator, `shown()`, `DA()` (integer minor units BigInt), `displayedToMinor()` (fr-DZ/DA money parse), `invoke()`/`invokeRaw()` (Tauri `__TAURI__.core.invoke` bridge), `unlockIfNeeded()` (setup PIN or lock-screen login, PIN digit-by-digit via `browser.keys(pin.split(''))`), `selectCustomer()`, `ledger()` (`e2e_get_db_state`), `getSale()` (`e2e_get_sale`), `stockOf()` (`e2e_get_product_stock`), `debtOf()` (`e2e_get_customer_ledger`), `refundDirect()` (calls `refund_sale_atomic` with a production-faithful payload), `nativeCodeOf()`, `clearCart()`, `seedSmoke()` (8 products + `e2e_reset_db` + `e2e_seed_state`), `openShiftUi()` (real UI shift open), `wipeWebMirrors()`/`clearWebMirrors()` (localStorage + Dexie `MobiPosDB` delete), `readOpenShiftDexie()`/`readDexieShift()` (IndexedDB `cashSessions`), `installErrorTrap()`/`readErrors()` (window error/unhandledrejection trap), `stubPrint()`.
- `test/specs/refund-money.e2e.ts` — MONEY refund suite: R1 full kernel refund, R1b replay dedup (`ALREADY_REFUNDED`), R1c modal gates (wrong PIN refused / sealed lane refuses payout), R2 partial+remainder reconcile, R4 hostile shapes fail closed (`TICKET_NOT_FOUND`, `INVALID:order money must be >= 0`, `ZERO_REFUNDABLE`, `DEVICE_IDENTITY_SPOOFED`, zero writes), R5 inflated quantities capped (`REFUND_EXCEEDS`), R3 exhausted tickets vanish from refund list.
- `test/specs/smoke.e2e.ts` — launch smoke: `#root`, `header`, title match.

### Separate proven encyclopedia harness (`e2e-tests/`)
- `e2e-tests/wdio.conf.ts` — self-contained under `e2e-tests/`, sandboxes `APPDATA`/`LOCALAPPDATA`/`USERPROFILE` into `{TEMP}/opencode/pos-wdio-sandbox/home/AppData/…/com.mobi.pos.e2e/`, external `tauri-driver` + msedgedriver, `DB_PATH = …/com.mobi.pos.e2e/mobi_pos.db`, `APP_PIN = '202020'` (overridable via `POS_E2E_PIN`).
- `e2e-tests/lib/env.ts` — sandbox path resolution, `DB_PATH`, `WEBVIEW_DIR`, `wipeSandbox()`.
- `e2e-tests/lib/pos.ts` — UI helpers: `addSku`, `payExactFlow`, `payTenderedFlow`, `openRefund`, `refundSearch`, `selectRefundTicket`, `setRefundQty`, `selectRefundMethod`, `typeRefundPin`, `clickRefundSubmit`, `toggleRefundRestock`/`toggleRefundWriteOff`, `refundTotalMinor`, `refundLineState`, `refundDialogVisible`, `refundSubmitDisabled`, `ensureShiftOpen`, `openShiftUi`, `clearCart`, `closeDialogs`, `installErrorTrap`, `installPageShims`, `typeReal`, `typeMoneyInto`, `seedBundleMirror`, `seedCustomerDebtMirror`, `readOpenShiftDexie`, `deviceId()`, `getSale()`, `expectNoUiErrors()`.
- `e2e-tests/lib/db.ts` — direct `better-sqlite3` access to the live sandbox DB, `waitForSchemaSettled()`, `all/one/scalar/count/run/tx`, `integrityCheck()`, `schemaDump()`.
- `e2e-tests/lib/invariants.ts` — G-01…G-34 global DB invariant harness (capture baseline in `before()`, assert delta in `afterEach()`, NDJSON to `results/invariant-events.ndjson`), including G-29 cumulative refund guards and G-32 debt column==ledger==payload.
- `e2e-tests/lib/seed.ts` — `seedProducts`, `seedCustomerFull`, `seedCustomers`, `seedImeiRecords`, direct SQL seeding mirroring `src-tauri/src/e2e.rs`.
- `e2e-tests/specs/30-34-ref-refunds*.e2e.ts` — 5 refund spec batches covering REF-01…REF-91 (full/partial/over-refund/discount allocation/card-anti-arbitrage/stock-cycle/PIN step-up/IMEI/write-off/multi-tender/change/race/replay/forged-invoke/void/clock-regression/2B-DA units/etc.), each with live-SQLite assertions.
- `e2e-tests/results/summary.json` — 687 total cases: 186 passed, 202 failed, 112 N/A, 124 remaining, 63 blocked; invariants 25/36 covered.
- `e2e-tests/FINDINGS.md` + `EDGE_CASE_VULNERABILITY_REPORT.md` — documented root-cause clusters (refund allocation/conservation CRT-05/06/17 ↔ REF-03/28/33, drawer state, identity, security boundaries, IMEI, audit chain, supervisor windows, offline/shift fences).

### `refund-audit/` scaffolding (created for this mission, NOT yet executed)
- `refund-audit/playwright-cdp.config.ts` — Playwright config, `testMatch: '**/refund-audit/**/*.spec.mjs'`, baseURL `http://localhost:${CDP_PORT}` (default 9223), CDP connection via `connectOverCDP` per-test.
- `refund-audit/src/cdp-client.mjs` — raw WebSocket CDP client (port 9222), `discoverCdpUrl()`. Has defects: duplicate `fill` method, references undefined `clickByText`, no `connectOverCDP`.
- `refund-audit/src/cdp-connect.mjs` — `discoverCdpEndpoint()` (port 9223), `scenarioEvidenceId()`.
- `refund-audit/src/scenario-generator.mjs` — generates 10,000 scenarios (`REF-<seed>-<hash>`), mulberry32 RNG, independent oracle (`computeOracle`), modes full/partial/zero-qty/over-limit/single-item/multi-line/repeat-partial, payment methods, serialized/non-serialized, restock/defective.
- `refund-audit/src/test-executor.mjs` — `runScenarios()` with UI + IPC modes, `CdpApp` helper (hardcoded PIN '789012', not the established '202020'), `invokeRefundSaleAtomic()` via `__TAURI__.core.invoke`, oracle checks `checkCumulativeRefundBound`/`checkNoDuplicateRefunds`.
- `refund-audit/src/test-runner.mjs` — Playwright CDP runner, `ensureAppReady()` (hardcoded PIN '789012'), `openRefundModal()`, `selectTransactionForRefund()`, `configureRefundItems()`, `submitRefund()`, `RefundOracle`, `captureEvidence()`.
- `refund-audit/src/smoke-test.mjs`, `verify-cdp.mjs`, `test-cdp-client.mjs` — connectivity/smoke helpers (require a running app with remote debugging).
- `refund-audit/scenarios/scenarios.jsonl` — 10,000 pre-generated scenarios.
- `refund-audit/scenarios/scenario-index.json` — total 10000, valid 6692, invalidFixture 3308, executable 5864, seedBase 20261025.

### Adversarial race harness (`tests/refund-race/`)
- `race.mjs` — two worker threads, own SQLite connections, `refundFixed` (JS model of `refund_sale_atomic`) vs `refundBaseline` (pre-fix TOCTOU), repros S1a/S1b baseline bugs and S2-S7 fixed-behavior checks (dedup, quota, atomicity, void races).

## 0.2 How a previous E2E test works (trace)

Representative: `test/specs/refund-money.e2e.ts` R1 (full kernel refund):

1. **Launch/attach**: `wdio` launches `target-e2e/debug/mobi-pos.exe` via `@wdio/tauri-service` (external or embedded driver). `before()` switches to window handle [0].
2. **WebView context**: tauri-driver attaches to the WebView2; specs drive the real DOM through `@wdio/globals` (`browser`, `$`, `$$`).
3. **Ready detection**: `unlockIfNeeded()` waits for `setup-pin-root` / `lock-screen` / `header` (60s timeout).
4. **PIN/auth**: If setup screen → set manager name + PIN + confirm. If lock screen → click `login-pin-pad`, `browser.keys(pin.split(''))` (digit-by-digit), click `login-submit`, wait for `header`. PIN = `202020`.
5. **Navigation**: `openShiftUi()` opens a shift via the shift pill → `shift-open-dialog` → `shift-open-direct` → float input → `shift-open-total` settles → `shift-open-confirm`.
6. **UI controls**: `data-testid` selectors (`cart-line-remove`, `checkout-button`, `pay-exact`, `pay-confirm`, `refund-button`, `refund-dialog`, `refund-search`, `refund-sale-row`, `refund-pin`, `refund-submit`). First DISPLAYED match wins (mobile/desktop twins share testids).
7. **Wait/verify**: `browser.waitUntil` on DOM/DB conditions; out-of-band `ledger()`/`getSale()`/`stockOf()` via Tauri `e2e_*` IPC for ground truth; `nativeCodeOf()` extracts `CODE:detail` from WDIO-wrapped native errors.
8. **Test data prep**: `invoke('e2e_reset_db')` + `invoke('e2e_seed_state', {payload: {products, openShift}})`; `clearWebMirrors()` so UI re-reads SQLite authority.
9. **Evidence on failure**: `dumpRefundState()` screenshot + dialog state JSON; `readErrors()` console-error trap asserted empty in `after()`.
10. **Teardown**: `onComplete` → `stopAppGracefully()` (taskkill, 15s grace, then /F) + kill drivers + release run lock. `.e2e` container never touches production data.

## 0.3 PIN workflow (established)

- **Value**: `APP_PIN = '202020'` (six digits, the "20, 20, 20" convention). Overridable via `POS_E2E_PIN` env in `e2e-tests/lib/env.ts`.
- **Entry**: lock-screen `login-pin-pad` (click to focus) + `browser.keys(pin.split(''))` + `login-submit` click. Refund manager step-up: `refund-pin` input + `refund-submit` click.
- **Shared**: one PIN across all test users/cashiers/manager gates; not environment- or session-varying.
- **Pre-PIN steps**: fresh container → setup screen (set name + PIN + confirm) → lock screen → dashboard. On subsequent runs (same container) → lock screen only.
- **Persistence**: auth state lives in the `.e2e` data dir + Dexie mirror; `clearWebMirrors()` + `refresh()` forces re-read from SQLite but does NOT log out (PIN persisted natively).
- **Failure**: wrong PIN → toast "incorrect", modal stays open, nothing written. 5 failures → native escalating lockout (5 fails → 60s, `pin.rs:66` `LOCKOUT_LADDER`), TS pacing mirror `mobipos_pin_lockout_v1` in localStorage (cleared via `clearPinMirror()` between tests as UI hygiene; native ladder is authoritative).
- **Helper reused**: `unlockIfNeeded(pin)` from `test/helpers/pos.ts` (root) or `e2e-tests/lib/pos.ts` (encyclopedia). Both enter `202020` through real UI controls.

## 0.4 Previous successes/failures

- Confirmed refund-domain failures (from `EDGE_CASE_VULNERABILITY_REPORT.md` batches 3-8): REF-06 card-funded cash anti-arbitrage, REF-03 invoice-discount net-share (P0-8: preview 450 commits 405), REF-28/CRT-17 stacked bundle refund (P0-9: preview 269 commits 207), REF-17 PIN step-up/lockout surface quirks (TS mirror answers before kernel), REF-44 side-effect ordering (refused writes nothing), REF-47 double-submit dedup, REF-78 forged receipts, REF-80 supervisor freshness vs monotonic anchor, REF-87 2B-DA integer money.
- Flaky patterns historically: toast-polling races (parked error from previous attempt misread as current refusal — mitigated by `graceLanned()` 6s row re-verify + `prePage`/`preToast` staleness checks), `submitForeignLocked` vs `isSubmitting` disabled-submit ambiguity, virtualized customer list cut-off (scan then filter via search), `F` key swallowed by global hotkey (mitigated by `installPageShims` `__e2eFShield`), `element click intercepted` on sticky pricing tier strip (centre + JS-click fallback), wedge-burst barcode cadence ≤25ms.
- Reliable selectors: `data-testid` (tid), first-DISPLAYED match, visible-text buttons (`button=Valider`, `/Remboursement/`, `/Valider & Ouvrir/`).
- Isolation: `.e2e` flavor + sandboxed `USERPROFILE` means production data never opened; `POS_E2E_WIPE=1` wipes container + WebView profile.

## 0.5 Reuse decision

**Infrastructure reused WITHOUT modification:**
- `e2e-tests/wdio.conf.ts` (launcher, driver, sandbox, provenance, wipe, lifecycle) — the proven, executed harness.
- `e2e-tests/lib/{pos,db,invariants,seed,env,invoke}.ts` — UI helpers, direct SQLite, G-01…G-34 invariants, seeders.
- `unlockIfNeeded()` + `APP_PIN = '202020'` — PIN workflow through real UI controls.
- `refundDirect()` / `refund_sale_atomic` IPC bridge — for out-of-band oracle cross-checks (root `test/helpers/pos.ts`).
- `data-testid` selectors + first-displayed pattern.

**NOT reused (obsolete/unsafe, not copied):**
- `refund-audit/src/{cdp-client,cdp-connect,test-executor,test-runner}.mjs` — raw CDP client has duplicate `fill`, calls undefined `clickByText`, hardcodes PIN '789012' (not '202020'), never executed against a real binary. CDP requires `--remote-debugging-port` which the e2e build does not enable by default. Documented as a limitation; WebDriver via tauri-driver is the validated connection.
- Any duplicate login/fixture framework — would violate the "no duplicate systems" rule.

**Additional functionality the refund suite requires:**
- A scenario runner that drives the REFUND UI (open refund modal → search receipt → select row → set qty/method → enter manager PIN → submit) for each generated scenario, with per-scenario DB baseline + post-state snapshot via `better-sqlite3` (`lib/db.ts`).
- Deterministic fixture builder (seed products/customers/shift, ring sales via real UI `addSku`+`payExactFlow`/`payTenderedFlow`, pre-existing refunds via `refundDirect` IPC or UI).
- Per-scenario invariant assertions (G-01 cashDisbursed↔cash_movements, G-29 cumulative refund ≤ purchased, G-32 debt column==ledger==payload, stock↔ledger drift G-04, no duplicate refund rows G-09).
- Failure diagnostics: `dumpRefundState()` screenshot + body tail + console errors + `refundsFor(ticketId)` rows.
- Serial IDs + seeds for reproducibility.

**Existing tests to execute first (environment validation):**
- `test/specs/smoke.e2e.ts` (launch + header + title)
- `test/specs/refund-money.e2e.ts` (R1-R5) — validates refund IPC + UI gate + DB ground truth

**Plan**: Build `target-e2e/debug/mobi-pos.exe` (`npm run build:e2e`), install `tauri-driver` (`cargo install tauri-driver`), run smoke + refund-money to validate launch/PIN/auth/navigation/assertion/cleanup, then build the autonomous refund campaign on the `e2e-tests/` harness reusing `refund-audit/scenarios/scenarios.jsonl` as the scenario inventory (adapted for UI execution).
