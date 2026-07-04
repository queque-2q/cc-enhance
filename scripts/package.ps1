# package.ps1 - CC Diff one-click build and package
param(
    [string]$Version
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "=== CC Diff Package Builder ===" -ForegroundColor Cyan

# 0. Update version if specified
if ($Version) {
    Write-Host "`nVersion parameter detected: $Version" -ForegroundColor Magenta
    $totalSteps = 4
} else {
    $totalSteps = 3
}

# 1. Update version numbers
if ($Version) {
    Write-Host "`n[1/$totalSteps] Updating version to $Version..." -ForegroundColor Yellow

    # Update extension package.json
    $extPkgPath = Join-Path $root "vscode-extension\package.json"
    $extPkg = Get-Content $extPkgPath -Raw | ConvertFrom-Json
    $extPkg.version = $Version
    $extPkg | ConvertTo-Json -Depth 10 | Set-Content $extPkgPath -Encoding UTF8
    Write-Host "  Updated package.json" -ForegroundColor Gray

    # Update hooks package.json
    $hooksPkgPath = Join-Path $root "vscode-extension\hooks\package.json"
    $hooksPkg = Get-Content $hooksPkgPath -Raw | ConvertFrom-Json
    $hooksPkg.version = $Version
    $hooksPkg | ConvertTo-Json -Depth 10 | Set-Content $hooksPkgPath -Encoding UTF8
    Write-Host "  Updated hooks/package.json" -ForegroundColor Gray

    $stepNum = 2
} else {
    $stepNum = 1
}

# 2. Install extension dependencies
Write-Host "`n[$stepNum/$totalSteps] Installing extension dependencies..." -ForegroundColor Yellow
Push-Location "$root\vscode-extension"
npm install
Pop-Location
$stepNum++

# 3. Compile TypeScript
Write-Host "`n[$stepNum/$totalSteps] Compiling TypeScript..." -ForegroundColor Yellow
Push-Location "$root\vscode-extension"
npx tsc -p ./
Pop-Location
$stepNum++

# 4. Package VSIX
Write-Host "`n[$stepNum/$totalSteps] Packaging VSIX..." -ForegroundColor Yellow
Push-Location "$root\vscode-extension"
npx vsce package --allow-missing-repository
Pop-Location

Write-Host "`n=== Done! VSIX is in  ===" -ForegroundColor Green
