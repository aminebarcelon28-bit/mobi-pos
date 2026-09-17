@echo off
REM ==============================================================================
REM MobiPOS — One-Click Android APK Build (PC)
REM Double-click this file. It verifies AND auto-repairs the whole toolchain
REM (Java 17+, Android SDK packages, NDK, Rust targets), then builds an
REM install-ready DEBUG APK. No Android Studio needed.
REM
REM Release/signed APKs stay on CI: push a tag (v*) and GitHub builds them.
REM ==============================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo  ============================================================
echo   MobiPOS — Android APK builder (one click)
echo  ============================================================
echo.

REM ---------- [1/6] Node.js (required for the Tauri CLI) ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [FATAL] Node.js not found. Install LTS from https://nodejs.org then re-run.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo [OK] Node %%v

REM ---------- [2/6] Java 17+ (required for Gradle) ----------
where java >nul 2>nul
if errorlevel 1 (
  echo [FATAL] Java not found. Install Temurin JDK 17: winget install EclipseAdoptium.Temurin.17.JDK
  pause
  exit /b 1
)
node scripts\check-java.mjs
if errorlevel 1 (
  echo        Install: winget install EclipseAdoptium.Temurin.17.JDK
  pause
  exit /b 1
)

REM ---------- [3/6] Rust Android targets ----------
where rustup >nul 2>nul
if errorlevel 1 (
  echo [FATAL] rustup not found. Install from https://rustup.rs then re-run.
  pause
  exit /b 1
)
echo [OK] rustup found — ensuring Android targets...
call rustup target add aarch64-linux-android armv7-linux-androideabi >nul 2>nul

REM ---------- [4/6] Locate Android SDK ----------
if not defined ANDROID_HOME (
  if exist "%LOCALAPPDATA%\Android\Sdk" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
)
if not defined ANDROID_HOME (
  echo [FATAL] ANDROID_HOME not set and no SDK at %%LOCALAPPDATA%%\Android\Sdk.
  echo        Install "Android SDK Command-line Tools" once, then set ANDROID_HOME.
  echo        See: https://developer.android.com/studio#command-line-tools-only
  pause
  exit /b 1
)
echo [OK] ANDROID_HOME=%ANDROID_HOME%

set "SDKMANAGER="
if exist "%ANDROID_HOME%\cmdline-tools\latest\bin\sdkmanager.bat" set "SDKMANAGER=%ANDROID_HOME%\cmdline-tools\latest\bin\sdkmanager.bat"
if not defined SDKMANAGER (
  if exist "%ANDROID_HOME%\cmdline-tools\bin\sdkmanager.bat" set "SDKMANAGER=%ANDROID_HOME%\cmdline-tools\bin\sdkmanager.bat"
)

REM ---------- [5/6] Auto-install missing SDK packages ----------
set "NEED_INSTALL=0"
if not exist "%ANDROID_HOME%\platform-tools\adb.exe" set "NEED_INSTALL=1"
if not exist "%ANDROID_HOME%\platforms\android-36" set "NEED_INSTALL=1"
if not exist "%ANDROID_HOME%\build-tools" set "NEED_INSTALL=1"

if "%NEED_INSTALL%"=="1" (
  if not defined SDKMANAGER (
    echo [FATAL] SDK packages missing and no sdkmanager found.
    echo        Install command-line tools into %%ANDROID_HOME%%\cmdline-tools\latest, then re-run.
    pause
    exit /b 1
  )
  echo [...] Installing missing SDK packages ^(platform-tools, android-36, build-tools^)...
  call "%SDKMANAGER%" --install "platform-tools" "platforms;android-36" "build-tools;35.0.0"
  if errorlevel 1 (
    echo [FATAL] sdkmanager failed. Run it once manually to accept licenses.
    pause
    exit /b 1
  )
) else (
  echo [OK] SDK packages present.
)

REM ---------- NDK (auto-detect newest, install default if absent) ----------
if not defined NDK_HOME (
  for /d %%d in ("%ANDROID_HOME%\ndk\*") do set "NDK_HOME=%%d"
)
if not defined NDK_HOME (
  if not defined SDKMANAGER (
    echo [FATAL] No NDK found and no sdkmanager to install one.
    pause
    exit /b 1
  )
  echo [...] Installing NDK 26.1.10909125 ^(matches CI^)...
  call "%SDKMANAGER%" --install "ndk;26.1.10909125"
  set "NDK_HOME=%ANDROID_HOME%\ndk\26.1.10909125"
)
echo [OK] NDK_HOME=%NDK_HOME%

REM ---------- [6/7] Disk space + prune dropped ABI artifacts ----------
REM Android + Gradle builds need several GB free. Prune emulator-only ABI
REM artifacts (we no longer build i686/x86_64) and refuse with guidance if low.
if exist "target\i686-linux-android" rmdir /s /q "target\i686-linux-android" >nul 2>nul
if exist "target\x86_64-linux-android" rmdir /s /q "target\x86_64-linux-android" >nul 2>nul
node scripts\check-disk.mjs 8
if errorlevel 1 (
  pause
  exit /b 1
)

REM ---------- [7/7] Build debug APK (auto-signed, installs immediately) ----------
REM Device ABIs only: aarch64 = all modern phones, armv7 = old 32-bit phones.
REM i686/x86_64 are emulator-only and their C toolchain regularly breaks
REM the build (sqlx archive failure) — CI still builds every ABI for release.
echo.
echo [BUILD] npx tauri android build --apk --debug -t aarch64 armv7
echo         First build takes several minutes (Rust + Gradle). Be patient.
echo.
call npx tauri android build --apk --debug -t aarch64 armv7
if errorlevel 1 (
  echo.
  echo [FATAL] Build failed — scroll up for the Gradle/Rust error.
  pause
  exit /b 1
)

echo.
echo  ============================================================
echo   SUCCESS — install-ready APK:
for /r "src-tauri\gen\android\app\build\outputs\apk" %%f in (*debug*.apk) do echo     %%f
echo.
echo   Install via USB ^(phone in developer-mode^):
echo     "%%ANDROID_HOME%%\platform-tools\adb.exe" install -r ^<apk-path^>
echo  ============================================================
pause
