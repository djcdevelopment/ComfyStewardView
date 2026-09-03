<#
.SYNOPSIS
  Build the snapshot-matched terrain and water context for the Era 17 world view.
#>
[CmdletBinding()]
param(
    [long]$SnapshotId = 107,
    [string]$ArtifactRoot = '',
    [string]$WorldDbPath = 'E:\omen\era17\ComfyEra17.db',
    [string]$WorldFilePath = 'E:\omen\era17\ComfyEra17.fwl',
    [string]$MinimapRoot = '',
    [string]$OutputRoot = '',
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ArtifactRoot) { $ArtifactRoot = Join-Path $repoRoot 'data\era17-artifacts' }
if (-not $MinimapRoot) {
    $MinimapRoot = Join-Path $env:USERPROFILE 'AppData\LocalLow\IronGate\Valheim\worlds_local'
}
if (-not $OutputRoot) { $OutputRoot = Join-Path $repoRoot 'data\era17-context' }
$artifactManifest = Join-Path ([IO.Path]::GetFullPath($ArtifactRoot)) "$SnapshotId\manifest.json"
if (-not (Test-Path -LiteralPath $artifactManifest -PathType Leaf)) {
    throw "artifact manifest not found: $artifactManifest"
}
$artifact = Get-Content -LiteralPath $artifactManifest -Raw | ConvertFrom-Json
$worldId = [string]$artifact.snapshot.worldId
if ([string]::IsNullOrWhiteSpace($worldId)) { throw 'artifact manifest has no world id' }
$mapCache = Join-Path $MinimapRoot "${worldId}_mapTexCache"
$heightCache = Join-Path $MinimapRoot "${worldId}_heightTexCache"
$forestCache = Join-Path $MinimapRoot "${worldId}_forestMaskTexCache"
$output = Join-Path ([IO.Path]::GetFullPath($OutputRoot)) ([string]$SnapshotId)

& $Python -c 'import numpy, PIL' 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "terrain context dependencies are missing; install tools\requirements-context.txt for $Python"
}

& $Python (Join-Path $PSScriptRoot 'build-terrain-context.py') `
    --world-db ([IO.Path]::GetFullPath($WorldDbPath)) `
    --world-file ([IO.Path]::GetFullPath($WorldFilePath)) `
    --map-cache ([IO.Path]::GetFullPath($mapCache)) `
    --height-cache ([IO.Path]::GetFullPath($heightCache)) `
    --forest-cache ([IO.Path]::GetFullPath($forestCache)) `
    --artifact-manifest $artifactManifest `
    --output-dir $output
if ($LASTEXITCODE -ne 0) { throw "terrain context build failed with exit code $LASTEXITCODE" }

$manifest = Join-Path $output 'manifest.json'
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw 'terrain context manifest was not created' }
Write-Output $manifest
