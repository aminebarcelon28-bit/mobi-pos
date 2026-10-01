//! Phase 1 — native Ed25519 license-token verification.
//!
//! # Why this module exists (threat-model requirement)
//! The B.2 layout lists no crypto module, but the B.1 threat model
//! ("replayed or forged IPC payloads, including client-supplied license
//! fields") cannot hold if kernel state transitions are driven by
//! JavaScript: a modified webview could simply assert any state. The kernel
//! therefore verifies the existing Ed25519 JWS license tokens itself,
//! mirroring `src/licensing/token.ts` exactly:
//! - compact JWS `header.payload.signature`, `alg == "EdDSA"`,
//! - 32-byte raw public key (default: the production root of trust from
//!   `src/licensing/publicKey.ts`),
//! - 64-byte signature over the ASCII `headerB64.payloadB64` bytes,
//! - `nbf`/`exp` temporal checks with the same 120 s leeway as TypeScript,
//! - hardware binding with the same `'*'` wildcard semantics.
//!
//! # Deliberate limits (Phase 2 owns the clock)
//! Temporal checks use caller-supplied `now_sec` (system clock). A rolled-back
//! wall clock can therefore make an expired token look valid to this module.
//! Signature forgery is still impossible; only the expiry judgment depends on
//! the untrusted clock. Authenticated trusted time (Phase 2) will replace
//! `now_sec` with kernel time. This is reported as a residual gap, not hidden.

use super::ipc_authorizer::TrustError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;

/// Production Ed25519 root of trust (mirrors `ED25519_PUBLIC_KEY_RAW_B64URL`
/// in `src/licensing/publicKey.ts`). The private key lives in Cloudflare
/// Worker secrets and never appears here.
pub const PRODUCTION_PUBLIC_KEY_B64URL: &str = "Kw8ScZAHScD0IOm0Lx2bSYab-OPHkjdWFDbMR4j6Hdc";

/// Temporal leeway in seconds (mirrors `token.ts`).
pub const TOKEN_LEEWAY_SEC: u64 = 120;

#[derive(Debug, Deserialize)]
struct TokenHeader {
    alg: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenPayload {
    #[serde(default)]
    exp: Option<i64>,
    #[serde(default)]
    nbf: Option<i64>,
    #[serde(default)]
    device_id: Option<String>,
}

/// Outcome of a successful signature verification. `expired` is a judgment
/// from the (currently untrusted) caller clock; the caller maps
/// `expired == true` to the `EXPIRED` kernel state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedLicense {
    pub device_id: String,
    pub expired: bool,
}

fn b64url_decode(input: &str) -> Result<Vec<u8>, TrustError> {
    URL_SAFE_NO_PAD
        .decode(input.trim())
        .map_err(|_| TrustError::IPCProtocolError {
            reason: "malformed license token encoding",
        })
}

/// Verify a compact JWS license token. `now_sec` is the caller's wall clock
/// (best effort until Phase 2 trusted time).
pub fn verify_license_token(
    token: &str,
    pubkey_b64url: &str,
    now_sec: u64,
) -> Result<VerifiedLicense, TrustError> {
    verify_token_with_domain(token, pubkey_b64url, now_sec, None)
}

/// Domain-separated verification for non-license assertions (e.g. signed
/// server-time for re-anchor). The domain prefix is prepended to the signed
/// bytes, so a license token can never verify as a time assertion and vice
/// versa — even if both were ever signed by the same key.
pub fn verify_token_with_domain(
    token: &str,
    pubkey_b64url: &str,
    now_sec: u64,
    domain: Option<&[u8]>,
) -> Result<VerifiedLicense, TrustError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(TrustError::IPCProtocolError {
            reason: "empty license token",
        });
    }
    let mut parts = token.split('.');
    let (header_b64, payload_b64, sig_b64) = match (parts.next(), parts.next(), parts.next()) {
        (Some(h), Some(p), Some(s)) if parts.next().is_none() => (h, p, s),
        _ => {
            return Err(TrustError::IPCProtocolError {
                reason: "license token must have 3 parts",
            })
        }
    };

    let header_bytes = b64url_decode(header_b64)?;
    let header: TokenHeader =
        serde_json::from_slice(&header_bytes).map_err(|_| TrustError::IPCProtocolError {
            reason: "unreadable token header",
        })?;
    if header.alg.as_deref() != Some("EdDSA") {
        return Err(TrustError::IPCProtocolError {
            reason: "unsupported token algorithm",
        });
    }

    let pubkey_bytes = b64url_decode(pubkey_b64url)?;
    if pubkey_bytes.len() != 32 {
        return Err(TrustError::IPCProtocolError {
            reason: "invalid Ed25519 public key length",
        });
    }
    let mut pubkey_arr = [0u8; 32];
    pubkey_arr.copy_from_slice(&pubkey_bytes);
    let verifying_key =
        VerifyingKey::from_bytes(&pubkey_arr).map_err(|_| TrustError::IPCProtocolError {
            reason: "invalid Ed25519 public key",
        })?;

    let sig_bytes = b64url_decode(sig_b64)?;
    let signature = Signature::from_slice(&sig_bytes).map_err(|_| TrustError::IPCProtocolError {
        reason: "invalid Ed25519 signature length",
    })?;

    let signing_input = format!("{header_b64}.{payload_b64}");
    let mut signed_bytes: Vec<u8> = Vec::with_capacity(
        domain.map(|d| d.len() + 1).unwrap_or(0) + signing_input.len(),
    );
    if let Some(d) = domain {
        signed_bytes.extend_from_slice(d);
        signed_bytes.push(b'.');
    }
    signed_bytes.extend_from_slice(signing_input.as_bytes());
    verifying_key
        .verify(&signed_bytes, &signature)
        .map_err(|_| TrustError::SecurityPolicyFailure {
            reason: "license signature invalid",
        })?;

    let payload_bytes = b64url_decode(payload_b64)?;
    let payload: TokenPayload =
        serde_json::from_slice(&payload_bytes).map_err(|_| TrustError::IPCProtocolError {
            reason: "unreadable token payload",
        })?;

    let now = now_sec as i64;
    let leeway = TOKEN_LEEWAY_SEC as i64;
    if let Some(nbf) = payload.nbf {
        if now < nbf - leeway {
            return Err(TrustError::SecurityPolicyFailure {
                reason: "license not yet valid",
            });
        }
    }
    let expired = match payload.exp {
        Some(exp) if exp != 0 => now > exp + leeway,
        _ => false,
    };

    Ok(VerifiedLicense {
        device_id: payload.device_id.unwrap_or_default(),
        expired,
    })
}

/// Hardware binding check with the same semantics as TypeScript
/// (`activateWithOfflineToken`): an empty or `'*'` token binding matches any
/// device (demo/dev); otherwise the token binding must equal the NATIVE
/// hardware hash. Callers must pass the natively computed fingerprint — never
/// a client-supplied value.
pub fn device_binding_ok(token_device_id: &str, native_hwid_hash: &str) -> bool {
    token_device_id.is_empty() || token_device_id == "*" || token_device_id == native_hwid_hash
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn test_keypair() -> (SigningKey, String) {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let pub_b64 = URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes());
        (signing, pub_b64)
    }

    fn mint_token(signing: &SigningKey, payload_json: &str) -> String {
        let header_b64 = URL_SAFE_NO_PAD.encode(r#"{"alg":"EdDSA","typ":"JWT"}"#);
        let payload_b64 = URL_SAFE_NO_PAD.encode(payload_json);
        let msg = format!("{header_b64}.{payload_b64}");
        let sig = signing.sign(msg.as_bytes());
        let sig_b64 = URL_SAFE_NO_PAD.encode(sig.to_bytes());
        format!("{msg}.{sig_b64}")
    }

    #[test]
    fn valid_token_verifies_and_reports_device() {
        let (sk, pk) = test_keypair();
        let tok = mint_token(&sk, r#"{"exp":0,"device_id":"abc123"}"#);
        let v = verify_license_token(&tok, &pk, 1_700_000_000).unwrap();
        assert_eq!(v.device_id, "abc123");
        assert!(!v.expired);
    }

    #[test]
    fn tampered_signature_is_policy_failure_not_protocol() {
        let (sk, pk) = test_keypair();
        let mut tok = mint_token(&sk, r#"{"exp":0,"device_id":"abc123"}"#);
        let last = tok.pop().unwrap();
        tok.push(if last == 'A' { 'B' } else { 'A' });
        let err = verify_license_token(&tok, &pk, 1_700_000_000).unwrap_err();
        assert!(matches!(
            err,
            TrustError::SecurityPolicyFailure { .. }
        ));
    }

    #[test]
    fn tampered_payload_breaks_signature() {
        let (sk, pk) = test_keypair();
        let tok = mint_token(&sk, r#"{"exp":0,"device_id":"abc123"}"#);
        let mut parts: Vec<&str> = tok.split('.').collect();
        let mut payload = URL_SAFE_NO_PAD.decode(parts[1]).unwrap();
        payload[5] ^= 0xFF;
        parts[1] = Box::leak(URL_SAFE_NO_PAD.encode(&payload).into_boxed_str());
        let forged = parts.join(".");
        assert!(verify_license_token(&forged, &pk, 1_700_000_000).is_err());
    }

    #[test]
    fn wrong_algorithm_and_structure_are_protocol_errors() {
        let (sk, pk) = test_keypair();
        assert!(matches!(
            verify_license_token("only.two", &pk, 0).unwrap_err(),
            TrustError::IPCProtocolError { .. }
        ));
        assert!(matches!(
            verify_license_token("", &pk, 0).unwrap_err(),
            TrustError::IPCProtocolError { .. }
        ));
        // HS256 header, validly signed body otherwise.
        let header_b64 = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256"}"#);
        let payload_b64 = URL_SAFE_NO_PAD.encode(r#"{"exp":0}"#);
        let msg = format!("{header_b64}.{payload_b64}");
        let sig_b64 = URL_SAFE_NO_PAD.encode(sk.sign(msg.as_bytes()).to_bytes());
        let tok = format!("{msg}.{sig_b64}");
        assert!(matches!(
            verify_license_token(&tok, &pk, 0).unwrap_err(),
            TrustError::IPCProtocolError { .. }
        ));
    }

    #[test]
    fn expiry_judgment_mirrors_typescript_leeway() {
        let (sk, pk) = test_keypair();
        let now = 1_800_000_000u64;
        // Long expired.
        let tok = mint_token(&sk, r#"{"exp":1700000000,"device_id":"d"}"#);
        assert!(verify_license_token(&tok, &pk, now).unwrap().expired);
        // Within leeway (60 s past exp) -> not expired.
        let tok = mint_token(&sk, &format!(r#"{{"exp":{},"device_id":"d"}}"#, now - 60));
        assert!(!verify_license_token(&tok, &pk, now).unwrap().expired);
        // exp == 0 means no expiry (lifetime).
        let tok = mint_token(&sk, r#"{"exp":0,"device_id":"d"}"#);
        assert!(!verify_license_token(&tok, &pk, now).unwrap().expired);
        // Future nbf beyond leeway -> rejected.
        let tok = mint_token(&sk, &format!(r#"{{"nbf":{},"exp":0}}"#, now + 10_000));
        assert!(verify_license_token(&tok, &pk, now).is_err());
    }

    #[test]
    fn device_binding_wildcard_semantics() {
        assert!(device_binding_ok("*", "anything"));
        assert!(device_binding_ok("", "anything"));
        assert!(device_binding_ok("abc", "abc"));
        assert!(!device_binding_ok("abc", "def"));
    }

    #[test]
    fn production_pubkey_decodes_to_32_bytes() {
        let bytes = URL_SAFE_NO_PAD.decode(PRODUCTION_PUBLIC_KEY_B64URL).unwrap();
        assert_eq!(bytes.len(), 32);
    }
}
