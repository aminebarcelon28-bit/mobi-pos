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

/// Production Ed25519 roots of trust (mirror `src/licensing/publicKey.ts`).
/// Private keys live in Cloudflare Worker secrets and never appear here.
///
/// SEC-ROT-02 rotation:
/// - k1: legacy root. Its private half was publicly burned in git history, so it
///   is accepted ONLY for tokens already stored on the device (boot path).
/// - k2: current root. The only key allowed to create a licence (activation path
///   is enforced in TypeScript, which owns activation); the kernel accepts both
///   kids at boot so pre-rotation lifetime customers keep working.
pub const PRODUCTION_PUBLIC_KEY_B64URL: &str = "Kw8ScZAHScD0IOm0Lx2bSYab-OPHkjdWFDbMR4j6Hdc";
pub const PRODUCTION_PUBLIC_KEY_K2_B64URL: &str = "h8uQ-7zm_yApFXmdGKj5QQnRNu39QkMBKxEje4aQGxU";

/// Temporal leeway in seconds (mirrors `token.ts`).
pub const TOKEN_LEEWAY_SEC: u64 = 120;

#[derive(Debug, Deserialize)]
struct TokenHeader {
    alg: Option<String>,
    kid: Option<String>,
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

/// Resolve the pinned public key for a token header's `kid`.
/// Missing kid = legacy k1 token (minted before the kid header existed).
/// Unknown kid = protocol error (fail closed).
pub fn public_key_for_kid(kid: Option<&str>) -> Result<&'static str, TrustError> {
    match kid {
        None | Some("k1") => Ok(PRODUCTION_PUBLIC_KEY_B64URL),
        Some("k2") => Ok(PRODUCTION_PUBLIC_KEY_K2_B64URL),
        Some(_) => Err(TrustError::IPCProtocolError {
            reason: "unknown license token kid",
        }),
    }
}

/// Verify a compact JWS license token, resolving the pinned public key from
/// the header's `kid` (boot semantics: k1 legacy + k2 current both accepted).
/// `now_sec` is the caller's wall clock (best effort until Phase 2 trusted time).
pub fn verify_license_token(token: &str, now_sec: u64) -> Result<VerifiedLicense, TrustError> {
    // RT-1b kernel sunset (red-team round 2, finding E2): the trust kernel
    // accepts ONLY the current k2 root. k1's private half is public, so any
    // k1 acceptance here is a forgeable offline unlock — a modified WebView
    // can call sync_verified_license directly, bypassing the TS online gate.
    // Legacy customers are migrated to a k2 token by the TS boot flow
    // (silent re-activation after a DB-backed online verify) before the
    // kernel ever sees their token, so no legitimate customer is locked out.
    verify_token_resolving_kid(token, now_sec, |kid| match kid {
        Some("k2") => Ok(PRODUCTION_PUBLIC_KEY_K2_B64URL.to_string()),
        None | Some("k1") => Err(TrustError::SecurityPolicyFailure {
            reason: "legacy k1 tokens are sunset in the trust kernel; re-activate to migrate",
        }),
        // Unknown kids keep their protocol-error classification (fail closed,
        // distinct from the sunset policy failure).
        other => Err(public_key_for_kid(other).unwrap_err()),
    })
}

/// Verify against an explicitly supplied public key (tests, domain-separated
/// time assertions). No kid resolution.
pub fn verify_license_token_with_key(
    token: &str,
    pubkey_b64url: &str,
    now_sec: u64,
) -> Result<VerifiedLicense, TrustError> {
    verify_token_with_domain(token, pubkey_b64url, now_sec, None)
}

/// Kid-resolving verification with an injected resolver (tests inject a
/// synthetic root map; production injects the pinned `public_key_for_kid`).
/// The signature is always verified against the key the kid resolves to, so
/// key confusion (sign with k2's key, claim kid k1) is impossible.
fn verify_token_resolving_kid<F>(
    token: &str,
    now_sec: u64,
    resolve_kid: F,
) -> Result<VerifiedLicense, TrustError>
where
    F: Fn(Option<&str>) -> Result<String, TrustError>,
{
    let (header_b64, payload_b64, sig_b64) = split_token(token)?;
    // SEC-ROT-02 optimization: the header is parsed exactly once — the kid
    // resolution and the algorithm check share a single decode/deserialize.
    let header = parse_token_header(header_b64)?;
    if header.alg.as_deref() != Some("EdDSA") {
        return Err(TrustError::IPCProtocolError {
            reason: "unsupported token algorithm",
        });
    }
    let pubkey = resolve_kid(header.kid.as_deref())?;
    verify_parts(
        &header,
        header_b64,
        payload_b64,
        sig_b64,
        &pubkey,
        now_sec,
        None,
    )
}

/// Split a compact JWS into its three parts. An empty token and a wrong
/// segment count are distinct protocol errors.
fn split_token(token: &str) -> Result<(&str, &str, &str), TrustError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(TrustError::IPCProtocolError {
            reason: "empty license token",
        });
    }
    let mut parts = token.split('.');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(h), Some(p), Some(s)) if parts.next().is_none() => Ok((h, p, s)),
        _ => Err(TrustError::IPCProtocolError {
            reason: "license token must have 3 parts",
        }),
    }
}

/// Decode + deserialize the token header (single parse, shared by all paths).
fn parse_token_header(header_b64: &str) -> Result<TokenHeader, TrustError> {
    let header_bytes = b64url_decode(header_b64)?;
    serde_json::from_slice(&header_bytes).map_err(|_| TrustError::IPCProtocolError {
        reason: "unreadable token header",
    })
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
    let (header_b64, payload_b64, sig_b64) = split_token(token)?;
    let header = parse_token_header(header_b64)?;
    verify_parts(
        &header,
        header_b64,
        payload_b64,
        sig_b64,
        pubkey_b64url,
        now_sec,
        domain,
    )
}

/// Shared verification core: algorithm check, signature over the (optionally
/// domain-prefixed) signing input, then payload decode and temporal judgment.
/// The caller has already split the token and parsed the header exactly once.
fn verify_parts(
    header: &TokenHeader,
    header_b64: &str,
    payload_b64: &str,
    sig_b64: &str,
    pubkey_b64url: &str,
    now_sec: u64,
    domain: Option<&[u8]>,
) -> Result<VerifiedLicense, TrustError> {
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

    // SEC-ROT-02 hardening (red-team finding RT-1): a k1-signed token with an
    // empty or wildcard device binding is a universal skeleton key — k1's
    // private half is public, so anyone could mint one token that unlocks
    // every install at boot. Legacy tokens were all issued device-bound;
    // k2 tokens may keep the wildcard (only the vendor holds the k2 key).
    let is_legacy_k1 = header.kid.as_deref().map_or(true, |k| k == "k1");
    let unbound = matches!(payload.device_id.as_deref(), None | Some("") | Some("*"));
    if is_legacy_k1 && unbound {
        return Err(TrustError::SecurityPolicyFailure {
            reason: "legacy k1 token must be device-bound",
        });
    }

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
        let v = verify_license_token_with_key(&tok, &pk, 1_700_000_000).unwrap();
        assert_eq!(v.device_id, "abc123");
        assert!(!v.expired);
    }

    #[test]
    fn tampered_signature_is_policy_failure_not_protocol() {
        let (sk, pk) = test_keypair();
        let mut tok = mint_token(&sk, r#"{"exp":0,"device_id":"abc123"}"#);
        let last = tok.pop().unwrap();
        tok.push(if last == 'A' { 'B' } else { 'A' });
        let err = verify_license_token_with_key(&tok, &pk, 1_700_000_000).unwrap_err();
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
        assert!(verify_license_token_with_key(&forged, &pk, 1_700_000_000).is_err());
    }

    #[test]
    fn wrong_algorithm_and_structure_are_protocol_errors() {
        let (sk, pk) = test_keypair();
        assert!(matches!(
            verify_license_token_with_key("only.two", &pk, 0).unwrap_err(),
            TrustError::IPCProtocolError { .. }
        ));
        assert!(matches!(
            verify_license_token_with_key("", &pk, 0).unwrap_err(),
            TrustError::IPCProtocolError { .. }
        ));
        // HS256 header, validly signed body otherwise.
        let header_b64 = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256"}"#);
        let payload_b64 = URL_SAFE_NO_PAD.encode(r#"{"exp":0}"#);
        let msg = format!("{header_b64}.{payload_b64}");
        let sig_b64 = URL_SAFE_NO_PAD.encode(sk.sign(msg.as_bytes()).to_bytes());
        let tok = format!("{msg}.{sig_b64}");
        assert!(matches!(
            verify_license_token_with_key(&tok, &pk, 0).unwrap_err(),
            TrustError::IPCProtocolError { .. }
        ));
    }

    #[test]
    fn expiry_judgment_mirrors_typescript_leeway() {
        let (sk, pk) = test_keypair();
        let now = 1_800_000_000u64;
        // Long expired.
        let tok = mint_token(&sk, r#"{"exp":1700000000,"device_id":"d"}"#);
        assert!(verify_license_token_with_key(&tok, &pk, now).unwrap().expired);
        // Within leeway (60 s past exp) -> not expired.
        let tok = mint_token(&sk, &format!(r#"{{"exp":{},"device_id":"d"}}"#, now - 60));
        assert!(!verify_license_token_with_key(&tok, &pk, now).unwrap().expired);
        // exp == 0 means no expiry (lifetime).
        let tok = mint_token(&sk, r#"{"exp":0,"device_id":"d"}"#);
        assert!(!verify_license_token_with_key(&tok, &pk, now).unwrap().expired);
        // Future nbf beyond leeway -> rejected.
        let tok = mint_token(&sk, &format!(r#"{{"nbf":{},"exp":0,"device_id":"d"}}"#, now + 10_000));
        assert!(verify_license_token_with_key(&tok, &pk, now).is_err());
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
        let k2 = URL_SAFE_NO_PAD.decode(PRODUCTION_PUBLIC_KEY_K2_B64URL).unwrap();
        assert_eq!(k2.len(), 32);
    }

    #[test]
    fn kid_resolution_selects_pinned_roots() {
        assert_eq!(public_key_for_kid(None).unwrap(), PRODUCTION_PUBLIC_KEY_B64URL);
        assert_eq!(public_key_for_kid(Some("k1")).unwrap(), PRODUCTION_PUBLIC_KEY_B64URL);
        assert_eq!(public_key_for_kid(Some("k2")).unwrap(), PRODUCTION_PUBLIC_KEY_K2_B64URL);
        assert!(matches!(
            public_key_for_kid(Some("k3")),
            Err(TrustError::IPCProtocolError { .. })
        ));
    }

    #[test]
    fn kid_k2_token_verifies_at_boot_without_explicit_key() {
        // A k2-signed token (kid header) verifies through the kid-resolving
        // path against the key that kid resolves to (synthetic root map — the
        // production private keys never appear in tests).
        let signing = SigningKey::from_bytes(&[9u8; 32]);
        let k2_pub = URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes());
        let header = r#"{"alg":"EdDSA","typ":"JWT","kid":"k2"}"#;
        let payload = r#"{"exp":0,"device_id":"dev2"}"#;
        let header_b64 = URL_SAFE_NO_PAD.encode(header);
        let payload_b64 = URL_SAFE_NO_PAD.encode(payload);
        let msg = format!("{header_b64}.{payload_b64}");
        let sig = signing.sign(msg.as_bytes());
        let tok = format!("{msg}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()));
        let v = verify_token_resolving_kid(&tok, 1_700_000_000, |kid| {
            match kid {
                Some("k2") => Ok(k2_pub.clone()),
                _ => Ok(PRODUCTION_PUBLIC_KEY_B64URL.to_string()),
            }
        })
        .unwrap();
        assert_eq!(v.device_id, "dev2");
    }

    #[test]
    fn kid_signed_by_k2_key_but_claiming_k1_is_rejected() {
        // A k2 key's signature over a kid:"k1" header must NOT verify: the
        // resolver pins k1's public key for that header, so the signature check
        // fails. Key confusion is impossible.
        let signing = SigningKey::from_bytes(&[9u8; 32]);
        let header = r#"{"alg":"EdDSA","typ":"JWT","kid":"k1"}"#;
        let payload = r#"{"exp":0,"device_id":"dev2"}"#;
        let header_b64 = URL_SAFE_NO_PAD.encode(header);
        let payload_b64 = URL_SAFE_NO_PAD.encode(payload);
        let msg = format!("{header_b64}.{payload_b64}");
        let sig = signing.sign(msg.as_bytes());
        let tok = format!("{msg}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()));
        assert!(verify_license_token(&tok, 1_700_000_000).is_err());
    }

    #[test]
    fn legacy_k1_wildcard_binding_is_rejected_at_boot() {
        // RT-1: k1's private half is public — a k1 token with a wildcard (or
        // empty) device binding would be a universal skeleton key. It must be
        // rejected even though the signature itself is valid.
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let tok = mint_token(&signing, r#"{"exp":0,"device_id":"*"}"#);
        let mut tok_with_kid = tok.split('.').map(str::to_string).collect::<Vec<_>>();
        tok_with_kid[0] = URL_SAFE_NO_PAD.encode(r#"{"alg":"EdDSA","typ":"JWT","kid":"k1"}"#);
        let forged = tok_with_kid.join(".");
        // NOTE: signed over the ORIGINAL header bytes, so the header swap must
        // break the signature — rebuild properly instead:
        let header_b64 = URL_SAFE_NO_PAD.encode(r#"{"alg":"EdDSA","typ":"JWT","kid":"k1"}"#);
        let payload_b64 = URL_SAFE_NO_PAD.encode(r#"{"exp":0,"device_id":"*"}"#);
        let msg = format!("{header_b64}.{payload_b64}");
        let sig = signing.sign(msg.as_bytes());
        let properly_forged = format!("{msg}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()));
        let _ = forged; // (unused variant kept for clarity)
        assert!(matches!(
            verify_license_token(&properly_forged, 1_700_000_000),
            Err(TrustError::SecurityPolicyFailure { .. })
        ));
        // Empty binding is equally rejected.
        let payload_b64b = URL_SAFE_NO_PAD.encode(r#"{"exp":0,"device_id":""}"#);
        let msg_b = format!("{header_b64}.{payload_b64b}");
        let sig_b = signing.sign(msg_b.as_bytes());
        let forged_b = format!("{msg_b}.{}", URL_SAFE_NO_PAD.encode(sig_b.to_bytes()));
        assert!(verify_license_token(&forged_b, 1_700_000_000).is_err());
    }

    #[test]
    fn legacy_k1_is_sunset_in_kernel_even_when_device_bound() {
        // RT-1b round 2 (E2): the kernel must reject EVERY k1 token — even a
        // properly device-bound one — because k1's private half is public and
        // a modified WebView could sync a forged token directly, bypassing
        // the TS online gate. Legacy customers reach the kernel only as k2
        // (migrated by the TS boot flow).
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let header_b64 = URL_SAFE_NO_PAD.encode(r#"{"alg":"EdDSA","typ":"JWT","kid":"k1"}"#);
        let payload_b64 = URL_SAFE_NO_PAD.encode(r#"{"exp":0,"device_id":"realdevicehash123"}"#);
        let msg = format!("{header_b64}.{payload_b64}");
        let sig = signing.sign(msg.as_bytes());
        let tok = format!("{msg}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()));
        assert!(matches!(
            verify_license_token(&tok, 1_700_000_000),
            Err(TrustError::SecurityPolicyFailure { .. })
        ));
        // ...and a missing kid (pre-kid legacy shape) is equally sunset.
        let header_b64b = URL_SAFE_NO_PAD.encode(r#"{"alg":"EdDSA","typ":"JWT"}"#);
        let msg_b = format!("{header_b64b}.{payload_b64}");
        let sig_b = signing.sign(msg_b.as_bytes());
        let tok_b = format!("{msg_b}.{}", URL_SAFE_NO_PAD.encode(sig_b.to_bytes()));
        assert!(verify_license_token(&tok_b, 1_700_000_000).is_err());
    }

    #[test]
    fn kernel_accepts_k2_device_bound_token() {
        // The sunset must not lock out current-root customers.
        let signing = SigningKey::from_bytes(&[9u8; 32]);
        let k2_pub = URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes());
        let header_b64 = URL_SAFE_NO_PAD.encode(r#"{"alg":"EdDSA","typ":"JWT","kid":"k2"}"#);
        let payload_b64 = URL_SAFE_NO_PAD.encode(r#"{"exp":0,"device_id":"realdevicehash123"}"#);
        let msg = format!("{header_b64}.{payload_b64}");
        let sig = signing.sign(msg.as_bytes());
        let tok = format!("{msg}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()));
        let v = verify_token_resolving_kid(&tok, 1_700_000_000, |kid| {
            match kid {
                Some("k2") => Ok(k2_pub.clone()),
                _ => Ok(PRODUCTION_PUBLIC_KEY_B64URL.to_string()),
            }
        })
        .unwrap();
        assert_eq!(v.device_id, "realdevicehash123");
    }

    #[test]
    fn k2_wildcard_binding_remains_allowed() {
        // Only the vendor holds the k2 private key, so a k2 wildcard token is
        // vendor-minted by definition (demo/dev flows) and stays legal.
        let signing = SigningKey::from_bytes(&[9u8; 32]);
        let k2_pub = URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes());
        let header_b64 = URL_SAFE_NO_PAD.encode(r#"{"alg":"EdDSA","typ":"JWT","kid":"k2"}"#);
        let payload_b64 = URL_SAFE_NO_PAD.encode(r#"{"exp":0,"device_id":"*"}"#);
        let msg = format!("{header_b64}.{payload_b64}");
        let sig = signing.sign(msg.as_bytes());
        let tok = format!("{msg}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()));
        let v = verify_token_resolving_kid(&tok, 1_700_000_000, |kid| {
            match kid {
                Some("k2") => Ok(k2_pub.clone()),
                _ => Ok(PRODUCTION_PUBLIC_KEY_B64URL.to_string()),
            }
        })
        .unwrap();
        assert_eq!(v.device_id, "*");
    }

    #[test]
    fn unknown_kid_is_protocol_error_even_before_signature() {
        let signing = SigningKey::from_bytes(&[9u8; 32]);
        let header = r#"{"alg":"EdDSA","typ":"JWT","kid":"k9"}"#;
        let payload = r#"{"exp":0}"#;
        let header_b64 = URL_SAFE_NO_PAD.encode(header);
        let payload_b64 = URL_SAFE_NO_PAD.encode(payload);
        let msg = format!("{header_b64}.{payload_b64}");
        let sig = signing.sign(msg.as_bytes());
        let tok = format!("{msg}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()));
        assert!(matches!(
            verify_license_token(&tok, 1_700_000_000),
            Err(TrustError::IPCProtocolError { .. })
        ));
    }

    #[test]
    fn extra_token_segment_is_rejected() {
        // The 3-part guard (`parts.next().is_none()`) must reject a 4-part
        // token even when the first three parts form a valid JWS. If the guard
        // were forced to `true`, the trailing segment would be silently
        // ignored and the token would verify.
        let (sk, pk) = test_keypair();
        let tok = mint_token(&sk, r#"{"exp":0,"device_id":"abc123"}"#);
        let forged = format!("{tok}.deadbeef");
        assert!(matches!(
            verify_license_token_with_key(&forged, &pk, 1_700_000_000).unwrap_err(),
            TrustError::IPCProtocolError { .. }
        ));
    }

    #[test]
    fn nbf_at_leeway_boundary_is_accepted() {
        // now == nbf - leeway is the last accepted instant: `now < nbf - leeway`
        // is false, so the token passes. Pins the strict `<` (a `<=` mutant
        // would reject at exact equality).
        let (sk, pk) = test_keypair();
        let now = 1_800_000_000u64;
        let nbf = now + TOKEN_LEEWAY_SEC; // nbf - leeway == now
        let tok = mint_token(&sk, &format!(r#"{{"nbf":{nbf},"exp":0,"device_id":"d"}}"#));
        let v = verify_license_token_with_key(&tok, &pk, now).unwrap();
        assert!(!v.expired);
    }

    #[test]
    fn nbf_within_leeway_is_accepted() {
        // A `nbf` slightly in the future but within the leeway is accepted.
        // Pins `nbf - leeway` (a `+` mutant widens the window forward and would
        // reject this token).
        let (sk, pk) = test_keypair();
        let now = 1_800_000_000u64;
        let nbf = now + 60; // < leeway of 120 s
        let tok = mint_token(&sk, &format!(r#"{{"nbf":{nbf},"exp":0,"device_id":"d"}}"#));
        assert!(verify_license_token_with_key(&tok, &pk, now).is_ok());
    }

    #[test]
    fn exp_at_leeway_boundary_is_not_expired() {
        // now == exp + leeway is the last non-expired instant: `now > exp + leeway`
        // is false. Pins the strict `>` (a `>=` mutant would report expired at
        // exact equality).
        let (sk, pk) = test_keypair();
        let now = 1_800_000_000u64;
        let exp = now - TOKEN_LEEWAY_SEC; // exp + leeway == now
        let tok = mint_token(&sk, &format!(r#"{{"exp":{exp},"device_id":"d"}}"#));
        let v = verify_license_token_with_key(&tok, &pk, now).unwrap();
        assert!(!v.expired);
    }
}
