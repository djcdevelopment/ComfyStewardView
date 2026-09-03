[CmdletBinding()]
param(
    [string]$SourceCache = '',
    [string]$OutputCache = '',
    [string]$ContextManifest = '',
    [string]$BuildingGeometry = '',
    [string]$PieceGeometry = '',
    [long]$SnapshotId = 107
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $SourceCache) { $SourceCache = Join-Path $repoRoot 'data/era17-cache.duckdb' }
if (-not $OutputCache) { $OutputCache = Join-Path $repoRoot 'data/era17-public.duckdb' }
if (-not $ContextManifest) { $ContextManifest = Join-Path $repoRoot "data/era17-context/$SnapshotId/manifest.json" }
if (-not $BuildingGeometry) { $BuildingGeometry = 'E:\omen\steward-era17-arch\building-geometry.parquet' }
if (-not $PieceGeometry) { $PieceGeometry = 'C:\work\baseline\tools\selfie-stick\out\era17\arch\piece-geometry.json' }
$SourceCache = [IO.Path]::GetFullPath($SourceCache)
$OutputCache = [IO.Path]::GetFullPath($OutputCache)
$ContextManifest = [IO.Path]::GetFullPath($ContextManifest)
$BuildingGeometry = [IO.Path]::GetFullPath($BuildingGeometry)
$PieceGeometry = [IO.Path]::GetFullPath($PieceGeometry)
if (-not (Test-Path -LiteralPath $SourceCache -PathType Leaf)) { throw "Source cache not found: $SourceCache" }
if (-not (Test-Path -LiteralPath $ContextManifest -PathType Leaf)) { throw "Context manifest not found: $ContextManifest" }
if (-not (Test-Path -LiteralPath $BuildingGeometry -PathType Leaf)) { throw "Building geometry not found: $BuildingGeometry" }
if (-not (Test-Path -LiteralPath $PieceGeometry -PathType Leaf)) { throw "Piece geometry not found: $PieceGeometry" }
if ($SnapshotId -le 0) { throw 'SnapshotId must be positive.' }

& (Join-Path $repoRoot 'mvnw.cmd') -q -DskipTests package
if ($LASTEXITCODE -ne 0) { throw 'The public-cache exporter did not compile.' }

$java = (Get-Command java.exe -ErrorAction SilentlyContinue).Source
if (-not $java) {
    foreach ($candidate in @(
        (Join-Path $repoRoot '..\.tools\jdk-17.0.19+10\bin\java.exe'),
        (Join-Path $repoRoot '..\comfystewardview\.tools\jdk-17.0.19+10\bin\java.exe')
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $java = [IO.Path]::GetFullPath($candidate)
            break
        }
    }
}
if (-not $java) { throw 'Java 17 was not found.' }
$jar = Join-Path $repoRoot 'target/steward-spatial-lab-0.1.0-SNAPSHOT.jar'
& $java -cp $jar dev.steward.lab.PublicCacheExporter $SourceCache $OutputCache $SnapshotId `
    $ContextManifest $BuildingGeometry $PieceGeometry
if ($LASTEXITCODE -ne 0) { throw 'Public-cache export failed.' }

Write-Host "Portable cache: $OutputCache"
