param(
  [Parameter(Mandatory = $false)]
  [string]$Url = 'https://example.com/',
  [ValidateSet('chrome', 'edge')]
  [string]$Browser = 'chrome',
  [int]$Port = 9222,
  [switch]$CaptureBodies
)

$ErrorActionPreference = 'Stop'
& "$PSScriptRoot\launch-debug-browser.ps1" -Browser $Browser -DebugPort $Port -Url $Url
Start-Sleep -Seconds 2
$hostMatch = ([Uri]$Url).Host
& "$PSScriptRoot\start-monitor.ps1" -Port $Port -Match $hostMatch -CaptureBodies:$CaptureBodies
