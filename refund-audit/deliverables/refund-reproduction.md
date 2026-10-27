# Reproduction Instructions — BUG-1: R1c Sealed Lane Accepts Refund It Should Refuse

## Bug summary
- **ID:** BUG-1
- **Title:** Offline/foreign-ticket "sealed lane" accepts a refund with the correct PIN when it should refuse (dialog closes instead of staying open; writes persisted)
- **Severity:** HIGH (financial integrity — offline/foreign-ticket gate not enforced)
- **Status:** Confirmed, reproducible (2/2 runs)
- **Location:** `test/specs/refund-money.e2e.ts:403-447` (test "R1c modal gates: wrong PIN never fires; sealed lane refuses payout")
- **Failure line:** `test/specs/refund-money.e2e.ts:442` — `expect(isDisplayed()).toBe(true)` received `false`

## Environment
- **Binary:** `target-e2e/debug/mobi-pos.exe` (e2e flavor `com.mobi.pos.e2e`, gitSha=ac01bc2123f836e0a656f1654669ac6f0b554b31)
- **Driver:** tauri-driver v2.0.0 (embedded), root `wdio.conf.ts`
- **OS:** Windows (WebView2 / msedge 155.0.0.0)
- **PIN:** `APP_PIN = '202020'` (from `test/helpers/common.ts`) — do NOT publish or change production credentials
- **Sandbox:** `.e2e` container, `POS_E2E_WIPE=1` (isolated from production `com.mobi.pos`)

## Execution command
```
cd C:\Users\Click\Desktop\phone3-sync-lab
$env:WDIO_E2E_DRIVER="embedded"
$env:WDIO_E2E_BINARY="target-e2e\debug\mobi-pos.exe"
$env:WDIO_TAURI_DRIVER="D:\cargo\bin\tauri-driver.exe"
$env:WDIO_LOG_LEVEL="error"
$env:POS_E2E_WIPE="1"
npx wdio run wdio.conf.ts --spec ./test/specs/refund-money.e2e.ts
```
Expect: 6 passing, 1 failing — the failing test is "MONEY refunds R1c modal gates: wrong PIN never fires; sealed lane refuses payout" at line 442.

## Reproduction steps (UI)
1. Launch app (fresh `.e2e` container).
2. Unlock via PIN screen: click `login-pin-pad`, type `202020` digit-by-digit, click `login-submit`.
3. Open a shift via the shift pill → `shift-open-dialog` → `shift-open-direct` → enter float → `shift-open-confirm`.
4. Add a product to cart (`addSku`) → `payExactFlow` → sale completes (status COMPLETED).
5. Click `refund-button` → `refund-dialog` appears.
6. Search the receipt via `refund-search` → sale row appears (`refund-sale-row`).
7. Click the sale row → refund line configures.
8. **Wrong PIN test:** enter `000000` in `refund-pin`, click `refund-submit` → expect dialog stays open, zero writes (this part PASSES).
9. **Correct PIN test (the failure):** enter `202020` in `refund-pin`, click `refund-submit`.
10. **Expected:** Dialog REMAINS open (sealed lane refuses payout), no refund row written.
11. **Observed:** Dialog CLOSES (refund accepted), refund row persisted → gate not enforced.

## Expected vs observed
| Step | Expected | Observed |
|------|----------|----------|
| Wrong PIN + submit | Dialog stays open, zero writes | Dialog stays open (PASS) |
| Correct PIN (202020) + submit on sealed lane | Dialog stays open, zero writes | **Dialog closes, refund accepted (FAIL)** |
| `counts()` after correct PIN | Unchanged (c0) | Changed (refund written) |

## Evidence
- WDIO test output: `expect(received).toBe(expected)` — Expected: true, Received: false at `refund-money.e2e.ts:442:65`
- Test name: "MONEY refunds R1c modal gates: wrong PIN never fires; sealed lane refuses payout"
- Reproduced: 2 consecutive runs (100% reproducible)

## Triage note
Determine whether the "sealed lane" (offline/foreign-ticket gate) is supposed to refuse correct-PIN refunds after a `browser.refresh()`. If the gate should refuse, fix the native validation path. If the test's premise is wrong (fresh local sale is not "foreign"), correct the test expectation rather than the app.
