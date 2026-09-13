[CmdletBinding()]
param(
    [ValidateSet('chrome', 'edge')]
    [string]$Browser = 'chrome',
    [int]$DebugPort = 9222,
    [string]$Url = 'about:blank',
    [string]$ProfileDir = (Join-Path $PSScriptRoot 'debug-profile'),
    [string]$ExtensionDir = ''
)

$ErrorActionPreference = 'Stop'

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
    throw "未找到 $Browser。检查浏览器安装路径，或修改 launch-debug-browser.ps1 中的 candidates。"
}

$resolvedProfile = [System.IO.Path]::GetFullPath($ProfileDir)
New-Item -ItemType Directory -Force -Path $resolvedProfile | Out-Null

# Start-Process 会把 ArgumentList 拼成单个命令行；显式引用可保留 URL/路径中的空格。
function Quote-ProcessArgument([string]$Value) {
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

$arguments = @(
    "--remote-debugging-port=$DebugPort",
    "--user-data-dir=$(Quote-ProcessArgument $resolvedProfile)",
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=TranslateUI'
)

if ($ExtensionDir) {
    $resolvedExtension = [System.IO.Path]::GetFullPath($ExtensionDir)
    if (-not (Test-Path -LiteralPath (Join-Path $resolvedExtension 'manifest.json'))) {
        throw "扩展目录缺少 manifest.json: $resolvedExtension"
    }
    $arguments += "--load-extension=$(Quote-ProcessArgument $resolvedExtension)"
    Write-Host "Extension: $resolvedExtension" -ForegroundColor Cyan
}
$arguments += (Quote-ProcessArgument $Url)

Write-Host "启动: $exe" -ForegroundColor Cyan
Write-Host "CDP:  http://127.0.0.1:$DebugPort" -ForegroundColor Cyan
Write-Host "Profile: $resolvedProfile" -ForegroundColor Cyan
Start-Process -FilePath $exe -ArgumentList $arguments
