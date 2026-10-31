# Decision D2 — narrow test-only lift on `src-tauri/src/checkout.rs`

- **Why:** `cargo test` cannot compile at HEAD: four assertions compare `Option<f64>` fields to integer
  literals (`Some(200)`, `Some(1001)`, `Some(2100 - 1001)`). No test that touches the refund native lane
  can run until that is fixed.
- **Scope of the lift:** the four literal comparisons only —
  `checkout.rs:1808/1809/1897/1911`. No production code, no behaviour, no assertion strength change
  (`200` → `200.0` is the same value at the same precision).
- **Evidence:** `cargo test --lib refund::tests::d4a` compiles and runs only after this fix (E-0073/E-0076).
- **Reversal:** revert the four literals; the crate test target returns to its pre-existing
  non-compiling state.
- **Relock:** after this milestone's merge, `checkout.rs` leaves the editable list again.
