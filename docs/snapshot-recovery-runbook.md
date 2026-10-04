# Snapshot recovery drill + runbook

Snapshots are write-only from app code (the file-restore wrappers were
deleted in FT-06; no IPC restores a snapshot into place). Recovery is a
**manual file operation**. This runbook makes it exact, including the
WAL/SHM trap.

## Layout (verified)

- Dir: OS-local `backups/` next to the app data dir (`%LOCALAPPDATA%` on
  Windows — NOT Roaming; see `snapshot-storage-posture.md`). Pre-Phase-3
  files may still sit under the old `<roaming>/backups` — orphaned, never
  auto-migrated, managed by nothing; prefer a fresh snapshot unless you
  specifically need an old one.
- Names: `{kind}_mobi_pos_backup_{ms}_{rand8}.db`, kinds `wipe` /
  `restore` / `migration` / `manual`. O_EXCL reservation means a name can
  never collide or overwrite.
- New (backup-API) snapshots are **self-contained single files**: no
  `-wal`/`-journal` sidecars are written for them. Old raw-copy snapshots
  may still have `-wal` companions; `-shm` is never copied (it is a
  process-local index — restoring it replays stale pages).

## Recovery runbook (operator)

1. **Stop the app on the terminal** (close all windows; on mobile,
   force-stop). A live writer during the swap is the failure mode.
2. **Quarantine the live state:** copy `mobi_pos.db` (+ `-wal` if present)
   to a dated folder OUTSIDE `backups/`. Never skip this — a bad swap
   without a way back is data loss.
3. **Decrypt the snapshot to a working copy** (Phase 4d — snapshots rest
   sealed): invoke `decrypt_snapshot_for_recovery` with the `snapshotId`
   and a fresh manager PIN (verified natively; wrong PINs burn the ladder).
   This produces `{id}.recovery.db` next to the sealed original (reserved
   exclusively — refuses when present) and writes the kernel audit row
   `Décryptage Snapshot Secours`. Use the working copy for every step
   below — never touch the sealed original.
4. **Verify the working copy BEFORE swapping** (read-only — never open it
   read-write):
   - `PRAGMA integrity_check;` must return exactly one row `ok` (the
     decrypt command already verified this before reporting success —
     re-check here as the operator's own eyes).
   - Row counts: `SELECT COUNT(*) FROM transactions;`,
     `SELECT COUNT(*) FROM security_audit_logs;`,
     `SELECT COUNT(*) FROM audit_chain;` — compare against the audit row
     that references this snapshot (`DATA_WIPE_BEFORE.details.snapshotId`,
     plus `snapshotBytes`).
   - The sealed file's `sha256` (receipt/row) matches a fresh hash of the
     sealed bytes; the working copy's content matches the drill record.
4. **Remove the live `-wal` AND `-shm` next to `mobi_pos.db`.** A stale
   `-shm` makes SQLite trust a dead page index; a stale `-wal` replays
   frames from the pre-swap database onto the restored file. Delete both;
   keep the quarantined copies from step 2.
5. **Copy the WORKING COPY over `mobi_pos.db`** (copy, never move — keep
   both the sealed snapshot and the working copy intact until step 6
   passes). Delete the working copy only after the drill record is filed.
6. **Boot the app.** Expect: journal opens after the manager gate, FT-03
   integrity banner runs `audit_verify` — pre-existing rows verify under
   their old links (the `source` column never enters the chain hash);
   counts match step 3.
7. **Housekeeping:** `backups/` must contain no stray `-wal`/`-shm` files
   (new snapshots never create them; delete any left by old copies).
   Confirm the audit trail shows the recovery: the pre-existing
   `DATA_WIPE_BEFORE` / import rows plus fresh boot rows.

## Drill (proves snapshots work end to end)

On a TEST terminal with a manager PIN known to the operator:

1. Record counts: transactions, `security_audit_logs`, `audit_chain`
   (via the Diagnostics SQL or a scratch `sqlite3` read-only open).
2. Run a guarded wipe (`requestDataWipe` — fresh PIN, checkpoint,
   snapshot, `DATA_WIPE_BEFORE`, clear). Copy the `snapshotId` from the
   receipt.
3. Confirm the wipe: business tables empty, journal intact (pre-wipe row
   present), banner state sane.
4. Follow steps 1–7 above using that `snapshotId`. Expected: counts from
   step 1 restored exactly; `audit_verify` intact; no stray `-wal`/`-shm`
   in `backups/`.
5. Record the drill (date, terminal, snapshot id, counts before/after,
   verify state) — a drill without a record did not happen.

## Why there is no "Restore" button

File-restore needs pool quiesce (drain queries, close pool, swap, re-open,
`integrity_check`, resume) plus PIN + audit + schema validation. That is
deferred until a real restore feature exists (FT-06 removed the wrappers
rather than ship a half-guarded one). Until then, this runbook IS the
restore path.
