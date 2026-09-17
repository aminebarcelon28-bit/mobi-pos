# ADR-0008: Server-authoritative sync protocol (one clock, one identity)

- Status: accepted · Date: 2026-09-16
- Context: pull cursors and LWW ordering keyed on per-device wall clocks.
  Industry consensus (checked 2026-09-16) is unanimous that client wall time
  must never be sync authority: "Avoid device wall-clock time as the
  authority" / "Incremental pull needs a server-issued cursor … A client
  timestamp is not a safe cursor" (tamdd.dev, 2026-07-19); "Server-Assigned
  Monotonic Versions … SHOULD be the default choice for centralized sync"
  (Agentic Developer Cookbook, clock-systems); "Use server time when sync
  happens (server stamps)" (AgentsKit offline-first pattern); "Delta Sync
  paired with a structured server change log" over CRDTs for this workload
  shape (Champlin, 2026-08-25). Turso supports `CREATE TRIGGER` (GA since
  0.6/0.7 per official docs + COMPAT.md), which keeps a future server journal
  available without changing vendors.
- Decision:
  1. One clock: `pushOnce` reads the cloud clock once per non-empty batch and
     `toRemoteUpsert` stamps every pushed `updated_at` with it. `created_at`
     keeps origin truth (display/sort); `updated_at` is the cursor authority.
     Idle cycles cost nothing extra (no fetch when the outbox is empty).
  2. One identity: `getStableDeviceId()` (SQLite authorship id, localStorage
     fallback) feeds every `syncManager.start()` call site (App, pairing
     wizard, CloudSyncPanel — the hardcoded `'pos-main'` is gone). New-row
     presence checks (ADR-0007) remain the primary echo suppressor.
  3. One instance: relay + BroadcastChannel self-suppression keys on a per-
     start `instanceId` nonce (falling back to deviceId for legacy senders),
     so two windows/sessions on one device no longer starve each other.
- Consequences: cursor ordering is immune to device clock drift (the skew
  probe stays as a diagnostic); row authorship is a single UUID namespace
  going forward (legacy `[object Object]`/envelope ids already in the cloud
  are inert opaque strings); +1 read per non-empty push (~85 k/mo at heavy
  use — negligible against the 500 M budget).
- Next step (deferred, not in this change): replace `updated_at` cursors with
  a server journal (`sync_seq` AUTOINCREMENT + AFTER INSERT/UPDATE triggers
  fanning every table into it; pulls read `WHERE seq > cursor`). Re-evaluate
  when a second writer backend appears or when cursor-expiry/resnapshot
  semantics are needed.

## Addendum 2026-09-16 — no-latch rule (live one-way-sync root cause)
- `quotaExceeded` was set on quota-scare strings and never cleared: uploads
  wedged forever while pulls (which never check the flag) kept working —
  exactly the reported "receives but never sends" shape. A single transient
  blip (dead zone, 429, scary error text) became permanent until app restart.
- Rule now: every sync-blocking flag auto-recovers. Quota blocks expire after
  5 min and clear on the first confirmed cloud write; offline state re-probes
  (throttled 15 s) instead of latching, in both push and pull. Corroborating
  evidence: the cloud held zero phone-originated Khobz rows while the phone
  demonstrably pushes (its 13:31 test sale + adjusts are present) — the sale
  died in the wedged uploader, not on the wire.
