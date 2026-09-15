# ADR-004: Hardware Peripherals Architecture & Thermal Printing

- **Status:** Accepted
- **Date:** 2026-09-14
- **Decision-Makers:** Autonomous Engineering Agent
- **Consulted:** `AGENTS.md` §3, §14.1 & Roadmap Phase 4

---

## 1. Context & Problem Statement

Retail POS operations require hardware integration with thermal receipt printers (ESC/POS over USB/TCP), cash drawers, and barcode scanners. These peripheral interfaces are platform-specific (desktop-only USB spooler vs mobile camera/Bluetooth).

---

## 2. Decision

- **Peripherals Crate (`crates/pos-peripherals`)**: Desktop hardware logic (ESC/POS stream encoding, drawer kick pulses `[0x1B, 0x70]`, paper cutting) is isolated in a dedicated crate gated with `#[cfg(desktop)]`.
- **Keyboard Wedge Scanners**: Scanners communicating over USB HID are handled via timing burst analysis (< 50ms per key) in `setupKeyboardWedgeScanner`.
- **Mobile Graceful Fallback**: On Android and iOS, hardware calls return typed errors indicating mobile Bluetooth printing plugin paths.
