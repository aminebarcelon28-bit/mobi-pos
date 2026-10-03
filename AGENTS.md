# AGENTS.md — binding decisions for automated work on this repo

This file overrides any conflicting guidance elsewhere (notably the
SUPERSEDED `rules.md` §§S1–S5 and Appendix B, which describe a libSQL-replica
architecture with no implementation — the store is plain SQLite with
TypeScript outbox sync).

## Storage topology (authoritative)

- Local store is **plain SQLite** (`mobi_pos.db`, WAL): `rusqlite` native
  handles + `tauri-plugin-sql` (sqlx pool) from the WebView.
- Turso is a **remote sync transport only** (`@libsql/client` remote Hrana
  client in TypeScript). No `libsql` Rust crate, no embedded replica, no
  replica `sync()` semantics exist or may be assumed.

## Binding policy decisions (owner-set, do not re-litigate)

1. Missing manifest MAC = **warning, distinct state UNAUTHENTICATED**
   (hashes must still pass; recovery-only, never evidence; never shown as
   verified). Present-but-failing MAC = hard failure (tamper).
2. TAMPER_SUSPECTED / CLOCK_RESET_REQUIRED terminals **may run emergency
   export** with MAC-covered `integrity_state` (`tamper`/`clock`); read-only,
   no state change, no unlock. REVOKED stays denied.
3. Manifest unwritable = **fail the export** (typed error). No unverified
   output is produced.
4. Native export snapshot (`trust_core/export_snapshot.rs`) and native audit
   INSERT (`emergency_export.rs`) are **the model for locked-state reads**:
   dedicated native commands, never generic SQL.
5. Trust tables are **native-write-only** (audit log, license/trust files,
   PIN keys) — including when operational.

## Working rules

- Fail closed. Unknown states deny. No silent sequential fallbacks for
  money flows (checkout, refund, void).
- Report-first on architectural conflicts (STOP and report, do not
  improvise). Evidence is `file:line`, never speculation.

### Accessibility & locators (WCAG 2.5.3 Label in Name — binding)

- **Label-in-Name requirement:** never use `aria-label` to replace
  visible button/link/input text with a synonym or expansion (e.g. do
  NOT put `aria-label="Créer un bon de commande…"` on a button showing
  "Créer PO").
- **Prefix rule:** when dynamic context must be added to `aria-label`,
  the string must begin verbatim with the visible label:
  `aria-label="${visibleText} — ${context}"`. State-dependent visible
  text (ternaries like "Voir détails"/"Masquer lignes") requires a
  state-aware `aria-label` using the same ternary.
- **Glyph-only controls** (⌫, ‹, ›, ✕, bare digits): mark the glyph
  text node `aria-hidden="true"` and keep the descriptive
  `aria-label` — no visible label remains, so 2.5.3 no longer applies.
- **Prefer descriptions:** auxiliary state (supplier names, counts,
  statuses) may alternatively go into an `aria-describedby`
  `.sr-only` element instead of overloading the accessible name.
- **Locator testability:** every interactive component must be locatable
  via `getByRole('<role>', { name: /<visibleText>/i })`. When a fix
  changes an accessible name, update the dependent Playwright locators
  in the same change and run the suite.

## Tracked gates (Phase 4.4, owner-set)

- **Tier B residual (accepted):** `sync_outbox` / `entity_keys` stay
  gateway-writable ONLY after per-device sync credentials exist. The sync
  server (merchant Turso) validates nothing today and the token is shared
  per merchant — until device-bound credentials land, treat Tier B as
  native-only in any gateway design.
- **Per-device sync credentials:** required before Tier B unlocks. Shared
  merchant token must not authorize peer writes.
- **PIN keys:** device-local, native verify; Argon2id + per-user salt +
  keystore pepper; lockout; 6-digit manager minimum; migrate on login; old
  synced hashes treated as exposed. Per-device PINs (no provisioned
  shared PIN for now).
- **PIN migration + forced rotation (Phase 4.5, owner-set):** legacy fast
  hashes authenticate once, then rotation is mandatory before unlock
  (lock-screen gate; manager new minimum 6 digits, cashiers 4). No
  auto-submit at fixed length (would misfire on longer PINs). Lock-screen
  login verifies natively under Tauri (`pin_verify`: persisted escalating
  lockout, migration detection); a native verdict is final (no local
  fallback — that would bypass the native lockout). Local verification
  remains only outside Tauri (web preview/tests) and for manager-gate
  modals (interim). Argon2id backend pending `argon2` dependency
  approval — until then no new hashes are minted natively (rotation
  re-secrets with a fresh device-local `v1$`, killing exposed copies)
  and `zeroize` is likewise ungated (short-lived PIN Strings).
- **Ship gates still open:** data-plane gateway, signed-time endpoint,
  mobile on-device verification. Offline re-anchor codes are deferred and
  must share the export `integrity_state` (`tamper`/`clock`) vocabulary.
- **Offline suspension-key deletion (accepted residual):** deleting
  `SUSPENSION_KEY` (unsigned localStorage) skips the TS boot suspension
  gate while offline. Bounded by the next server contact (boot verify or
  ≤120 s heartbeat re-suspends, wipes the token, propagates revocation
  natively) and by token expiry. Inherent to offline-first; the native
  kernel never reads localStorage and is unaffected.
- **WebView SQL bypass (OPEN residual):** modified WebView JS holds a
  writable handle to the live DB (`tauri-plugin-sql`) outside IPC
  authorization — trust-table guarantees are detection-backed (chain
  verify, boot latch, export gate), not prevention-backed, until the
  data-plane gateway lands. Exact paths + Tier A/B holdings:
  `docs/webview-sql-residual.md`. Inherent to pre-gateway; the native
  kernel logic itself is unaffected.
