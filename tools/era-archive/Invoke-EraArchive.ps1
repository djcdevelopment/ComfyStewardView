<#
.SYNOPSIS
One unattended CPU pass over every pending era, with nothing left to remember.

.DESCRIPTION
Runs inventory -> ingest -> payloads -> community -> community tables -> rasters -> pilots ->
read-model rebuild -> integrity check, then cleans up and writes a run receipt.

Every cross-era flag (legacy galleries, curated links, every capture manifest) comes from the
run manifest, not the command line: the first pass lost 535 albums to one forgotten flag and
every photograph to another. analysis/ is snapshotted before the projection is rebuilt, and
the receipt asserts the projection imported exactly the manifests the run manifest names.

Per-era ingest failures are isolated by archive.py; this driver records them and carries on.
Eras already verified are skipped by archive.py itself, so a rerun resumes.

.PARAMETER Manifest
Defaults to <OutputRoot>\run-manifest.json.

.PARAMETER Era
Restrict ingest to these era slugs. Every later stage still covers all verified eras.

.EXAMPLE
.\Invoke-EraArchive.ps1 -InputRoot E:\omen\gallery\valheim -OutputRoot E:\omen\steward-multi-era -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$InputRoot,
    [Parameter(Mandatory)][string]$OutputRoot,
    [string]$Java = '',
    [string]$Python = 'python',
    [string]$Manifest = '',
    [string[]]$Era = @(),
    [switch]$SkipCleanup
)
$ErrorActionPreference = 'Stop'
$OutputRoot = (Resolve-Path $OutputRoot).Path
if (-not $Manifest) { $Manifest = Join-Path $OutputRoot 'run-manifest.json' }
if (-not (Test-Path $Manifest)) { throw "Run manifest not found: $Manifest" }
$spec = Get-Content -Raw -Encoding UTF8 $Manifest | ConvertFrom-Json
if ($spec.schema -ne 'steward-run-manifest/v1') { throw "Unexpected manifest schema: $($spec.schema)" }
if (-not $Java) { $Java = $spec.java }
if (-not $Java) { throw 'No -Java given and the manifest names none' }

function Resolve-Lake([string]$path) {
    if ([System.IO.Path]::IsPathRooted($path)) { return $path }
    return Join-Path $OutputRoot $path
}

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$runStart = Get-Date
$runDir = Join-Path $OutputRoot "runs\$stamp"
$stages = @()
$failures = @()
$whatIf = $WhatIfPreference

if (-not $whatIf) {
    New-Item -ItemType Directory -Force $runDir | Out-Null
    Start-Transcript -Path (Join-Path $runDir 'transcript.log') | Out-Null
}

function Invoke-Stage {
    param([string]$Name, [string[]]$Arguments, [switch]$Fatal)
    $line = ($Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    if ($whatIf) { Write-Host "[$Name] $Python $line"; return $true }
    Write-Host "== $Name" -ForegroundColor Cyan
    Write-Host "   $Python $line"
    $started = Get-Date
    & $Python @Arguments
    $code = $LASTEXITCODE
    $script:stages += [ordered]@{ name = $Name; exitCode = $code; startedAt = $started.ToUniversalTime().ToString('o');
                                  seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1); command = @($Python) + $Arguments }
    if ($code -ne 0) {
        $script:failures += "$Name exited $code"
        Write-Warning "$Name exited $code"
        if ($Fatal) { throw "$Name failed; see $runDir" }
        return $false
    }
    return $true
}

$archive = Join-Path $PSScriptRoot 'archive.py'
try {
    # 1. Intake: every save judged on its own; the report says what was rejected.
    Invoke-Stage 'inventory' @($archive, 'inventory', '--input-root', $InputRoot, '--output-root', $OutputRoot) -Fatal | Out-Null

    # 2. Snapshot the analyses before anything rebuilds them. The operator did this by hand
    #    every time for a reason; keeping the last few is cheap (~0.5 GB each).
    $analysis = Join-Path $OutputRoot 'analysis'
    $backup = Join-Path $OutputRoot "analysis-backup-$stamp-auto"
    if (Test-Path $analysis) {
        if ($PSCmdlet.ShouldProcess($backup, 'snapshot analysis/')) {
            Copy-Item -Recurse -LiteralPath $analysis -Destination $backup
        }
        $keep = 3; if ($spec.analysisBackupsToKeep) { $keep = [int]$spec.analysisBackupsToKeep }
        $auto = Get-ChildItem -LiteralPath $OutputRoot -Directory -Filter 'analysis-backup-*-auto' | Sort-Object Name -Descending
        foreach ($old in ($auto | Select-Object -Skip $keep)) {
            if ($PSCmdlet.ShouldProcess($old.FullName, 'prune old analysis snapshot')) { Remove-Item -Recurse -Force -LiteralPath $old.FullName }
        }
    }

    # 3. Ingest every pending era; archive.py isolates failures per era and skips verified ones.
    $ingest = @($archive, 'ingest', '--output-root', $OutputRoot, '--java', $Java, '--no-rebuild')
    if ($spec.parserJar) { $ingest += @('--jar', (Resolve-Lake $spec.parserJar)) }
    foreach ($slug in $Era) { $ingest += @('--era', $slug) }
    Invoke-Stage 'ingest' $ingest | Out-Null

    # 4. Everything after ingest covers exactly the verified eras.
    Invoke-Stage 'payloads' @((Join-Path $PSScriptRoot 'payloads.py'), '--output-root', $OutputRoot) -Fatal | Out-Null

    $community = @((Join-Path $PSScriptRoot 'community.py'), '--output-root', $OutputRoot)
    if ($spec.legacyGalleries) { $community += @('--legacy-galleries', (Resolve-Lake $spec.legacyGalleries)) }
    if ($spec.links) { $community += @('--links', (Resolve-Lake $spec.links)) }
    $captureCount = 0
    foreach ($manifestPath in @($spec.captures)) {
        $full = Resolve-Lake $manifestPath
        if (-not (Test-Path $full)) { throw "Capture manifest named by the run manifest is missing: $full" }
        $community += @('--captures', $full); $captureCount += 1
    }
    Invoke-Stage 'community' $community -Fatal | Out-Null
    Invoke-Stage 'community-tables' @((Join-Path $PSScriptRoot 'community_store.py'), '--output-root', $OutputRoot) -Fatal | Out-Null

    $rasters = @((Join-Path $PSScriptRoot 'jobs.py'), 'rasters', '--output-root', $OutputRoot, '--java', $Java)
    if ($spec.labJar) { $rasters += @('--jar', (Resolve-Lake $spec.labJar)) }
    Invoke-Stage 'rasters' $rasters | Out-Null
    Invoke-Stage 'pilots' @((Join-Path $PSScriptRoot 'pilot.py'), '--output-root', $OutputRoot) | Out-Null

    # 5. One read-model rebuild, then the integrity check that reads it.
    Invoke-Stage 'rebuild' @($archive, 'rebuild', '--output-root', $OutputRoot) -Fatal | Out-Null
    Invoke-Stage 'verify' @((Join-Path $PSScriptRoot 'verify.py'), '--output-root', $OutputRoot) | Out-Null

    # 6. Cleanup of what earlier runs left behind: read-model candidates that never got
    #    promoted, headless-Chrome profiles under receipt folders, and stale .bak copies.
    $removed = @()
    if (-not $SkipCleanup) {
        $candidates = Get-ChildItem -LiteralPath $OutputRoot -File -Filter 'world-cache-*.duckdb' |
            Where-Object { $_.Name -match '^world-cache-[0-9a-f]{32}\.duckdb$' -and $_.LastWriteTime -lt $runStart }
        $profiles = @()
        foreach ($area in @('projections', 'validation', 'world-view-v2', 'world-view-v3')) {
            $base = Join-Path $OutputRoot $area
            if (Test-Path $base) {
                $profiles += Get-ChildItem -LiteralPath $base -Directory -Recurse -Filter 'profile' -ErrorAction SilentlyContinue |
                    Where-Object { Test-Path (Join-Path $_.FullName 'Default') }
            }
        }
        $legacyProfile = Join-Path $OutputRoot 'validation\legacy-browser-profile-25960'
        if (Test-Path $legacyProfile) { $profiles += Get-Item -LiteralPath $legacyProfile }
        $baks = Get-ChildItem -LiteralPath $analysis -File -Filter '*.bak-*' -ErrorAction SilentlyContinue
        foreach ($item in @($candidates) + @($profiles) + @($baks)) {
            if ($PSCmdlet.ShouldProcess($item.FullName, 'remove stale artifact')) {
                Remove-Item -Recurse -Force -LiteralPath $item.FullName
                $removed += $item.FullName
            }
        }
    }
}
finally {
    if (-not $whatIf) {
        # 7. The receipt: what ran, what it produced, and the assertion that the projection
        #    imported every manifest the run manifest names.
        $state = [ordered]@{ stamp = $stamp; startedAt = $runStart.ToUniversalTime().ToString('o');
                             manifest = $Manifest; expectedCaptureImports = $captureCount;
                             stages = $stages; failures = $failures; removed = $removed }
        $statePath = Join-Path $runDir 'stages.json'
        $state | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 $statePath
        & $Python (Join-Path $PSScriptRoot 'run_receipt.py') --output-root $OutputRoot --run-dir $runDir --manifest $Manifest
        if ($LASTEXITCODE -ne 0) { $failures += "run_receipt exited $LASTEXITCODE" }
        Stop-Transcript | Out-Null
    }
}
if ($failures.Count) {
    Write-Warning ("Run finished with failures: " + ($failures -join '; '))
    exit 1
}
Write-Host "CPU processing complete; receipt at $runDir\run-receipt.json. Game sessions are dispatched explicitly."
