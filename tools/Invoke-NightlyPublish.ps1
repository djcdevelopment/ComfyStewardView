<#
.SYNOPSIS
  Scheduled nightly Steward publish: accumulate world history onto AM4.

.DESCRIPTION
  Thin wrapper for Task Scheduler around Publish-Steward.ps1 -Push -NoOpIfUnchanged.
  Each run appends up to two snapshots (am4 + omen copies) to the live latest-6 window
  and the permanent Parquet archive; unchanged worlds are a quiet no-op. Output goes to
  a dated log under the publish workdir; the last 14 logs are kept.

  Registered as Windows scheduled task "Steward Nightly Publish" (03:30 daily).
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$logDir = Join-Path $env:LOCALAPPDATA 'steward-publish\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("nightly-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

& powershell -NoProfile -ExecutionPolicy Bypass `
    -File (Join-Path $PSScriptRoot 'Publish-Steward.ps1') -Push -NoOpIfUnchanged `
    *> $log
$exit = $LASTEXITCODE

Get-ChildItem $logDir -Filter 'nightly-*.log' | Sort-Object Name -Descending |
    Select-Object -Skip 14 | Remove-Item -Force -ErrorAction SilentlyContinue

exit $exit
