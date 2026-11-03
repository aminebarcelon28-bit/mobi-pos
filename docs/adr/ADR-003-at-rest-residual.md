# ADR-003 — Data at rest on the terminal (SYN-26)

- **Status:** accepted residual (deployment requirement), no code change
- **Date:** 2026-11-03
- **Case:** SYN-26

## Context

A stolen or decommissioned terminal exposes `mobi_pos.db` (plain SQLite, WAL) to anyone with disk
access. The UI PIN gate is an application control; it does not encrypt files. The database is the
fiscal source of truth and must remain openable offline, after a crash, and by support staff with
a recovery path.

## Decision

1. **Accept the at-rest exposure of the working DB as a documented residual**, bounded by
   **full-disk encryption as a deployment requirement** (BitLocker/Device Encryption on Windows,
   FileVault on macOS, LUKS on Linux; Android/iOS file-based encryption on mobile). The install
   runbook must state it; the threat model is "device loss", not "hosted multi-tenant server".
2. **Do not ship database-level encryption (SQLCipher-class) now.**
   - Key loss for a small merchant is a fiscal-data loss: no recovery path means the till cannot
     open and the audit trail is gone. A safe design needs a key-escrow/recovery flow (manager
     recovery code, printed escrow, or merchant KMS) before encryption can be the default.
   - Performance on low-end PCs (AES per page) and licence/maintenance of the SQLCipher build were
     not measured; both would need evidence before a default-on change.
   - SQLite tooling used by support (DB inspection, WAL recovery) would need an encrypted-aware
     path.
3. **What is already protected:** exported snapshots/backups are encrypted with a device key
   (`snapshot_crypto`, key in the OS keyring); trust tables are native-write-only; PIN hashes are
   device-local Argon2id envelopes, never plaintext.
4. **Field-level encryption for PII is not adopted** while the whole DB is the fiscal record; it
   would break reporting without reducing the loss surface meaningfully.

## Residual / exit path

- The residual is closed by (a) the deployment requirement above, plus (b) a future encrypted-DB
  project with: migration of existing plaintext DBs, key backup/recovery flow, rollback path, and a
  measured performance delta on low-end hardware. Until then SYN-26 stays **ACCEPTED RESIDUAL**.
- Re-open only if a merchant contract or regulation requires encryption at rest per terminal.

## Rejected alternatives

- **SQLCipher default-on now:** key-loss risk without an escrow flow; no measured perf evidence.
- **Encrypt only PII columns:** the fiscal rows (items, totals, customer identity on credit sales)
  are the sensitive data; partial encryption gives little.
- **Rely on the PIN gate:** it protects the UI, not the file; a disk image bypasses it.
