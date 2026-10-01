//! Phase 2 — sleep-inclusive monotonic clocks behind a testable trait.
//!
//! `std::time::Instant` is BANNED for trusted time: it is not guaranteed to
//! count time spent asleep on every OS. Each platform below names its exact
//! sleep-inclusive source:
//!
//! | OS | Source | Notes |
//! |----|--------|-------|
//! | Windows | `GetTickCount64` (interrupt time) | Includes suspend; `QueryUnbiasedInterruptTime` deliberately NOT used (excludes suspend) |
//! | Linux / Android | `clock_gettime(CLOCK_BOOTTIME)` | Includes suspend; `CLOCK_MONOTONIC` does not |
//! | macOS / iOS | `mach_continuous_time` | Advances across sleep; converted via `mach_timebase_info` |
//!
//! Boot-session identity (`boot_id`) per OS:
//!
//! | OS | Primary signal | Fallback |
//! |----|---------------|----------|
//! | Linux / Android | `/proc/sys/kernel/random/boot_id` | BOOTTIME-regression + ΔM/ΔW consistency |
//! | macOS / iOS | `kern.boottime` sysctl | `mach_continuous_time` regression + ΔM/ΔW consistency |
//! | Windows | (none cheap/stable — WMI noted as future) | `GetTickCount64` regression + ΔM/ΔW consistency |
//!
//! Android/iOS bodies are compiled per-cfg and covered by the `ManualClock`
//! fake in unit tests; they are reported as NOT verified on-device (no mobile
//! hardware in CI).

/// Sleep-inclusive monotonic millisecond source.
pub trait MonotonicSource: Send + Sync {
    /// Milliseconds on a clock that advances across device sleep.
    /// Returns `None` when the source is unavailable (fail closed upstream).
    fn now_ms(&self) -> Option<u64>;
    /// Stable boot-session identifier, when the OS provides one cheaply.
    fn boot_id(&self) -> Option<String> {
        None
    }
    /// Human-readable source name for diagnostics (never a trust input).
    fn source_name(&self) -> &'static str;
}

// ---------------------------------------------------------------------------
// Production sources
// ---------------------------------------------------------------------------

/// Windows: `GetTickCount64` (sysinfoapi interrupt time) — includes suspend.
/// `QueryUnbiasedInterruptTime` is deliberately NOT used (excludes suspend).
#[cfg(target_os = "windows")]
pub struct WindowsMonotonic;

#[cfg(target_os = "windows")]
impl MonotonicSource for WindowsMonotonic {
    fn now_ms(&self) -> Option<u64> {
        // SAFETY: GetTickCount64 takes no arguments and cannot fail.
        Some(unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() })
    }

    fn source_name(&self) -> &'static str {
        "windows:GetTickCount64"
    }
}

/// Linux/Android: `CLOCK_BOOTTIME` — includes suspend.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub struct BoottimeMonotonic;

#[cfg(any(target_os = "linux", target_os = "android"))]
impl MonotonicSource for BoottimeMonotonic {
    fn now_ms(&self) -> Option<u64> {
        let mut ts = std::mem::MaybeUninit::<libc::timespec>::uninit();
        // SAFETY: ts is a valid out-pointer; CLOCK_BOOTTIME is valid on
        // Linux ≥ 2.6.39 and Android.
        let rc = unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, ts.as_mut_ptr()) };
        if rc != 0 {
            return None;
        }
        let ts = unsafe { ts.assume_init() };
        u64::try_from(ts.tv_sec)
            .ok()?
            .checked_mul(1_000)?
            .checked_add((ts.tv_nsec as u64) / 1_000_000)
    }

    fn boot_id(&self) -> Option<String> {
        std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    fn source_name(&self) -> &'static str {
        "linux:CLOCK_BOOTTIME"
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
const _: () = {
    // Compile-time proof the constant exists on these targets.
    let _ = libc::CLOCK_BOOTTIME;
};

/// macOS/iOS: `mach_continuous_time` — advances across sleep.
#[cfg(target_vendor = "apple")]
pub struct MachContinuousMonotonic;

#[cfg(target_vendor = "apple")]
#[repr(C)]
struct MachTimebaseInfo {
    numer: u32,
    denom: u32,
}

#[cfg(target_vendor = "apple")]
extern "C" {
    fn mach_continuous_time() -> u64;
    fn mach_timebase_info(info: *mut MachTimebaseInfo) -> i32;
    fn sysctlbyname(
        name: *const core::ffi::c_char,
        oldp: *mut core::ffi::c_void,
        oldlenp: *mut usize,
        newp: *mut core::ffi::c_void,
        newlen: usize,
    ) -> core::ffi::c_int;
}

#[cfg(target_vendor = "apple")]
#[repr(C)]
struct AppleTimeval {
    tv_sec: i64,
    tv_usec: i32,
}

#[cfg(target_vendor = "apple")]
impl MonotonicSource for MachContinuousMonotonic {
    fn now_ms(&self) -> Option<u64> {
        let mut info = MachTimebaseInfo { numer: 0, denom: 0 };
        // SAFETY: mach_timebase_info writes a fixed-size struct.
        let rc = unsafe { mach_timebase_info(&mut info as *mut _) };
        if rc != 0 || info.numer == 0 || info.denom == 0 {
            return None;
        }
        // SAFETY: no arguments, cannot fail.
        let ticks = unsafe { mach_continuous_time() };
        (ticks as u128)
            .checked_mul(info.numer as u128)?
            .checked_div(info.denom as u128)?
            .checked_div(1_000_000)?
            .try_into()
            .ok()
    }

    /// `kern.boottime` as the primary boot signal (best effort).
    fn boot_id(&self) -> Option<String> {
        let name = core::ffi::CStr::from_bytes_with_nul(b"kern.boottime\0").ok()?;
        let mut tv = AppleTimeval { tv_sec: 0, tv_usec: 0 };
        let mut len = core::mem::size_of::<AppleTimeval>();
        // SAFETY: name is NUL-terminated; tv/len are valid out-pointers.
        let rc = unsafe {
            sysctlbyname(
                name.as_ptr(),
                &mut tv as *mut _ as *mut core::ffi::c_void,
                &mut len as *mut _,
                core::ptr::null_mut(),
                0,
            )
        };
        if rc != 0 {
            return None;
        }
        Some(format!("apple-boot:{}:{}", tv.tv_sec, tv.tv_usec))
    }

    fn source_name(&self) -> &'static str {
        "apple:mach_continuous_time"
    }
}

/// Process-wide production source for the current target.
#[cfg(target_os = "windows")]
pub fn production_monotonic() -> impl MonotonicSource {
    WindowsMonotonic
}
#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn production_monotonic() -> impl MonotonicSource {
    BoottimeMonotonic
}
#[cfg(target_vendor = "apple")]
pub fn production_monotonic() -> impl MonotonicSource {
    MachContinuousMonotonic
}
/// Fallback for unlisted targets: no trusted monotonic source. The engine
/// treats `None` as unavailable and fails closed; port owners must add a
/// verified source here.
#[cfg(not(any(
    target_os = "windows",
    target_os = "linux",
    target_os = "android",
    target_vendor = "apple"
)))]
pub fn production_monotonic() -> impl MonotonicSource {
    NoMonotonic
}

#[cfg(not(any(
    target_os = "windows",
    target_os = "linux",
    target_os = "android",
    target_vendor = "apple"
)))]
struct NoMonotonic;

#[cfg(not(any(
    target_os = "windows",
    target_os = "linux",
    target_os = "android",
    target_vendor = "apple"
)))]
impl MonotonicSource for NoMonotonic {
    fn now_ms(&self) -> Option<u64> {
        None
    }
    fn source_name(&self) -> &'static str {
        "none:unavailable"
    }
}

// ---------------------------------------------------------------------------
// Test fake
// ---------------------------------------------------------------------------

/// Manually advanced clock for unit tests (all platform logic is exercised
/// through this fake; per-OS bodies are NOT verified on-device).
#[derive(Debug, Clone, Copy)]
pub struct ManualClock {
    ms: u64,
    boot: Option<&'static str>,
}

impl ManualClock {
    pub fn new(ms: u64) -> Self {
        Self { ms, boot: None }
    }

    pub fn with_boot(ms: u64, boot: &'static str) -> Self {
        Self {
            ms,
            boot: Some(boot),
        }
    }

    pub fn advance(&mut self, delta_ms: u64) {
        self.ms = self.ms.saturating_add(delta_ms);
    }

    pub fn set(&mut self, ms: u64) {
        self.ms = ms;
    }
}

impl MonotonicSource for ManualClock {
    fn now_ms(&self) -> Option<u64> {
        Some(self.ms)
    }

    fn boot_id(&self) -> Option<String> {
        self.boot.map(|s| s.to_string())
    }

    fn source_name(&self) -> &'static str {
        "test:manual"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_clock_advances_and_reports_boot() {
        let mut c = ManualClock::with_boot(1_000, "boot-A");
        assert_eq!(c.now_ms(), Some(1_000));
        assert_eq!(c.boot_id().as_deref(), Some("boot-A"));
        c.advance(500);
        assert_eq!(c.now_ms(), Some(1_500));
    }

    #[test]
    fn production_source_reports_sane_value_on_host() {
        // Host-only sanity: the call must succeed and be self-consistent.
        // This exercises the real per-OS body on the dev/CI machine; mobile
        // bodies remain NOT verified on-device (see module docs).
        let src = production_monotonic();
        let a = src.now_ms().expect("production clock must be available on host");
        let b = src.now_ms().expect("production clock must be available on host");
        assert!(b >= a, "monotonic source moved backwards");
        assert!(!src.source_name().is_empty());
    }
}
