# TEST_EXECUTION_REPORT.md

Generated: 2026-10-23T19:31:51.0727802+01:00
Working directory: the repo root
Git commit: ac01bc2 docs(import): design historical destination lanes
Uncommitted changes: 49
Staged changes: 0
Platform:  Microsoft Windows NT 10.0.26300.0
Node: v24.18.0
npm: 11.16.0
Tauri binary (e2e): `target-e2e\debug\mobi-pos.exe` (repo-relative)
Tauri driver: `%USERPROFILE%\.cargo\bin\tauri-driver.exe`
WebdriverIO: 9.32.0
Sandbox base: %TEMP%\opencode\pos-wdio-sandbox (from wdio.conf.ts)
DB path (sandbox): {SANDBOX}\home\AppData\Roaming\com.mobi.pos.e2e\mobi_pos.db
E2E identifier: com.mobi.pos.e2e

## Coverage (post-regen)
- Total catalog cases: 687 (incl. 15 I18 + 8 HW; 10 retired tax IDs reported N/A separately)
- Passed: 148
- Failed: 124
- N/A: 93
- Remaining (not covered yet/implemented-not-run): 322
- Invariants G-01..G-36 harnessed/executed: 25/36
- Implemented specs cover 320 case-IDs; events.ndjson has 907 pass / 852 fail / 1 skip (1760 lines)

## Notes
- The coverage numbers are reconciled from CASE_INDEX.csv (single verdict source), fixtures/cases.json (catalog id-set proof + G-invariant texts), specs/*, and results/events.ndjson via tools/coverage.mjs (batch-only).
- The encyclopedia source referenced by fixtures is POS_EDGE_CASE_ENCYCLOPEDIA_and_LONG_SESSION.md (kept outside this repo) (verified present).
- REP/WAR and REF/MNY/CRT/SHF/SEC/IDN/DRW runs are documented in logs/ and results/ with detailed evidence in EDGE_CASE_VULNERABILITY_REPORT.md.
- Some failures are confirmed via earlier canonical runs carried in CASE_INDEX.csv (e.g. CRT-05/06/17 linked to REF-28/03/33).

## Evidence locations
- COVERAGE.md (authoritative reconciled ledger)
- EDGE_CASE_VULNERABILITY_REPORT.md (detailed findings with citations)
- results/summary.json, results/events.ndjson, results/invariant-events.ndjson
- logs/*, test-logs/*, results/* (per-run logs)
- fixtures/cases.json, CASE_INDEX.csv
- TEST_EVIDENCE/ (organized evidence structure created)
