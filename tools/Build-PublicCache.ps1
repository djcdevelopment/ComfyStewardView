[CmdletBinding()]
param(
    [string]$SourceCache = '',
    [string]$OutputCache = '',
    [string]$ContextManifest = '',
    [long]$SnapshotId = 107
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $SourceCache) { $SourceCache = Join-Path $repoRoot 'data/era17-cache.duckdb' }
if (-not $OutputCache) { $OutputCache = Join-Path $repoRoot 'data/era17-public.duckdb' }
if (-not $ContextManifest) { $ContextManifest = Join-Path $repoRoot "data/era17-context/$SnapshotId/manifest.json" }
$SourceCache = [IO.Path]::GetFullPath($SourceCache)
$OutputCache = [IO.Path]::GetFullPath($OutputCache)
$ContextManifest = [IO.Path]::GetFullPath($ContextManifest)
if (-not (Test-Path -LiteralPath $SourceCache -PathType Leaf)) { throw "Source cache not found: $SourceCache" }
if (-not (Test-Path -LiteralPath $ContextManifest -PathType Leaf)) { throw "Context manifest not found: $ContextManifest" }
if ($SnapshotId -le 0) { throw 'SnapshotId must be positive.' }

& (Join-Path $repoRoot 'mvnw.cmd') -q -DskipTests package
if ($LASTEXITCODE -ne 0) { throw 'The public-cache exporter did not compile.' }

$java = (Get-Command java.exe -ErrorAction SilentlyContinue).Source
if (-not $java) {
    $sharedJava = Join-Path $repoRoot '..\comfystewardview\.tools\jdk-17.0.19+10\bin\java.exe'
    if (Test-Path -LiteralPath $sharedJava -PathType Leaf) { $java = [IO.Path]::GetFullPath($sharedJava) }
}
if (-not $java) { throw 'Java 17 was not found.' }
$jar = Join-Path $repoRoot 'target/steward-spatial-lab-0.1.0-SNAPSHOT.jar'
& $java -cp $jar dev.steward.lab.PublicCacheExporter $SourceCache $OutputCache $SnapshotId $ContextManifest
if ($LASTEXITCODE -ne 0) { throw 'Public-cache export failed.' }

Write-Host "Portable cache: $OutputCache"
