//! R-2 standalone money gate.
//!
//! Includes the canonical primitive by path — there is exactly ONE Money
//! implementation (`src-tauri/src/money.rs`); this crate only re-hosts it
//! (plus its in-module tests, incl. the C-4 shared display fixture) so
//! `cargo test -p money-gate` passes on a clean checkout TODAY, independent
//! of other lanes' breakage. If `money.rs` ever gains a `crate::` dependency
//! this crate fails to compile BY DESIGN — the primitive must stay
//! self-contained (serde/serde_json/std only).

#[path = "../../../src-tauri/src/money.rs"]
mod money;

pub use money::{Money, MoneyError, CURRENCY_CODE, CURRENCY_EXPONENT};
