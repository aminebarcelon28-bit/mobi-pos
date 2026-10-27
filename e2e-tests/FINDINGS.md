# FINDINGS.md

Generated: 2026-10-23T19:32:13.2068259+01:00
Source: e2e-tests/EDGE_CASE_VULNERABILITY_REPORT.md + COVERAGE reconciliation + events.ndjson

## Summary
- Failed catalog cases (current): 124 (COVERAGE.md)
- Notable root-cause clusters (documented): refund allocation/conservation (CRT-05/06/17 linked to REF-03/28/33), loyalty tier mismatch (LOY-08), identity/attribution (IDN), drawer state across devices (DRW), security boundaries/WebView bypass (SEC), IMEI/serialization, audit chain, supervisor windows, offline/shift fences.

## Key confirmed failures (representative)
See COVERAGE.md domain sections for full per-case details. Critical P0/P1 examples:
- CRT-05/06/17: stacked discounts/bundle allocation incorrect on refund (P0-8/P0-9) - confirmed
- CRM-03, CRM-06, CRM-09: customer deletion/duplicates/role visibility issues
- LOY-08: tier column/payload mismatch (Silver vs Bronze)
- REF family: many historical failures reproduced; some with UI/harness nuances documented
- REP/WAR: significant FAIL counts per COVERAGE summary (REP 3P/16F/5N, WAR 5P/14F/11N mentioned)
- DRW/IDN/SEC: multiple product gaps and trust-model issues

## Evidence
- Full details: e2e-tests/EDGE_CASE_VULNERABILITY_REPORT.md (914 lines) with citations to src/, src-tauri/, specs/, logs/
- Per-run: e2e-tests/logs/*, e2e-tests/test-logs/*, e2e-tests/results/*
- Machine map: e2e-tests/results/summary.json, e2e-tests/results/events.ndjson

## Notes
Failures are deduplicated by root cause where documented in the report; individual case IDs are preserved per requirements.
