# ADR-002: Headless Business Logic in `pos-core`

- **Status:** Accepted
- **Date:** 2026-09-14
- **Decision-Makers:** Autonomous Engineering Agent
- **Consulted:** `AGENTS.md` §1 & §3

---

## 1. Context & Problem Statement

In a multi-platform retail point of sale operating across Windows, macOS, Linux, Android, and iOS, duplicating core financial and inventory math (totals, discounts, inventory ledger deltas, stock deductions) between frontend JavaScript and backend Tauri commands causes drift, float rounding divergence, and untestable rules.

---

## 2. Decision

All business domain rules, line item calculations, inventory delta formulations, and POS financial math live in the standalone Rust crate **`crates/pos-core`**.
Key invariants:
- **Zero `tauri::*` imports**: Crate compiles independently of GUI runtime.
- **Headless Unit Testing**: Domain invariants are tested directly with `cargo test`.
- **Integer Minor Units**: Money values are strictly `i64` (integer dinars / cents); zero float values in persistent or calculation paths.
