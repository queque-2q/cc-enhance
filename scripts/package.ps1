# package.ps1 - CC Diff one-click build and package
param(
    [string]$Version
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot | Split-Path -Parent

Write-Host "=== CC Diff Package Builder ===" -ForegroundColor Cyan

# 0. Update version if specified
if ($Version) {
    Write-Host "`nUpdating version to $Version..." -ForegroundColor Yellow
    $pkgPath = Join-Path $root "package.json"
    $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
    $pkg.version = $Version
    $pkg | ConvertTo-Json -Depth 10 | Set-Content $pkgPath -Encoding UTF8
    Write-Host "  Updated package.json" -ForegroundColor Gray
    $totalSteps = 2
} else {
    $totalSteps = 1
}

# 1. Build (compile + copy webview)
Write-Host "`n[$stepNum/$totalSteps] Building..." -ForegroundColor Yellow
Push-Location $root
npm run build
Pop-Location
$stepNum++

# 2. Package VSIX
Write-Host "`n[$stepNum/$totalSteps] Packaging VSIX..." -ForegroundColor Yellow
Push-Location $root
npx vsce package --allow-missing-repository --baseContentUrl .
Pop-Location

Write-Host "`n=== Done! ===" -ForegroundColor Green
