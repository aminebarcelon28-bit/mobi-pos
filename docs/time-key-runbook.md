# Time-key provisioning runbook (Phase 4.5 WP6a — BLOCKED companion)

Companion to `docs/signed-time-endpoint-contract.md`. Do not execute against
production until the endpoint contract is implemented and reviewed.

## 1. Generate the dedicated time keypair (offline ceremony machine)

```sh
# Any Ed25519 tooling; example with age-compatible openssl-free flow is out
# of scope — what matters is the outputs:
#   time-2026-01.sk  (32-byte seed — NEVER leaves the HSM/vault)
#   time-2026-01.pk  (32-byte pubkey, base64url-no-pad for pinning)
```

- Key separation: MUST NOT reuse the license-signing key.
- Store `.sk` in the merchant vault (HSM preferred); `.pk` goes to the app
  pin set + endpoint config.

## 2. Pin the production key in the app

Current home: `PRODUCTION_TIME_PUBKEY_B64URL` in
`src-tauri/src/trust_core/reanchor.rs` (placeholder `"UNCONFIGURED"`).

1. Replace the placeholder with the base64url pubkey (keep the `time-…`
   key id in a comment next to it).
2. `cargo test -p mobi-pos --lib trust_core::reanchor` (dev: 7 pass).
3. `cargo test --release -p mobi-pos --lib trust_core::reanchor`
   (release: 7 pass — INCLUDES `release_profile_refuses_without_production_key`.
   NOTE: that test asserts REFUSAL with the placeholder. After pinning a real
   key it must be UPDATED to assert acceptance-path behavior for the pinned
   key (verify a mint against the pinned pubkey); leaving the refusal test
   green against a real key is impossible by construction — the test reads
   the same constant. Update it in the same commit that pins the key.)
4. Rebuild + re-verify the A1 profile proofs (env cfg-gating) — key pinning
   must not touch them, prove it by re-running.

## 3. Deploy the endpoint

Per the contract: `GET /v1/time`, Ed25519 with the `.sk`, `seq` persisted
per device and monotonic across rotations. Smoke test with a quarantined
dev terminal: challenge → fetch → `trust_reanchor_time` → anchor advances,
challenge consumed (second submit of the same assertion fails).

## 4. Rotate

Overlap ≤ 7 days is a MAXIMUM for compromise response, not a target:
normal rotation overlaps until the slowest terminal has checked in
(heartbeat ≤ 120 s when online; offline terminals update on return —
never strand them by retiring early). Steps: add new `key_id` to pin set
(app release) → endpoint dual-signs or switches with overlap → monitor
`key_id` mix in server logs → retire old only at ~0% old-assertion traffic.

## 5. Compromise response

1. Endpoint: stop serving the compromised `key_id` immediately.
2. Ship pin-set removal (expedited app release).
3. Terminals holding only the compromised key fail closed (quarantine exit
   via owner re-validation, never via time acceptance) — that is the
   designed posture, not an outage to work around.
4. Post-mortem: audit `seq` continuity per device for rollback exploitation
   during the exposure window.

## 6. TEST-ONLY key hygiene

`TEST_TIME_SEED` (`reanchor.rs`) exists ONLY under `cfg(debug_assertions)`:
absent from every release-profile build (app and `cargo test --release`),
proven by the profile-split tests. Rules:

- NEVER copy the seed, its pubkey, or a debug-minted assertion into any
  production config, doc, or ticket (this runbook included — no key bytes).
- Debug builds print `[trust_core] WARNING: re-anchor using TEST time key`
  on every use; if that line ever appears in a production log, treat the
  binary as misbuilt and quarantine the terminal.
- CI must run BOTH `cargo test` and `cargo test --release` for
  `trust_core::reanchor` (7 + 7): a change that re-admits the test key to
  release breaks `release_profile_refuses_without_production_key` loudly.
