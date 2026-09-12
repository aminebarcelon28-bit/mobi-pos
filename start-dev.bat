@echo off
REM MobiPOS lab launcher: token broker + Tauri dev app (sandbox only).
REM Double-click this file. Keep both windows open while selling.
cd /d "%~dp0"
echo [1/2] Starting sync-token broker :8787 ...
start "MobiPOS broker :8787" /min node proxy\server.mjs
timeout /t 3 /nobreak >nul
echo [2/2] Starting Tauri dev app (first build takes minutes) ...
start "MobiPOS tauri dev" powershell -NoExit -Command "npx tauri dev *> tauri-dev-app.log"
echo Done. Watch the "MobiPOS tauri dev" window; the POS opens automatically.
echo Sell, wait for the badge to turn green, then check Turso.
pause
