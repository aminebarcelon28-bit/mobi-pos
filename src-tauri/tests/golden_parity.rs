//! Golden parity: frozen Rust `money` kernel vs `e2e/golden/money-vectors.json`.
//!
//! The GOLDEN file is the expectation (independent BigInt generator +
//! Python Fraction cross-check + TS parity runner). This harness is READ-ONLY
//! against the kernel: any mismatch is a REPORTED discrepancy —
//! `src-tauri/src/money.rs` stays byte-frozen (owner gate).
//!
//! Run: `cargo test --release -p mobi-pos --test golden_parity`
//! (also covered by the workspace `--lib` gate via `money.rs` unit tests).

use mobi_pos_lib::money::Money;
use serde_json::Value;
use std::path::PathBuf;

fn golden_doc() -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let path = root.join("..").join("e2e").join("golden").join("money-vectors.json");
    let raw = std::fs::read_to_string(&path).expect("golden file readable");
    serde_json::from_str(&raw).expect("golden file parses")
}

fn minor(s: &str) -> i64 {
    s.parse::<i64>().expect("minor fits i64")
}

#[test]
fn display_vectors_byte_match() {
    let doc = golden_doc();
    let arr = doc["vectors"]["display"].as_array().expect("display array");
    assert!(!arr.is_empty(), "golden carries display vectors");
    for v in arr {
        let id = v["id"].as_str().unwrap_or("?");
        let m = minor(v["minorMinor"].as_str().expect("minor string"));
        let want = v["display"].as_str().expect("display string");
        let got = Money::from_minor(m).format();
        assert_eq!(got, want, "{id}: Rust format != golden");
    }
}

#[test]
fn parse_vectors_agree() {
    let doc = golden_doc();
    let arr = doc["vectors"]["parse"].as_array().expect("parse array");
    assert!(!arr.is_empty(), "golden carries parse vectors");
    for v in arr {
        let id = v["id"].as_str().unwrap_or("?");
        let input = v["input"].as_str().expect("input string");
        let want = minor(v["minorMinor"].as_str().expect("minor string"));
        let got = Money::from_user_input(input)
            .unwrap_or_else(|e| panic!("{id}: Rust rejected valid input {input:?}: {e:?}"))
            .to_minor();
        assert_eq!(got, want, "{id}: Rust parse != golden");
    }
    let errs = doc["vectors"]["parseError"].as_array().expect("parseError array");
    assert!(!errs.is_empty(), "golden carries parseError vectors");
    for v in errs {
        let id = v["id"].as_str().unwrap_or("?");
        let input = v["input"].as_str().expect("input string");
        assert!(
            Money::from_user_input(input).is_err(),
            "{id}: Rust accepted {input:?}, golden says reject"
        );
    }
}

#[test]
fn invoice_vectors_agree() {
    let doc = golden_doc();
    let arr = doc["vectors"]["invoice"].as_array().expect("invoice array");
    assert!(!arr.is_empty(), "golden carries invoice vectors");
    for v in arr {
        let id = v["id"].as_str().unwrap_or("?");
        let bp = v["cartPctBp"].as_i64().expect("bp integer");
        let mut base = Money::from_minor(0);
        for l in v["lines"].as_array().expect("lines array") {
            let unit = Money::from_minor(minor(l["unitMinor"].as_str().expect("unit string")));
            let qty = l["qty"].as_i64().expect("qty integer");
            let gross = unit.mul_int(qty).expect("mul fits");
            let disc = Money::from_minor(
                l.get("discountFixedMinor")
                    .and_then(|d| d.as_str())
                    .map(minor)
                    .unwrap_or(0),
            );
            base = base.add(gross.sub(disc).expect("sub fits")).expect("add fits");
        }
        if let Some(err) = v.get("expectedError").and_then(|e| e.as_str()) {
            // Rejection lives at the app boundary, not in Money arithmetic:
            // verify the generator's premise (discount exceeds line) holds.
            assert_eq!(err, "discount exceeds line", "{id}: unknown error class");
            let first = &v["lines"].as_array().unwrap()[0];
            let u = minor(first["unitMinor"].as_str().unwrap());
            let f = minor(first["discountFixedMinor"].as_str().unwrap());
            assert!(f > u * first["qty"].as_i64().unwrap(), "{id}: premise broken");
            continue;
        }
        let want = minor(v["expectedTotalMinor"].as_str().expect("total string"));
        let cart_disc = if base.to_minor() > 0 && bp > 0 {
            base.mul_div_half_up(bp, 10000).expect("div fits")
        } else {
            Money::from_minor(0)
        };
        let total = base.sub(cart_disc).expect("sub fits").to_minor();
        assert_eq!(total, want, "{id}: Rust invoice != golden");
    }
}
