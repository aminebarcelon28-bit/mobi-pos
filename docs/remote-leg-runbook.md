# Remote-leg runbook — 1b-i Turso cutover (both owner-answer branches)

## Branch A — owner delivers `tax != 0` count = 0 (cloud in use)

Precondition: `SELECT COUNT(*) FROM transactions WHERE tax != 0;` on the
merchant Turso returns 0 (via `turso db shell <name>` or E3 with
`TURSO_URL`/`TURSO_TOKEN`). Any non-zero → HALT for owner decision
(real values) or document-and-zero (float dust |tax| ≤ 1e-9).

Cutover (PD-20/PD-21), same maintenance window, in this order:

1. **Remote first.** Apply remote schema v13 (`DROP COLUMN tax` on
   `transactions` in `turso/remote-schema.sql` + `remoteSchema.ts`
   `LATEST_REMOTE_VERSION = 13`). Single DDL statement = atomic server-side.
   Verify: `SELECT sql FROM sqlite_master WHERE name='transactions'` shows
   no `tax`; row count matches pre-cutover.
2. **Version gate live.** New builds carry `MIN_SUPPORTED_REMOTE_VERSION = 13`
   + `KNOWN_MAX = 13`, checked after `checkRemoteSchemaStatus`, BEFORE any
   `cursorQueries`/`toRemoteUpsert`. Old builds facing v13 fail LOUD, not
   silent: pull side stalls per-table with `pull query failed [transactions]`
   (cursor not advanced, retried); push side quarantines after 10 retries
   (never marked `synced`, no silent loss) — both verified behaviors, both
   resolved by upgrading the device.
3. **Upgrade every device in the same session.** The fleet never sits split
   across versions longer than one maintenance window. Confirm per device:
   app boots, pull completes with zero warnings, one test sale syncs.
4. **Re-run E3 against Turso post-cutover** (column gone → expect the
   query to report "tax column ABSENT", which is the desired end-state).

## Branch B — owner declares "no production remote in use"

1. The remote v13 migration **ships unexercised** (DDL + version bump land
   in code, never applied to a production remote).
2. Record in the residual-risk memo, verbatim: "Remote Turso leg of 1b-i
   never executed against a production database (owner declaration
   <date>). First cloud onboarding MUST run the E3 count + v13 cutover
   above before any device syncs."
3. Local leg proceeds unchanged (device counts already 0; rehearsal 22/22;
   abort drill 39/39 on the live copy).

## Access notes

- `turso db list` finds the DB name; `turso db shell <name> "<sql>"` runs
  read-only checks. E3 never prints tokens (reports only set/unset).
- PF-1 atomicity holds for the remote leg the same way: single-statement
  DDL is atomic; the multi-statement fallback (if ever needed remotely)
  runs inside one transaction or not at all.
