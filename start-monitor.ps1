[CmdletBinding()]
param(
    [int]$Port = 9222,
    [string]$Match = '',
    [switch]$CaptureBodies,
    [switch]$RawSecrets,
    [int]$BodyLimit = 131072,
    [string[]]$Preload = @()
)

$ErrorActionPreference = 'Stop'
$argsList = @(
    (Join-Path $PSScriptRoot 'cdp-monitor.mjs'),
    '--port', "$Port",
    '--out', (Join-Path $PSScriptRoot 'telemetry'),
    '--body-limit', "$BodyLimit"
)
if ($Match) { $argsList += @('--match', $Match) }
if ($CaptureBodies) { $argsList += '--capture-bodies' }
if ($RawSecrets) { $argsList += '--raw-secrets' }
foreach ($file in $Preload) { $argsList += @('--preload', $file) }

& node @argsList
