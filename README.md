# MobiPOS

Offline-first point-of-sale for phone-and-accessory retail (Algeria): checkout,
credit/debt, loyalty, repairs (SAV), trade-ins, purchasing, cash-drawer control,
fiscal receipts and multi-terminal sync.

- **Desktop:** Tauri v2 (Rust core) + React/TypeScript/WebView2.
- **Data:** local SQLite (`mobi_pos.db`, WAL) as the fiscal source of truth;
  Turso is a remote sync transport only (see `AGENTS.md`).
- **Mobile:** the same WebView UI in a mobile shell (companion mode).
- **Money:** integer dinars at every boundary; no tax feature by product decision.

## Quick start

```bash
npm ci
npm run dev            # web preview (no Tauri shell)
npm run build          # production bundle
npm run tauri dev      # desktop app with the native core
```

## Verification (the gates that define "done")

| Gate | Command | Expect |
|---|---|---|
| Money boundary | `node scripts/check-money-boundary.mjs` | `BOUNDARY GATE: 65 PASSED, 0 FAILED` |
| Zero-tax | `node scripts/test_zero_tax.mjs` | `SUMMARY: 23 PASSED, 0 FAILED` |
| Cash terms | `node scripts/test_cash_terms.mjs` | `CASH TERMS SUMMARY: 32 Passed, 0 Failed` |
| Types | `npx tsc --noEmit` | exit 0 |
| Rust | `cd src-tauri && cargo test --lib` | `test result: ok` |
| Harness selftest | `node .opencode/skills/e2e-testing/scripts/selftest.mjs` | `137/137 checks passed` |
| Case ledger | `node .opencode/skills/e2e-testing/scripts/reconcile.mjs` | `RECONCILED 687 active cases` |
| Boundaries | `npm run test:boundaries` | exit 0 |
| SQL boundary (renderer writes) | `npm run gate:sql-boundary` | count ≤ baseline (ratchet) |
| Secrets | `npm run gate:secrets` | `no secret material found` |
| Licences (shipped) | `npm run gate:licences` | `runtime outside allowlist: 0` |
| Technician recovery | `npm run test:technician-recovery` | 9/9 |

Hardware- and protocol-level harnesses (dev-only, hermetic, no credentials):

| Harness | Command | What it proves |
|---|---|---|
| ESC/POS sink + oracle | `npm run test:escpos` | the exact bytes a printer receives: init, Arabic raster, totals, barcode, cut, drawer; byte-exact goldens |
| ESC/POS hardware kit | `npm run escpos:kit` | builds the artifacts + `CHECKLIST.md`; `-- --host <ip>` prints them to a real printer |
| Two-client faults | `npm run test:syn-faults` | convergence primitives (partition, replay, reorder, skew, tombstones) |
| Two-device + gateway | `npm run test:sync-two-device` | per-device cursors, gap arbitration, dedupe, revocation against the real gateway |
| Gateway loopback | `npm run test:sync-e2e` | signed envelopes + `SERVERTIME_V1` tokens end to end |
| Acquirer contract | `npm run test:acquirer` | authorize/capture/void/refund/decline/timeout-reconcile on the mock acquirer |

End-to-end suites (WebdriverIO, sandboxed app):

```bash
npm run build:e2e
node .opencode/skills/e2e-testing/scripts/run.mjs --spec e2e-tests/specs/50-sec-authorization.e2e.ts --wipe
```

`e2e-tests/CASE_INDEX.csv` is the case ledger; verdicts are written only by
`verdicts.mjs --run <sidecar> --write-index`.

## Dependency inventory

`npm run sbom` writes `docs/sbom.json` (827 packages: runtime + dev) and
`docs/THIRD_PARTY.md` (shipped only). `npm run gate:licences` fails if a shipped
package is outside MIT/Apache-2.0/BSD-family or has an unknown licence.

## Layout

```
src/                  React app (store slices, utils, components)
src-tauri/src/        Rust core: trust_core, refunds, sync, audit, escpos IPC
e2e-tests/            WebdriverIO specs, lib helpers, case index
scripts/              gates + dev harnesses (money, zero-tax, sink, sync)
tests/                fixtures (gateway, acquirer, escpos goldens) and pipelines
docs/                 ADRs, plans, case register, evidence ledger
agent/                handoff: RESUME, HUMAN_ACTIONS, dossiers
proxy/                merchant sync gateway (server-side; never shipped)
```

## Architecture decisions

`docs/adr/` — start with `ADR-001` (native session principal), `ADR-002`
(convergence model), `ADR-003` (data at rest), `ADR-004` (Arabic printing),
`ADR-005` (role-bound IPC).

## License and third-party notices

This repository is **proprietary; all rights reserved** — see `LICENSE`.
Shipped dependencies are permissively licensed only (MIT / Apache-2.0 / BSD);
the audit trail is `licenses_ledger.json` and `licenses_audit.json`.
