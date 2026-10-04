# Snapshot storage posture (recorded decision)

**Status:** Phase 4d IMPLEMENTED (2026-10-02) — snapshots are sealed at
rest (ChaCha20-Poly1305, per-device key). This file records the decision
and the facts behind it.

## Facts (verified in code)

- Snapshots live in `<app_data>/backups/` as
  `{kind}_mobi_pos_backup_{ms}_{rand8}.db` (`src-tauri/src/lib.rs`,
  `backup_db_file`). Kinds: `wipe` / `restore` / `migration` / `manual`.
- Each file is a **full copy of `mobi_pos.db`**: every table, including
  `app_settings` (`manager_pin`, `cashier_users` hashes), customer data,
  and the audit trail. A snapshot is as sensitive as the live DB.
- Permissions: `0600` on Unix (owner-only, enforced in code). On Windows
  the file inherits the per-user app-data ACL (profile-private by default);
  nothing here changes that.
- **Sealed at rest (Phase 4d).** After integrity verification, every new
  snapshot is sealed with ChaCha20-Poly1305 under a per-device 256-bit data
  key (`src-tauri/src/snapshot_crypto.rs`): `MPB1` magic + 12-byte random
  nonce + ciphertext. Filenames and the `.db` extension are UNCHANGED, so
  prune, list, and audit `snapshotId` references keep working — sealed vs
  legacy plaintext is told by magic, never by name. The reported SHA-256
  covers the stored (ciphertext) bytes. The live `mobi_pos.db` itself stays
  unencrypted (separate item).
- Key custody: OS keychain (`mobi-pos-backup`/`data-key`, desktop) or the
  device vault file (mobile — same accepted weakness as the trust file
  vault). Provisioned loudly on first use; later absence fails closed (no
  silent plaintext fallback). **Key loss = data loss: no escrow, no
  backdoor.** Legacy plaintext snapshots are sealed in place by the boot
  janitor (one-way migration; failures logged, boot never blocked).
- Manual recovery: `decrypt_snapshot_for_recovery` (manager PIN verified
  inside natively + kernel audit row `Décryptage Snapshot Secours`)
  produces a verified plaintext working copy; the sealed original is never
  modified.
- **Location roams on Windows.** Tauri's `app_data_dir` resolves under
  `%APPDATA%` (Roaming): with roaming profiles, folder redirection, or
  OneDrive Known-Folder-Move, snapshot files (and the live DB) can leave
  the terminal to servers. Linux (`~/.local/share`) and macOS
  (`~/Library/Application Support`) are local; Android internal storage is
  local; iOS containers are iCloud-backup eligible unless excluded (no
  exclusion is set — unverified either way, treat as eligible).
- **Phase 3 follow-up: snapshots moved out of Roaming.** `backups_dir()`
  (`src-tauri/src/lib.rs`) now resolves the OS-LOCAL sandbox
  (`app_local_data_dir`: `%LOCALAPPDATA%` on Windows, `~/.local/share` on
  Linux, `~/Library/Application Support` on macOS, app-private storage on
  mobile), falling back to the roaming dir only where the platform exposes
  no local variant. All writers/readers (backup, list, prune, janitor) go
  through it. Pre-existing files under the old `<roaming>/backups` are left
  alone — never auto-migrated — and the janitor/prune do not manage them.
  The live `mobi_pos.db` itself stays where it is (relocating it is out of
  scope; encryption covers it in Phase 4).

## Decision

Phase 4d implemented as designed (file-level AEAD; machine-random device
key, so no password stretching is involved): seal-on-create,
seal-on-boot-migration, PIN-gated decrypt for manual recovery, magic-based
format detection with stable filenames. Explicitly NOT claimed:
disk-forensics resistance (atomic rename leaves stale blocks) or live-DB
encryption (still plaintext — separate item). The old "accept plaintext for
now" decision is superseded by this file.

Legacy path note: historical pre-relocation snapshots remain in the legacy
Roaming `backups/` path for manual recovery if ever required — they are
never auto-migrated, and the janitor/prune do not manage them.

## What would change the decision

- Evidence of snapshots leaving the device (roaming sync logs, MDM reports).
- A customer or regulator requiring encryption at rest.
- Theft/loss of a terminal with an intact disk (unencrypted DB AND
  snapshots are readable — this is already true of the live DB today).
