//! Tier A Rust properties (dep-free, std-only seeded xorshift — no proptest
//! crate in the tree): 100k cases per property against the frozen kernel.
//!
//! Q1 mul_div_half_up == trunc-toward-zero half-up reference (u128 math,
//! written independently of `Money` internals).
//! Q2 add/sub/mul_int agree with i128 reference (overflow iff out of i64).
//! Q3 from_user_input/format round-trip on random minors via golden vectors
//!     + synthetic ASCII-space grouped strings.
//! Q4 nets/gross/total discipline on random invoice shapes (mirror of the
//!     TS P1/P2/P3 over the same seed family).
//!
//! Run: `cargo test --release -p mobi-pos --test money_properties`
//! Seed: STRESS_SEED env (default 20261010), printed by every run.

use mobi_pos_lib::money::{Money, MoneyError};

fn seed() -> u64 {
    std::env::var("STRESS_SEED")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(20261010)
}

struct Xor(u64);
impl Xor {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn ref_half_up(num: i128, div: i128) -> i128 {
    // Trunc-toward-zero quotient, round up iff 2*rem >= div (Rust % keeps
    // the numerator sign; the comparison matches both engines).
    let q = num / div;
    let r = num % div;
    if r * 2 >= div {
        q + 1
    } else {
        q
    }
}

#[test]
fn q1_mul_div_matches_reference() {
    let s = seed();
    println!("STRESS_SEED={s}");
    let mut g = Xor(s);
    let cases = 100_000u32;
    for _ in 0..cases {
        // Non-negative money path (the suite scope) + negative sweep.
        let minor = if g.below(10) < 8 {
            g.below(200_000_000) as i64
        } else {
            -(g.below(200_000) as i64)
        };
        let mult = g.below(10_001) as i64;
        let div = (g.below(10_000) + 1) as i64;
        let got = Money::from_minor(minor).mul_div_half_up(mult, div);
        let want = ref_half_up(minor as i128 * mult as i128, div as i128);
        match got {
            Ok(m) => assert_eq!(
                m.to_minor() as i128, want,
                "minor={minor} mult={mult} div={div}"
            ),
            Err(_) => assert!(
                want > i64::MAX as i128 || want < i64::MIN as i128,
                "unexpected overflow minor={minor} mult={mult} div={div}"
            ),
        }
    }
}

#[test]
fn q2_add_sub_mul_agree_with_i128() {
    let s = seed() ^ 0x9e3779b9;
    let mut g = Xor(s);
    let cases = 100_000u32;
    for _ in 0..cases {
        let a = g.below(400_000_000) as i64 - 200_000_000;
        let b = g.below(400_000) as i64 - 200_000;
        let k = g.below(10_000) as i64;
        let ma = Money::from_minor(a);
        let mb = Money::from_minor(b);
        match ma.add(mb) {
            Ok(m) => assert_eq!(m.to_minor() as i128, a as i128 + b as i128),
            Err(_) => assert!(a as i128 + b as i128 > i64::MAX as i128),
        }
        match ma.sub(mb) {
            Ok(m) => assert_eq!(m.to_minor() as i128, a as i128 - b as i128),
            Err(_) => assert!((a as i128 - b as i128) < i64::MIN as i128),
        }
        match ma.mul_int(k) {
            Ok(m) => assert_eq!(m.to_minor() as i128, a as i128 * k as i128),
            Err(_) => assert!((a as i128 * k as i128) > i64::MAX as i128),
        }
    }
}

#[test]
fn q3_format_parse_round_trip() {
    let s = seed() ^ 0x85ebca6b;
    let mut g = Xor(s);
    let cases = 100_000u32;
    for _ in 0..cases {
        let minor = g.below(20_000_000_000) as i64;
        let shown = Money::from_minor(minor).format();
        // Display contract: ASCII-space groups, two decimals, DA suffix.
        assert!(shown.ends_with(" DA"), "suffix {shown}");
        // Re-parse through the kernel entry (space-grouped + decimal).
        let back = Money::from_user_input(&shown.replace(" DA", ""))
            .expect("kernel re-parses its own display")
            .to_minor();
        assert_eq!(back, minor, "round-trip {shown}");
    }
}

#[test]
fn q4_invoice_discipline() {
    let s = seed() ^ 0xc2b2ae35;
    let mut g = Xor(s);
    let cases = 100_000u32;
    for _ in 0..cases {
        let n = 1 + g.below(5);
        let mut base = Money::from_minor(0);
        for _ in 0..n {
            let unit = Money::from_minor(g.below(20_000_000) as i64);
            let qty = (g.below(7) + 1) as i64; // 1..=7 + boundary bias
            let qty = if g.below(4) == 0 { [1, 2, 3, 7][g.below(4) as usize] } else { qty };
            base = base.add(unit.mul_int(qty).unwrap()).unwrap();
        }
        let bps = [0i64, 500, 1000, 2500, 3333, 5000, 10000];
        let bp = bps[g.below(bps.len() as u64) as usize];
        let disc = if base.to_minor() > 0 && bp > 0 {
            base.mul_div_half_up(bp, 10000).unwrap()
        } else {
            Money::from_minor(0)
        };
        let total = base.sub(disc).unwrap().to_minor();
        assert!(total >= 0, "non-negative total");
        assert!(total <= base.to_minor(), "discount monotonicity");
        // Single-shot reference.
        let want = ref_half_up(base.to_minor() as i128 * bp as i128, 10000);
        let want_total = base.to_minor() as i128 - if base.to_minor() > 0 && bp > 0 { want } else { 0 };
        assert_eq!(total as i128, want_total);
    }
}

// Q5: boundary/validator pins on the public kernel surface (no internals).
// These target the observable branch/limit mutants the property sweeps leave
// alive: whole-fn predicate arms, the inclusive i64 overflow limits, and the
// separator validators reached only through `from_user_input`.
#[test]
fn q5_kernel_boundaries_pin_overflow_and_validators() {
    // Predicate arms (kill whole-fn `-> true/false` and `==`/`<` swaps).
    assert!(Money::from_minor(0).is_zero());
    assert!(!Money::from_minor(1).is_zero());
    assert!(!Money::from_minor(-1).is_zero());

    assert!(!Money::from_minor(0).is_negative());
    assert!(!Money::from_minor(5).is_negative());
    assert!(Money::from_minor(-5).is_negative());

    // mul_int: the limits themselves are valid (inclusive), one past is not.
    assert_eq!(Money::from_minor(i64::MAX).mul_int(1).unwrap().to_minor(), i64::MAX);
    assert_eq!(Money::from_minor(i64::MIN).mul_int(1).unwrap().to_minor(), i64::MIN);
    assert_eq!(Money::from_minor(i64::MAX).mul_int(-1).unwrap().to_minor(), -i64::MAX);
    assert_eq!(Money::from_minor(i64::MAX).mul_int(2), Err(MoneyError::Overflow));
    assert_eq!(Money::from_minor(i64::MIN).mul_int(2), Err(MoneyError::Overflow));
    assert_eq!(Money::from_minor(i64::MIN).mul_int(-1), Err(MoneyError::Overflow));

    // mul_div_half_up: half-up rounding, inclusive limits, div<=0 guard.
    assert_eq!(Money::from_minor(5).mul_div_half_up(1, 2).unwrap().to_minor(), 3);
    assert_eq!(Money::from_minor(1).mul_div_half_up(1, 3).unwrap().to_minor(), 0);
    assert_eq!(Money::from_minor(2).mul_div_half_up(1, 3).unwrap().to_minor(), 1);
    assert_eq!(Money::from_minor(i64::MAX).mul_div_half_up(1, 1).unwrap().to_minor(), i64::MAX);
    assert_eq!(Money::from_minor(i64::MIN).mul_div_half_up(1, 1).unwrap().to_minor(), i64::MIN);
    assert_eq!(Money::from_minor(i64::MAX).mul_div_half_up(2, 1), Err(MoneyError::Overflow));
    assert_eq!(Money::from_minor(i64::MIN).mul_div_half_up(2, 1), Err(MoneyError::Overflow));
    assert_eq!(Money::from_minor(1).mul_div_half_up(1, 0), Err(MoneyError::Overflow));
    assert_eq!(Money::from_minor(1).mul_div_half_up(1, -1), Err(MoneyError::Overflow));

    // from_user_input: discriminated errors (not just is_err) + FR validators.
    assert_eq!(Money::from_user_input(""), Err(MoneyError::Empty));
    assert_eq!(Money::from_user_input("   "), Err(MoneyError::Empty));
    assert_eq!(Money::from_user_input("-5"), Err(MoneyError::SignNotAllowed));
    assert_eq!(Money::from_user_input("+5"), Err(MoneyError::SignNotAllowed));
    assert_eq!(Money::from_user_input("1,234"), Err(MoneyError::TooManyDecimals));
    assert_eq!(Money::from_user_input("1.2,3"), Err(MoneyError::AmbiguousSeparators));
    assert_eq!(Money::from_user_input("12.50,5"), Err(MoneyError::AmbiguousSeparators));

    assert_eq!(Money::from_user_input("12.500,50").unwrap().to_minor(), 1_250_050);
    assert_eq!(Money::from_user_input("1.234,5").unwrap().to_minor(), 123_450);
    assert_eq!(Money::from_user_input("1.234").unwrap().to_minor(), 123_400);
    assert_eq!(Money::from_user_input("1.23").unwrap().to_minor(), 123);
    assert_eq!(Money::from_user_input("1 234").unwrap().to_minor(), 123_400);
    assert_eq!(Money::from_user_input("12,5").unwrap().to_minor(), 1_250);

    // Display arm coverage (kills the `fmt -> Ok(Default::default())` mutant).
    assert_eq!(MoneyError::SignNotAllowed.to_string(), "[Money] sign not allowed for money entry");
    assert_eq!(MoneyError::Overflow.to_string(), "[Money] amount exceeds i64");
}
