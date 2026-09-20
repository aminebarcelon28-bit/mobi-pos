# Deep-Dive Analysis: Auditing a Tauri v2 Codebase & Fixing the Android APK Build Failure

**Document version:** 1.0
**Applies to:** Tauri v2.x
**Goal:** Full methodology for auditing a Tauri v2 app, common bug patterns, and a step-by-step breakdown of why `tauri android build` fails to produce an APK and how to fix it.

## Table of Contents

- Part 0 — How to use this document
- Part 1 — Understand the build pipeline
- Part 2 — Environment audit (prerequisites checklist)
- Part 3 — Correct environment setup per OS
- Part 4 — The 13 root causes of "cannot compile the APK"
- Part 5 — The clean-slate recovery procedure
- Part 6 — What a successful build looks like
- Part 7 — Post-compile bug hunting on Android
- Part 8 — General Tauri v2 codebase audit checklist
- Part 9 — Prevention: CI build matrix
- Part 10 — Information needed for a pinpoint diagnosis

---

## Part 0 — How to use this document

**Reported bug:**

> "I cannot compile the application APK for Android, and I'm using Tauri v2."

That symptom has roughly 13 root causes. The fix is almost never a single line — it's a chain: JDK → Android SDK → NDK → Rust cross-compilation targets → generated Gradle project → signing. Fixing one link while another is broken keeps the build failing, which is why people often report "I tried everything and it still doesn't work." This document walks the entire chain.

---

## Part 1 — Understand the build pipeline (this is where debugging starts)

When you run:

```bash
npx tauri android build --apk
```

the CLI executes three distinct stages. Knowing which stage failed tells you which layer of your system is broken:

```
┌─────────────────────────────────────────────────────────┐
│ STAGE 1: Frontend build                                  │
│   runs `build.beforeBuildCommand` (vite build / next…)   │
│   output → frontendDist directory                        │
├─────────────────────────────────────────────────────────┤
│ STAGE 2: Rust cross-compilation                          │
│   cargo build --target aarch64-linux-android (etc.)      │
│   uses clang from the NDK as the linker                  │
│   output → .so native libraries per ABI                  │
├─────────────────────────────────────────────────────────┤
│ STAGE 3: Gradle / Android build                          │
│   src-tauri/gen/android Gradle project                   │
│   Kotlin compile + resources (icons) + merge + sign      │
│   output → .apk / .aab                                   │
└─────────────────────────────────────────────────────────┘
```

**How to read your error:**

- Error mentions `error[E...]`, `linker`, `cargo`, `rustc`, `aarch64-linux-android` → **Stage 2 broken** (NDK / Rust targets / env vars).
- Error mentions `gradle`, `task ':app:...'`, `SDK location`, `Unsupported class file major version`, `mipmap` → **Stage 3 broken** (JDK / SDK / Gradle / icons).
- Error mentions your bundler (`vite`, `rollup`, `tsc`) → **Stage 1**.
- Process dies with `"NDK_HOME"` or `"failed to find NDK"` before anything compiles → **environment, before Stage 2**.

Re-run the build with verbose logging and capture the last 50 lines — that's your diagnosis document:

```bash
npx tauri android build --apk --verbose
```

---

## Part 2 — Environment audit (prerequisites checklist)

Run each of these and compare against the expected result:

| Check | Command | Expected |
|---|---|---|
| Java version | `java -version` | JDK 17 (17 or 21; 11 is too old) |
| Rust | `rustc --version` | Recent stable (1.77+ for Tauri 2) |
| Android targets | `rustup target list --installed` | All 4 android targets (see below) |
| SDK found | `echo $ANDROID_HOME` / `echo %ANDROID_HOME%` | Existing SDK path |
| NDK found | `echo $NDK_HOME` | Points to a versioned NDK folder |
| Tauri CLI | `npx tauri --version` / `cargo tauri --version` | 2.x |
| Everything at once | `npx tauri info` | All of the above in one report |

**The four Rust targets that must be installed:**

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

`npx tauri info` is your single best snapshot — if it prints an "Environment variable NDK_HOME is not set"-style warning or shows an empty Android section, that's your bug, full stop.

---

## Part 3 — Correct environment setup per OS

### Windows (PowerShell — persistent, user-level)

```powershell
# JDK — Android Studio ships a usable JDK 17 (JetBrains Runtime):
[Environment]::SetEnvironmentVariable("JAVA_HOME", "C:\Program Files\Android\Android Studio\jbr", "User")
# SDK (default Android Studio location):
[Environment]::SetEnvironmentVariable("ANDROID_HOME", "$env:LOCALAPPDATA\Android\Sdk", "User")
# NDK — must point INSIDE the versioned folder:
[Environment]::SetEnvironmentVariable("NDK_HOME", "$env:LOCALAPPDATA\Android\Sdk\ndk\26.1.10909125", "User")
```

Replace `26.1.10909125` with whatever version you actually have in `...\Sdk\ndk\`. Use a recent NDK (r26/r27); very old ones (r21–r23) are a common silent failure.

**Then close and reopen every terminal (VS Code too)** — this is the single most common "I set the variables but it still fails" cause.

**Windows extra warnings:**

- Keep the project, SDK, and NDK in paths without spaces or non-ASCII characters (avoid OneDrive/Dropbox folders — file watching and locking break builds there).
- Very deep project paths can hit Windows path-length limits (`os error 206` / "filename too long") — move to something like `C:\dev\myapp`.
- If you build inside WSL, you must install a Linux SDK/NDK/CLI toolchain inside WSL. Mixing a Windows SDK with a Linux toolchain does not work.

### macOS (`~/.zshrc`)

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export ANDROID_HOME=$HOME/Library/Android/sdk
export NDK_HOME=$ANDROID_HOME/ndk/26.1.10909125
export PATH=$PATH:$ANDROID_HOME/platform-tools
```

### Linux (`~/.bashrc`)

```bash
export ANDROID_HOME=$HOME/Android/Sdk
export NDK_HOME=$ANDROID_HOME/ndk/26.1.10909125
export PATH=$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin
```

**Accept SDK licenses** (fails Gradle dependency resolution otherwise):

```bash
sdkmanager --licenses
# or: yes | sdkmanager --licenses
```

---

## Part 4 — The 13 root causes of "cannot compile the APK"

### Bug #1 — NDK_HOME missing or pointing to the wrong level

**Symptom:** build dies early with a message about the NDK, or Stage 2 fails with:

```
error: linker `aarch64-linux-android21-clang` not found
```

**Root cause:** NDK_HOME must point to the version-specific directory:

- ❌ `/Android/Sdk/ndk`
- ✅ `/Android/Sdk/ndk/26.1.10909125`

**Fix:** set it correctly (Part 3), restart terminals, and because the CLI caches state, regenerate the project (Bug #6).

### Bug #2 — Rust Android targets not installed

**Symptom:**

```
error[E0463]: can't find crate for `std`
note: the aarch64-linux-android target may not be installed
```

**Fix:**

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

### Bug #3 — JDK / Gradle mismatch

**Symptom (Stage 3):**

```
Unsupported class file major version 65
Could not determine java version from '...'
```

**Root cause:** your default java is JDK 11 (too old) or a JDK the Gradle version in `gen/android` doesn't support.

**Fix:** install JDK 17, point `JAVA_HOME` to it, restart terminal, verify with `java -version`. If Gradle daemon is caching the old JDK, kill it:

```bash
cd src-tauri/gen/android && ./gradlew --stop
```

### Bug #4 — Android SDK not found by Gradle

**Symptom:**

```
SDK location not found. Define a valid SDK location with an
ANDROID_HOME environment variable or by setting the sdk.dir path
in your project's local properties file at '...\local.properties'
```

**Fix:** set `ANDROID_HOME` (Part 3). If `src-tauri/gen/android/local.properties` exists with a stale/wrong `sdk.dir`, delete the whole `gen` folder and re-init (Bug #6).

### Bug #5 — Invalid or missing bundle identifier

**Symptom:** `tauri android init` or the build fails with an identifier validation error, or Gradle fails on the package name.

**Root cause:** In `src-tauri/tauri.conf.json`, `identifier` becomes the Android application ID. Rules: at least two dot-separated segments, letters/digits/underscores only, each segment must start with a letter, no dashes.

**Fix:**

```json
{
  "identifier": "com.yourcompany.yourapp"
}
```

Then regenerate `gen` (Bug #6), because the package name is baked into the generated project.

### Bug #6 — Stale gen/android (generated with a broken environment) ⭐ extremely common

**Root cause:** `tauri android init` generates `src-tauri/gen/android` from your current environment (SDK paths, identifier, versions). If you ran init before your env was fixed — or before setting the identifier — the generated Gradle project is permanently broken, and fixing env vars afterwards does not repair it.

**Fix — the clean-slate method:**

```bash
# 1. Make sure env is correct (Part 3) and terminals are restarted
npx tauri info        # verify
# 2. Remove the generated project
rm -rf src-tauri/gen          # Windows: Remove-Item -Recurse -Force src-tauri\gen
# 3. Regenerate
npx tauri android init
# 4. Build
npx tauri android build --apk --verbose
```

Note: `/gen/schemas` is auto-ignored by Tauri's default `.gitignore`, but if you later customize `gen/android` (permissions in `AndroidManifest.xml`, signing config), commit those customizations so they're not lost.

### Bug #7 — Missing icons / Android resources

**Symptom (Stage 3):** task `:app:mergeReleaseResources` or `processReleaseResources` fails, e.g.

```
resource mipmap/ic_launcher (aka com.yourcompany.yourapp:mipmap/ic_launcher) not found
```

**Fix:** from a square PNG ≥1024×1024:

```bash
npx tauri icon path/to/app-icon.png
```

This regenerates `src-tauri/icons/` and the Android mipmaps in `gen/android`, then rebuild.

### Bug #8 — Release APK is unsigned

**Symptom:** build succeeds, but `adb install` fails:

```
INSTALL_PARSE_FAILED_NO_CERTIFICATES
```

**Root cause:** debug builds are auto-signed with the debug keystore; release builds need your own keystore.

**Fix:** create a keystore and wire it into Gradle:

```bash
keytool -genkey -v -keystore release-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias myapp
```

`src-tauri/gen/android/keystore.properties` (never commit this):

```properties
storeFile=../release-keystore.jks
storePassword=your-store-password
keyAlias=myapp
keyPassword=your-key-password
```

In `gen/android/app/build.gradle`:

```groovy
def keystoreProperties = new Properties()
def keystorePropertiesFile = rootProject.file('keystore.properties')
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}
android {
    // ...
    signingConfigs {
        release {
            if (keystorePropertiesFile.exists()) {
                keyAlias keystoreProperties['keyAlias']
                keyPassword keystoreProperties['keyPassword']
                storeFile file(keystoreProperties['storeFile'])
                storePassword keystoreProperties['storePassword']
            }
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
}
```

For quick testing, you can skip signing entirely:

```bash
npx tauri android build --apk --debug
```

### Bug #9 — Gradle can't download dependencies (network / proxy / firewall)

**Symptom:**

```
Could not resolve com.android.tools.build:gradle:...
Could not get resource / Connect timed out
```

**Fix:** ensure the machine can reach `dl.google.com` and `repo.maven.apache.org`. Behind a proxy, add to `src-tauri/gen/android/gradle.properties`:

```properties
systemProp.http.proxyHost=proxy.example.com
systemProp.http.proxyPort=8080
systemProp.https.proxyHost=proxy.example.com
systemProp.https.proxyPort=8080
```

### Bug #10 — SDK licenses not accepted

**Symptom:**

```
You have not accepted the license agreements of the following SDK components
```

**Fix:** `sdkmanager --licenses` and accept everything.

### Bug #11 — Frontend problems (Stage 1)

**Symptom:** the build fails in your JS bundler, or produces a blank WebView on device.

**Checklist:**

- `build.beforeBuildCommand` in `tauri.conf.json` actually produces output into the directory set in `build.frontendDist`.
- `build.devUrl` matters only for `tauri android dev`; the production APK embeds static files — your app must not depend on a dev server.
- A blank screen on Android but fine on desktop is very often an over-strict `app.security.csp` blocking inline scripts/styles.

### Bug #12 — ABI mismatch (build succeeds, won't run)

**Symptom:**

```
INSTALL_FAILED_NO_MATCHING_ABIS
```

or the app installs on a physical phone but not on an emulator.

**Root cause:** you built only `aarch64`, but you're installing to an `x86_64` emulator.

**Fix:** build for the right ABI or split:

```bash
npx tauri android build --apk --split-per-abi
npx tauri android build --apk --target aarch64     # faster single-target build
```

### Bug #13 — Corrupted local Gradle cache (transforms / daemon lock) ⭐ real-world case

**Symptom (Stage 3):** the build dies within seconds with `BUILD FAILED in <1s` and, at the bottom of a `--stacktrace` run:

```
Caused by: java.io.FileNotFoundException:
C:\Users\<you>\.gradle\caches\<gradle-version>\transforms\<hash>\metadata.bin
(The system cannot find the path specified)
```

The run finished that fast because Gradle resolved everything from cache and blew up on the one entry whose `metadata.bin` was missing/corrupt. A `Remove-Item` of `transforms` may also fail because a `.jar` inside is locked **by another process** — commonly the **VS Code Gradle extension's Language Server** (`vscjava.vscode-gradle`, a JVM child of the editor) rather than a Gradle daemon, so `gradlew --stop` won't free it.

**Root cause:** a partially written or manually tampered `~/.gradle/caches/<version>/transforms/` directory. Fixing env vars or regenerating `gen/android` (Bug #6) does **not** repair it — the damage is in the user-level cache, not the project.

**Fix (Windows shown):**

1. Stop Gradle daemons so they release their locks:
   ```powershell
   cd src-tauri\gen\android
   .\gradlew.bat --stop
   ```
2. If a jar is still locked, find the offender — often the VS Code Gradle language server:
   ```powershell
   Get-Process | Where-Object { $_.Name -match 'java' }
   Get-CimInstance Win32_Process -Filter "ProcessId = <pid>" |
     Select-Object -ExpandProperty CommandLine   # confirm it's the vscode-gradle server
   Stop-Process -Id <pid> -Force                 # it restarts on demand; safe to kill
   ```
3. Delete the whole transforms cache:
   ```powershell
   Remove-Item -LiteralPath "$env:USERPROFILE\.gradle\caches\$($(.\gradlew.bat --version | Select-String 'Gradle').ToString().Split()[-1])\transforms" -Recurse -Force
   ```
   (If unsure of the Gradle version, delete `C:\Users\<you>\.gradle\caches\<version>\transforms` as reported in the stacktrace — or all `transforms` folders under `~\.gradle\caches\`.)
4. Rebuild normally. Gradle re-resolves transforms on the next run:

   ```bash
   npx tauri android build --apk --verbose
   ```

**Prevention:** never kill Gradle mid-download/key the daemon's cache from the outside, and remember that the VS Code Gradle extension holds its own daemon that `gradlew --stop` cannot stop.

**Applied in this repo (2026-09-17):** exact same failure reproduced. `gradlew.bat --stop` alone did NOT release the lock; the offender was `java` PID owned by VS Code's Gradle Language Server (`vscjava.vscode-gradle`, GradleServer child of the editor). Killing that PID + `Remove-Item transforms -Recurse -Force` unblocked the build. Gradle re-resolves transforms on the next run.

---

## Part 5 — The clean-slate recovery procedure (do this in order, once)

```bash
# 0. Version check — CLI must be v2
npm install -D @tauri-apps/cli@latest @tauri-apps/api@latest
npx tauri --version          # must print 2.x

# 1. Environment (Part 3), then RESTART all terminals
npx tauri info               # confirm JDK, SDK, NDK all resolved

# 2. Rust cross-compilation targets
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android

# 3. Licenses
sdkmanager --licenses

# 4. Valid identifier in src-tauri/tauri.conf.json
#    "identifier": "com.yourcompany.yourapp"

# 5. Regenerate the Android project
rm -rf src-tauri/gen
npx tauri icon ./app-icon.png        # 1024x1024 PNG
npx tauri android init

# 6. Build with full logging
npx tauri android build --apk --verbose
```

If it still fails, go straight to Gradle for a raw, readable error:

```bash
cd src-tauri/gen/android
./gradlew assembleRelease --stacktrace     # Windows: .\gradlew.bat assembleRelease --stacktrace
```

---

## Part 6 — What a successful build looks like

Artifacts land here:

```
src-tauri/gen/android/app/build/outputs/
├── apk/universal/release/app-universal-release.apk     # with --apk
├── apk/arm64/release/app-arm64-release.apk             # with --split-per-abi
└── bundle/release/app-release.aab                      # default (Play Store)
```

Install on a connected device (`adb devices` should list it, USB debugging on):

```bash
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

Live error capture from the device:

```bash
adb logcat | grep -iE "tauri|rust|fatal"
```

Rust `println!`/`eprintln!` output appears in logcat too — this is your runtime debugging channel.

---

## Part 7 — Post-compile bug hunting on Android

Once it installs, these are the bugs to hunt next:

- **Capabilities/permissions (v2's biggest migration trap).** Check `src-tauri/capabilities/default.json`: it must include your plugin permissions, and must not restrict platforms to desktop. A capability limited to desktop yields "permission denied"-style invoke failures on mobile.
- **Plugin triple-install.** Every Tauri v2 plugin needs all three: the npm package, `.plugin(tauri_plugin_x::init())` in `lib.rs`, and its permission in capabilities. Missing any one = runtime invoke errors.
- **CORS.** The Android WebView enforces CORS on fetch to external APIs. Use `@tauri-apps/plugin-http`'s fetch for cross-origin calls.
- **Android manifest permissions.** Plugins like notifications (API 33+ runtime permission), camera, or biometric need entries in `gen/android/app/src/main/AndroidManifest.xml`.
- **v1 leftovers.** If this codebase was migrated: import paths changed (`@tauri-apps/api/tauri` → `@tauri-apps/api/core`), `appWindow` → `getCurrentWindow()`, `tauri::api::*` → plugins, allowlist → capabilities. Run `npx tauri migrate` if you haven't.
- **WebView feature parity.** Android uses the updatable System WebView (Chromium); cutting-edge JS/WebGPU features may lag desktop Chrome.

---

## Part 8 — General Tauri v2 codebase audit checklist

- [ ] `npx tauri info` clean on the build machine.
- [ ] Version matrix aligned: CLI 2.x, `@tauri-apps/api` 2.x, Rust `tauri` crate 2.x, all `tauri-plugin-*` at 2.x. Version skew between JS and Rust sides of a plugin is a classic silent bug.
- [ ] `cargo check --target aarch64-linux-android` passes (catches Android-only `#[cfg]` paths that desktop builds never compile).
- [ ] `cargo clippy` + `tsc --noEmit` + `npm audit` / `cargo audit` clean.
- [ ] `tauri.conf.json`: valid identifier, correct `frontendDist`/`beforeBuildCommand`, sensible CSP.
- [ ] Window config: desktop-only options (`decorations`, size) are ignored on mobile — verify nothing depends on them.
- [ ] IPC placement law: no `@tauri-apps/api/core` / `@tauri-apps/api/event` imports (and no raw `invoke()`/`listen()`) outside the `src/platform/` seam. Enforced in CI. **Applied 2026-09-17:** `src/api/{backup,cloud,hardware}.ts`, `src/utils/phoneUtils.ts`, `src/hooks/useAutoDetectedHardware.ts` had raw `@tauri-apps/api` calls; all now route through new `src/platform/{invoke,events,opener}.ts`. `npx tsc -b`, `npm run lint`, `npm test` (238 invariants) pass.
- [ ] Every command the webview invokes actually exists in the Rust `invoke_handler` — dead commands are silent runtime failures. **Fixed 2026-09-17:** `hardware_scan_devices` + `hardware_update_vfd` (new `src-tauri/src/hardware.rs`, registered in `generate_handler!`) — Windows spooler-printer + serial discovery, Unix `/dev` serial scan, allow-listed serial VFD writes, honest mobile errors; 5 unit tests. Hotplug push events (`hardware://device-list-updated`) still have no Rust emitter — the hook re-scans on demand, so discovery stays pull-based.
- [ ] Every backup the app reports as successful must be restorable. **Fixed 2026-09-17:** `createPreMigrationBackup` counted the unrestorable Dexie mirror snapshot toward success — now success requires the native SQLite file copy in Tauri (migration aborts otherwise, as designed). Added `listDexieSnapshots()` + `restoreDexieSnapshot()` (atomic mirror rebuild) for the documented mirror-refresh use case after a native file restore.
- [ ] Turso token must never sit in Web Storage inside Tauri (rules.md S4.1). **Fixed 2026-09-17:** `src/sync/keychain.ts` mirrored every save to `localStorage`; now mirrors only outside Tauri and wipes legacy mirrors after a successful keychain read.
- [ ] Print/drawer commands must fail honestly — silent `Ok(())` is a merchant-facing lie. **Fixed 2026-09-17:** `src-tauri/src/printer.rs` returned `Ok` for missing-printer (Windows) and no-op `Ok` (macOS/Linux); both now return `Err`. Callers are boolean-safe (`escpos.ts`), checkout unaffected.
- [ ] No `.lock().unwrap()` on hot paths. **Fixed 2026-09-17:** `src-tauri/src/hlc.rs` `now()`/`observe()` now recover via `unwrap_or_else(|e| e.into_inner())`.
- [ ] No stale nested lockfiles. **Fixed 2026-09-17:** deleted ignored `src-tauri/Cargo.lock` (workspace member; root `Cargo.lock` is authoritative).
- [ ] CI labels must match reality. **Fixed 2026-09-17:** quality-gate step renamed from "113 Invariants" to "Business Invariants" (suite is 238 and growing).

---

## Part 9 — Prevention: CI build matrix

Keep Android compilable forever by building it on every push:

```yaml
name: android
on: [push]
jobs:
  build:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: aarch64-linux-android,armv7-linux-androideabi,i686-linux-android,x86_64-linux-android
      - uses: android-actions/setup-android@v3
      - run: sdkmanager --install "ndk;26.1.10909125" --licenses
      - run: echo "NDK_HOME=$ANDROID_HOME/ndk/26.1.10909125" >> $GITHUB_ENV
      - run: npm ci
      - run: npx tauri android build --apk
      - uses: actions/upload-artifact@v4
        with:
          name: apk
          path: src-tauri/gen/android/app/build/outputs/apk/**/*.apk
```

---

## Part 10 — Information needed for a pinpoint diagnosis

Provide these six things to identify the exact failure:

1. The full output of `npx tauri android build --apk --verbose` (last ~50 lines at minimum).
2. Full output of `npx tauri info`.
3. `java -version` and `rustup target list --installed`.
4. Your OS, whether you build natively or in WSL, and whether the project path contains spaces or non-ASCII characters.
5. `src-tauri/tauri.conf.json` (identifier can be redacted).
6. Which of the three stages (Part 1) the error belongs to — if unsure, paste the error and classify it.

**1–6 ranking of most likely causes:**

1. `NDK_HOME` unset/wrong
2. Stale `gen/android` from a broken initial env
3. Missing Rust android targets
4. JDK mismatch
5. Missing signing on a release build
6. Corrupted local Gradle `transforms` cache / daemon lock (Bug #13) — check this if the build dies in under ~10 seconds with a cache `FileNotFoundException`**

The Part 5 clean-slate procedure fixes causes 1–5 in one pass — but not #6, which lives in `~/.gradle` and needs the Bug #13 cache-purging steps instead. Start with whichever symptom classification matches your error.