# BLOCKERS_AND_OWNER_QUESTIONS.md

Generated: 2026-10-23T19:32:42.8359227+01:00

## Environment/harness blockers
- msedgedriver not on PATH (wdio.conf.ts auto-downloads matching WebView2; first run may need network). 
- tauri-driver present at `%USERPROFILE%\.cargo\bin\tauri-driver.exe`. 
- E2E binary exists at target-e2e\debug\mobi-pos.exe (built). 
- Real MobiPOS exe may be running - wdio.conf.ts refuses if mobi-pos.exe running (must kill first).
- Sandbox isolation: POS_E2E_WIPE=1 wipes sandbox dirs; must ensure not targeting real data.
- WebView2 cold start can be slow (timeouts configured).

## Coverage gaps / unverified
- 322 cases remaining (not covered yet/implemented-not-run). 
- Invariants 11/36 not yet harnessed/executed per summary.
- REP/WAR have partial execution; many domains (SYN, SCL, MOB, I18, HW, PRF, RPT, INV, TIN, LOY full, etc.) have significant remaining.
- Hardware-in-the-loop: actual printers/scanners/drawers/Android devices not confirmed available - tests rely on logs/simulation where documented.
- Multi-device full sync-chaos/scale-soak profiles may require infrastructure not present.

## Policy questions (from encyclopedia)
- Sync/offline policy, rounding rules, loyalty cash-value conditions, credit sales terms, refund windows, trade-in requirements, repair deposits, drawer ownership, cashier attribution, warranty periods, mobile security, backups/RPO/RTO, multi-shop returns, additional refund types (see encyclopedia Part 6). Many marked [RULE?]/[UNVERIFIED-LAW].

## Notes
- Tax IDs retired per owner decision (10 IDs N/A).
- WebView SQL bypass is a known OPEN residual (docs/webview-sql-residual.md) - trust guarantees detection-backed not prevention-backed until data-plane gateway.
- Some failures require modified WebView/forged IPC to reach native boundaries (documented as trust-model issues).

## Recommendations
- Run full suite in clean environment with all services stopped: kill mobi-pos.exe, ensure no tauri-driver/msedgedriver conflicts, use POS_E2E_WIPE=1 if starting fresh.
- Prioritize P0 remaining: money integrity, refunds, sync, authz, data-loss.
- Resolve owner policy questions to convert INCONCLUSIVE/BLOCKED to definitive verdicts.
