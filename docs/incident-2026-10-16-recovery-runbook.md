# Incident recovery runbook — 2026-10-16

Two independent one-time repairs for DBs touched by the 2026-10-16 incidents.
Both tools are desktop-only, fail closed, write a snapshot before any change,
and default to read-only inspection.

## Who needs what (decision tree)

| Symptom / history | Repair |
| --- | --- |
| A device ran a build containing commit `3653e523` (shipped 2026-10-16 ~14:47) and its sync pushed while remote reachable | **Part A** if the app's Sync Diagnostics shows quarantined (failed) `sale_batch_allocations` rows |
| A DB was **first migrated** between 2026-10-02 and 2026-10-16 (commit `03e46b7` window) | **Part B** |
| A DB was migrated **before** 2026-10-02 (e.g. the main dev DB) | Nothing — its checksum is canonical; just run the reverted build |
| Rows pushed under the buggy build but quarantined **below 10 strikes** | Nothing — they self-heal on the next sync of the fixed build |

Deploy the **fixed builds first**. Both repairs assume the build that will next
read the DB contains the fixes (reverted v1 body + corrected SBA push SQL).

---

## Part A — Requeue quarantined sale_batch_allocations outbox rows

Root cause: commit `3653e523`'s push statement for `sale_batch_allocations`
built 13 placeholders for 14 columns (`SQLITE_UNKNOWN: SQLite error: 13 values
for 14 columns`). Rows hit the 10-strike cap and were quarantined
(`status='failed'`). A second, earlier window (same day, before 14:47) had no
mapping at all: `Payload non sérialisable ou entité non reconnue`.
Payloads are complete and valid — only the local SQL construction was broken,
so replay is the repair. Remote upserts are version-guarded and idempotent
(`ON CONFLICT(id) ... WHERE` guard), so replay cannot clobber newer cloud rows.

Procedure (per device):

1. Close the app.
2. Inspect (read-only):
   `node scripts/requeue_quarantined_sba_outbox.mjs`
   - lists candidates, validates each payload (id/sale_id/batch_id), and
     reports unrelated quarantined rows (untouched).
3. Apply (writes a `mobi_pos.db.pre-requeue-<ts>.db` snapshot next to the DB):
   `node scripts/requeue_quarantined_sba_outbox.mjs --apply`
4. Start the fixed app and let sync drain (pending → inflight → synced/delete).
5. Verify: re-run step 2 — candidates must be 0.

Built-in alternative (requeues **all** quarantined rows, including unrelated
GUARD-STALE test stubs): Sync Diagnostics → retry, or "Synchronisation
complète". Prefer the targeted script when the only failures are SBA rows.

---

## Part B — Restore migration v1 checksum (DBs migrated 2026-10-02 → 2026-10-16)

Root cause: commit `03e46b7` appended a duplicate no-op
`CREATE TABLE IF NOT EXISTS app_settings (..., version ...)` line inside the
**already-published** migration v1 body. sqlx records sha384 of each body at
first migration; DBs first migrated in that window recorded the modified hash
and fail boot ("migration 1 was previously applied but has been modified")
against the reverted build.

Why a checksum fix is complete (no DB reset, no data loss):

- The duplicate line ran **after** the original `app_settings` CREATE, so
  `IF NOT EXISTS` made it a no-op — schema and data are identical to a
  canonical v1 migration.
- The plugin migrator runs migrations transactionally — no partial states.
- Only the `_sqlx_migrations` v1 row differs; every other migration version
  is byte-identical.

Oracles (sha384, oracle-verified against live DBs):

- canonical: `5693a5e9020d6b2da139d41587adec2893308833c590088c4f01def14131c83f3ce87813b6b4393400da93dd5b879b39`
- modified (bad): `2c74ba5c5a59893695801bb3d38c4d73a34137476ccfa17745a5adf16de424cb4fcab129aaa7450cabf4ec68c9aa34c8`

Procedure (per device):

1. Close the app.
2. Inspect (read-only):
   `node scripts/repair_migration_v1_checksum.mjs`
   - `CANONICAL` → nothing to do; `MODIFIED` → repair; `UNKNOWN` → stop and
     review manually (script refuses).
3. Apply (writes a `mobi_pos.db.pre-v1-checksum-repair-<ts>.db` snapshot):
   `node scripts/repair_migration_v1_checksum.mjs --apply`
4. Start the fixed app — boot proceeds; migrations after v1 continue normally.

Manual equivalent (auditors), with the app closed and a file copy taken first:

```sql
UPDATE _sqlx_migrations
SET checksum = X'5693a5e9020d6b2da139d41587adec2893308833c590088c4f01def14131c83f3ce87813b6b4393400da93dd5b879b39'
WHERE version = 1
  AND lower(hex(checksum)) = '2c74ba5c5a59893695801bb3d38c4d73a34137476ccfa17745a5adf16de424cb4fcab129aaa7450cabf4ec68c9aa34c8';
```

### Rollback

Both snapshots are plain SQLite files. To roll back: close the app, delete
`mobi_pos.db` / `mobi_pos.db-wal` / `mobi_pos.db-shm`, copy the snapshot back
over `mobi_pos.db`, reopen.

---

## Evidence snapshot (2026-10-16, this machine)

| DB | v1 checksum recorded | outbox |
| --- | --- | --- |
| `%APPDATA%\com.mobi.pos\mobi_pos.db` | canonical (5693…) | 7 rows quarantined `13 values for 14 columns` + 1 unmapped-SBA row + unrelated GUARD-STALE stubs |
| `%APPDATA%\com.mobi.pos.backup_20261001_035407\mobi_pos.db` | canonical (5693…) | — |
| `%APPDATA%\com.mobi.pos.e2e\mobi_pos.db` | modified (2c74…) → **repair candidate** | — |
| working-tree `lib.rs` v1 body | canonical (5693…) = `03e46b7~1` bytes | — |

## Prevention shipped with the fixes

- `npm run test:migration-v1-pin` — pins the v1 body sha384 in `test:all`; any
  future in-place edit of a published migration fails CI-style before shipping.
- `npm run typecheck` is now the first gate of `test:all`.
- `lib.rs` already carries `.gitattributes: text eol=lf` — keep it: CRLF
  checkout would change every migration checksum (comment in `.gitattributes`).
