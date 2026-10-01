# WebView SQL bypass — residual risk (Phase 4.5 WP6c — OPEN)

Status: **OPEN**. Closes at the data-plane gateway milestone (Phase 4.3
design): the WebView loses write access to trust tables and all writes go
through authorized native commands. Until then the controls below are
convention + audit-boundary scripts, NOT enforcement against a modified
WebView.

## Threat model (standing)

The WebView JS is UNTRUSTED for enforcement: modified/compromised JS talks
to SQLite directly through `tauri-plugin-sql` (`execute`/`select`; the
plugin pool holds a writable handle to the live `mobi_pos.db`). The
capability matrix, `authorize_and_execute`, and every native command gate
constrain IPC commands only — raw SQL does not pass through them.

## Exact exploit paths (all verified present, none hypothetical)

1. **Auth bypass via credential plant.** Attacker JS runs
   `UPDATE app_settings SET value_json='"v1$<known-salt>$<sha256(salt:KNOWNPIN:mobi_pos_salt_v1)>"'
   WHERE key='manager_pin'` (or inserts a `cashier_users` row with a known
   hash), then types `KNOWNPIN` at the lock screen. Native `pin_verify`
   reads the PLANTED hash through its own handle, verifies correctly, and
   unlocks. The native lockout/rotation gates all function — on attacker
   data. (Cost to attacker: one SQL write. No crypto broken.)
2. **Register forgery.** `INSERT INTO security_audit_logs …` plants rows
   with no chain links. They render in the register/audit UI as if audited
   (the chain walk ignores link-less rows; the next keyed append folds them
   in as a `LEGACY-BOUNDARY`, blessing their existence silently).
3. **Chain tamper (detected, not prevented).** `UPDATE/DELETE` on
   `audit_chain` / `security_audit_logs` breaks verification — caught at the
   next `audit_verify`, boot head-check (surfaced via
   `get_gate_state.audit_boot`), or export (refused unless the terminal is
   already TAMPER_SUSPECTED/CLOCK_RESET_REQUIRED). Detection is real;
   prevention is not.
4. **Hash theft for offline brute force.** `SELECT value_json FROM
   app_settings WHERE key IN ('manager_pin','cashier_users')` yields `v1$`
   hashes; 4-digit cashier PINs fall in milliseconds, 6-digit manager PINs
   in seconds-to-minutes on commodity hardware. (Why rotation re-secrets
   instead of re-hashing: killing exposed copies is the only mitigation
   short of the gateway + Argon2id.)
5. **Sync-lane forgery (Tier B).** `sync_outbox` / `entity_keys` writes from
   JS replicate to peers/the merchant Turso, which validates nothing and
   shares one token per merchant. Peer-side, the pull mirror lands audit
   rows INSERT-only (evidence freeze) — content can't be rewritten, but
   wholly-forged peer rows still land as peer evidence.

## What still holds (Tier A/B, stated precisely)

- Native verification LOGIC is sound: with unmodified credential rows, a
  wrong PIN never verifies (constant-time compare, policy floors, unknown
  formats fail closed).
- Tamper is DETECTED, loudly, at three checkpoints (explicit verify, boot
  head-check latch, export gate) — an attacker cannot tamper AND stay
  green across a verify/export cycle.
- The capability matrix + audit/chain/export/PIN boundaries hold against
  all UNMODIFIED app code (proven by the boundary gates:
  `check-boundaries`, `check-audit-boundary`, `check-pin-boundary`,
  `check-trust-registry`, all green). The residual is precisely the
  modified-WebView delta.
- Tier B stays native-only by policy until per-device sync credentials land
  (shared merchant token must not authorize peer writes).

## Gateway milestone that closes it (not started — scope ban respected)

Per `docs/phase-4.3-gateway-design.md`: interpose an authorizing SQL proxy —
WebView `execute` loses the trust tables (Tier A: audit log + chain,
credential keys, license/trust rows) entirely; Tier B tables
(`sync_outbox`, `entity_keys`) become gateway-written only after
per-device sync credentials exist. Reads split Tier A (native commands)
from operational reads. Until that milestone ships, treat every trust-table
guarantee as detection-backed, not prevention-backed, against WebView
attackers — and say so in every report (as this entry does).
