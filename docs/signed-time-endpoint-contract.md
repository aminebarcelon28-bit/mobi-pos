# Signed-time endpoint contract (Phase 4.5 WP6a — BLOCKED: NOT SHIPPABLE)

Status: **BLOCKED**. Native enforcement is NOT shippable until a real endpoint
and production time key exist. Release builds refuse re-anchor
(`TrustedTimeFailure`) by construction. This contract is the build-to spec for
the server side; the native verifier it targets already exists and is tested
(`src-tauri/src/trust_core/reanchor.rs`, profile-split key tests).

## Protocol (implemented natively — server must match it exactly)

Two-step, nonce-bound, over the existing TLS heartbeat path:

1. Terminal calls `trust_reanchor_challenge` → kernel generates a 32-byte
   (64-hex-char) nonce, stores ONE active challenge (5-minute TTL,
   `REANCHOR_CHALLENGE_TTL_MS`), returns `{ nonce, expires_at_ms }`.
2. Terminal fetches a signed assertion embedding that nonce (HTTP below) and
   calls `trust_reanchor_time(assertion)` → kernel verifies Ed25519,
   consumes the challenge (single-use; reuse/expiry/absence rejected), and
   anchors wall time. Assertion size cap: 8 KiB.

## Assertion envelope (exact)

```
REANCHOR_V1.{payload_b64url}.{sig_b64url}
```

- `payload_b64url`: base64url (no pad) of JSON
  `{ "nonce": "<challenge hex>", "server_time_ms": <u64>, "expires_at_ms": <u64>, "seq?": <u64|null> }`.
- `sig_b64url`: base64url (no pad) of Ed25519 signature over bytes
  `MOBI-TIME-V1.REANCHOR_V1.{payload_b64url}` (ASCII domain + `.` + envelope).
- Validation order: envelope shape → base64 → signature → plausibility
  (`server_time_ms >= 1577836800000`, i.e. 2020-01-01) → assertion expiry
  (`now <= expires_at_ms`) → challenge bind (signature checked FIRST so
  malformed/forged assertions never burn a challenge; only well-formed ones
  consume, so a replayed assertion fails closed at consumption).

## HTTP endpoint (to build)

```
GET /v1/time?nonce={64-hex}&device_id={id}
→ 200 { "assertion": "REANCHOR_V1.…", "key_id": "time-2026-01", "server_time_ms": 123 }
```

- TLS 1.2+, existing heartbeat authentication (device token). Rate-limit per
  device (challenge TTL already bounds usefulness to 5 min).
- `key_id` names the signing key (see rotation). `server_time_ms` echoes the
  signed value for logging; the ASSERTION is authoritative, never the echo.
- Error shape on failure: `{ "error": "<code>", "retry_after_ms": <n> }`.
  Terminal treats any non-200 as "no observation" (advisory; never advances
  or retreats trust).

## Signature scheme

- Ed25519, **dedicated time key** (key separation from the license-signing
  key; cross-protocol confusion is additionally blocked by domain separation
  — proven by `domain_isolation_between_protocols` — but separation is policy).
- Payload `seq`: the server's monotonic per-device sequence. The kernel
  records `last_server_seq`; a regressed `seq` is a rollback signal (same
  quarantine path as counter regression). Servers MUST persist and
  monotonically increase `seq` per device; on key rotation the new key MUST
  continue the sequence (never reset to 0).

## Replay protection (four layers)

1. Challenge single-use + 5-min TTL (kernel-consumed).
2. Assertion `expires_at_ms` (short-lived; recommended ≤ 5 min).
3. `seq` monotonicity per device (replay of an older assertion regresses).
4. TLS + device authentication on fetch (no anonymous assertions).

## Key rotation

- Keys named `time-YYYY-NN`; endpoint returns the active `key_id`.
- Terminal pins a SET of verification keys: `{ key_id: pubkey_b64url }`.
  Current set ships with the app; rotation = ship new set with overlap.
- Rotation ceremony: introduce new key (endpoint signs with new, old still
  accepted during overlap ≤ 7 days) → terminals update → retire old.
  Overlap window MUST exceed the 7-day offline grace so offline terminals
  are not stranded.
- Compromise: retire `key_id` immediately (endpoint stops serving it);
  terminals with only the compromised key fail closed to quarantine exit
  via owner re-validation (existing manual path), never via time acceptance.
- Provisioning runbook: `docs/time-key-runbook.md`.

## What is NOT in this contract (out of scope, stated)

- No NTP replacement: this endpoint serves quarantine-exit observations,
  not continuous discipline. Continuous time stays advisory (Phase 2).
- No offline re-anchor codes (deferred; must share the export
  `integrity_state` vocabulary when designed).
