#!/usr/bin/env bash
# ==============================================================================
# MobiPOS — Multi-Platform Mobile Bootstrap Script (POSIX / macOS / Linux)
# ==============================================================================

set -euo pipefail

echo ">>> [MobiPOS] Initializing 5-Target Mobile Development Environment..."

if ! command -v rustup &> /dev/null; then
    echo "[FATAL] rustup is not installed or not in PATH. Install from https://rustup.rs" >&2
    exit 1
fi

echo ">>> Adding Android & iOS compilation targets..."
rustup target add \
    aarch64-linux-android \
    armv7-linux-androideabi \
    x86_64-linux-android \
    aarch64-apple-ios \
    aarch64-apple-ios-sim

echo ">>> Checking Environment..."
if [ -n "${ANDROID_HOME:-}" ]; then
    echo "  [OK] ANDROID_HOME is set: $ANDROID_HOME"
else
    echo "  [WARN] ANDROID_HOME is not set."
fi

if [ -n "${NDK_HOME:-}" ]; then
    echo "  [OK] NDK_HOME is set: $NDK_HOME"
else
    echo "  [WARN] NDK_HOME is not set."
fi

if command -v java &> /dev/null; then
    echo "  [OK] Java found: $(java -version 2>&1 | head -n 1)"
else
    echo "  [WARN] Java (JDK 17) not found in PATH."
fi

echo ">>> [MobiPOS] Mobile target prerequisites check complete!"
