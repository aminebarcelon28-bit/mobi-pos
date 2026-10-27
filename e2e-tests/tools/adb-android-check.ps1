$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"

# Check if app is running and what screen it's on
Write-Host "=== App state ==="
& $adb shell "dumpsys activity activities 2>&1 | Select-String 'mResumedActivity|mFocusedApp' | Select-Object -First 3"

# Try to get a screenshot
Write-Host "`n=== Taking screenshot ==="
& $adb exec-out screencap -p 2>&1 | Set-Content -Path "android-screen.png" -Encoding Byte -ErrorAction SilentlyContinue
if (Test-Path "android-screen.png") {
  $size = (Get-Item "android-screen.png").Length
  Write-Host "Screenshot saved: $size bytes"
} else {
  Write-Host "Could not take screenshot"
}

# Check if PIN screen is showing by looking at window content
Write-Host "`n=== Checking windows ==="
& $adb shell "dumpsys window windows 2>&1 | Select-String -Pattern 'mCurrentFocus|mVisible' | Select-Object -First 3"

# Check Dexie database
Write-Host "`n=== Checking database ==="
& $adb shell "run-as com.mobi.pos ls -la databases/ 2>&1 | head -10"
