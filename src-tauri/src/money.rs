//! Money — the SINGLE money primitive, Rust side (Stage A, Zero-Drift Mandate v4).
//!
//! Unit of account: integer minor units of DZD (1 dinar = 100 minor units).
//! Mirrors `src/utils/money.ts` (TS). Laws are identical:
//! - Construction only via [`Money::from_minor`] / [`Money::from_user_input`]
//!   / [`Money::from_json_str`]. No float ever touches a value.
//! - Entry parses the decimal STRING directly (PD-22); display renders via
//!   integer div/rem + zero-pad (PD-23).
//! - This file is float-free: no `f64`, no `as f64`, no float parsing.
//!   Digit runs parse via exact integer accumulation, checked against i64.
//! - Arithmetic uses checked ops (`checked_add`, `checked_mul` on widened
//!   i128); overflow is `Err`, never wrap.

use serde::{Deserialize, Serialize};

/// Minor units per dinar. SINGLE exponent source for Rust
/// (TS mirrors it in `src/utils/money.ts` CURRENCY; Test J asserts == 2).
pub const CURRENCY_EXPONENT: u32 = 2;
/// ISO code. Display label is "DA" (see [`Money::format`]).
pub const CURRENCY_CODE: &str = "DZD";

const MINOR_PER_UNIT: i64 = 100;

/// Canonical money value: integer minor units. Immutable (Copy).
/// Signedness allowed (P&L intermediates, refunds) — ENTRY rejects negatives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Money(i64);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoneyError {
    Empty,
    SignNotAllowed,
    AmbiguousSeparators,
    NotDecimal,
    TooManyDecimals,
    Overflow,
}

impl std::fmt::Display for MoneyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            MoneyError::Empty => "empty input",
            MoneyError::SignNotAllowed => "sign not allowed for money entry",
            MoneyError::AmbiguousSeparators => "ambiguous separators",
            MoneyError::NotDecimal => "not a decimal amount",
            MoneyError::TooManyDecimals => "max 2 decimals — re-enter, not rounded",
            MoneyError::Overflow => "amount exceeds i64",
        };
        write!(f, "[Money] {s}")
    }
}

impl Money {
    /// Single construction path for exact values.
    pub fn from_minor(minor: i64) -> Self {
        Money(minor)
    }

    pub fn to_minor(self) -> i64 {
        self.0
    }

    /// PD-22 string-based entry. NEVER float-based: the decimal string is
    /// split and concatenated into minor units ("130.5"→13050, "4.35"→435).
    /// Accepts "." and "," separators (FR/DZ keyboards); strips grouping
    /// spaces (regular, NBSP U+00A0, narrow NBSP U+202F) and apostrophes;
    /// understands FR thousand-grouping dots ("45.000"→45000, "12.500,50").
    /// REJECTS (Err, never silently rounded): 3+ decimals, signs,
    /// empty/unparseable input, i64 overflow.
    pub fn from_user_input(input: &str) -> Result<Self, MoneyError> {
        let raw = input.trim();
        if raw.is_empty() {
            return Err(MoneyError::Empty);
        }
        if raw.starts_with('-') || raw.starts_with('+') {
            return Err(MoneyError::SignNotAllowed);
        }
        let compact: String = raw
            .chars()
            .filter(|c| !matches!(c, ' ' | '\u{00A0}' | '\u{202F}' | '\u{2009}' | '\''))
            .collect();
        if compact.is_empty() {
            return Err(MoneyError::Empty);
        }
        let has_comma = compact.contains(',');
        let has_dot = compact.contains('.');
        let (int_part, frac_part): (String, String) = if has_comma && has_dot {
            // Strict FR grouping only ("12.500,50"); US-grouped input is
            // rejected rather than mangled 1000x.
            if !is_strict_fr_grouped(&compact) {
                return Err(MoneyError::AmbiguousSeparators);
            }
            let no_groups: String = compact.chars().filter(|c| *c != '.').collect();
            let i = no_groups.find(',').unwrap_or(no_groups.len());
            (no_groups[..i].to_string(), no_groups[i + 1..].to_string())
        } else if has_comma {
            let i = compact.find(',').unwrap_or(compact.len());
            (compact[..i].to_string(), compact[i + 1..].to_string())
        } else if has_dot {
            if is_fr_grouped_int(&compact) {
                (compact.chars().filter(|c| *c != '.').collect(), String::new())
            } else {
                let i = compact.find('.').unwrap_or(compact.len());
                (compact[..i].to_string(), compact[i + 1..].to_string())
            }
        } else {
            (compact, String::new())
        };
        let int_part = if int_part.is_empty() { "0".to_string() } else { int_part };
        if !int_part.chars().all(|c| c.is_ascii_digit())
            || !frac_part.chars().all(|c| c.is_ascii_digit())
        {
            return Err(MoneyError::NotDecimal);
        }
        if frac_part.len() > CURRENCY_EXPONENT as usize {
            return Err(MoneyError::TooManyDecimals);
        }
        let mut padded = format!("{int_part}{:0<2}", frac_part);
        while padded.starts_with('0') && padded.len() > 1 {
            padded.remove(0);
        }
        parse_exact_i64(&padded).map(Money)
    }

    /// PD-3: JSON carries integer minor units as STRINGS.
    pub fn from_json_str(s: &str) -> Result<Self, MoneyError> {
        if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit()) {
            return Err(MoneyError::NotDecimal);
        }
        parse_exact_i64(s).map(Money)
    }

    /// PD-3: serialize as minor-unit string.
    pub fn to_json_string(self) -> String {
        self.0.to_string()
    }

    /// PD-23 display: dinars with ALWAYS two decimals, integer div/rem +
    /// zero-pad. 13050 → "130.50 DA", 10000 → "100.00 DA", 10 → "0.10 DA".
    pub fn format(self) -> String {
        let neg = self.0 < 0;
        let abs = self.0.unsigned_abs();
        let whole = abs / MINOR_PER_UNIT as u64;
        let frac = abs % MINOR_PER_UNIT as u64;
        if neg {
            format!("-{whole}.{frac:02} DA")
        } else {
            format!("{whole}.{frac:02} DA")
        }
    }

    pub fn add(self, other: Money) -> Result<Money, MoneyError> {
        self.0.checked_add(other.0).map(Money).ok_or(MoneyError::Overflow)
    }

    pub fn sub(self, other: Money) -> Result<Money, MoneyError> {
        self.0.checked_sub(other.0).map(Money).ok_or(MoneyError::Overflow)
    }

    /// Integer multiplier with a widened i128 intermediate.
    pub fn mul_int(self, k: i64) -> Result<Money, MoneyError> {
        let r = (self.0 as i128) * (k as i128);
        if r > i64::MAX as i128 || r < i64::MIN as i128 {
            return Err(MoneyError::Overflow);
        }
        Ok(Money(r as i64))
    }

    /// Exact proportional core (future §8 allocator):
    /// roundHalfUp(self × mult / div), widened intermediate, no float.
    pub fn mul_div_half_up(self, mult: i64, div: i64) -> Result<Money, MoneyError> {
        if div <= 0 {
            return Err(MoneyError::Overflow);
        }
        let num = (self.0 as i128) * (mult as i128);
        let d = div as i128;
        let q = num / d;
        let rem = num % d;
        let rounded = if rem * 2 >= d { q + 1 } else { q };
        if rounded > i64::MAX as i128 || rounded < i64::MIN as i128 {
            return Err(MoneyError::Overflow);
        }
        Ok(Money(rounded as i64))
    }

    pub fn is_zero(self) -> bool {
        self.0 == 0
    }

    pub fn is_negative(self) -> bool {
        self.0 < 0
    }
}

fn is_strict_fr_grouped(s: &str) -> bool {
    // ^\d{1,3}(\.\d{3})+,\d+$
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut lead = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() && lead < 3 {
        i += 1;
        lead += 1;
    }
    if lead == 0 || lead > 3 {
        return false;
    }
    let mut groups = 0;
    while i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        let mut n = 0;
        while i < bytes.len() && bytes[i].is_ascii_digit() && n < 3 {
            i += 1;
            n += 1;
        }
        if n != 3 {
            return false;
        }
        groups += 1;
    }
    if groups == 0 {
        return false;
    }
    if i >= bytes.len() || bytes[i] != b',' {
        return false;
    }
    i += 1;
    let mut tail = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
        tail += 1;
    }
    tail > 0 && i == bytes.len()
}

fn is_fr_grouped_int(s: &str) -> bool {
    // ^\d{1,3}(\.\d{3})+$
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut lead = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() && lead < 3 {
        i += 1;
        lead += 1;
    }
    if lead == 0 || lead > 3 {
        return false;
    }
    let mut groups = 0;
    while i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        let mut n = 0;
        while i < bytes.len() && bytes[i].is_ascii_digit() && n < 3 {
            i += 1;
            n += 1;
        }
        if n != 3 {
            return false;
        }
        groups += 1;
    }
    groups > 0 && i == bytes.len()
}

fn parse_exact_i64(digits: &str) -> Result<i64, MoneyError> {
    let mut acc: i128 = 0;
    for c in digits.chars() {
        if !c.is_ascii_digit() {
            return Err(MoneyError::NotDecimal);
        }
        acc = acc * 10 + (c as i128 - '0' as i128);
        if acc > i64::MAX as i128 {
            return Err(MoneyError::Overflow);
        }
    }
    Ok(acc as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn currency_exponent_is_two() {
        assert_eq!(CURRENCY_EXPONENT, 2);
        assert_eq!(CURRENCY_CODE, "DZD");
    }

    #[test]
    fn entry_vectors() {
        assert_eq!(Money::from_user_input("130.5").unwrap().to_minor(), 13050);
        assert_eq!(Money::from_user_input("130.05").unwrap().to_minor(), 13005);
        assert_eq!(Money::from_user_input("4.35").unwrap().to_minor(), 435);
        assert_eq!(Money::from_user_input("0.1").unwrap().to_minor(), 10);
        assert_eq!(Money::from_user_input("130").unwrap().to_minor(), 13000);
        assert_eq!(Money::from_user_input("130,5").unwrap().to_minor(), 13050);
        // FR grouping: "45.000" = 45,000 DA exactly (cf. TS Test J).
        assert_eq!(Money::from_user_input("45.000").unwrap().to_minor(), 4500000);
        assert_eq!(Money::from_user_input("12.500,50").unwrap().to_minor(), 1250050);
        // FR convention (shared with TS Test J): "130.555" = 130,555 DA
        // grouped, not 3 decimals. Genuine 3+-decimal inputs are rejected.
        assert_eq!(Money::from_user_input("130.555").unwrap().to_minor(), 13055500);
        assert!(Money::from_user_input("130.5555").is_err());
        assert!(Money::from_user_input("4.3575").is_err());
        assert!(Money::from_user_input("-5").is_err());
        assert!(Money::from_user_input("").is_err());
        assert!(Money::from_user_input("1,200.50").is_err());
    }

    #[test]
    fn display_vectors() {
        assert_eq!(Money::from_minor(13050).format(), "130.50 DA");
        assert_eq!(Money::from_minor(10000).format(), "100.00 DA");
        assert_eq!(Money::from_minor(10).format(), "0.10 DA");
        assert_eq!(Money::from_minor(0).format(), "0.00 DA");
    }

    #[test]
    fn half_dinar_pl() {
        // Buy 10 @ 130.5 → cost 130,500; sell 3 @ 150.0 → revenue 45,000;
        // COGS 39,150; profit EXACTLY 5,850. Zero rounding in the path.
        let cost = Money::from_user_input("130.5").unwrap().mul_int(10).unwrap();
        assert_eq!(cost.to_minor(), 130500);
        let revenue = Money::from_user_input("150.0").unwrap().mul_int(3).unwrap();
        assert_eq!(revenue.to_minor(), 45000);
        let cogs = Money::from_user_input("130.5").unwrap().mul_int(3).unwrap();
        assert_eq!(cogs.to_minor(), 39150);
        let profit = revenue.sub(cogs).unwrap();
        assert_eq!(profit.to_minor(), 5850);
        assert_eq!(profit.format(), "58.50 DA");
    }

    #[test]
    fn fractional_qty_line() {
        // 0.5 units (500 milli) @ 130.5 → 6,525 exactly.
        let line = Money::from_user_input("130.5")
            .unwrap()
            .mul_div_half_up(500, 1000)
            .unwrap();
        assert_eq!(line.to_minor(), 6525);
    }

    #[test]
    fn overflow_fails_closed() {
        assert!(Money::from_minor(i64::MAX).add(Money::from_minor(1)).is_err());
        assert!(Money::from_minor(i64::MAX).mul_int(2).is_err());
    }

    #[test]
    fn json_round_trip() {
        let m = Money::from_user_input("130.5").unwrap();
        assert_eq!(m.to_json_string(), "13050");
        assert_eq!(Money::from_json_str("13050").unwrap(), m);
    }
}
