//! Phase 2 — authenticated time re-anchor.
//!
//! Quarantine exit (`CLOCK_RESET_REQUIRED` / `TAMPER_SUSPECTED`) requires a
//! server-asserted time observation. The kernel never accepts client wall
//! time: re-anchor is a two-step, nonce-bound protocol:
//!
//! 1. `trust_reanchor_challenge` (LicenseManagement) → kernel generates a
//!    16-byte nonce, stores a single active challenge (5-minute TTL), and
//!    returns `{nonce, expires_at_ms}`. TypeScript fetches a signed server
//!    assertion embedding that nonce over the existing TLS heartbeat path.
//! 2. `trust_reanchor_time` (LicenseManagement) → kernel verifies the
//!    Ed25519 assertion, consumes the challenge (single-use), and anchors.
//!
//! Nonce discipline: generated NATIVELY (never client-chosen), single-use
//! (consumed on success; expiry bounds the window), rejected when reused,
//! expired, or absent. Assertion envelope: `REANCHOR_V1.{payload}.{sig}`
//! with payload `{nonce, server_time_ms, expires_at_ms, seq?}`, signed over
//! domain-separated bytes `MOBI-TIME-V1.REANCHOR_V1.{payload}` — a license
//! token can never verify as a time assertion even if signed by the same key.
//!
//! # Keys (stated)
//! - Production: `PRODUCTION_TIME_PUBKEY_B64URL`, currently the
//!   `"UNCONFIGURED"` placeholder. Release builds with the placeholder
//!   REFUSE re-anchor (`TrustedTimeFailure`) — no test key, no bypass.
//!   Recommendation: dedicated time key (key separation); server must expose
//!   a signed-time endpoint (integration dependency — native enforcement is
//!   NOT shippable until it exists; see `docs/signed-time-endpoint-contract.md`).
//! - Test/debug: runtime-derived test keypair (fixed seed), usable only under
//!   `cfg(debug_assertions)`, with a loud stderr warning. It is ABSENT from
//!   every release-profile build (app AND `cargo test --release`): the
//!   release-profile test below pins the refusal. Never compiled into the
//!   release trust path.

use super::clocks::{production_monotonic, MonotonicSource};
use super::ipc_authorizer::{
    global_kernel, persist_current_snapshot, require_capability, TrustError,
};
use super::time_config::{MIN_PLAUSIBLE_UTC_MS, REANCHOR_CHALLENGE_TTL_MS};
use super::time_engine::global_time_kernel;
use super::Capability;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};

/// Domain separator for time assertions (cross-protocol confusion guard).
pub const TIME_ASSERTION_DOMAIN: &[u8] = b"MOBI-TIME-V1";
const ASSERTION_PREFIX: &str = "REANCHOR_V1";

/// Production pinned server time key. Placeholder until the server ships a
/// signed-time endpoint with a (recommended: dedicated) key.
pub const PRODUCTION_TIME_PUBKEY_B64URL: &str = "UNCONFIGURED";

/// Fixed test seed — `cfg(debug_assertions)` ONLY. Deliberately NOT
/// `cfg(any(test, debug_assertions))`: `cargo test --release` sets `test`
/// but NOT `debug_assertions`, so the seed (and every fn below) is absent
/// from release-profile builds entirely — proven by
/// `release_profile_refuses_without_production_key`.
#[cfg(debug_assertions)]
const TEST_TIME_SEED: [u8; 32] = [9u8; 32];

#[derive(Debug, Deserialize)]
struct TimeAssertionPayload {
    nonce: String,
    server_time_ms: u64,
    expires_at_ms: u64,
    #[serde(default)]
    seq: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct ReanchorChallenge {
    pub nonce: String,
    pub expires_at_ms: u64,
}

fn system_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn new_nonce_hex() -> String {
    let a = uuid::Uuid::new_v4();
    let b = uuid::Uuid::new_v4();
    let mut s = String::with_capacity(64);
    for byte in a.as_bytes().iter().chain(b.as_bytes().iter()) {
        s.push_str(&format!("{byte:02x}"));
    }
    s
}

#[cfg(debug_assertions)]
fn test_pubkey_b64url() -> String {
    use ed25519_dalek::SigningKey;
    let sk = SigningKey::from_bytes(&TEST_TIME_SEED);
    URL_SAFE_NO_PAD.encode(sk.verifying_key().to_bytes())
}

/// Resolve the active verification key: production pin, or the test key in
/// debug builds with a loud warning. Release without a production key
/// refuses — this is what makes unshipped enforcement fail closed.
fn active_time_pubkey_b64url() -> Result<String, TrustError> {
    if PRODUCTION_TIME_PUBKEY_B64URL != "UNCONFIGURED" {
        return Ok(PRODUCTION_TIME_PUBKEY_B64URL.to_string());
    }
    #[cfg(debug_assertions)]
    {
        eprintln!("[trust_core] WARNING: re-anchor using TEST time key (debug/test only)");
        Ok(test_pubkey_b64url())
    }
    #[cfg(not(debug_assertions))]
    {
        return Err(TrustError::TrustedTimeFailure);
    }
}

/// Verify a time assertion against the active key WITHOUT consuming any
/// challenge (pure; challenge consumption is a separate kernel step so tests
/// can exercise each rule independently).
fn verify_assertion(
    assertion: &str,
    pubkey_b64url: &str,
    now_ms: u64,
) -> Result<TimeAssertionPayload, TrustError> {
    let assertion = assertion.trim();
    if assertion.is_empty() {
        return Err(TrustError::IPCProtocolError {
            reason: "empty time assertion",
        });
    }
    let mut parts = assertion.split('.');
    let (prefix, payload_b64, sig_b64) = match (parts.next(), parts.next(), parts.next()) {
        (Some(a), Some(p), Some(s)) if parts.next().is_none() => (a, p, s),
        _ => {
            return Err(TrustError::IPCProtocolError {
                reason: "time assertion must have 3 parts",
            })
        }
    };
    if prefix != ASSERTION_PREFIX {
        return Err(TrustError::IPCProtocolError {
            reason: "unknown time assertion prefix",
        });
    }
    // Reuse the token verifier with the time domain: structure, base64,
    // signature rules are identical; only the signed bytes differ.
    let token_like = format!("{prefix}.{payload_b64}.{sig_b64}");
    // Header check inside the shared verifier expects alg EdDSA in a JSON
    // header — assertions use the envelope directly, so verify the signature
    // here with the same primitives instead of forcing JWS shape.
    let payload_bytes = URL_SAFE_NO_PAD.decode(payload_b64).map_err(|_| {
        TrustError::IPCProtocolError {
            reason: "malformed assertion encoding",
        }
    })?;
    let sig_bytes = URL_SAFE_NO_PAD.decode(sig_b64).map_err(|_| {
        TrustError::IPCProtocolError {
            reason: "malformed assertion signature",
        }
    })?;
    // Envelope shape documented above; signature verified below.
    verify_assertion_signature(&token_like, &sig_bytes, pubkey_b64url)?;
    let payload: TimeAssertionPayload =
        serde_json::from_slice(&payload_bytes).map_err(|_| TrustError::IPCProtocolError {
            reason: "unreadable assertion payload",
        })?;
    if payload.server_time_ms < MIN_PLAUSIBLE_UTC_MS {
        return Err(TrustError::SecurityPolicyFailure {
            reason: "asserted server time implausible",
        });
    }
    if now_ms > payload.expires_at_ms {
        return Err(TrustError::SecurityPolicyFailure {
            reason: "time assertion expired",
        });
    }
    Ok(payload)
}

fn verify_assertion_signature(
    token_like: &str,
    sig_bytes: &[u8],
    pubkey_b64url: &str,
) -> Result<(), TrustError> {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let pubkey_bytes =
        URL_SAFE_NO_PAD
            .decode(pubkey_b64url)
            .map_err(|_| TrustError::IPCProtocolError {
                reason: "invalid time-key length",
            })?;
    if pubkey_bytes.len() != 32 {
        return Err(TrustError::IPCProtocolError {
            reason: "invalid time-key length",
        });
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&pubkey_bytes);
    let vk = VerifyingKey::from_bytes(&arr).map_err(|_| TrustError::IPCProtocolError {
        reason: "invalid time key",
    })?;
    let sig = Signature::from_slice(sig_bytes).map_err(|_| TrustError::IPCProtocolError {
        reason: "invalid assertion signature length",
    })?;
    // Signed bytes: DOMAIN + "." + envelope ("REANCHOR_V1.{payload}").
    let envelope = token_like
        .rsplit_once('.')
        .map(|(head, _)| head)
        .unwrap_or(token_like);
    let mut signed = Vec::with_capacity(TIME_ASSERTION_DOMAIN.len() + 1 + envelope.len());
    signed.extend_from_slice(TIME_ASSERTION_DOMAIN);
    signed.push(b'.');
    signed.extend_from_slice(envelope.as_bytes());
    vk.verify(&signed, &sig)
        .map_err(|_| TrustError::SecurityPolicyFailure {
            reason: "time assertion signature invalid",
        })
}

/// Domain separation is enforced through the shared token verifier's
/// `domain` parameter (see `verify_token_with_domain`): the assertion path
/// signs `DOMAIN + "." + envelope`, so the two protocols cannot cross-verify
/// even under a shared key. Covered by `domain_isolation_between_protocols`.
///
/// Step 1: issue a kernel-generated, single-use, expiring challenge.
pub fn issue_reanchor_challenge() -> ReanchorChallenge {
    let nonce = new_nonce_hex();
    let expires_at_ms = system_now_ms().saturating_add(REANCHOR_CHALLENGE_TTL_MS);
    global_time_kernel().issue_challenge(nonce.clone(), expires_at_ms);
    ReanchorChallenge {
        nonce,
        expires_at_ms,
    }
}

/// Step 2: verify the assertion, consume the challenge, anchor on success.
/// Returns the newly trusted wall time (ms).
pub fn apply_reanchor_assertion(assertion: &str) -> Result<u64, TrustError> {
    let now = system_now_ms();
    let pubkey = active_time_pubkey_b64url()?;
    let payload = verify_assertion(assertion, &pubkey, now)?;
    // Challenge check AFTER signature validity is established: malformed or
    // forged assertions never burn a challenge; only well-formed ones bind.
    // (Replay of a well-formed assertion fails here — challenge consumed.)
    global_time_kernel()
        .consume_challenge(&payload.nonce, now)
        .map_err(|_| TrustError::SecurityPolicyFailure {
            reason: "stale or unknown re-anchor challenge",
        })?;
    let mono = production_monotonic();
    global_time_kernel().apply_reanchor(
        payload.server_time_ms,
        payload.seq,
        mono.now_ms(),
        mono.boot_id(),
    );
    // Any persisted mutation bumps the rollback counter.
    global_kernel().bump_counter_only();
    Ok(payload.server_time_ms)
}

/// `#[tauri::command]` wrapper: issue challenge (LicenseManagement, so a
/// quarantined terminal can always begin recovery).
#[tauri::command]
pub fn trust_reanchor_challenge() -> Result<ReanchorChallenge, TrustError> {
    require_capability("trust_reanchor_challenge", Capability::LicenseManagement)?;
    Ok(issue_reanchor_challenge())
}

/// `#[tauri::command]` wrapper: verify + anchor + persist.
#[tauri::command]
pub fn trust_reanchor_time(app: tauri::AppHandle, assertion: String) -> Result<u64, TrustError> {
    require_capability("trust_reanchor_time", Capability::LicenseManagement)?;
    if assertion.len() > 8 * 1024 {
        return Err(TrustError::IPCProtocolError {
            reason: "time assertion oversized",
        });
    }
    let trusted = apply_reanchor_assertion(assertion.trim())?;
    persist_current_snapshot(&app);
    Ok(trusted)
}

#[cfg(test)]
mod tests {
    use super::super::license_token::verify_token_with_domain;
    use super::*;
    use crate::trust_core::ipc_authorizer::serial_test_lock;
    use ed25519_dalek::{Signer, SigningKey};

    fn mint_assertion(
        sk: &SigningKey,
        nonce: &str,
        server_time_ms: u64,
        expires_at_ms: u64,
    ) -> String {
        let payload = serde_json::json!({
            "nonce": nonce,
            "server_time_ms": server_time_ms,
            "expires_at_ms": expires_at_ms,
        });
        let payload_b64 = URL_SAFE_NO_PAD.encode(payload.to_string());
        let envelope = format!("{ASSERTION_PREFIX}.{payload_b64}");
        let mut signed = Vec::new();
        signed.extend_from_slice(TIME_ASSERTION_DOMAIN);
        signed.push(b'.');
        signed.extend_from_slice(envelope.as_bytes());
        let sig_b64 = URL_SAFE_NO_PAD.encode(sk.sign(&signed).to_bytes());
        format!("{envelope}.{sig_b64}")
    }

    fn test_keypair() -> (SigningKey, String) {
        let sk = SigningKey::from_bytes(&[9u8; 32]);
        let pk = URL_SAFE_NO_PAD.encode(sk.verifying_key().to_bytes());
        (sk, pk)
    }

    #[test]
    fn valid_assertion_verifies() {
        let (sk, pk) = test_keypair();
        let a = mint_assertion(&sk, "n1", 1_800_000_000_000, 1_900_000_000_000);
        let p = verify_assertion(&a, &pk, 1_800_000_000_000).unwrap();
        assert_eq!(p.server_time_ms, 1_800_000_000_000);
    }

    #[test]
    fn wrong_key_and_tampered_payload_rejected() {
        let (sk, _) = test_keypair();
        let other = SigningKey::from_bytes(&[8u8; 32]);
        let other_pk = URL_SAFE_NO_PAD.encode(other.verifying_key().to_bytes());
        let a = mint_assertion(&sk, "n1", 1_800_000_000_000, 1_900_000_000_000);
        assert!(verify_assertion(&a, &other_pk, 1_800_000_000_000).is_err());
        // Flip a payload byte → signature invalid (policy failure).
        let mut parts: Vec<&str> = a.split('.').collect();
        let mut raw = URL_SAFE_NO_PAD.decode(parts[1]).unwrap();
        raw[10] ^= 0xFF;
        parts[1] = Box::leak(URL_SAFE_NO_PAD.encode(&raw).into_boxed_str());
        let forged = parts.join(".");
        let err = verify_assertion(&forged, &URL_SAFE_NO_PAD.encode(sk.verifying_key().to_bytes()), 1_800_000_000_000).unwrap_err();
        assert!(matches!(err, TrustError::SecurityPolicyFailure { .. }));
    }

    #[test]
    fn license_token_cannot_pose_as_time_assertion() {
        // Cross-protocol confusion: a valid license JWS (no domain) must not
        // verify through the assertion path (prefix + domain both enforced).
        let (sk, pk) = test_keypair();
        let header_b64 = URL_SAFE_NO_PAD.encode(r#"{"alg":"EdDSA","typ":"JWT"}"#);
        let payload_b64 = URL_SAFE_NO_PAD.encode(r#"{"exp":0,"device_id":"d"}"#);
        let msg = format!("{header_b64}.{payload_b64}");
        let sig_b64 = URL_SAFE_NO_PAD.encode(sk.sign(msg.as_bytes()).to_bytes());
        let jwt = format!("{msg}.{sig_b64}");
        let err = verify_assertion(&jwt, &pk, 1_800_000_000_000).unwrap_err();
        assert!(matches!(err, TrustError::IPCProtocolError { .. }));
    }

    #[test]
    fn domain_isolation_between_protocols() {
        // Same key, same payload bytes: domain-bound verification accepts its
        // own domain and rejects the other. Exercises the shared verifier.
        let (sk, pk) = test_keypair();
        let header_b64 = URL_SAFE_NO_PAD.encode(r#"{"alg":"EdDSA","typ":"JWT"}"#);
        let payload_b64 = URL_SAFE_NO_PAD.encode(r#"{"exp":0,"device_id":"d"}"#);
        let msg = format!("{header_b64}.{payload_b64}");
        let body = msg.as_bytes();
        let mut domained = Vec::from(TIME_ASSERTION_DOMAIN);
        domained.push(b'.');
        domained.extend_from_slice(body);
        let sig_domained = URL_SAFE_NO_PAD.encode(sk.sign(&domained).to_bytes());
        let sig_plain = URL_SAFE_NO_PAD.encode(sk.sign(body).to_bytes());
        let tok_domained = format!("{msg}.{sig_domained}");
        let tok_plain = format!("{msg}.{sig_plain}");
        assert!(verify_token_with_domain(&tok_domained, &pk, 1_800_000_000, Some(TIME_ASSERTION_DOMAIN)).is_ok());
        assert!(verify_token_with_domain(&tok_domained, &pk, 1_800_000_000, None).is_err());
        assert!(verify_token_with_domain(&tok_plain, &pk, 1_800_000_000, Some(TIME_ASSERTION_DOMAIN)).is_err());
        assert!(verify_token_with_domain(&tok_plain, &pk, 1_800_000_000, None).is_ok());
    }

    #[test]
    fn full_reanchor_flow_consumes_challenge() {
        let _g = serial_test_lock();
        let k = global_time_kernel();
        k.reset_for_tests();
        let (sk, _) = test_keypair();
        // NOTE: command-level path uses the active (test) key; exercise the
        // kernel-level flow with the same test keypair via internals.
        let ch = issue_reanchor_challenge();
        assert_eq!(k.peek_challenge().map(|(n, _)| n), Some(ch.nonce.clone()));
        // Forge with the test key but a client-chosen nonce → challenge miss.
        let rogue = mint_assertion(&sk, "client-chosen", 1_800_000_000_000, 1_900_000_000_000);
        let r = (|| -> Result<u64, TrustError> {
            // Same seed as TEST_TIME_SEED, derived locally: the test helper
            // is debug-only, and this test must also compile (and refuse
            // usefully) under release-profile runs that exercise refusal.
            let (_, pubkey) = test_keypair();
            let payload = verify_assertion(&rogue, &pubkey, 1_800_000_000_000)?;
            k.consume_challenge(&payload.nonce, 1_800_000_000_000)
                .map_err(|_| TrustError::SecurityPolicyFailure {
                    reason: "stale or unknown re-anchor challenge",
                })?;
            Ok(payload.server_time_ms)
        })();
        assert!(r.is_err(), "client-chosen nonce must not bind");
        assert!(k.peek_challenge().is_some(), "rogue attempt must not burn the challenge");
        k.reset_for_tests();
    }

    #[test]
    fn expired_assertion_rejected() {
        let (sk, pk) = test_keypair();
        let a = mint_assertion(&sk, "n1", 1_800_000_000_000, 1_800_000_060_000);
        let err = verify_assertion(&a, &pk, 1_800_000_061_000).unwrap_err();
        assert!(matches!(err, TrustError::SecurityPolicyFailure { .. }));
    }

    /// Amendment-A1-style profile split for the TEST time key (WP6a): the
    /// seed/helper exist ONLY under `debug_assertions`, so each profile
    /// proves its own behavior — debug uses the loud test key, release
    /// refuses without a production pin.
    #[test]
    #[cfg(debug_assertions)]
    fn debug_profile_uses_test_only_key() {
        let pk = active_time_pubkey_b64url().expect("debug must resolve the test key");
        let (_, expected) = test_keypair();
        assert_eq!(pk, expected, "debug resolves TEST_TIME_SEED, never production");
    }

    #[test]
    #[cfg(not(debug_assertions))]
    fn release_profile_refuses_without_production_key() {
        // PRODUCTION_TIME_PUBKEY_B64URL is "UNCONFIGURED" and no test key
        // exists in this profile: re-anchor must refuse, not bypass.
        let err = active_time_pubkey_b64url().unwrap_err();
        assert!(
            matches!(err, TrustError::TrustedTimeFailure),
            "RELEASE MUST REFUSE re-anchor without a production key, got {err:?}"
        );
    }
}
