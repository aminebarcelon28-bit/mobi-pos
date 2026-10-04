# Build "Licensing for MobiPOS" into a double-clickable Windows executable.
#
#   powershell -ExecutionPolicy Bypass -File build_licensing.ps1
#
# Output: dist\Licensing for MobiPOS\Licensing for MobiPOS.exe

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $root

$python = if ($env:LICENSING_PYTHON) { $env:LICENSING_PYTHON } else { "python" }

Write-Host "==> Installing build dependencies" -ForegroundColor Cyan
& $python -m pip install --upgrade pyinstaller | Out-Host
& $python -m pip install -r requirements-licensing.txt | Out-Host

Write-Host "==> Running headless checks" -ForegroundColor Cyan
& $python scripts\check_licensing_app.py
if ($LASTEXITCODE -ne 0) {
    Write-Error "Checks failed; build aborted."
    exit $LASTEXITCODE
}

Write-Host "==> Building single-file executable" -ForegroundColor Cyan
& $python -m PyInstaller --noconfirm --clean `
    --distpath (Join-Path $root "licensing_dist") `
    --workpath (Join-Path $root "build\licensing") `
    licensing.spec | Out-Host
if ($LASTEXITCODE -ne 0) {
    Write-Error "PyInstaller build failed."
    exit $LASTEXITCODE
}

$exe = Join-Path $root "licensing_dist\Licensing for MobiPOS.exe"
if (Test-Path $exe) {
    $sizeMb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
    Write-Host "`nBuild complete: $exe ($sizeMb MB)" -ForegroundColor Green
} else {
    Write-Warning "Executable not found at expected path."
}
