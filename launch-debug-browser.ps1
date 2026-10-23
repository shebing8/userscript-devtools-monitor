[CmdletBinding()]
param(
    [ValidateSet('chrome', 'edge')]
    [string]$Browser = 'chrome',
    [int]$DebugPort = 9222,
    [string]$Url = 'about:blank',
    [string]$ProfileDir = '',
    [string]$ExtensionDir = ''
)

$ErrorActionPreference = 'Stop'
if (-not $ProfileDir) {
    $ProfileDir = Join-Path $PSScriptRoot 'debug-profile'
}

$candidates = if ($Browser -eq 'chrome') {
    @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
} else {
    @(
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
    )
}

$exe = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $exe) {
    throw "Browser not found: $Browser"
}

$resolvedProfile = [System.IO.Path]::GetFullPath($ProfileDir)
New-Item -ItemType Directory -Force -Path $resolvedProfile | Out-Null

$argList = @(
    "--remote-debugging-port=$DebugPort",
    "--user-data-dir=$resolvedProfile",
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=TranslateUI'
)

if ($ExtensionDir) {
    $resolvedExtension = [System.IO.Path]::GetFullPath($ExtensionDir)
    if (-not (Test-Path -LiteralPath (Join-Path $resolvedExtension 'manifest.json'))) {
        throw "Extension missing manifest.json: $resolvedExtension"
    }
    $argList += "--load-extension=$resolvedExtension"
    Write-Host "Extension: $resolvedExtension" -ForegroundColor Cyan
}

if ($Url) {
    $argList += $Url
}

Write-Host "Starting: $exe" -ForegroundColor Cyan
Write-Host "CDP:  http://127.0.0.1:$DebugPort" -ForegroundColor Cyan
Write-Host "Profile: $resolvedProfile" -ForegroundColor Cyan

Start-Process -FilePath $exe -ArgumentList $argList
