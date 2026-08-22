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
param(
  [string]$ConfigPath = "$env:LOCALAPPDATA\steward-publish\nightly-world.json"
)

$ErrorActionPreference = 'Stop'
$logDir = Join-Path $env:LOCALAPPDATA 'steward-publish\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("nightly-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

# cmd-level redirection: PowerShell 5.1 wraps a native child's stderr lines in
# ErrorRecords under -ErrorAction Stop, turning harmless SLF4J warnings fatal.
$publishScript = Join-Path $PSScriptRoot 'Publish-Steward.ps1'
$publishArgs = '-Push -NoOpIfUnchanged'
if (Test-Path -LiteralPath $ConfigPath) {
    $cfg = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    foreach ($required in 'world_path', 'world_id', 'world_name', 'source', 'backup_id') {
        $value = [string]$cfg.$required
        if ([string]::IsNullOrWhiteSpace($value)) { throw "nightly config is missing $required" }
        if ($value -match '[`"\r\n]') { throw "nightly config $required contains unsupported characters" }
    }
    $publishArgs += " -SkipAm4World -OmenWorldPath `"$($cfg.world_path)`""
    $publishArgs += " -WorldId `"$($cfg.world_id)`" -WorldName `"$($cfg.world_name)`""
    $publishArgs += " -OmenSource `"$($cfg.source)`" -OmenBackupId `"$($cfg.backup_id)`""
}
& cmd /c "powershell -NoProfile -ExecutionPolicy Bypass -File `"$publishScript`" $publishArgs > `"$log`" 2>&1"
$exit = $LASTEXITCODE

Get-ChildItem $logDir -Filter 'nightly-*.log' | Sort-Object Name -Descending |
    Select-Object -Skip 14 | Remove-Item -Force -ErrorAction SilentlyContinue

exit $exit
