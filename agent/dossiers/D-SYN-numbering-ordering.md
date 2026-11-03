# D-SYN — SYN-02 (fiscal numbering) and SYN-27 (ordering) decision notes

## SYN-02 — two terminals minting receipt numbers offline

**Current scheme.** `newReceiptNumber(prefix)` = `PREFIX-YYYYMMDD-<msOfDay base36>-<seq2>-<random5>`
(`src/utils/ids.ts:110`). It is unique in practice by randomness, but it is **not a fiscal
sequence** (no per-series continuity) and the DB has no uniqueness constraint on
`transactions.receipt_number`, so a collision — or a caller reusing a number — is accepted.

**Why it cannot be fixed by a "merchant-scoped sequence" alone.** Offline-first: a terminal must
commit a sale with no network. A single merchant counter requires coordination; two disconnected
terminals would either block or duplicate. Every offline-safe design therefore reserves a
**per-device series** (a block allocation while online, then a local continuous counter), which is
also the common multi-till practice for continuous/sequential numbering.

**Options.**
- **A (recommended): device-series numbering.** `PREFIX-<series>-<YYYYMMDD>-<seq>` where the series
  identifies the terminal (short device token, printed on the receipt). Each series is continuous;
  no cross-terminal collision by construction. Requires a one-time series assignment per device
  and a printed legend.
- **B: merchant-scoped counter with online block reservation.** Same guarantee only while the
  device can reserve blocks; offline devices still need a device component, so it converges to A.
- **C: keep the current timestamp+random scheme** and add a unique index (fail-closed on a
  collision). No fiscal continuity; rejected for a fiscal document number.

**Status:** **BLOCKED — business/regulatory decision (HAR-004).** It changes the printed document
number and the continuity contract; the owner must choose A (and whether the series is registered
with the tax administration / reset annually). No code change was made unilaterally.

**If A is chosen:** migration for existing numbers (prefix preserved), `newReceiptNumber` takes the
device series, a unique index on `(device_series, receipt_number)`, printed legend, and a
two-instance harness case proving offline uniqueness (SYN-02 then RUN, not BLOCKED).

## SYN-27 — ordering by clock vs version/HLC

**Inspection result (2026-11-03).** The concern "the pull cursor compares timestamps" is largely
already addressed in the current code:
- Rows are **stamped with the cloud/server clock at push** (`SyncManager.ts` push lane,
  ADR-0008), so peers order on one clock and a drifting device cannot hide its rows behind a
  cursor.
- The pull cursor is a **tuple** `(updated_at, id)`:
  `WHERE (updated_at > ?) OR (updated_at = ? AND id > ?) ORDER BY updated_at, id`
  (`SyncManager.ts:2321`), so equal-timestamp rows are not skipped.
- Application is **version-primary** with a deterministic device-id tiebreak
  (`causalVersion.ts: tiedVersionGuardSql`, proven order-independent by
  `scripts/test_sync_tiebreak.mts`).
- The event lane uses an **HLC cursor** (`sync.pull_hlc_cursor`, `eventSyncEngine.ts`).

**Residual risk not closed by inspection:** a server clock that moves backwards (NTP step) between
two pulls could skip a row stamped below the cursor; and the two-terminal interleaving has never
been executed end to end (the case is harness-BLOCKED). **No product change is justified from
inspection alone**; the decisive experiment is the two-instance harness (reserve: SYN-27 moves to
PASS-SIM with a clock-skew injection, then RUN with the real gateway).

**Status:** **BLOCKED — harness** (two instances + clock skew + gateway). Exit path is the R3
harness; the cursor predicate already has unit coverage in `test_pull_guard_*` /
`test_sync_tiebreak`.
