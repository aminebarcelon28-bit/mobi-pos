# ==============================================================================
# MobiPOS — Multi-Platform Mobile Bootstrap Script (Phase 1)
# Verifies environment, adds rust toolchains, and initializes Android / iOS shells
# ==============================================================================

Write-Host ">>> [MobiPOS] Initializing 5-Target Mobile Development Environment..." -ForegroundColor Cyan

# 1. Check Rust installation
if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) {
    Write-Error "[FATAL] Rustup is not installed or not in PATH. Install from https://rustup.rs"
    exit 1
}

# 2. Add Mobile Target Toolchains
Write-Host ">>> Installing Android & iOS compilation targets via rustup..." -ForegroundColor Yellow
$targets = @(
    "aarch64-linux-android",
    "armv7-linux-androideabi",
    "x86_64-linux-android",
    "aarch64-apple-ios",
    "aarch64-apple-ios-sim"
)

foreach ($target in $targets) {
    Write-Host "  - Adding target: $target"
    rustup target add $target
}

# 3. Verify Android Environment Variables
Write-Host ">>> Checking Android SDK and NDK configurations..." -ForegroundColor Yellow
if ($env:ANDROID_HOME) {
    Write-Host "  [OK] ANDROID_HOME is set: $env:ANDROID_HOME" -ForegroundColor Green
} else {
    Write-Warning "  [WARN] ANDROID_HOME is not set. Set this to your Android SDK directory (e.g. %LOCALAPPDATA%\Android\Sdk)."
}

if ($env:NDK_HOME) {
    Write-Host "  [OK] NDK_HOME is set: $env:NDK_HOME" -ForegroundColor Green
} else {
    Write-Warning "  [WARN] NDK_HOME is not set. Required for compiling native Rust bindings for Android."
}

# 4. Check Java JDK (JDK 17 recommended for Tauri v2 Android)
if (Get-Command java -ErrorAction SilentlyContinue) {
    $javaVersion = java -version 2>&1 | Select-Object -First 1
    Write-Host "  [OK] Java found: $javaVersion" -ForegroundColor Green
} else {
    Write-Warning "  [WARN] Java (JDK 17) not found in PATH. Required for Gradle Android builds."
}

Write-Host ">>> [MobiPOS] Mobile target prerequisites check complete!" -ForegroundColor Cyan
Write-Host "To initialize or build Android: npx tauri android init && npx tauri android dev" -ForegroundColor Gray
Write-Host "To initialize or build iOS:     npx tauri ios init && npx tauri ios dev" -ForegroundColor Gray
