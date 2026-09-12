# Mobile setup (sandbox) — Android + iOS via Tauri v2

> Rust core (`lib.rs` + `plugin-sql` + `printer` gating) and configs
> (`tauri.conf.json`, `capabilities/`, `vite.config.ts`, `index.html`) are DONE.
> Scaffolding `src-tauri/gen/android|apple` needs host toolchains (below).

## 1. Android (Windows OK after SDK install)

1. Install Android Studio + SDK Platform 34 + Build-Tools + NDK r25+; set:
   ```powershell
   [Environment]::SetEnvironmentVariable('ANDROID_HOME', "$env:LOCALAPPDATA\Android\Sdk", 'User')
   [Environment]::SetEnvironmentVariable('NDK_HOME', "$env:LOCALAPPDATA\Android\Sdk\ndk\25.2.9519653", 'User')
   ```
2. `rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android`
3. In THIS folder (`phone3-sync-lab`):
   ```
   npx @tauri-apps/cli android init
   npx tauri android dev --open   # same LAN, device/emulator
   npx tauri android build --apk
   ```
4. Store release: bump `bundle.android.versionCode` in `tauri.conf.json` per upload.

Attempted 2026-09-08: `android init` correctly refused (no SDK at
`C:\Users\Click\Documents\zoughlal\android-sdk` nor `%LOCALAPPDATA%\Android\Sdk`).
Install SDK then re-run — no code changes needed.

## 2. iOS (macOS only)

`ios` CLI is hidden on Windows by design. On a Mac with Xcode + CocoaPods:
```
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
npx @tauri-apps/cli ios init
npx tauri ios dev --open
npx tauri ios build
```
Icons in `src-tauri/icons/android|ios` are reused automatically.

## 3. What already works without SDK

- `npm run build` (tsc + vite) — validates TS + SyncManager
- `cargo check` in `src-tauri` — validates `lib.rs` + migrations + printer gating
- `node proxy/server.mjs` with `proxy/.env` — token broker for SyncManager
- Turso remote: `turso db shell <db> < turso/remote-schema.sql`

## 4. Touch/responsive TODO (shell is still desktop-first)

- `App.tsx` split-view (`CartPanel` + `ProductCatalog`) needs bottom-tab/stacked mobile layout.
- Add `env(safe-area-inset-*)` padding (base rules already in `src/index.css`).
- Replace F-key hotkeys / wedge-scanner timing / `window.print()` with touch buttons,
  camera barcode (tauri-plugin-barcode-scanner), and native print share.
