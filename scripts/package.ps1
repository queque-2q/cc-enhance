# package.ps1 - CC Diff one-click build and package
param([switch]$SkipTests)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "=== CC Diff Package Builder ===" -ForegroundColor Cyan

# 1. Install extension dependencies
Write-Host "`n[1/4] Installing extension dependencies..." -ForegroundColor Yellow
Push-Location "$root\vscode-extension"
npm install
Pop-Location

# 2. Compile TypeScript
Write-Host "`n[2/4] Compiling TypeScript..." -ForegroundColor Yellow
Push-Location "$root\vscode-extension"
npx tsc -p ./
Pop-Location

# 3. Run integration tests
if (-not $SkipTests) {
    Write-Host "`n[3/4] Running integration tests..." -ForegroundColor Yellow
    $testScript = Join-Path (Join-Path $root "test") "integration-test.sh"
    bash $testScript
    if ($LASTEXITCODE -ne 0) {
        throw "Integration tests failed (exit code: $LASTEXITCODE)"
    }
    Write-Host "Tests passed!" -ForegroundColor Green
} else {
    Write-Host "`n[3/4] Tests skipped (-SkipTests)" -ForegroundColor DarkYellow
}

# 4. Package VSIX
Write-Host "`n[4/4] Packaging VSIX..." -ForegroundColor Yellow
Push-Location "$root\vscode-extension"
npx vsce package
Pop-Location

Write-Host "`n=== Done! VSIX is in vscode-extension/ ===" -ForegroundColor Green
