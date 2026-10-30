# Harness map - surface -> helper -> oracle

One row per surface a new feature can land on. "Drive with" is what the test calls;
"Oracle" is what decides the verdict. If a surface has no row here, grep
`e2e-tests/lib/*.ts` for an export before writing a selector by hand - the helpers
exist because the raw path was flaky.

## The three oracles (and what is *not* one)

| Oracle | How it is read | Use it for |
|---|---|---|
| **Live SQLite** | `e2e-tests/lib/db.ts` - `one` / `all` / `scalar` / `count` / `run` / `columnNames` / `tableCounts`, over better-sqlite3 on the same `mobi_pos.db` the app is writing | money, stock, ledger, sessions, outbox, trust - every fact that survives the screen |
| **Native IPC** | `e2e-tests/lib/invoke.ts` - `invoke`, `invokeRaw`, `nativeCodeOf` | typed refusals, commands with no UI, anything the WebView could fake |
| **Bytes** | `lib/sav.ts` `armPrintBuffer` / `readPrintBuffers`, `lib/pos.ts` `armPrintCounter` / `readPrintCalls` | receipts, Z-report, warranty certificate - what the printer actually got |

**Not an oracle:** the DOM you just drove, a `console.log` the app emits about its own
success, or a mirror (Dexie/localStorage) the app maintains in parallel. A case whose only
assertion is "the modal closed" is `PASS-PARTIAL` at best.

Sandbox facts that change how you read the oracle: the DB is WAL, writes from the app cross
an IPC boundary, so **poll** state (`browser.waitUntil` on a DB read) rather than reading once
after a click. `waitForSchemaSettled()` gates the first read after a wipe; `resetData()` wipes
business tables, not the schema. Paths come from `lib/env.ts` (`DB_PATH`, `SANDBOX`,
`WEBVIEW_DIR`).

## Surface table

| Surface | Drive with | Oracle | Working example |
|---|---|---|---|
| Cart / checkout | `tid`, `addSku`, `scanCode`, `cartLineCount`, `cartTotalMinor`, `cartLineTexts`, `applyCartDiscountPercent`, `overrideLastLinePrice`, `toggleLastLineReturn`, `payExactFlow`, `payTenderedFlow`, `clearCart` | `transactions` row + `json_payload`, `inventory_ledger`, `products.stock`, `cartTotalMinor()` vs stored integer | `10-mny-money.e2e.ts`, `71-crt-cart.e2e.ts` |
| Refunds / voids | `openRefund`, `refundSearch`, `selectRefundTicket`, `setRefundQty`, `setRefundReason`, `selectRefundMethod`, `clickRefundSubmit`, `refundTotalMinor`, `refundLineState`, `refundSubmitDisabled`, `closeRefund` | refund rows (`is_refund=1`, `original_transaction_id`), `cash_sessions` totals, `inventory_ledger` restock delta | `30-`…`34-ref-refunds*.e2e.ts` |
| Shifts / drawer / cash | `openShiftUi`, `ensureShiftOpen`, `readOpenShiftDexie` | `cash_sessions` (`opening_float`, `status`, variance columns), one-OPEN-session invariant G-17 | `40-shf-shifts.e2e.ts` |
| Customers / loyalty / credit | `selectCustomer`, `seedCustomerFull`, `seedCustomerDebts`, `seedCreditVouchers` | `customers`, `customer_debts` (**not** a derived `current_debt` column), `loyalty` ledger, G-23/G-32 | `70-crm-customers.e2e.ts`, `75-loy-loyalty.e2e.ts` |
| Inventory / trade-in | `seedProducts`, `seedImeiRecords`, `addSku` | `products.stock`, `inventory_ledger`, `imei_records` lifecycle (G-04/G-05) | `82-inv-inventory.e2e.ts`, `80-tin-tradein.e2e.ts` |
| SAV / repair / warranty | `lib/sav.ts` - `seedSale`, `openRepairModal`, `fillIntake`, `setCardStatus`, `deliverViaStatus`, `drawSignature`, `writeAttachment`; `lib/warrantyCertificateProbe.ts` | `sav_repairs` + payload, `attachments` blob refs (G-21/G-26), certificate bytes | `84-rep-repair.e2e.ts`, `86-war-warranty.e2e.ts` |
| Reports / print | `armPrintBuffer` + `readPrintBuffers` (sav), `armPrintCounter`/`readPrintCalls` (pos), `armConsoleTap`/`countConsoleMatching` | printed bytes vs the on-screen headline vs the DB aggregate - all three, or `PASS-PARTIAL` | `26-rcp-tim.e2e.ts`, `27b-lbl-hw.e2e.ts` |
| Authorization / step-up | `unlockIfNeeded`, `typeReal`, `typeRefundPin`, `armInvokeCounter`/`readInvokeCalls` | the typed IPC code (`nativeCodeOf`) + `audit_log` actor row (G-15/G-19) | `50-sec-authorization.e2e.ts`, `51-sec-hardening.e2e.ts` |
| Data layer / native commands | `invoke` / `invokeRaw`, `db.ts` for ground truth | command result code + resulting table rows; never the TS wrapper's return value alone | `99-probe-native.e2e.ts`, `20-dat-data-integrity-*.e2e.ts` |
| Sync / outbox / gateway | `getPendingOutbox`-style reads via `db.ts`, `clearOutbox`, `proxy/gateway.mjs` + `tests/fixtures/mockGatewayServer.mjs` for the loopback lane (`npm run test:sync-e2e`) | `sync_outbox` rows (`seq_no`, signature, envelope v112), `device_identity.last_acked_seq` contiguity | `24-syn-sync.e2e.ts`, `24-syn-probe.e2e.ts` |
| Mobile shell (`?mode=mobile`) | `e2e-tests/lib/session.mjs` - `ensureMobileSession`, `mobileLogin`, `dismissMobileOverlays`, `seedMobileDbOnly`; reset via `resetApp()` in `mobile/lib/adb.mjs` | mobile Dexie mirror reconciled against the till's SQLite row (bidirectional), G-18 freshness | `94-probe-mobile-demo.e2e.ts`, `mobile/` fixtures |
| Scale / performance | `seedCustomers` in bulk (`23-scl-scale-*`), `lib/rng.ts` for deterministic ids | query timing + row counts + WAL size; assertions must be ratio-based, not absolute ms | `23-scl-scale-*.e2e.ts` |

## Invariants are part of every spec

`lib/invariants.ts` runs a baseline-delta check of the global invariants (G-01…G-34 subset)
against the live DB:

```ts
captureInvariantBaseline('FEAT');           // in before(), AFTER seeding + mirror refresh
assertInvariants(`FEAT :: ${title}`);       // in afterEach(), after cleanup
finalizeInvariants('FEAT batch NN (spec NN)'); // in after()
```

Consequences for new features:

- A new write path that touches money, stock, sessions or audit **will** trip an invariant if
  it is wrong - that is the point; do not disable a hook to get green.
- An invariant failure that appears **only** in the `afterEach` hook is attributed to the
  last `it()`. Treat it as a fact about the batch, record it in the report, and do not
  silently override the case to PASS (the `PAY-22` precedent: the case passed, the hook
  fired on a documented residual, and the override carries its justification).
- `01-invariant-negative-controls.e2e.ts` proves the hooks actually fire; re-run it if you
  doubt a silent pass.

## Gaps you must not paper over

| Gap | Consequence for a new case |
|---|---|
| Bluetooth / USB ESC-POS printer absent | receipt **bytes** cases are `BLOCKED` (say which printer), not `N/A` - `armPrintBuffer` captures the command stream, not the paper |
| Real merchant gateway + enrolled device pubkeys absent | server-side verification is `BLOCKED`; the loopback lane proves client behaviour only |
| Android sandbox health is intermittent | mobile cases that need a live device are `BLOCKED` with the sandbox state, not "N/A" |
| No video / WebDriver trace | the four artifacts are the whole evidence set; add a `console.log` with the case id and re-run instead of guessing |

`N/A` means *the product has no such surface*; `BLOCKED` means *the surface exists but the
harness cannot reach it today*. Mixing them inflates the dashboard and hides a real gap.
