//! Phase 1 — trusted-time interface, stub only (B.12).
//!
//! Only the trait is created in Phase 1. The stub MUST return
//! [`TrustError::TrustedTimeFailure`](super::ipc_authorizer::TrustError) on
//! every call and MUST NOT fall back to system time: a stub that falls back
//! to `SystemTime::now()` would reintroduce clock rollback through the kernel
//! path (gap G-18). Full trusted-time evaluation is Phase 2 and must not
//! replace the current TypeScript `clockGuard` yet.

use super::ipc_authorizer::TrustError;

/// Source of monotonic, sleep-inclusive, authenticated wall-clock judgments.
/// Phase 2 implements the real engine (boot sessions, server observations,
/// quarantine); Phase 1 only defines the seam so the kernel never reads the
/// wall clock directly.
pub trait TrustedTimeProvider: Send + Sync {
    /// Best-known trusted UTC instant in milliseconds. Fails closed.
    fn now_utc_ms(&self) -> Result<u64, TrustError>;
}

/// Fail-closed stub: always refuses. Kernel paths that need trusted time
/// today must propagate this error, never substitute `SystemTime::now()`.
pub struct FailClosedStub;

impl TrustedTimeProvider for FailClosedStub {
    fn now_utc_ms(&self) -> Result<u64, TrustError> {
        Err(TrustError::TrustedTimeFailure)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_never_returns_time() {
        let stub = FailClosedStub;
        for _ in 0..3 {
            assert!(matches!(
                stub.now_utc_ms(),
                Err(TrustError::TrustedTimeFailure)
            ));
        }
    }
}
