<#
.SYNOPSIS
  Deploy the focused Comfy Era 17 world view to AM4 without touching /steward.

.DESCRIPTION
  Validates the local artifact manifest against the snapshot already served by
  comfy-steward-view, stages a versioned source release, builds a separate
  steward-world container, and verifies its deliberately narrow public API.

  Discord credentials are read only from /home/derek/steward-world/.env on AM4.
  The script never resets or rewrites Tailscale Funnel routes; if /world is not
  mounted it prints the one required sudo command.
#>
[CmdletBinding()]
param(
    [string]$SshTarget = 'am4',
    [int]$Port = 7081,
    [string]$RemoteRoot = '/home/derek/steward-world',
    [string]$PublicBaseUrl = 'https://am4.tail8e749c.ts.net',
    [string]$PublicPath = '/world',
    [long]$SnapshotId = 107,
    [string]$ArtifactRoot = '',
    [string]$PublicCachePath = '',
    [string]$ContextRoot = '',
    [string]$SourceCachePath = 'E:\omen\steward-era17\out\world-cache.duckdb',
    [string]$BuildingGeometryPath = 'E:\omen\steward-era17-arch\building-geometry.parquet',
    [string]$PieceGeometryPath = 'C:\work\baseline\tools\selfie-stick\out\era17\arch\piece-geometry.json',
    [string]$LocalEnvPath = '',
    [int]$TimeoutMinutes = 5
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ArtifactRoot) { $ArtifactRoot = Join-Path $repoRoot 'data/era17-artifacts' }
$ArtifactRoot = [IO.Path]::GetFullPath($ArtifactRoot)
if (-not $PublicCachePath) { $PublicCachePath = Join-Path $repoRoot 'data/era17-public.duckdb' }
$PublicCachePath = [IO.Path]::GetFullPath($PublicCachePath)
if (-not $ContextRoot) { $ContextRoot = Join-Path $repoRoot 'data/era17-context' }
$ContextRoot = [IO.Path]::GetFullPath($ContextRoot)
$SourceCachePath = [IO.Path]::GetFullPath($SourceCachePath)
$BuildingGeometryPath = [IO.Path]::GetFullPath($BuildingGeometryPath)
$PieceGeometryPath = [IO.Path]::GetFullPath($PieceGeometryPath)
if (-not $LocalEnvPath) { $LocalEnvPath = Join-Path $repoRoot '.env' }
$LocalEnvPath = [IO.Path]::GetFullPath($LocalEnvPath)
$startedAt = (Get-Date).ToUniversalTime().ToString('o')

function Invoke-Ssh {
    param([Parameter(Mandatory)][string]$Command, [switch]$AllowFailure)
    $output = ssh -n -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 $SshTarget $Command
    if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) {
        throw "ssh command failed (exit $LASTEXITCODE): $Command"
    }
    return ($output -join "`n")
}

function Require-RemoteEnvValue {
    param([Parameter(Mandatory)][string]$Name)
    $result = Invoke-Ssh "grep -Eq '^${Name}=.+' $RemoteRoot/.env && echo present || true"
    if ($result.Trim() -ne 'present') {
        throw "AM4 is missing $Name in $RemoteRoot/.env. See .env.example."
    }
}

function Read-RemoteJson {
    param([Parameter(Mandatory)][string]$Url)
    $raw = Invoke-Ssh "curl -fsS -m 20 '$Url'"
    try { return $raw | ConvertFrom-Json }
    catch { throw "invalid JSON from $Url" }
}

function Assert-ProductionHealthy {
    $status = Read-RemoteJson "http://127.0.0.1:7080/api/v1/status"
    if ($status.done -ne $true) { throw 'The existing /steward service is not ready.' }
    return $status
}

if ($SshTarget -notmatch '^[A-Za-z0-9._@-]+$') { throw 'SshTarget contains unsupported characters.' }
if ($RemoteRoot -notmatch '^/home/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$' -or
    $RemoteRoot.Contains('..') -or $RemoteRoot.EndsWith('/')) {
    throw 'RemoteRoot must be a specific directory below /home/<user>.'
}
if ($PublicPath -notmatch '^/[A-Za-z0-9_-]+$') { throw 'PublicPath must be one simple path segment.' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535.' }
if ($SnapshotId -le 0) { throw 'SnapshotId must be positive.' }
if ($TimeoutMinutes -lt 1 -or $TimeoutMinutes -gt 30) { throw 'TimeoutMinutes must be between 1 and 30.' }
$baseUri = $null
if (-not [Uri]::TryCreate($PublicBaseUrl, [UriKind]::Absolute, [ref]$baseUri) -or
    $baseUri.Scheme -ne 'https' -or $PublicBaseUrl.Contains("'")) {
    throw 'PublicBaseUrl must be an absolute HTTPS URL.'
}
$publicUrl = "$($PublicBaseUrl.TrimEnd('/'))$PublicPath/"
foreach ($inputPath in @($SourceCachePath,$BuildingGeometryPath,$PieceGeometryPath)) {
    if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) {
        throw "Required Era 17 source input not found: $inputPath"
    }
}
$buildingGeometrySha = (Get-FileHash -LiteralPath $BuildingGeometryPath -Algorithm SHA256).Hash.ToLowerInvariant()
$pieceGeometrySha = (Get-FileHash -LiteralPath $PieceGeometryPath -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedBuildingGeometrySha = '45d8642551ca904fbba0ddfe51f15294977ad3087fc530d5a41c86d99558691b'
$expectedPieceGeometrySha = '74ecc5e164766defa5553251aaa8bb8115d2e8f7d1d7cebb5826917b350bd86c'
if ($buildingGeometrySha -ne $expectedBuildingGeometrySha -or
    $pieceGeometrySha -ne $expectedPieceGeometrySha) {
    throw 'The geometry inputs do not match the reviewed Comfy Era 17 release receipts.'
}

Write-Host '[1/7] Validating the focused Era 17 release...'
$manifestPath = Join-Path $ArtifactRoot "$SnapshotId/manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "missing artifact manifest: $manifestPath"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ([long]$manifest.snapshotId -ne $SnapshotId) { throw 'Artifact manifest snapshot mismatch.' }
if ($manifest.snapshot.worldName -ne 'Comfy Era 17') { throw 'This deploy profile only serves Comfy Era 17.' }
if ([string]::IsNullOrWhiteSpace($manifest.snapshot.fileHash)) { throw 'Artifact manifest has no file hash.' }
$requiredCells = @(1000, 320, 160, 80, 64, 16)
foreach ($cell in $requiredCells) {
    $layer = @($manifest.layers) | Where-Object {
        $_.lensId -eq 'build-density' -and [int]$_.cellSize -eq $cell
    } | Select-Object -First 1
    if (-not $layer) { throw "missing build-density ${cell}m layer" }
    $layerPath = Join-Path (Split-Path -Parent $manifestPath) $layer.file
    if (-not (Test-Path -LiteralPath $layerPath -PathType Leaf)) { throw "missing artifact: $layerPath" }
}
$contextLayer = @($manifest.layers) | Where-Object { $_.id -eq 'all-zdos-320' } | Select-Object -First 1
if (-not $contextLayer) { throw 'missing all-zdos-320 navigator/context layer' }
$referenceLayer = @($manifest.layers) | Where-Object {
    $_.lensId -eq 'build-density' -and [int]$_.cellSize -eq 1000
} | Select-Object -First 1

$contextManifestPath = Join-Path $ContextRoot "$SnapshotId/manifest.json"
$contextNeedsBuild = -not (Test-Path -LiteralPath $contextManifestPath -PathType Leaf)
if (-not $contextNeedsBuild) {
    try {
        $candidateContext = Get-Content -LiteralPath $contextManifestPath -Raw | ConvertFrom-Json
        $contextNeedsBuild = [int]$candidateContext.schemaVersion -ne 2 -or
            $candidateContext.kind -ne 'steward-terrain-context' -or
            [long]$candidateContext.snapshot.id -ne $SnapshotId -or
            $candidateContext.snapshot.sha256 -ne $manifest.snapshot.fileHash -or
            $candidateContext.world.id -ne $manifest.snapshot.worldId -or
            @($candidateContext.variants).Count -ne 6 -or
            $candidateContext.biomes.maskVariant -ne 'biome-mask' -or
            $candidateContext.biomes.displayMaskVariant -ne 'biome-display-mask'
    } catch { $contextNeedsBuild = $true }
}
if ($contextNeedsBuild) {
    Write-Host 'Building the snapshot-matched terrain context on OMEN...'
    & (Join-Path $PSScriptRoot 'Build-TerrainContext.ps1') `
        -SnapshotId $SnapshotId -ArtifactRoot $ArtifactRoot -OutputRoot $ContextRoot | Write-Host
    if ($LASTEXITCODE -ne 0) { throw 'Could not build the terrain context.' }
}
if (-not (Test-Path -LiteralPath $contextManifestPath -PathType Leaf)) {
    throw "missing terrain context manifest: $contextManifestPath"
}
$contextManifest = Get-Content -LiteralPath $contextManifestPath -Raw | ConvertFrom-Json
if ([int]$contextManifest.schemaVersion -ne 2 -or
    $contextManifest.kind -ne 'steward-terrain-context' -or
    [long]$contextManifest.snapshot.id -ne $SnapshotId -or
    $contextManifest.snapshot.sha256 -ne $manifest.snapshot.fileHash -or
    $contextManifest.world.id -ne $manifest.snapshot.worldId -or
    [double]$contextManifest.bounds.minX -ne -12288 -or
    [double]$contextManifest.bounds.maxX -ne 12288 -or
    [double]$contextManifest.bounds.minZ -ne -12288 -or
    [double]$contextManifest.bounds.maxZ -ne 12288) {
    throw 'The terrain context does not match the focused artifact manifest.'
}
$contextDir = Split-Path -Parent $contextManifestPath
$contextArchiveItems = @("$SnapshotId/manifest.json")
foreach ($variantId in @('overview','detail','topographic-overview','topographic-detail','biome-mask','biome-display-mask')) {
    $variant = @($contextManifest.variants) | Where-Object { $_.id -eq $variantId } | Select-Object -First 1
    if (-not $variant -or $variant.file -notmatch '^[A-Za-z0-9._-]+$' -or
        $variant.sha256 -notmatch '^[0-9a-f]{64}$') { throw "invalid terrain context variant: $variantId" }
    $variantPath = Join-Path $contextDir $variant.file
    if (-not (Test-Path -LiteralPath $variantPath -PathType Leaf)) {
        throw "missing terrain context image: $variantPath"
    }
    if ((Get-Item -LiteralPath $variantPath).Length -ne [long]$variant.bytes -or
        (Get-FileHash -LiteralPath $variantPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $variant.sha256) {
        throw "terrain context checksum mismatch: $variantId"
    }
    $contextArchiveItems += "$SnapshotId/$($variant.file)"
}

$cacheMetadataPath = "$PublicCachePath.json"
$cacheNeedsBuild = -not (Test-Path -LiteralPath $PublicCachePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $cacheMetadataPath -PathType Leaf)
if (-not $cacheNeedsBuild) {
    try {
        $candidateMetadata = Get-Content -LiteralPath $cacheMetadataPath -Raw | ConvertFrom-Json
        $cacheNeedsBuild = [int]$candidateMetadata.schemaVersion -ne 3 -or
            [long]$candidateMetadata.snapshotId -ne $SnapshotId -or
            $candidateMetadata.snapshotHash -ne $manifest.snapshot.fileHash -or
            $candidateMetadata.biomeMaskSha256 -ne (@($contextManifest.variants) | Where-Object id -eq 'biome-mask' | Select-Object -First 1).sha256 -or
            $candidateMetadata.buildingGeometrySha256 -ne $buildingGeometrySha -or
            $candidateMetadata.pieceGeometrySha256 -ne $pieceGeometrySha
    } catch { $cacheNeedsBuild = $true }
}
if ($cacheNeedsBuild) {
    Write-Host 'Building the isolated public query cache on OMEN...'
    & (Join-Path $PSScriptRoot 'Build-PublicCache.ps1') -OutputCache $PublicCachePath `
        -SnapshotId $SnapshotId -ContextManifest $contextManifestPath `
        -SourceCache $SourceCachePath -BuildingGeometry $BuildingGeometryPath `
        -PieceGeometry $PieceGeometryPath
    if ($LASTEXITCODE -ne 0) { throw 'Could not build the public query cache.' }
}
if (-not (Test-Path -LiteralPath $PublicCachePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $cacheMetadataPath -PathType Leaf)) {
    throw 'The public query cache or its metadata is missing.'
}
$cacheMetadata = Get-Content -LiteralPath $cacheMetadataPath -Raw | ConvertFrom-Json
if ([int]$cacheMetadata.schemaVersion -ne 3 -or
    [long]$cacheMetadata.snapshotId -ne $SnapshotId -or
    $cacheMetadata.snapshotHash -ne $manifest.snapshot.fileHash -or
    $cacheMetadata.biomeMaskSha256 -ne (@($contextManifest.variants) | Where-Object id -eq 'biome-mask' | Select-Object -First 1).sha256 -or
    $cacheMetadata.buildingGeometrySha256 -ne $buildingGeometrySha -or
    $cacheMetadata.pieceGeometrySha256 -ne $pieceGeometrySha -or
    [long]$cacheMetadata.geometryCatalogRows -ne 974 -or
    [long]$cacheMetadata.knownGeometryRows -ne ([long]$cacheMetadata.realGeometryRows + [long]$cacheMetadata.estimatedGeometryRows) -or
    [long]$cacheMetadata.unknownGeometryRows -ne ([long]$cacheMetadata.buildingCount - [long]$cacheMetadata.knownGeometryRows) -or
    [long]$cacheMetadata.zdoCount -ne [long]$manifest.snapshot.zdoCount -or
    [long]$cacheMetadata.buildingCount -lt [long]$referenceLayer.totalValue -or
    [long]$cacheMetadata.buildingCount -gt [long]$cacheMetadata.zdoCount) {
    throw 'The public query cache does not match the focused artifact manifest.'
}
$cacheSha = (Get-FileHash -LiteralPath $PublicCachePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($cacheSha -ne $cacheMetadata.sha256) { throw 'The public query cache checksum does not match its metadata.' }
$cacheFile = Split-Path -Leaf $PublicCachePath
if ($cacheFile -notmatch '^[A-Za-z0-9._-]+$') { throw 'Public cache filename contains unsupported characters.' }

Write-Host "[2/7] Checking AM4, the shared read-only cache, and Discord configuration..."
$canonicalRoot = (Invoke-Ssh "readlink -m '$RemoteRoot'").Trim()
if ($canonicalRoot -ne $RemoteRoot) { throw "RemoteRoot resolves to an unexpected path: $canonicalRoot" }
Invoke-Ssh "install -d -m 700 '$RemoteRoot' '$RemoteRoot/releases'" | Out-Null
$envExample = Join-Path $repoRoot '.env.example'
if (-not (Test-Path -LiteralPath $envExample -PathType Leaf)) { throw 'missing .env.example' }
    scp -q -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 $envExample "${SshTarget}:$RemoteRoot/.env.example"
if ($LASTEXITCODE -ne 0) { throw 'Could not stage the Discord environment template.' }
Invoke-Ssh "chmod 644 '$RemoteRoot/.env.example'" | Out-Null
if (Test-Path -LiteralPath $LocalEnvPath -PathType Leaf) {
    $localValues = @{}
    foreach ($line in (Get-Content -LiteralPath $LocalEnvPath)) {
        if ($line -match '^([A-Z0-9_]+)=(.+)$') { $localValues[$matches[1]] = $matches[2].Trim() }
    }
    foreach ($name in @('DISCORD_CLIENT_ID','DISCORD_CLIENT_SECRET','DISCORD_FEEDBACK_WEBHOOK_URL','DISCORD_OWNER_USER_ID')) {
        if (-not $localValues.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($localValues[$name])) {
            throw "Local handoff file is missing ${name}: $LocalEnvPath"
        }
    }
    if ($localValues.DISCORD_CLIENT_ID -notmatch '^[0-9]{5,30}$' -or
        $localValues.DISCORD_OWNER_USER_ID -notmatch '^[0-9]{5,30}$' -or
        $localValues.DISCORD_FEEDBACK_WEBHOOK_URL -notmatch '^https://(discord|discordapp)\.com/api/webhooks/') {
        throw "Local Discord handoff values are malformed: $LocalEnvPath"
    }
    scp -q -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 $LocalEnvPath "${SshTarget}:$RemoteRoot/.env.upload"
    if ($LASTEXITCODE -ne 0) { throw 'Could not upload the local Discord handoff file.' }
    Invoke-Ssh "chmod 600 '$RemoteRoot/.env.upload' && mv -f '$RemoteRoot/.env.upload' '$RemoteRoot/.env' && chmod 600 '$RemoteRoot/.env'" | Out-Null
}
$availableKb = [long](Invoke-Ssh "df -Pk '$RemoteRoot' | awk 'NR==2 {print `$4}'").Trim()
if ($availableKb -lt 2GB / 1KB) { throw 'AM4 has less than 2 GB free; refusing to build another image.' }
if ((Invoke-Ssh "test -f '$RemoteRoot/.env' && echo yes || true").Trim() -ne 'yes') {
    throw "On AM4, copy $RemoteRoot/.env.example to $RemoteRoot/.env, add the Discord values, and chmod 600 before deploying."
}
Invoke-Ssh "chmod 600 '$RemoteRoot/.env'" | Out-Null
@('DISCORD_CLIENT_ID','DISCORD_CLIENT_SECRET','DISCORD_FEEDBACK_WEBHOOK_URL','DISCORD_OWNER_USER_ID') |
    ForEach-Object { Require-RemoteEnvValue $_ }
$existingContainer = (Invoke-Ssh "docker ps -a --filter name=^/steward-world`$ --format '{{.Names}}'" -AllowFailure).Trim()
if (-not $existingContainer) {
    $listener = Invoke-Ssh "ss -ltn 'sport = :$Port' | tail -n +2" -AllowFailure
    if ($listener.Trim()) { throw "port $Port is already owned by another service: $listener" }
}
$productionBefore = Assert-ProductionHealthy
$published = Read-RemoteJson 'http://127.0.0.1:7080/api/v1/db/snapshots'
$publishedSnapshot = @($published.snapshots) | Where-Object { [long]$_.snapshotId -eq $SnapshotId } | Select-Object -First 1
if (-not $publishedSnapshot) { throw "snapshot #$SnapshotId is not in the production cache volume" }
if ($publishedSnapshot.fileHash -ne $manifest.snapshot.fileHash) {
    throw "snapshot hash mismatch: cache=$($publishedSnapshot.fileHash), artifacts=$($manifest.snapshot.fileHash)"
}

$gitSha = ((git -C $repoRoot rev-parse --short HEAD 2>$null) -join '').Trim()
if (-not $gitSha) { $gitSha = 'unknown' }
$dirty = [bool]((git -C $repoRoot status --porcelain 2>$null) -join '')
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss')
$releaseVersion = "$gitSha-$stamp" + $(if ($dirty) { '-dirty' } else { '' })
if ($releaseVersion -notmatch '^[A-Za-z0-9._-]+$') { throw 'Generated release version is unsafe.' }
$releaseDir = "$RemoteRoot/releases/$releaseVersion"
$previousRelease = (Invoke-Ssh "readlink -f '$RemoteRoot/current' 2>/dev/null || true" -AllowFailure).Trim()

Write-Host "[3/7] Staging release $releaseVersion..."
$sourceFiles = @('Dockerfile','.dockerignore','entrypoint-public.sh','docker-compose.am4.yml','pom.xml','src')
foreach ($item in $sourceFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $item))) { throw "missing build input: $item" }
}
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "steward-world-$releaseVersion"
$sourceArchive = "$tempRoot-source.tgz"
$artifactArchive = "$tempRoot-artifacts.tgz"
$cacheArchive = "$tempRoot-cache.tgz"
$contextArchive = "$tempRoot-context.tgz"
try {
    Push-Location $repoRoot
    try {
        tar -czf $sourceArchive $sourceFiles
        if ($LASTEXITCODE -ne 0) { throw 'Could not create source archive.' }
    } finally { Pop-Location }
    tar -czf $artifactArchive -C $ArtifactRoot "$SnapshotId"
    if ($LASTEXITCODE -ne 0) { throw 'Could not create artifact archive.' }
    tar -czf $cacheArchive -C (Split-Path -Parent $PublicCachePath) $cacheFile "$cacheFile.json"
    if ($LASTEXITCODE -ne 0) { throw 'Could not create public-cache archive.' }
    tar -czf $contextArchive -C $ContextRoot $contextArchiveItems
    if ($LASTEXITCODE -ne 0) { throw 'Could not create terrain-context archive.' }

    Invoke-Ssh "test ! -e '$releaseDir' && mkdir -p '$releaseDir/build' '$releaseDir/artifacts' '$releaseDir/cache' '$releaseDir/context'" | Out-Null
    scp -q -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 $sourceArchive "${SshTarget}:$releaseDir/source.tgz"
    if ($LASTEXITCODE -ne 0) { throw 'Source upload failed.' }
    scp -q -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 $artifactArchive "${SshTarget}:$releaseDir/artifacts.tgz"
    if ($LASTEXITCODE -ne 0) { throw 'Artifact upload failed.' }
    scp -q -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 $cacheArchive "${SshTarget}:$releaseDir/cache.tgz"
    if ($LASTEXITCODE -ne 0) { throw 'Public-cache upload failed.' }
    scp -q -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 $contextArchive "${SshTarget}:$releaseDir/context.tgz"
    if ($LASTEXITCODE -ne 0) { throw 'Terrain-context upload failed.' }
    Invoke-Ssh "tar -xzf '$releaseDir/source.tgz' -C '$releaseDir/build' && tar -xzf '$releaseDir/artifacts.tgz' -C '$releaseDir/artifacts' && tar -xzf '$releaseDir/cache.tgz' -C '$releaseDir/cache' && tar -xzf '$releaseDir/context.tgz' -C '$releaseDir/context'" | Out-Null
    Invoke-Ssh "printf '%s\n' 'STEWARD_WORLD_CACHE_PATH=$releaseDir/cache/$cacheFile' 'STEWARD_WORLD_ARTIFACTS_PATH=$releaseDir/artifacts' 'STEWARD_WORLD_CONTEXT_PATH=$releaseDir/context/$SnapshotId' 'STEWARD_PUBLIC_URL=$publicUrl' 'STEWARD_RELEASE_VERSION=$releaseVersion' 'STEWARD_SNAPSHOT_ID=$SnapshotId' > '$releaseDir/runtime.env'" | Out-Null
} finally {
    if (Test-Path -LiteralPath $sourceArchive) { Remove-Item -LiteralPath $sourceArchive -Force }
    if (Test-Path -LiteralPath $artifactArchive) { Remove-Item -LiteralPath $artifactArchive -Force }
    if (Test-Path -LiteralPath $cacheArchive) { Remove-Item -LiteralPath $cacheArchive -Force }
    if (Test-Path -LiteralPath $contextArchive) { Remove-Item -LiteralPath $contextArchive -Force }
}

$compose = "cd '$releaseDir/build' && docker compose --env-file '$RemoteRoot/.env' --env-file '$releaseDir/runtime.env' -f docker-compose.am4.yml"
Write-Host '[4/7] Building the isolated steward-world image...'
Invoke-Ssh "$compose build" | Write-Host

Write-Host '[5/7] Starting steward-world and waiting for readiness...'
try {
    Invoke-Ssh "$compose up -d" | Write-Host
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        $health = Invoke-Ssh "curl -fsS -m 5 http://127.0.0.1:$Port/api/health" -AllowFailure
        if ($health -match '"status"\s*:\s*"ready"') { $ready = $true; break }
        Start-Sleep -Seconds 3
    }
    if (-not $ready) { throw "steward-world was not ready within $TimeoutMinutes minutes" }

    Write-Host '[6/7] Verifying public scope, query path, and production isolation...'
    $healthJson = Read-RemoteJson "http://127.0.0.1:$Port/api/health"
    $bootstrap = Read-RemoteJson "http://127.0.0.1:$Port/api/bootstrap"
    $publicManifest = Read-RemoteJson "http://127.0.0.1:$Port/api/manifest?snapshot=$SnapshotId"
    if ($healthJson.publicMode -ne $true -or $healthJson.release -ne $releaseVersion -or
        $healthJson.context -ne 'ready' -or [long]$healthJson.contextSnapshot -ne $SnapshotId) {
        throw 'Public health/context contract failed.'
    }
    if ($bootstrap.publicMode -ne $true -or $bootstrap.feedbackEnabled -ne $true -or
        $bootstrap.discordIdentityEnabled -ne $true -or $bootstrap.sceneAvailable -ne $true) {
        throw 'Public feedback/OAuth/scene bootstrap contract failed.'
    }
    if (@($bootstrap.snapshots).Count -ne 1 -or [long]$bootstrap.snapshots[0].snapshotId -ne $SnapshotId) {
        throw 'Public bootstrap exposed the wrong snapshots.'
    }
    if (@($bootstrap.lenses).Count -ne 1 -or $bootstrap.lenses[0].id -ne 'build-density') {
        throw 'Public bootstrap exposed the wrong lenses.'
    }
    if ($bootstrap.context.available -ne $true -or
        $bootstrap.context.provenance -ne 'SNAPSHOT-MATCHED' -or
        [long]$bootstrap.context.snapshotId -ne $SnapshotId -or
        [double]$bootstrap.context.bounds.minX -ne -12288 -or
        @($bootstrap.context.variants).Count -ne 6 -or
        $bootstrap.context.biomes.maskVariant -ne 'biome-mask' -or
        $bootstrap.context.biomes.displayMaskVariant -ne 'biome-display-mask' -or
        @($bootstrap.context.biomes.catalog).Count -ne 8 -or
        [long]$bootstrap.context.publishedItemCount -le 0) {
        throw 'Public terrain context bootstrap contract failed.'
    }
    foreach ($variant in @($contextManifest.variants)) {
        $servedSha = (Invoke-Ssh "curl -fsS -m 30 'http://127.0.0.1:$Port/api/context/$($variant.id)?v=$($variant.sha256.Substring(0,16))' | sha256sum | cut -d' ' -f1").Trim()
        if ($servedSha -ne $variant.sha256) { throw "served terrain context checksum mismatch: $($variant.id)" }
    }
    if (@($publicManifest.lenses).Count -ne 1 -or $publicManifest.lenses[0].id -ne 'build-density') {
        throw 'Public manifest exposed hidden lenses.'
    }
    $unexpectedLayer = @($publicManifest.layers) | Where-Object {
        $_.lensId -ne 'build-density' -and $_.id -ne 'all-zdos-320'
    }
    if ($unexpectedLayer) { throw 'Public manifest exposed hidden artifact layers.' }
    $selection = Read-RemoteJson "http://127.0.0.1:$Port/api/selection?snapshot=$SnapshotId&lens=build-density&minX=-1000&maxX=1000&minZ=-1000&maxZ=1000&topN=3"
    if ($selection.lensId -ne 'build-density' -or [long]$selection.snapshotId -ne $SnapshotId) {
        throw 'Representative selection query failed.'
    }
    $biomeSelection = Read-RemoteJson "http://127.0.0.1:$Port/api/selection?snapshot=$SnapshotId&lens=build-density&minX=-26500&maxX=26500&minZ=-20500&maxZ=27500&topN=3&biomes=meadows"
    if (@($biomeSelection.biomes).Count -ne 1 -or $biomeSelection.biomes[0] -ne 'meadows' -or
        [long]$biomeSelection.total -le 0) { throw 'Biome-filtered selection query failed.' }
    $biomeSample = Read-RemoteJson "http://127.0.0.1:$Port/api/points?snapshot=$SnapshotId&lens=build-density&minX=-26500&maxX=26500&minZ=-20500&maxZ=27500&limit=5000&sample=true&biomes=meadows"
    if ($biomeSample.sampled -ne $true -or @($biomeSample.points).Count -ne 5000 -or
        [long]$biomeSample.total -le 5000) { throw 'Biome representative sample query failed.' }
    $biomeItems = Read-RemoteJson "http://127.0.0.1:$Port/api/items?snapshot=$SnapshotId&lens=build-density&minX=-26500&maxX=26500&minZ=-20500&maxZ=27500&limit=3&biomes=meadows"
    if (@($biomeItems.items).Count -ne 3 -or $biomeItems.hasMore -ne $true -or
        [string]::IsNullOrWhiteSpace($biomeItems.nextCursor)) { throw 'Biome item pagination query failed.' }
    $pilotSceneQuery = "snapshot=$SnapshotId&lens=build-density&minX=467.8&maxX=511.6&minZ=5501.4&maxZ=5535.9"
    $pilotSceneHeaders = Invoke-Ssh "curl -sS -m 30 -D - -o /dev/null 'http://127.0.0.1:$Port/api/scene?$pilotSceneQuery'"
    if ($pilotSceneHeaders -notmatch 'HTTP/\S+ 200' -or
        $pilotSceneHeaders -notmatch '(?im)^content-type:\s*application/vnd\.comfysteward\.scene' -or
        $pilotSceneHeaders -notmatch '(?im)^x-steward-scene-pieces:\s*862\s*$') {
        throw 'The exact 862-piece pilot scene contract failed.'
    }
    $stressSceneQuery = "snapshot=$SnapshotId&lens=build-density&minX=2021.7&maxX=2101.9&minZ=-4851.3&maxZ=-4751.8"
    $stressDirectCode = (Invoke-Ssh "curl -sS -m 30 -o /dev/null -w '%{http_code}' 'http://127.0.0.1:$Port/api/scene?$stressSceneQuery'").Trim()
    if ($stressDirectCode -ne '409') { throw "The scene override gate returned $stressDirectCode instead of 409." }
    $stressSceneHeaders = Invoke-Ssh "curl -sS -m 30 -D - -o /dev/null 'http://127.0.0.1:$Port/api/scene?$stressSceneQuery&override=true'"
    if ($stressSceneHeaders -notmatch 'HTTP/\S+ 200' -or
        $stressSceneHeaders -notmatch '(?im)^x-steward-scene-pieces:\s*22387\s*$') {
        throw 'The exact 22,387-piece forced scene contract failed.'
    }
    $overLimitCode = (Invoke-Ssh "curl -sS -m 30 -o /dev/null -w '%{http_code}' 'http://127.0.0.1:$Port/api/scene?snapshot=$SnapshotId&lens=build-density&minX=-12288&maxX=12288&minZ=-12288&maxZ=12288&override=true'").Trim()
    if ($overLimitCode -ne '413') { throw "The 25,000-piece scene ceiling returned $overLimitCode instead of 413." }
    $jobsCode = (Invoke-Ssh "curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:$Port/api/jobs").Trim()
    $scopeCode = (Invoke-Ssh "curl -sS -o /dev/null -w '%{http_code}' 'http://127.0.0.1:$Port/api/manifest?snapshot=$($SnapshotId - 1)'").Trim()
    $hiddenArtifactCode = (Invoke-Ssh "curl -sS -o /dev/null -w '%{http_code}' 'http://127.0.0.1:$Port/api/artifacts/$SnapshotId/dropped-items-320.png'").Trim()
    if ($jobsCode -ne '404' -or $scopeCode -ne '400' -or $hiddenArtifactCode -ne '404') {
        throw "Public denial contract failed (jobs=$jobsCode scope=$scopeCode artifact=$hiddenArtifactCode)."
    }
    $oauthHeaders = Invoke-Ssh "curl -sS -D - -o /dev/null http://127.0.0.1:$Port/api/auth/discord/start"
    if ($oauthHeaders -notmatch 'discord\.com/oauth2/authorize' -or $oauthHeaders -notmatch 'steward_oauth_nonce=') {
        throw 'Discord OAuth start contract failed.'
    }
    $productionAfter = Assert-ProductionHealthy
    if ([long]$productionAfter.parsed -ne [long]$productionBefore.parsed) {
        throw 'The existing /steward status changed during deployment.'
    }
    Invoke-Ssh "ln -sfn '$releaseDir' '$RemoteRoot/current'" | Out-Null
} catch {
    Invoke-Ssh "docker logs --tail 80 steward-world" -AllowFailure | Write-Host
    if ($previousRelease -and $previousRelease.StartsWith("$RemoteRoot/releases/") -and
        (Invoke-Ssh "test -f '$previousRelease/runtime.env' && echo yes || true" -AllowFailure).Trim() -eq 'yes') {
        Write-Warning "Verification failed; restoring $previousRelease"
        $rollback = "cd '$previousRelease/build' && docker compose --env-file '$RemoteRoot/.env' --env-file '$previousRelease/runtime.env' -f docker-compose.am4.yml up -d"
        Invoke-Ssh $rollback -AllowFailure | Write-Host
    } else {
        Invoke-Ssh "$compose down" -AllowFailure | Write-Host
    }
    throw
}

Write-Host '[7/7] Checking the public /world route...'
$publicOk = $false
try {
    $publicBootstrap = Invoke-RestMethod -TimeoutSec 20 -Uri "${publicUrl}api/bootstrap"
    $publicOk = $publicBootstrap.publicMode -eq $true -and
        @($publicBootstrap.snapshots).Count -eq 1 -and
        [long]$publicBootstrap.snapshots[0].snapshotId -eq $SnapshotId -and
        $publicBootstrap.context.available -eq $true -and
        $publicBootstrap.context.provenance -eq 'SNAPSHOT-MATCHED'
} catch {}

if (-not $publicOk) {
    Write-Host ''
    Write-Host 'The container is ready, but /world is not mounted in Tailscale Funnel yet.'
    Write-Host 'Run this one-time command on AM4 (it preserves every existing route):'
    Write-Host "  sudo tailscale funnel --bg --yes --set-path=$PublicPath http://127.0.0.1:$Port"
    Write-Host 'Never run "tailscale funnel reset"; that removes every public route on AM4.'
}

$receipt = [ordered]@{
    deployed_at = $startedAt
    finished_at = (Get-Date).ToUniversalTime().ToString('o')
    ssh_target = $SshTarget
    release = $releaseVersion
    git_sha = $gitSha
    dirty_worktree = $dirty
    snapshot_id = $SnapshotId
    snapshot_hash = $manifest.snapshot.fileHash
    public_cache_sha256 = $cacheSha
    public_cache_bytes = [long]$cacheMetadata.bytes
    building_geometry_sha256 = $cacheMetadata.buildingGeometrySha256
    piece_geometry_sha256 = $cacheMetadata.pieceGeometrySha256
    geometry_catalog_rows = [long]$cacheMetadata.geometryCatalogRows
    known_geometry_rows = [long]$cacheMetadata.knownGeometryRows
    real_geometry_rows = [long]$cacheMetadata.realGeometryRows
    estimated_geometry_rows = [long]$cacheMetadata.estimatedGeometryRows
    unknown_geometry_rows = [long]$cacheMetadata.unknownGeometryRows
    scene_pilot_pieces = 862
    scene_stress_pieces = 22387
    terrain_context_style = $contextManifest.style
    terrain_context_overview_sha256 = (@($contextManifest.variants) | Where-Object id -eq 'overview').sha256
    terrain_context_detail_sha256 = (@($contextManifest.variants) | Where-Object id -eq 'detail').sha256
    terrain_context_topographic_overview_sha256 = (@($contextManifest.variants) | Where-Object id -eq 'topographic-overview').sha256
    terrain_context_topographic_detail_sha256 = (@($contextManifest.variants) | Where-Object id -eq 'topographic-detail').sha256
    terrain_context_biome_mask_sha256 = (@($contextManifest.variants) | Where-Object id -eq 'biome-mask').sha256
    terrain_context_biome_display_mask_sha256 = (@($contextManifest.variants) | Where-Object id -eq 'biome-display-mask').sha256
    terrain_compiler_payloads = [long]$contextManifest.terrainEdits.compilerPayloadCount
    container = 'steward-world'
    port = $Port
    production_container_untouched = $true
    public_url = $publicUrl
    public_verified = $publicOk
}
$receiptPath = Join-Path $PSScriptRoot 'deploy-world-receipt.json'
$receipt | ConvertTo-Json | Out-File -LiteralPath $receiptPath -Encoding utf8
Write-Host ''
Write-Host "Receipt: $receiptPath"
if ($publicOk) { Write-Host "Live: $publicUrl" }
else { Write-Host "AM4-local service ready at http://127.0.0.1:$Port/" }
