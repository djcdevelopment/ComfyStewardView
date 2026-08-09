<#
.SYNOPSIS
  Report (and optionally delete) abandoned agent scratchpads and orphaned analytics caches.

.DESCRIPTION
  Every world save in this project is ~1.27 GB and every analytics cache built from one is 1-10 GB.
  Nothing prunes agent scratch directories, so a session that rehearses the publish lane leaves
  multi-GB DuckDB files behind forever. Three abandoned sessions had accumulated 28.3 GB and taken
  C: down to 1.1 GB free — low enough that the nightly publish, which pulls a 1.24 GB world into
  %LOCALAPPDATA%\steward-publish, would have failed on space.

  Dry run by default: it prints what it would remove and the space that would come back. Pass
  -Delete to actually remove. The live session is identified from CLAUDE_SESSION_ID when present
  and is never a candidate; pass -KeepSession to protect one explicitly.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\Clear-StewardScratch.ps1
  powershell -ExecutionPolicy Bypass -File .\tools\Clear-StewardScratch.ps1 -Delete
#>
[CmdletBinding()]
param(
    [string]$ScratchRoot = "$env:LOCALAPPDATA\Temp\claude",
    # Age below which a scratchpad is assumed to still be in use.
    [int]$MinAgeHours = 6,
    # Only report scratchpads at least this large; small ones are not worth the noise.
    [double]$MinSizeGB = 0.25,
    [string]$KeepSession = '',
    [switch]$Delete
)

$ErrorActionPreference = 'Stop'

$live = if ($KeepSession) { $KeepSession } elseif ($env:CLAUDE_SESSION_ID) { $env:CLAUDE_SESSION_ID } else { '' }
if ($live) { Write-Host "Protecting live session: $live" -ForegroundColor DarkGray }

function Get-SizeGB([string]$Path) {
    $s = (Get-ChildItem $Path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    [math]::Round($s / 1GB, 2)
}

$cutoff = (Get-Date).AddHours(-$MinAgeHours)
$candidates = @()

if (Test-Path $ScratchRoot) {
    # Layout is <root>\<project-slug>\<session-guid>\...
    Get-ChildItem $ScratchRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $session = $_
            if ($live -and $session.Name -eq $live) { return }
            $newest = (Get-ChildItem $session.FullName -Recurse -File -ErrorAction SilentlyContinue |
                       Measure-Object LastWriteTime -Maximum).Maximum
            if ($newest -and $newest -gt $cutoff) { return }   # still warm
            $gb = Get-SizeGB $session.FullName
            if ($gb -lt $MinSizeGB) { return }
            $candidates += [pscustomobject]@{
                Path = $session.FullName
                SizeGB = $gb
                LastWrite = $newest
                Label = "$($session.Parent.Name)\$($session.Name.Substring(0, [Math]::Min(8, $session.Name.Length)))"
            }
        }
    }
}

if (-not $candidates) {
    Write-Host 'No stale scratchpads found.' -ForegroundColor Green
} else {
    Write-Host ''
    Write-Host ("{0,8}  {1,-19}  {2}" -f 'SIZE', 'LAST WRITE', 'SCRATCHPAD')
    foreach ($c in ($candidates | Sort-Object SizeGB -Descending)) {
        Write-Host ("{0,6:N2} GB  {1,-19}  {2}" -f $c.SizeGB, $c.LastWrite, $c.Label)
    }
    $total = [math]::Round(($candidates | Measure-Object SizeGB -Sum).Sum, 2)
    Write-Host ''
    Write-Host ("Reclaimable: {0:N2} GB across {1} stale session(s)." -f $total, $candidates.Count) -ForegroundColor Yellow
}

# Large caches outside the scratch root are reported but never deleted here — the publish
# workdir's cache is regenerated from the Parquet archive on every run, but a corpus cache
# may be the only copy of an expensive parse, so removing those stays a human decision.
Write-Host ''
Write-Host 'Large analytics caches elsewhere (report only):'
$seen = $false
foreach ($root in @("$env:LOCALAPPDATA\steward-publish", 'D:\')) {
    if (-not (Test-Path $root)) { continue }
    Get-ChildItem $root -Recurse -File -Include '*.duckdb' -ErrorAction SilentlyContinue |
        Where-Object { $_.Length -gt 500MB } | ForEach-Object {
            $seen = $true
            Write-Host ("  {0,6:N2} GB  {1}" -f ($_.Length / 1GB), $_.FullName)
        }
}
if (-not $seen) { Write-Host '  (none over 500 MB)' }

$free = [math]::Round((Get-PSDrive C).Free / 1GB, 2)
Write-Host ''
Write-Host "C: free: $free GB"
if ($free -lt 5) {
    Write-Host 'WARNING: below 5 GB. Publish-Steward pulls a ~1.3 GB world into %LOCALAPPDATA% and' -ForegroundColor Red
    Write-Host '         rebuilds a ~10 GB cache; it will fail on space before it fails on anything else.' -ForegroundColor Red
}

if ($Delete -and $candidates) {
    Write-Host ''
    foreach ($c in $candidates) {
        Remove-Item -LiteralPath $c.Path -Recurse -Force -ErrorAction Stop
        Write-Host ("removed {0,6:N2} GB  {1}" -f $c.SizeGB, $c.Label)
    }
    Write-Host ''
    Write-Host "C: free now: $([math]::Round((Get-PSDrive C).Free / 1GB, 2)) GB" -ForegroundColor Green
} elseif ($candidates) {
    Write-Host ''
    Write-Host 'Dry run. Re-run with -Delete to remove the scratchpads listed above.'
}
