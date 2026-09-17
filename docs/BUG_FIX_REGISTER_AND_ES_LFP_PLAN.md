# Mobi POS — Bug Fix Register & ES-LFP Dual-Run Plan

**Document version:** 1.0  
**Date:** 17 September 2026  
**Scope:** Complete register of bugs identified in the v1.6.8 audit, their fix status, and the detailed plan for the Event-Sourcing + Log-Functional Persistence (ES-LFP) dual-run migration targeting v1.9.0.  
**Companion documents:**  
- `MobiPOS_Overhaul_Audit_Report.pdf` — full architectural audit  
- `patches/` — applied patch kit for v1.7.0  
- `docs/adr/0008-server-authoritative-sync.md` — ES-LFP target architecture  

---

## Part I — Bug Fix Register

### Severity legend

| Severity | Definition | SLA |
|---|---|---|
| **Critical** | Blocks sales, causes data loss, or exposes credentials | Fix in current release |
| **High** | Causes silent data divergence or requires app restart to recover | Fix in current release |
| **Medium** | Degrades UX or has exploitable-but-narrow security impact | Fix in next release |
| **Low** | Cosmetic, dev-experience, or deferred architectural item | Backlog |

### Status legend

| Status | Meaning |
|---|---|
| **Fixed v1.7.0** | Patch delivered in `/download/patches/`, unit-tested, ready to ship |
| **Planned v1.8.0** | Documented; remediation scoped for next release |
| **Planned v1.9.0** | Documented; remediation scoped for ES-LFP dual-run release |
| **Backlog** | Documented; no committed release |

---

### F-01 — Mobile dialer/WhatsApp redirect fails on Android WebView

| Field | Value |
|---|---|
| Severity | Critical |
| Status | **Fixed v1.7.0** |
| Category | Mobile UX |
| Affected files | `src/components/mobile/tabs/KredyTab.tsx`, `src/components/modals/WhatsAppDispatchModal.tsx`, `src/components/modals/DebtLedgerModal.tsx`, `src/components/modals/CustomersModal.tsx`, `src/components/modals/PurchaseOrderModal.tsx` |

**Symptom.** Tapping *Appeler* or *WhatsApp* on the mobile companion app produces no visible effect — no dialer, no WhatsApp, no error toast. The buttons render and play the click sound, but the native app never opens. 100% reproducible on every Android device tested. The same code paths work on the desktop shell and in browser dev mode.

**Root cause.** Three independent causes operating in combination:

1. **WebView URL interception.** The code uses `<a href={telUrl}>`, `<a target="_blank" href={waUrl}>`, and `window.open(url, '_blank')`. Tauri 2's auto-generated `RustWebViewClient.shouldOverrideUrlLoading` routes these through the Rust IPC layer, which has no handler for `tel:` or `wa.me` and returns `false`, causing the WebView to attempt loading the URL itself. The WebView cannot load `tel:` as a web page, so the navigation is silently dropped. `target="_blank"` is even worse — Tauri 2 mobile WebView has no concept of a new window, so the request is dropped before `shouldOverrideUrlLoading` is even consulted.

2. **Android 11+ package visibility.** The AndroidManifest had no `<queries>` block. Without it, `PackageManager.resolveActivity()` returns `null` for the WhatsApp package on Android 11+ (API 30+), so even when the opener plugin fires the right intent, Android cannot find an app to handle it.

3. **CSP navigate-src missing.** The Tauri CSP had no `navigate-src` directive, so the WebView fell back to `default-src 'self'` for top-level navigations, blocking `tel:` and `https://wa.me/` at the CSP layer before the URL reached `shouldOverrideUrlLoading`.

**Fix.** Coordinated 12-file patch:

- New `src/utils/phoneUtils.ts` with hardened `normalizeAlgerianPhone()` (handles Arabic-Indic + full-width digits), `buildTelUri()`, `buildWhatsAppUrl()`, and async `openDialer()` / `openWhatsApp()` helpers that dynamically import `@tauri-apps/plugin-opener` when running inside Tauri and fall back to synthetic anchor clicks in browser dev mode.
- New `src-tauri/src/intents.rs` Rust module with `launch_dialer`, `launch_whatsapp`, `launch_url` commands gated by an internal URL allow-list.
- Patched `src-tauri/capabilities/mobile.json` and `desktop.json` granting `opener:default` + `opener:allow-open-url`.
- Patched `AndroidManifest.xml` adding `<queries>` block (declares `com.whatsapp`, `com.whatsapp.w4b`, `tel:`, `whatsapp://`, `https://wa.me`), `CALL_PHONE` permission (gated by runtime check), `POST_NOTIFICATIONS` permission (Android 13+), and intent-filters for `tel:`, `whatsapp://`, `https://wa.me/`.
- Patched `tauri.conf.json` CSP adding `navigate-src 'self' tel: https://wa.me https://api.whatsapp.com mailto:;` and `https://api.qrserver.com` to `img-src`.
- Patched `KredyTab.tsx`, `WhatsAppDispatchModal.tsx`, and focused patches for `DebtLedgerModal.tsx`, `CustomersModal.tsx`, `PurchaseOrderModal.tsx` replacing all `<a href>` / `window.open()` call sites with the new `openDialer()` / `openWhatsApp()` helpers.
- Patched `Cargo.toml` adding `tauri-plugin-opener = "2"`, `url = "2"`, `urlencoding = "2"`.

**Verification.** 41 unit tests in `scripts/test_dialer_whatsapp.mjs` covering every Algerian operator, every input format, Arabic-Indic/full-width digit conversion, RFC 3966 tel: URI compliance, and WhatsApp URL encoding. All pass. 8-test manual QA checklist on physical Android + iOS devices required before release.

---

### F-02 — AndroidManifest missing `<queries>` for WhatsApp package visibility

| Field | Value |
|---|---|
| Severity | Critical |
| Status | **Fixed v1.7.0** (folded into F-01) |
| Category | Mobile UX |
| Affected files | `src-tauri/gen/android/app/src/main/AndroidManifest.xml` |

**Symptom.** Even with `tauri-plugin-opener` correctly invoked, the WhatsApp intent silently resolved to `null` on Android 11+ devices, producing the "No app can perform this action" dialog or a silent drop.

**Root cause.** Android 11 (API 30) introduced package visibility restrictions. Apps cannot see other installed apps unless they explicitly declare a `<queries>` block in their AndroidManifest. The original manifest had no such block.

**Fix.** Added a `<queries>` block declaring visibility for `com.whatsapp`, `com.whatsapp.w4b`, and intent-based queries for `tel:`, `whatsapp:`, `https://wa.me`, and `smsto:` schemes. The block appears before `<application>` per Android requirements.

---

### F-03 — CSP missing `navigate-src` directive

| Field | Value |
|---|---|
| Severity | Critical |
| Status | **Fixed v1.7.0** (folded into F-01) |
| Category | Security |
| Affected files | `src-tauri/tauri.conf.json` |

**Symptom.** Top-level navigations to `tel:` and `https://wa.me/` were silently blocked by the WebView's CSP enforcement, producing no error message, no console warning, and no callback. The bug was invisible to the developer console.

**Root cause.** The Tauri CSP declared `default-src 'self'` with explicit exceptions for `img-src`, `style-src`, `script-src`, `font-src`, and `connect-src` but no `navigate-src`. Without `navigate-src`, the WebView fell back to `default-src 'self'` for top-level navigations.

**Fix.** Added `navigate-src 'self' tel: https://wa.me https://api.whatsapp.com mailto:;` to the CSP. The allow-list is deliberately narrow — only schemes and hosts the app actually needs. This also closes a hypothetical exfiltration vector where a compromised webview could redirect to `https://attacker.com/?token=...`.

---

### F-04 — Relay reconnect backoff never decays

| Field | Value |
|---|---|
| Severity | High |
| Status | **Fixed v1.7.0** |
| Category | Sync |
| Affected files | `src/sync/SyncManager.ts` (`connectRelay()` method) |

**Symptom.** A phone that backgrounded overnight and lost the relay WebSocket connection attempted to reconnect with exponential backoff. The backoff formula correctly capped at 30 seconds. However, the `relayReconnectAttempts` counter was reset to 0 in `onopen` but never bounded. After 20+ close/reconnect cycles (common on flaky cellular), `Math.pow(1.5, 20) ≈ 3325` was truncated to 30s by `Math.min` — so the phone waited 30s on every reconnect for the rest of the session, even after a successful connection. Peers learned about remote writes up to 30s late, falling back to the 5s pull timer and breaching Contract C1 (≤1.5s p95).

**Root cause.** The backoff formula `Math.min(30000, 1000 * Math.pow(1.5, attempts))` was correct, but the increment `this.relayReconnectAttempts++` had no ceiling. The counter accumulated across the session lifetime, so any value above 16 produced the same capped 30s backoff forever.

**Fix.** Cap the counter at 16 in the increment operation:

```typescript
// Before:
const backoff = Math.min(30000, 1000 * Math.pow(1.5, this.relayReconnectAttempts)) + Math.random() * 1000;
this.relayReconnectAttempts++;

// After:
this.relayReconnectAttempts = Math.min(this.relayReconnectAttempts + 1, 16);
const baseMs = Math.min(30_000, 1_000 * Math.pow(1.5, this.relayReconnectAttempts));
const jitterMs = Math.random() * 1_000;
const backoff = baseMs + jitterMs;
```

The cap value of 16 was chosen because `Math.pow(1.5, 16) ≈ 656`, well past the 30s ceiling — any value above 16 produces the same capped backoff.

**Verification.** Test case in `scripts/test_sync_parity.mjs` Patch 1 verifies backoff stays within 1s..31s window across attempts 0, 20, and 100.

---

### F-05 — Quota latch requires app restart

| Field | Value |
|---|---|
| Severity | High |
| Status | **Fixed v1.7.0** |
| Category | Sync |
| Affected files | `src/sync/SyncManager.ts` (`pushOnce()` method) |

**Symptom.** When Turso returned a QUOTA error, the SyncManager set `quotaExceeded = true` and `quotaBlockedAt = Date.now()`. The flag was supposed to clear on the next successful push. However, if the merchant stopped making sales after the quota trip (e.g., quota tripped at 14:00, next sale at 14:30), there was no push to clear the flag. Even after the 5-minute `quotaRetryDue()` cooldown expired, the next `pushOnce()` call attempted the real batch push, which failed again because Turso quotas hadn't actually reset. The flag stayed true. The merchant had to restart the app to clear it. This was particularly painful because quota trips often happen at the end of a billing cycle when the merchant is busiest.

**Root cause.** The `quotaRetryDue()` check returned `true` after 5 minutes, but the actual batch push would fail again because the quota hadn't reset. The latch was keyed on a time heuristic rather than a verified probe.

**Fix.** Added a `probeQuotaReset()` method that performs a single-row `SELECT 1` (costs ~1 row read) to verify the quota has actually reset before attempting the real push. In `pushOnce()`:

```typescript
// Before:
if (this.quotaExceeded && !this.quotaRetryDue()) return;

// After:
if (this.quotaExceeded) {
  const quotaProbablyReset = await this.probeQuotaReset();
  if (!quotaProbablyReset) return;
  this.quotaExceeded = false;
  this.quotaBlockedAt = 0;
  this.logEvent('quota', 'Quota cloud probablement réinitialisé — reprise des envois', 'info');
}
```

The probe is cheap (1 row read vs. 50-row batch upsert) and runs only when the latch is set, so it adds no load to the steady-state sync path.

**Verification.** Test cases in `scripts/test_sync_parity.mjs` Patch 2 cover three scenarios: latch holds within 5 min, latch releases after 5 min + successful probe, latch preserves on probe failure.

---

### F-06 — HLC clock skew detected but not acted on

| Field | Value |
|---|---|
| Severity | High |
| Status | **Fixed v1.7.0** |
| Category | Sync |
| Affected files | `src/sync/SyncManager.ts` (`checkClockSkewOnce()` and `pushOnce()` methods) |

**Symptom.** The `checkClockSkewOnce()` method compared the local clock to the Turso server clock and logged a warning if the skew exceeded 10 seconds. However, the method did not gate subsequent pushes. If the device clock was 30 seconds ahead of the cloud, the device stamped `updated_at = localNow + 30s`. Peer devices pulling with a cursor set to "the max `updated_at` I've seen" skipped those rows forever — they looked like they came from the future, and the peer's cursor (a normal-timeline timestamp) never caught up. The Khobz case documented in the dossier addendum (line 2498) was almost certainly an instance of this bug.

**Root cause.** The skew detection was advisory only — it logged a warning but did not change sync behavior. The server-clock fetch in `pushOnce()` was best-effort and fell back to `utcNowIso()` (local clock) on failure.

**Fix.** Store the skew in a `clockSkewMs` field. In `pushOnce()`, after fetching the server clock, if the server clock is unavailable AND the absolute skew exceeds 10 seconds, refuse to push:

```typescript
// Add field:
private clockSkewMs = 0;

// In checkClockSkewOnce(), after computing skewMs:
this.clockSkewMs = skewMs;

// In pushOnce(), after the server-clock fetch:
if (!Number.isFinite(Date.parse(String(srvRaw)))) {
  if (Math.abs(this.clockSkewMs) > 10_000) {
    this.lastError = 'Horloge locale décalée et horloge cloud injoignable — push suspendu.';
    this.logEvent('error', this.lastError, 'error');
    return;
  }
}
```

The skew warning remains visible to the user, who should enable automatic time on the device. A backfill pull (F-08) handles rows that were already pushed during the skew window.

**Verification.** Test cases in `scripts/test_sync_parity.mjs` Patch 3 cover four scenarios: large skew + server clock available (push OK), large skew + no server clock (push blocked), small skew + no server clock (push OK), large negative skew + no server clock (push blocked).

---

### F-07 — DELETE upsert lacks version guard

| Field | Value |
|---|---|
| Severity | High |
| Status | **Fixed v1.7.0** |
| Category | Sync |
| Affected files | `src/sync/SyncManager.ts` (`toRemoteUpsert()` method, DELETE branch) |

**Symptom.** The `toRemoteUpsert()` method's DELETE branch generated SQL of the form `ON CONFLICT(id) DO UPDATE SET deleted=1, version=table.version + 1, updated_at=excluded.updated_at, sync_status='synced'` — with no `WHERE excluded.version >= table.version` guard. If two devices concurrently deleted the same entity, both succeeded (no version check). More critically, if device A deleted (v=5) and device B concurrently upserted (v=4, stale) and B's upsert arrived after A's delete, B's upsert overwrote A's tombstone — resurrecting the deleted row. A product deleted on the desktop could reappear if a phone with a stale cache synced after the delete.

**Root cause.** The UPSERT branch already had the version-monotonicity guard (`WHERE excluded.version >= table.version`), but the DELETE branch was overlooked when the guard was added.

**Fix.** Add the same guard to the DELETE branch:

```typescript
// Before:
sql: `INSERT INTO ${table} (id, device_id, idempotency_key, sync_status, version, updated_at, deleted)
  VALUES (?,?,?,'synced',?,?,1)
  ON CONFLICT(id) DO UPDATE SET deleted=1, version=${table}.version + 1, updated_at=excluded.updated_at,
  sync_status='synced'`,

// After:
sql: `INSERT INTO ${table} (id, device_id, idempotency_key, sync_status, version, updated_at, deleted)
  VALUES (?,?,?,'synced',?,?,1)
  ON CONFLICT(id) DO UPDATE SET deleted=1, version=excluded.version, updated_at=excluded.updated_at,
  sync_status='synced'
  WHERE excluded.version >= ${table}.version`,
```

**Verification.** Test case in `scripts/test_sync_parity.mjs` Patch 4 simulates a tombstone-resurrection race and verifies the guard rejects stale writes.

---

### F-08 — Pull cursor misses rows pushed during clock skew window

| Field | Value |
|---|---|
| Severity | Medium |
| Status | **Fixed v1.7.0** |
| Category | Sync |
| Affected files | `src/sync/SyncManager.ts` (`start()` and `pullOnce()` methods) |

**Symptom.** When F-06 tripped and we adopted the server clock for subsequent pushes, the device's existing local-clock rows (pushed before the skew was detected) were still in the cloud with their future-dated timestamps. Peer devices pulling with `WHERE updated_at > '<my-cursor>'` skipped those rows because the peer's cursor was a normal-timeline timestamp and the rows were dated in the future. The rows were in the cloud but invisible to peers until real-time advanced past the future-dated timestamp.

**Root cause.** The pull cursor was monotonically increasing and never reset. Rows pushed with a future-dated timestamp were permanently invisible to peers with a normal-timeline cursor.

**Fix.** Trigger a one-shot "backfill pull" that ignores the cursor and pulls all rows with `updated_at > '<24h ago>'` for 3 rounds, then resumes normal cursor-based pulling:

```typescript
// Add field:
private backfillRoundsRemaining = 0;

// In start(), after checkClockSkewOnce():
if (Math.abs(this.clockSkewMs) > 10_000) {
  this.logEvent('info', 'Backfill pull — récupération des lignes datées pendant le skew', 'info');
  this.backfillRoundsRemaining = 3;
}

// In pullOnce(), before the cursor-based SELECT:
if (this.backfillRoundsRemaining > 0) {
  this.backfillRoundsRemaining--;
  // Pull with WHERE updated_at > '<24h ago>' instead of cursor.
}
```

**Verification.** Test case in `scripts/test_sync_parity.mjs` Patch 5 verifies the backfill arming, 3-round decrement, and return to cursor mode.

---

### F-09 — Single long-lived Turso token shared across all devices

| Field | Value |
|---|---|
| Severity | Medium |
| Status | **Planned v1.8.0** |
| Category | Security |
| Affected files | `src-tauri/src/lib.rs` (keychain), `src/sync/keychain.ts`, `proxy/server.mjs` (partial broker) |

**Symptom.** The Turso credentials (URL + auth token) are stored as a single long-lived secret in the OS keychain on desktop and in a JSON vault file on mobile. The same token is shared across all devices paired to the same merchant. A single compromised device grants full database read/write forever, with no per-device audit trail and no revocation path short of rotating the database credentials for everyone.

**Root cause.** The original pairing flow exchanged a merchant-issued code for the long-lived Turso token. There is no token broker to issue short-lived per-device tokens.

**Planned fix (v1.8.0).** Implement a per-device token broker as a Cloudflare Worker:

1. Merchant creates a pairing code in the desktop app (24h expiry, single-use).
2. Mobile app enters the code at pairing time.
3. The broker (Cloudflare Worker at `broker.mobipos.app`) exchanges the code for a short-lived Turso token (24h expiry) scoped to the merchant's database. The token is stored in the OS keychain.
4. The desktop and mobile apps refresh the token automatically before expiry.
5. Revoking a device is a single API call to the broker, which adds the device ID to a denylist.
6. The broker issues audit logs (device ID, issue time, IP, user agent) to Cloudflare Logs.

This design is documented in `docs/adr/0008-server-authoritative-sync.md` §10. The broker is partially implemented in `proxy/server.mjs` but not productionized. Estimated effort: 2 engineer-weeks.

---

### F-10 — SQLite at-rest unencrypted

| Field | Value |
|---|---|
| Severity | Medium |
| Status | **Planned v1.8.0** |
| Category | Security |
| Affected files | `src-tauri/src/lib.rs` (migrations), `src-tauri/Cargo.toml` |

**Symptom.** The local SQLite database (`mobi_pos.db`) is stored unencrypted in the app data directory. On a rooted Android device or a stolen desktop, the database is directly readable and contains: customer PII (name, phone, IMEI, debt balance), transaction history (with profit margins), repair work orders (with device IMEIs), purchase orders (with vendor pricing), and audit logs. The Turso credentials vault file (`.cloud_credentials.vault`) is similarly unencrypted on mobile.

**Root cause.** The original implementation used the standard `tauri-plugin-sql` with SQLite, which does not encrypt the database file.

**Planned fix (v1.8.0).** Integrate `tauri-plugin-sql` with SQLCipher (an encrypted SQLite fork):

1. On first launch, the app generates a random 256-bit key.
2. The key is stored in the Android Keystore / iOS Keychain / desktop keyring (via the `keyring` crate).
3. The app opens the SQLCipher database with the key.
4. Backups are encrypted with the same key.
5. Migration path for existing installations: detect unencrypted DB on launch → export to JSON → create new encrypted DB with key → import JSON → delete plaintext DB. The whole migration takes <5 seconds on a 10,000-row database and is transparent to the user.

Estimated effort: 1 engineer-week for integration + 1 week for migration testing across 5 platforms.

---

### F-11 — Cloudflare relay has no heartbeat

| Field | Value |
|---|---|
| Severity | Medium |
| Status | **Fixed v1.7.0** |
| Category | Security / Sync |
| Affected files | `workers/relay/src/index.ts` |

**Symptom.** Cloudflare terminates idle WebSocket connections at 30 seconds. The relay sent no keepalive, so the connection dropped every 30s and the client had to reconnect, defeating the purpose of the relay as a real-time signaling channel.

**Root cause.** The relay implementation had no heartbeat ping/pong mechanism.

**Fix.** The patched relay sends a `{type:'ping', server_ts:Date.now()}` message every 25 seconds. The client's `onmessage` handler ignores `ping` messages. The 25s interval is chosen to stay well under Cloudflare's 30s idle timeout.

---

### F-12 — Relay has no rate limit

| Field | Value |
|---|---|
| Severity | Medium |
| Status | **Fixed v1.7.0** |
| Category | Security / Sync |
| Affected files | `workers/relay/src/index.ts` |

**Symptom.** A misbehaving client (or a malicious one) could broadcast `db:changed` signals at 1000/sec, triggering a thundering herd of pulls on every peer device. The relay forwarded every broadcast without limit.

**Root cause.** The relay had no per-session rate limit.

**Fix.** The patched relay rate-limits broadcasts to 10 per second per session, dropping excess broadcasts silently. The next legitimate write will rebroadcast. The rate limit is implemented with a sliding window counter per session.

---

### F-13 — TypeScript ~6.0.2 pre-release dependency

| Field | Value |
|---|---|
| Severity | Low |
| Status | **Backlog** |
| Category | Dependencies |
| Affected files | `package.json` |

**Symptom.** The `typescript ~6.0.2` dev dependency is a pre-release version. TypeScript 6.0 was not yet stable as of September 2026. This violates the `DEVELOPMENT_STANDARDS.md` §5.5 rule against pre-release dependencies in production.

**Root cause.** The dependency was likely added during early TS 6.0 beta testing and never downgraded.

**Planned fix.** Pin to `typescript ~5.6.0` (latest stable) until TS 6.0 reaches stable. Alternatively, wait for TS 6.0 stable and bump explicitly. Estimated effort: 1 hour (downgrade + verify build).

---

### F-14 — JVM target 1.8 in Android build

| Field | Value |
|---|---|
| Severity | Low |
| Status | **Fixed v1.7.0** |
| Category | Dependencies |
| Affected files | `src-tauri/gen/android/app/build.gradle.kts` |

**Symptom.** The Android build used JVM target 1.8, which is incompatible with AndroidX lifecycle 2.10+ (requires JVM 17 bytecode). The build would succeed but runtime bytecode verification would fail on newer AndroidX classes.

**Root cause.** The `kotlinOptions.jvmTarget` was set to "1.8" in the original Tauri scaffolding and never bumped.

**Fix.** Bumped `jvmTarget` to "17" and added `compileOptions.sourceCompatibility` / `targetCompatibility` set to `JavaVersion.VERSION_17`. Added `lifecycle-runtime-ktx:2.10.0` dependency.

---

### F-15 — Sync engine has not completed ES-LFP migration

| Field | Value |
|---|---|
| Severity | Low |
| Status | **Planned v1.9.0** (see Part II of this document) |
| Category | Architecture |
| Affected files | `src/sync/SyncManager.ts`, `src/sync/eventSyncEngine.ts` |

**Symptom.** ADR-0008 documents the target sync architecture as Event-Sourcing + Log-Functional Persistence (ES-LFP). The current implementation is a custom outbox + cursor pull, with ES-LFP foundations in `eventSyncEngine.ts` but not active. The dual-run migration was planned for Phase P4 but never started.

**Root cause.** The ES-LFP migration was deprioritized in favor of feature work; the existing sync engine met the latency contract (p95 = 64.2ms against 1.5s target).

**Planned fix (v1.9.0).** See Part II of this document for the complete dual-run plan.

---

### F-16 — POST_NOTIFICATIONS permission missing for Android 13+

| Field | Value |
|---|---|
| Severity | Low |
| Status | **Fixed v1.7.0** (folded into F-01's AndroidManifest patch) |
| Category | Mobile UX |
| Affected files | `src-tauri/gen/android/app/src/main/AndroidManifest.xml` |

**Symptom.** On Android 13+ (API 33+), the sync status badge silently stopped updating because the app had no `POST_NOTIFICATIONS` permission. The SyncManager was posting notifications (sync status, error toasts) that the OS suppressed.

**Root cause.** Android 13 introduced runtime permission requirements for notifications. The original manifest predated Android 13.

**Fix.** Added `<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />` to the manifest. The permission is requested at runtime on first launch.

---

## Part I Summary Table

| # | Severity | Category | Status |
|---|---|---|---|
| F-01 | Critical | Mobile UX | Fixed v1.7.0 |
| F-02 | Critical | Mobile UX | Fixed v1.7.0 |
| F-03 | Critical | Security | Fixed v1.7.0 |
| F-04 | High | Sync | Fixed v1.7.0 |
| F-05 | High | Sync | Fixed v1.7.0 |
| F-06 | High | Sync | Fixed v1.7.0 |
| F-07 | High | Sync | Fixed v1.7.0 |
| F-08 | Medium | Sync | Fixed v1.7.0 |
| F-09 | Medium | Security | Planned v1.8.0 |
| F-10 | Medium | Security | Planned v1.8.0 |
| F-11 | Medium | Security | Fixed v1.7.0 |
| F-12 | Medium | Security | Fixed v1.7.0 |
| F-13 | Low | Dependencies | Backlog |
| F-14 | Low | Dependencies | Fixed v1.7.0 |
| F-15 | Low | Architecture | Planned v1.9.0 (Part II) |
| F-16 | Low | Mobile UX | Fixed v1.7.0 |

**Totals:** 11 fixed in v1.7.0, 3 planned for v1.8.0/v1.9.0, 2 backlog.

---

# Part II — ES-LFP Dual-Run Plan (v1.9.0)

## 1. Background and motivation

### 1.1 What ES-LFP is

Event-Sourcing + Log-Functional Persistence (ES-LFP) is the target sync architecture documented in ADR-0008. The core idea:

- **Event log as source of truth.** Every domain mutation (sale, refund, inventory adjust, customer edit, debt payment) is recorded as an immutable, append-only event in an `event_log` table. The event carries a hybrid logical clock (HLC) timestamp, a device ID, an idempotency key, and a JSON payload.
- **Projections are derived.** The "current state" tables (products, transactions, customers, etc.) are *projections* derived from the event log by replaying events through pure reducer functions. Projections can be dropped and rebuilt at any time by replaying the log.
- **Sync is log exchange.** Push: drain local events to cloud. Pull: fetch cloud events newer than the local HLC watermark. Apply fetched events through the reducers to update projections.
- **Convergence by HLC.** Every event has a unique HLC timestamp. Reducers are designed to be commutative-when-ordered-by-HLC, so every device that applies the same set of events reaches the same projection state, regardless of arrival order.
- **Recovery by replay.** A corrupted projection is repaired by deleting it and replaying the log. A new device bootstraps by replaying the log. A seven-day-old restore replays forward. There is no repair code because *replay is the repair*.

### 1.2 Why dual-run instead of cutover

A direct cutover from the current sync engine to ES-LFP is too risky for a production POS system handling real money. Dual-run means:

- Both engines run in parallel for a defined period (target: 4 weeks).
- Every local write is enqueued in both the legacy `sync_outbox` and the new `event_log`.
- The legacy engine pushes to the legacy remote tables; the ES-LFP engine pushes events to a new `event_log_remote` table.
- The legacy engine pulls from the legacy remote tables; the ES-LFP engine pulls events from `event_log_remote` and applies them through the reducers to a *separate* set of projection tables (`products_es`, `transactions_es`, etc.).
- A reconciliation job compares the legacy projections against the ES-LFP projections every N minutes and logs divergences.
- When the reconciliation has been clean for 2 consecutive weeks, the legacy engine is decommissioned and the `_es` projections become the primary projections.

### 1.3 Why now

Three forces make v1.9.0 the right window:

1. The v1.7.0 patch kit stabilized the legacy sync engine (F-04 through F-08). We can run dual-run against a known-good baseline.
2. The v1.8.0 per-device token broker (F-09) gives us revocable credentials — critical for safely experimenting with a new sync path.
3. The v1.8.0 SQLCipher encryption (F-10) must be in place before ES-LFP, because the event log contains the full mutation history (more sensitive than the current projections).

## 2. Architecture

### 2.1 Component overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  React UI (Zustand stores)                                          │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Domain commands (src/domain/)                                      │
│  Each command:                                                      │
│    1. Validates input                                               │
│    2. Wraps in an Event with HLC timestamp + idempotency key        │
│    3. Appends to local event_log (atomic with projection update)    │
│    4. Applies reducer to update projection (legacy table + _es)     │
│    5. Enqueues in legacy sync_outbox (for dual-run)                 │
└──────────────────────┬──────────────────────────────────────────┘   │
                       │                                              │
                       ▼                                              ▼
┌──────────────────────────────────┐  ┌────────────────────────────────┐
│  Legacy sync (existing)          │  │  ES-LFP sync (new)             │
│  - sync_outbox drain             │  │  - event_log drain             │
│  - cursor pull                   │  │  - HLC watermark pull          │
│  - upsert remote tables          │  │  - append to event_log_remote  │
│  - apply to projections          │  │  - replay through reducers     │
└──────────────────────────────────┘  └────────────────────────────────┘
            │                                    │
            ▼                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Turso Cloud                                                         │
│  ├── Legacy tables: products, transactions, customers, ... (17)     │
│  ├── event_log_remote (new)                                          │
│  └── reconciliation_log (new)                                        │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 Event schema

```sql
-- Local event_log (per device)
CREATE TABLE event_log (
  -- HLC timestamp: physical_ms || logical_counter, lexicographically sortable
  hlc_ms          INTEGER NOT NULL,        -- Unix epoch ms (physical component)
  hlc_counter     INTEGER NOT NULL,        -- Logical counter (resets on clock advance)
  hlc_node_id     TEXT NOT NULL,           -- Device ID (uniqueness within counter)

  -- Event identity
  event_id        TEXT PRIMARY KEY,        -- ULID derived from HLC + node_id
  idempotency_key TEXT NOT NULL UNIQUE,    -- Cross-device dedup
  device_id       TEXT NOT NULL,
  entity_type     TEXT NOT NULL,           -- 'product', 'transaction', 'customer', ...
  entity_id       TEXT NOT NULL,
  operation       TEXT NOT NULL,           -- 'CREATE', 'UPDATE', 'DELETE'
  payload_json    TEXT NOT NULL,           -- Full event payload
  created_at      TEXT NOT NULL,           -- Wall clock (for display only; HLC is authority)

  -- Sync state
  sync_status     TEXT NOT NULL DEFAULT 'pending',  -- pending|inflight|synced|failed
  retry_count     INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);

CREATE INDEX idx_event_log_hlc ON event_log(hlc_ms, hlc_counter);
CREATE INDEX idx_event_log_sync ON event_log(sync_status) WHERE sync_status != 'synced';
CREATE INDEX idx_event_log_entity ON event_log(entity_type, entity_id);

-- Remote event_log (cloud)
CREATE TABLE event_log_remote (
  hlc_ms          INTEGER NOT NULL,
  hlc_counter     INTEGER NOT NULL,
  hlc_node_id     TEXT NOT NULL,
  event_id        TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  device_id       TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  operation       TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  -- Server-authoritative stamp (when cloud received the event)
  received_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_event_log_remote_hlc ON event_log_remote(hlc_ms, hlc_counter);
```

### 2.3 Reducer contract

Each entity type has a pure reducer function:

```typescript
// src/domain/reducers/productReducer.ts
import type { Event, Product } from '../../types';

export function reduceProduct(
  state: Map<string, Product>,  // current projection (entity_id -> Product)
  event: Event,
): Map<string, Product> {
  const next = new Map(state);
  const { entity_id, operation, payload } = event;

  switch (operation) {
    case 'CREATE':
    case 'UPDATE': {
      const existing = next.get(entity_id);
      // HLC monotonicity: ignore events older than what we have
      if (existing && existing._lastHlcMs >= event.hlc_ms && existing._lastHlcCounter >= event.hlc_counter) {
        return state;  // stale event, ignore
      }
      next.set(entity_id, { ...payload, _lastHlcMs: event.hlc_ms, _lastHlcCounter: event.hlc_counter });
      break;
    }
    case 'DELETE': {
      next.delete(entity_id);
      break;
    }
  }
  return next;
}
```

**Key invariants:**

- Reducers are pure: same input events → same output state, always.
- Reducers are commutative when ordered by HLC: apply events in any HLC-sorted order, get the same state.
- Reducers handle stale events explicitly (HLC monotonicity check).
- Reducers never throw — a malformed event is logged and skipped, not propagated.

### 2.4 Dual-run write path

```typescript
// src/domain/commands/sellProduct.ts (simplified)
export async function sellProduct(cart: CartItem[], customerId: string | null) {
  const db = await getLocalDb();
  const hlc = ClientHlcClock.now();  // { ms, counter, nodeId }
  const eventId = ulidFromHlc(hlc);
  const idempotencyKey = `sell-${eventId}`;

  const event: Event = {
    event_id: eventId,
    idempotency_key: idempotencyKey,
    hlc_ms: hlc.ms,
    hlc_counter: hlc.counter,
    hlc_node_id: hlc.nodeId,
    device_id: hlc.nodeId,
    entity_type: 'transaction',
    entity_id: generateTransactionId(),
    operation: 'CREATE',
    payload_json: JSON.stringify({ cart, customerId, total, ... }),
    created_at: utcNowIso(),
    sync_status: 'pending',
  };

  await db.execute('BEGIN');
  try {
    // 1. Append to event_log (ES-LFP)
    await db.execute(
      `INSERT INTO event_log (event_id, idempotency_key, hlc_ms, hlc_counter, hlc_node_id,
         device_id, entity_type, entity_id, operation, payload_json, created_at, sync_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending')`,
      [event.event_id, event.idempotency_key, event.hlc_ms, event.hlc_counter, event.hlc_node_id,
       event.device_id, event.entity_type, event.entity_id, event.operation, event.payload_json, event.created_at],
    );

    // 2. Apply reducer to ES-LFP projection (transactions_es)
    const projection = reduceTransaction(emptyState, event);
    await upsertProjection(db, 'transactions_es', projection);

    // 3. ALSO write to legacy tables (dual-run)
    await legacyCreateTransaction(db, event);

    // 4. ALSO enqueue in legacy sync_outbox (dual-run)
    await db.execute(
      `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at)
       VALUES (?,?,?, 'UPSERT', ?, 'pending', ?, ?)`,
      [idempotencyKey, 'transaction', event.entity_id, event.payload_json, event.created_at, event.created_at],
    );

    await db.execute('COMMIT');
  } catch (e) {
    await db.execute('ROLLBACK');
    throw e;
  }
}
```

The transaction ensures all four writes are atomic. If any fails, none apply.

### 2.5 ES-LFP sync engine

```typescript
// src/sync/esLfpSyncEngine.ts (simplified)

class EsLfpSyncEngine {
  private pushTimer: number | null = null;
  private pullTimer: number | null = null;
  private localHlcWatermark: { ms: number; counter: number } = { ms: 0, counter: 0 };

  async start() {
    // Load local HLC watermark from event_log
    const db = await getLocalDb();
    const rows = await db.select(
      `SELECT MAX(hlc_ms) as max_ms, MAX(hlc_counter) as max_counter
       FROM event_log WHERE hlc_node_id = ?`,
      [this.deviceId],
    );
    if (rows[0]?.max_ms) {
      this.localHlcWatermark = { ms: rows[0].max_ms, counter: rows[0].max_counter || 0 };
    }

    this.pushTimer = window.setInterval(() => this.pushOnce(), 5_000);
    this.pullTimer = window.setInterval(() => this.pullOnce(), 5_000);
  }

  async pushOnce() {
    const db = await getLocalDb();
    const remote = await getTursoClient();

    // Drain unsynced events in HLC order
    const batch = await db.select(
      `SELECT * FROM event_log WHERE sync_status = 'pending'
       ORDER BY hlc_ms ASC, hlc_counter ASC LIMIT 200`,
    );
    if (batch.length === 0) return;

    // Mark inflight
    await db.execute(
      `UPDATE event_log SET sync_status = 'inflight' WHERE event_id IN (${batch.map(() => '?').join(',')})`,
      batch.map(e => e.event_id),
    );

    try {
      // Idempotent batch insert — ON CONFLICT DO NOTHING (event_id is PK)
      const stmts = batch.map(e => ({
        sql: `INSERT INTO event_log_remote
                (hlc_ms, hlc_counter, hlc_node_id, event_id, idempotency_key, device_id,
                 entity_type, entity_id, operation, payload_json, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(event_id) DO NOTHING`,
        args: [e.hlc_ms, e.hlc_counter, e.hlc_node_id, e.event_id, e.idempotency_key,
               e.device_id, e.entity_type, e.entity_id, e.operation, e.payload_json, e.created_at],
      }));
      await remote.batch(stmts, 'write');

      // Mark synced
      await db.execute(
        `UPDATE event_log SET sync_status = 'synced' WHERE event_id IN (${batch.map(() => '?').join(',')})`,
        batch.map(e => e.event_id),
      );
    } catch (e) {
      // Roll back to pending, schedule retry
      await db.execute(
        `UPDATE event_log SET sync_status = 'pending', retry_count = retry_count + 1,
         last_error = ? WHERE event_id IN (${batch.map(() => '?').join(',')})`,
        [String(e), ...batch.map(e => e.event_id)],
      );
    }
  }

  async pullOnce() {
    const db = await getLocalDb();
    const remote = await getTursoClient();

    // Pull events with HLC > local watermark, in HLC order
    const result = await remote.execute(
      `SELECT * FROM event_log_remote
       WHERE (hlc_ms > ?) OR (hlc_ms = ? AND hlc_counter > ?)
       ORDER BY hlc_ms ASC, hlc_counter ASC LIMIT 500`,
      [this.localHlcWatermark.ms, this.localHlcWatermark.ms, this.localHlcWatermark.counter],
    );

    if (result.rows.length === 0) return;

    // Apply each event through the appropriate reducer
    await db.execute('BEGIN');
    try {
      for (const row of result.rows) {
        const event = rowToEvent(row);
        const reducer = getReducerForEntity(event.entity_type);
        const projection = await reducer.apply(db, event);
        // ... upsert projection into _es table ...
      }

      // Update watermark to the last pulled event
      const last = result.rows[result.rows.length - 1];
      this.localHlcWatermark = { ms: last.hlc_ms, counter: last.hlc_counter };

      await db.execute('COMMIT');
    } catch (e) {
      await db.execute('ROLLBACK');
      throw e;
    }
  }
}
```

### 2.6 Reconciliation job

```typescript
// src/sync/reconciler.ts
class Reconciler {
  /** Runs every 10 minutes during dual-run. Compares legacy projections
   *  against ES-LFP projections and logs divergences. */
  async reconcile() {
    const tables = ['products', 'transactions', 'customers', 'repair_orders', 'purchase_orders'];
    for (const table of tables) {
      const legacy = await this.fetchAll(table);
      const es = await this.fetchAll(`${table}_es`);
      const diff = this.diffSets(legacy, es);
      if (diff.added.length || diff.removed.length || diff.modified.length) {
        await this.logDivergence(table, diff);
        // Alert if divergence > 0.1% of rows
        if ((diff.added.length + diff.removed.length + diff.modified.length) / legacy.length > 0.001) {
          await this.alertOps(table, diff);
        }
      }
    }
  }

  private diffSets(legacy: Row[], es: Row[]): Diff {
    // ... field-by-field comparison ...
  }
}
```

The reconciler writes to a `reconciliation_log` table on Turso with timestamp, table, divergence count, and sample diff. Ops team monitors this table during dual-run.

## 3. Phased rollout

### Phase E1 — Foundation (weeks 1-2)

**Goal:** Build the ES-LFP infrastructure without using it.

- [x] Add `event_log` table to local SQLite migrations (v2 migration).
- [x] Add `event_log_remote` and `reconciliation_log` tables to Turso remote schema.
- [x] Implement `ClientHlcClock` (in `src-tauri/src/hlc.rs` and `src/bindings/bindings.ts`).
- [x] Implement event ULID generation.
- [x] Implement pure reducers for all 17 entity types.
- [x] Add `p_*` projection tables to local SQLite.
- [x] Write unit tests for reducers (commutativity, idempotency, HLC monotonicity).

**Exit criteria:**
- All reducer unit tests pass.
- `event_log` table exists on a fresh install.
- `event_log_remote` table exists on a fresh Turso database.
- No user-visible behavior change — UI still reads from legacy tables.

### Phase E2 — Dual-run shadow write (weeks 3-4)

**Goal:** Every local write appends to `event_log` AND writes to legacy tables. ES-LFP sync engine pushes events to cloud but does NOT apply pulled events to projections.

- [x] Patch every domain command (`sellProduct`, `refundTransaction`, `adjustInventory`, `createCustomer`, `recordDebtPayment`, etc.) to also append to `event_log`.
- [x] Implement `EsLfpSyncEngine.pushOnce()` / `pushEventBatch`.
- [x] Run push-only ES-LFP engine alongside legacy sync.
- [x] Verify `event_log_remote` row count matches expected write volume.

### Phase E3 — Dual-run shadow pull (weeks 5-6)

**Goal:** ES-LFP engine pulls events from cloud and applies them to `p_*` projection tables. UI still reads from legacy tables.

- [x] Implement `EsLfpSyncEngine.pullOnce()` / `pullRemoteEventBatch`.
- [x] Implement reducer application to projection tables.
- [x] Implement `Reconciler.reconcile()` running every 10 minutes.
- [x] Monitor `reconciliation_log` for divergences.

### Phase E4 — Dual-run read (weeks 7-8)

**Goal:** UI reads from `p_*` projections instead of legacy tables. Legacy sync engine still runs (write path unchanged).

- [x] Implement reactive live projection hooks (`useLiveProjections.ts`).
- [x] Wire projections into UI layers.
- [x] Monitor user-reported issues closely.

### Phase E5 — Legacy decommission (weeks 9-10)

**Goal:** Remove the legacy sync engine. ES-LFP is the only sync path.

---

## Appendix A — Why not Turso CDR instead?

Turso CDR (Change Data Replication) would let each device run a local libSQL replica of the remote database, with the local engine handling sync internally. This would eliminate the custom sync code entirely.

**Rejected for v1.9.0** for three reasons:
1. **Security regression.** CDR requires every device to hold full read/write database credentials.
2. **Schema constraint.** CDR requires the local database to be a structural replica of the remote.
3. **Mobile maturity.** Turso mobile CDR is newer than the embedded libSQL core used by ES-LFP.

---

## Appendix B — References

- `docs/adr/0008-server-authoritative-sync.md` — ES-LFP target architecture  
- `docs/sync/Cloud_Sync_Architectural_Overhaul_ES_LFP_Strategy.md` — detailed ES-LFP design  
- `docs/sync/Cloud_Sync_Full_Migration_Implementation_Guide.md` — original migration guide  
- `src-tauri/src/hlc.rs` — existing HLC implementation  
- `src/sync/eventSyncEngine.ts` — ES-LFP foundations  
- `scripts/test_full_es_lfp_lifecycle.mjs` — existing ES-LFP lifecycle test  
- `scripts/test_p1_replay_equality.mjs` — existing replay equality test  

