# Phase 4.3 — Data-Plane Gateway: Revised Design + Baseline

**Status: DRAFT FOR OWNER REVIEW. No implementation. No capability/plugin changes.**
Companion: Phase 4.1 audit report (chat, same session). Binding decisions: `AGENTS.md`.
`rules.md` §§S1–S5/Appendix B are superseded (annotated in-file); `AGENTS.md` is normative.

## 0. What changed since the 4.1 draft

- Tranche order reversed: generic native gateway FIRST, named money commands LATER (cheaper, closes the hole in one cut).
- `checkout_commit`-as-Rust-port dropped: the report's "run today's sequence natively" read as porting ~1100 lines of FIFO/audit logic to Rust — the riskier path. Named commands become an optional later tranche for flows wanting more than table-level protection.
- Trust tables split into Tier A (native-only) / Tier B (gateway + server-validated) — **contingent**: the sync server validates nothing (A4), so Tier B as specified is unsound until validation exists (options in §5).

## Part A — audit answers (read-only, file:line)

### A1. Suspension / clock-key deletion
- Boot order is suspension → token → signature → clock guard (`client.ts:297-362`).
  `SUSPENSION_KEY` is unsigned localStorage (`store.ts:160-191`): deleting it
  skips the boot gate. It helps only while offline: reachable boots re-verify
  online (`client.ts:379`) and the 120 s heartbeat re-suspends, wipes the
  token + cloud creds, and propagates natively (`:515-543`, incl.
  `trustReportRevocation`). The native kernel never reads localStorage — it
  re-derives state from token verification at boot (`trustSyncLicense`,
  `:446`) — so deletion moves only the TS gate, never the kernel.
- `CLOCK_GUARD_KEY` deletion (`store.ts:125-143`, zeros on absent) re-baselines
  the TS guard (rollback blindness until a new high-water mark). The native
  time engine keeps its own MAC'd anchor — unaffected.
- **Answer:** deletion lifts the TS suspension gate while offline; the kernel
  and the next online contact (boot or ≤120 s heartbeat) re-assert it.

### A2. PIN hashes — fast hash, brute-forceable, replicating
- `hashPin` = **single SHA-256**(`salt:pin:mobi_pos_salt_v1`) (`security.ts:125-131`);
  the file header claims "PBKDF2" (`:3`) — the header is wrong, there are no
  iterations and no KDF. Salt: 16 alnum chars, per-credential, stored alongside
  (`v1$salt$digest`, `:105-120,:146-157`). The "pepper" is a public constant,
  not a secret. Constant-time compare on verify (`:100-103`) is the one
  sound piece.
- Policy in code: length ≥ 4 (`createUISlice.ts:263,940`); no max, no charset
  enforcement at hash/verify time. At 4–6 numeric digits the space is
  10⁴–10⁶ — **milliseconds offline** with one SHA-256 round each.
- Replication: `manager_pin`/`cashier_users` sync peer-to-peer and to cloud
  through the generic `app_settings` lane (`genericApply.ts:41,497-534`,
  version-guarded upsert). `DEVICE_LOCAL_SETTING_KEYS` is intentionally empty
  ("now sync", `sqlPluginAdapter.ts:2779-2787`). Also present in backups,
  Dexie mirror, and any DB copy. NOT in emergency exports (sales/shift tables
  only). Lockout is localStorage client-side (`security.ts:161-179`) —
  deletable, not a boundary.
- **Answer:** salted fast hash over a tiny PIN space, replicating everywhere
  the DB goes. Offline brute force is trivial; treat these hashes as
  delay-only, not secret.

### A3. security_audit_logs writers from JS
Single funnel `logSecurityAction` → `saveAuditLog` upsert (`createUISlice.ts:292-342),
~30 fire-and-forget call sites (cart, catalog, orders, customers, shifts,
procurement, lock screen, scanner, modals), failures swallowed by design
(`:335-340`: throwing would invert the meaning of committed money ops).
Plus pull-side `INSERT` (`genericApply.ts:480`) and the native export audit
INSERT (`emergency_export.rs`). No gate, no PIN, no capability on any JS path.

### A4. Server push validation — there is none
The sync "server" is the merchant's Turso database: a plain SQLite store
with no triggers, no RLS, no validators. The relay worker is signaling-only
(`workers/relay/src/index.ts`: device registry + epochs; bearer check only
on admin device routes, `:345-348`). The licensing worker signs license
tokens, never data. All push/pull validation is peer-client-side
(`applyRemoteRow` version guards, idempotency, hygiene). Auth material is a
**shared per-merchant Turso token**, so any holder can write any table.
**Consequence:** Tier B (gateway + server-validated) is unsound as specified —
see §5 options.

### A5. Native-port sizing (outbox/version/entity_keys inside money flows)
- `writeCheckoutAtomicInner` (`sqlPluginAdapter.ts:757-1847`, ~1090 lines):
  outbox/version/clock logic ≈ version read+1 (`:835-842`), ~8 outbox
  INSERTs (`:1109-1684` region), `entity_keys` via `enqueueGenericSync`
  (`:2814+`, clock helpers `:2728-2760`) — ≈120 lines of trust-write code
  embedded in ~700 lines of FIFO/audit/math. A port must still READ all the
  FIFO context (or duplicate it) — this is the expensive design.
- Void (`transactionAdapter.ts:100-244`) and refund (`:300-420`ish): one
  status/version bump + IMEI null-outs + outbox rows each (~30 trust-write
  lines per flow, inside small functions).
- Backfill/repair paths add 2 more outbox writers (`backfill.ts:126,162`).
- 32 `INSERT INTO sync_outbox` sites in `sqlPluginAdapter.ts`, 0 in
  `transactionAdapter.ts` (void/refund reuse the shared helpers), 2 in
  `backfill.ts`. Version `+1` reads-then-writes are scattered per adapter
  (customers :77-88, debts :239-250, vouchers :204/:340, app_settings :226-234).

## Part B — revised design (propose only)

### B1. Tranche order (reversed)
- **Tranche 1 — generic native gateway + TS adapter migration, ending with
  plugin removal.** New native surface: `db_select` (engine-level read-only
  check + authorizer; rejects BEGIN/COMMIT/ROLLBACK/SAVEPOINT/PRAGMA/ATTACH/
  DDL), `db_execute` with a table×statement-class policy, native transaction
  handles (id bound to window+capability, idle timeout ~5 s, auto-rollback on
  timeout/drop/owner-exit, one statement per call, multi-statement rejected).
  Migrate the TS adapter call-by-call, then delete `sql:allow-execute`, then
  `allow-select`/`allow-load`/`allow-close`, then the `sql` plugin
  registration — on desktop AND mobile. Exit: bypass checklist green with
  zero `sql:*` in capabilities.
- **Tranche 2 (optional, later):** named money commands (`checkout_commit`
  etc.) only where table-level protection is insufficient.
- This matches the handles-are-smaller advice and avoids porting FIFO logic
  to Rust.

### B2. Protected-tables matrix (two tiers, contingent)
- **Tier A — native-only, always** (no contingency): `security_audit_logs`,
  license/trust files + keystore entries, PIN keys (`manager_pin`,
  `cashier_users` after §B3), trust snapshot. Native writes allowed
  operational or locked; WebView writes blocked unconditionally.
- **Tier B — gateway-writable ONLY IF server-validated**
  (`sync_outbox`, `entity_keys`, version clocks): requires per-device auth +
  server-side schema/ownership/version checks that DO NOT EXIST (A4).
  Until they do, Tier B tables stay native-only too (the expensive design),
  or the owner accepts peer-client validation as the check with the stated
  residual (a malicious peer holding the shared merchant token can forge rows
  honest peers will apply). If server validation is built (new scope), Tier B
  unlocks and most checkout native-hook cost disappears.

### B3. PIN keys — removal from generic sync + migration
- Take `manager_pin`/`cashier_users` out of the generic `app_settings` sync
  lane (restore `DEVICE_LOCAL_SETTING_KEYS`, `sqlPluginAdapter.ts:2779`).
- Expose them only through dedicated native commands (read for auth gates,
  write for rotation), native-write-only per AGENTS.md.
- Multi-terminal shops: sync PINs through an authorized path only, and
  upgrade the KDF (memory-hard: Argon2id/bcrypt/scrypt — never another fast
  hash round) with a versioned envelope (`v2$…`, migrate-on-verify like the
  current `v1$` path). Product decision required (affects shared-PIN shops).
- Migration for existing synced values: on upgrade, keep local rows, stop
  emitting them, tombstone/expire peer copies at next sync; rotate shop PINs
  once (old fast hashes must be assumed exposed wherever the DB replicated).

### B4. Interim hardening spec (PROPOSE ONLY — not implemented here)
Cheapest stopgaps inside the already-patched plugin + handler, explicitly
NOT security boundaries:
1. Confine `load` to exactly `mobi_pos.db`: reject absolute paths (defeats
   `PathBuf::push` replacement), `..` segments, and any other name
   (`wrapper.rs:321-334`).
2. Bind integers as i64; make unrepresentable values an error, never silent
   `0` (`wrapper.rs:162-163,229-230` and mysql/postgres twins).
3. Reject obviously non-read statements in `select` (write/DDL/BEGIN-class;
   full `sqlite3_stmt_readonly` parity as follow-up).
4. Remove `swap_staging_database` + `restore_database_backup` from the
   handler: zero in-app callers, no staging producer, no PIN, no audit —
   pure attack surface. Restoring them later requires PIN + audit + schema
   validation. This also defers the quiesce work (§B5) until a real restore
   feature exists.

### B5. Swap/restore quiescing (deferred section)
When a restore feature returns: drain in-flight queries → close pool →
file swap → re-open + `integrity_check` → resume; block new queries during
the window; audit row + (per current policy) no PIN. Separate problem from
the native-writer close/reopen: rusqlite handles re-open by path and converge;
the sqlx pool holds old-inode handles (POSIX split-brain; Windows share race).

## Part C — baseline harness design (propose only, no code run)

- Harness: test-only Node script driving `writeCheckoutAtomic` with fixture
  carts (1/10/50 lines) against a scratch DB, warming up, then reporting
  p50/p95 of full round-trip latency over ≥200 samples; exclude first-run
  migration noise; pin CPU-idle conditions in the procedure.
- No production hooks exist for this today; required hooks (list, not
  implement): none if run in-process via tsx against `sqlPluginAdapter`
  directly (test-only import, no prod change); if isolation is required,
  a `BENCH_` env-gated timer inside `withBusyRetry` — also not implemented
  here.
- Proposed cap (for approval after numbers): **no regression vs measured
  baseline p95**; single-call checkout is expected to beat it (N−1 fewer IPC
  round trips), but the cap is set from data, not hope.

## Standing notes
- Offline re-anchor codes (deferred) must share the `integrity_state`
  (`tamper`/`clock`) vocabulary with the export flag so verifiers treat both
  paths identically — flagged, recovery-only.
- Gates held: data-plane phase · signed-time endpoint · mobile on-device
  verification · stale `rules.md`/missing `AGENTS.md` (closed this phase by
  annotation + `AGENTS.md` creation).
