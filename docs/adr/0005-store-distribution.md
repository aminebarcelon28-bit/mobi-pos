# ADR-005: Multi-Platform Distribution & Auto-Updater

- **Status:** Accepted
- **Date:** 2026-09-14
- **Decision-Makers:** Autonomous Engineering Agent
- **Consulted:** `AGENTS.md` §1 (Decision 10), §10 & Contract C4

---

## 1. Context & Problem Statement

Merchants require zero-friction installation (Contract C4: first sale $\le 90\text{ s}$) with seamless self-updating capabilities across Windows, macOS, and Linux, and standard store packaging for Android (`.aab`) and iOS (`.ipa`).

---

## 2. Decision

- **Desktop Distribution**:
  - Windows: Per-user NSIS installer with bundled WebView2 bootstrapper.
  - Signed updates managed via `tauri-plugin-updater` with minisign public key pinned in `tauri.conf.json`.
  - Manifest served from GitHub Releases (`latest.json`).
- **Mobile Distribution**:
  - Android: Google Play Store distribution via Android App Bundle (`.aab`), targeting SDK 24 floor.
  - iOS: Apple App Store distribution via IPA archive, targeting iOS 13 floor.
