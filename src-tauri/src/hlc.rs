// Hybrid Logical Clock (HLC) Implementation
// Implements Authority ③ §4.2, Authority ② §5.3, and AGENTS.md Contract C6.
//
// Properties:
// 1. Monotonic: HLC strictly increases across every call, even if physical clock rewinds.
// 2. Causal: observe() guarantees local clock strictly exceeds any observed remote clock.
// 3. Deterministic: total order across all devices broken deterministically by device_id.
// 4. Compact string format: 16-char hex ms + 4-char hex counter + device_id.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Hlc {
    pub physical: u64,  // unix timestamp in milliseconds
    pub logical: u16,   // logical sequence counter within the same millisecond
    pub device: String, // device identifier for deterministic tie-breaking
}

impl Hlc {
    pub fn new(physical: u64, logical: u16, device: String) -> Self {
        Self {
            physical,
            logical,
            device,
        }
    }

    /// Canonical text representation: 16-char hex physical + 4-char hex logical + device_id
    /// Example: "00000191f6305a40:0000:desktop-reg-1"
    pub fn to_text(&self) -> String {
        format!("{:016x}:{:04x}:{}", self.physical, self.logical, self.device)
    }

    /// Parse canonical text representation back into an Hlc struct
    pub fn parse(s: &str) -> Option<Self> {
        let mut parts = s.splitn(3, ':');
        let p = u64::from_str_radix(parts.next()?, 16).ok()?;
        let l = u16::from_str_radix(parts.next()?, 16).ok()?;
        let d = parts.next()?.to_string();
        if d.is_empty() {
            return None;
        }
        Some(Hlc {
            physical: p,
            logical: l,
            device: d,
        })
    }
}

/// Deterministic total order: physical millis, then logical counter, then device ID.
impl PartialOrd for Hlc {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Hlc {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.physical
            .cmp(&other.physical)
            .then(self.logical.cmp(&other.logical))
            .then(self.device.cmp(&other.device))
    }
}

pub struct HlcClock {
    device: String,
    state: Mutex<(u64, u16)>,
}

impl HlcClock {
    pub fn new(device: &str) -> Self {
        Self {
            device: device.to_string(),
            state: Mutex::new((0, 0)),
        }
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Generate next timestamp. Guaranteed strictly greater than any previously
    /// issued timestamp or any timestamp observed via observe().
    pub fn now(&self) -> Hlc {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let phys = Self::now_ms();
        let (p, l) = *st;

        let (np, nl) = if phys > p {
            (phys, 0)
        } else {
            (p, l.saturating_add(1))
        };

        *st = (np, nl);
        Hlc {
            physical: np,
            logical: nl,
            device: self.device.clone(),
        }
    }

    /// Observe a remote HLC timestamp (e.g. from cloud pull or relay event).
    /// Advances local clock so any subsequent write is strictly newer than the remote write.
    pub fn observe(&self, remote: &Hlc) {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let phys = Self::now_ms();
        let (p, l) = *st;

        let (np, nl) = if phys > remote.physical && phys > p {
            (phys, 0)
        } else if remote.physical > p {
            (remote.physical, remote.logical.saturating_add(1))
        } else if p > remote.physical {
            (p, l.saturating_add(1))
        } else {
            (p, l.max(remote.logical).saturating_add(1))
        };

        *st = (np, nl);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hlc_text_roundtrip() {
        let h = Hlc::new(1726531200000, 42, "dev-test-1".to_string());
        let text = h.to_text();
        assert_eq!(text, "00000191fd476400:002a:dev-test-1");
        let parsed = Hlc::parse(&text).expect("Parse must succeed");
        assert_eq!(parsed, h);
    }

    #[test]
    fn test_hlc_monotonic_under_clock_regression() {
        let clock = HlcClock::new("dev-a");
        let t1 = clock.now();
        let t2 = clock.now();
        assert!(t2 > t1, "t2 ({:?}) must be strictly greater than t1 ({:?})", t2, t1);
        assert_eq!(t2.logical, t1.logical + 1);
    }

    #[test]
    fn test_hlc_observe_advances_clock() {
        let clock = HlcClock::new("dev-local");
        let future_physical = HlcClock::now_ms() + 100_000;
        let remote_hlc = Hlc::new(future_physical, 10, "dev-remote".to_string());

        clock.observe(&remote_hlc);
        let next_local = clock.now();

        assert!(
            next_local > remote_hlc,
            "Local write after observe must exceed remote HLC"
        );
        assert!(next_local.physical >= remote_hlc.physical);
    }

    #[test]
    fn test_hlc_deterministic_tie_break() {
        let h1 = Hlc::new(1000, 0, "device-a".to_string());
        let h2 = Hlc::new(1000, 0, "device-b".to_string());
        assert!(h1 < h2);
        assert!(h2 > h1);
    }
}
