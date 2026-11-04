# Changelog

All notable changes to MobiPOS. Dates are local. Evidence IDs refer to
`docs/c01-evidence.ndjson`; tags `c01-rc-N` are cut from a clean worktree whose
gate table is recorded in the same ledger.

## [Unreleased] — after c01-rc-11

### Added
- **ESC/POS capture sink + decoder oracle** (`scripts/escpos_sink.mjs`,
  `e2e-tests/lib/escpos-parse.ts`): raw TCP virtual printer, byte-exact goldens,
  structural assertions (init, raster, align, barcode, cut, drawer) and negative
  controls. `npm run test:escpos` — 27 checks.
- **Arabic printing** (`src/utils/arabicText.ts`, `src/utils/receiptRaster.ts`,
  `ADR-004`): Arabic runs print as `GS v 0` bit images rendered by the platform,
  because CP864 carries only 65 of the 117 Arabic contextual forms. CP864 remains
  a documented fallback.
- **Hardware kit** `npm run escpos:kit` (artifacts + `CHECKLIST.md`, `--host` to
  print) — HAR-002 is now a 10-minute human check.
- **Two-device + gateway fault suite** (`npm run test:sync-two-device`): 19 checks
  over the real gateway with real Ed25519 keys, fake clocks, partition/heal,
  duplicate, reorder, crash-replay, revocation, concurrent same-ticket.
- **Mock acquirer** (`npm run test:acquirer`, 15 checks) and **two-client sync
  fault suite** (`npm run test:syn-faults`, 8 checks, with negative control).
- **SEC-18/19/20**: audit rows carry `app_version` + `session_id` (v129 + native
  self-heal), customer-directory browsing is audited (10 s throttle), the release
  window is capture-protected and sensitive clipboard values auto-clear.
- **ADRs 002–005**: convergence model, data at rest, Arabic printing, role-bound
  IPC (SEC-01 design).

### Fixed
- REF-17: the native PIN lockout map overflowed the OS-keyring blob, so every
  `pin_verify` errored and failures stopped counting. The map is now pruned and
  bounded (Rust test).
- REF-19/91: refund PIN entry and modal waits no longer history-back the dialog.
- Refund-value checker: debt relief (`PAYMENT_SETTLED`) is a destination of
  record; spec 30 runs with zero money violations.
- G-21: a repair created directly as `Livré` now stamps `deliveredAt` and
  `warrantyExpiresAt`; G-05: the serialization-flip fixture registers its units.
- Printing: fr-DZ amounts printed `1?700 DA` (U+202F has no Latin-1 byte) — now a
  plain space; long item names and the footer overflowed 58 mm paper — now folded.
- SHF-05 is clock-independent (two-day backdate, 48-slot sweep); 40-shf 12/12.
- Zero-tax gate converted to content anchors over all of `src-tauri/src`
  (23/23) — a moved line no longer fails, an edited or new one does.

### Changed
- **Native boot maintenance (SEC-01 step 2):** outbox purge/inflight reset, debt
  cache reconcile, duplicate live-shift close and the one-live-shift index run in
  one native transaction at startup; the renderer skips those statements.
- **Measured the read-only flip surface:** 205 refused renderer statements under
  `POS_SQL_QUERY_ONLY=1` (schema heal, settings, sync, maintenance). The switch
  stays opt-in until that surface is migrated (ADR-005).

## [c01-rc-10] — 2026-11-03 (`4dd4d0e`)

- **SEC-01 increment 2 step 2a:** native `sql_select_ro` — own connection with
  `SQLITE_OPEN_READONLY`, authorizer allowlist, single-statement rule, row/time
  caps, credential tables unreadable. App-path probes + writable controls in spec 92.
- Persistent read-only connection: 2.8 ms → **0.4 ms** p50 (plugin pool 0.5 ms),
  no long-lived read transaction.
- **SQL boundary gate:** `scripts/check-sql-boundary.mjs` lists the 318 renderer
  write statements, `--ratchet` fails on new ones, `--fail` reserved for the end
  state; CI runs ratchet + report; baseline may only shrink.
- **Security fix from the new secrets scan:** the technician recovery secret was a
  constant in the source — a universal manager-PIN backdoor. It is now provisioned
  per install and the lane **fails closed** until it exists (9-test regression,
  including replay-burn and cross-install binding).
- **Repo pass:** `SECURITY.md`, `OWNER_ACTIONS.md`, SBOM + third-party inventory
  (`npm run sbom`, `gate:licences`: 27 runtime packages, all permissive), secrets
  gate (`gate:secrets`), CI wiring.

## [c01-rc-6] — 2026-11-03 (`d57ddef`)

- Role-bound IPC (R1) and the session principal in native code.
- Money-boundary debt closed with B′: two redundant rounds removed, cap 54 → 56,
  `clampCashRefund` four-class matrix (money 65/65, cash terms 32/32).
- Clean-worktree verification: 50-sec 10/10 ×3, 40-shf 12/12, refund suites 30–34
  green (34 with clean invariants after the G-05 fixture fix), cargo 454/454,
  tsc 0, selftest 137/137, reconcile 687.

## [c01-rc-5] — superseded

- Superseded by `c01-rc-6` (owner decision OD-001). The tag is immutable and was
  not moved.
