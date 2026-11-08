# Ops — MobiPOS licensing infrastructure

One command per operation. Companion to `docs/break-glass.md` (what to do
when the owner is unreachable); this file is the normal-operations record.
Never paste secret values here — names and commands only.

## Deploy

| Thing | Command |
|---|---|
| Worker | `cd workers/licensing && npx wrangler deploy` |
| Worker secrets | `npx wrangler secret put <NAME>` — see list below; never in `wrangler.toml` |
| Schema | `turso db shell "$TURSO_DB" < workers/licensing/schema_v2.sql` (idempotent, safe to re-run) |
| Site | `git push` → Cloudflare Pages builds |
| App | `scripts/release.js` + GitHub Actions `release.yml` |
| Console | `build_licensing.ps1` → `licensing_dist/` |

**Deploy ordering (binding):** apply `schema_v2.sql` to the master Turso DB
BEFORE deploying a worker that references new tables. The new rate limiter
reads `rate_limits`; if the table is missing the gates fail open (logged as
`rate_limit_degraded`) until the table exists.

## Secrets (Worker)

| Name | Purpose |
|---|---|
| `ADMIN_TOKEN` | dedicated admin bearer for all `/api/v1/admin/*` routes; when set, `MASTER_ENCRYPTION_KEY` is no longer accepted for admin |
| `MASTER_ENCRYPTION_KEY` | legacy admin bearer fallback + AES master key; rotate away from admin use once `ADMIN_TOKEN` is set |
| `LICENSE_ED25519_PRIVATE_JWK_K2` | current signing key (`kid: k2`) |
| `LICENSE_ED25519_PRIVATE_JWK` | legacy signing key (`kid: k1`); sunset — do not sign with it |
| `LICENSE_PEPPER` / `LICENSE_PEPPER_PREVIOUS` | key-hash peppers; rotation is lazy dual-pepper (`licenseLookup.ts`), remove `*_PREVIOUS` only after zero re-hash traffic |
| `IP_PEPPER` | peppers IP hashes used in rate-limit identities and logs |
| `MASTER_TURSO_URL` / `MASTER_TURSO_TOKEN` | master DB access |
| `TELEGRAM_TOKEN` / `TELEGRAM_CHAT_ID` | owner doorbell notifications |
| `RESEND_API_KEY` | email outbox (when email lands) |

## Health

```bash
curl -s "$WORKER/health" | jq .
```

`/health` (also `/`) reports worker + DB reachability. Check it from outside
your network after every deploy. A failing `/health` should page you — wire
an external monitor (UptimeRobot or a cron) to the Telegram doorbell.

## Rate limits (in `workers/licensing/src/rateLimit.ts`)

Fixed 1-hour windows in the master DB (`rate_limits` table), per-IP and
per-key identities (peppered hashes, never raw). Buckets:
`activate_ip 20`, `activate_key 30`, `verify_ip 300`, `verify_key 240`,
`deactivate_ip 20`, `deactivate_key 30`, `trial_ip 5`, `admin_ip 30`.

**Fail-open on infra outage is deliberate:** a Turso hiccup must not lock a
merchant out of their till. Sustained outages are caught by `/health`
monitoring; look for the `rate_limit_degraded` log marker.

## Backups and restore

Turso supports point-in-time restore and manual dumps:

```bash
turso db dump "$TURSO_DB" -o backup-$(date +%F).sql   # verify flag names against `turso db dump --help`
```

Keep the ledger (`licenses_ledger.json`) backed up with the repo owner's
files; it is the local mirror of issued keys. Restore drill: restore into a
scratch DB, point `MASTER_TURSO_URL` at it in a dev shell, run
`npm run test:license` — the drill must be done once before launch and the
result recorded as an `E-####` entry.

## Release gates (floors, not suggestions)

Before any release tag, on a clean worktree of the tagged commit:
`test:license`, `test:licensing-worker`, `tsc --noEmit` (app + worker),
`cargo test --lib`, harness selftest, case reconcile, guard scripts, plus the
suites the change touched. A red floor is a stop, not a note.
