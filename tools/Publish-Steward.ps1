<#
.SYNOPSIS
  Build Steward's analytics artifacts on OMEN and publish them to AM4.

.DESCRIPTION
  Splits Steward into a processing lane and a serving lane.

  OMEN does the work: parsing each world save into a DuckDB analytics cache and
  rendering the static map layers.

  Measured on a 9.16M-ZDO world, a fresh build is ~53 s and ~1.2 GB of write, so
  the argument for moving it off AM4 is not raw CPU time. It is that (a) AM4 is
  also hosting a live Valheim server and should not be doing gigabytes of disk
  churn beside it, and (b) the snapshot history grows ~1-2 GB per retained save
  and appending to it costs 12+ minutes once the indexes exist. That archive
  belongs on OMEN; AM4 receives only the snapshots it actually serves.

  AM4 keeps serving. entrypoint.sh already gates its batch build on the marker
  file /data/.cache-complete, so publishing prebuilt artifacts into the
  steward-data volume and touching that marker makes the container skip the
  build entirely and go straight to serve mode. No application change required.

  Two copies of the world are published as two snapshots of ONE world_id:

    source=am4    the copy on AM4, snapshotted there and pulled to OMEN
    source=omen   OMEN's own copy, read from a rotated backup on local disk

  These are all copies of the same Era16 save with slight testing drift, not
  distinct worlds, so they share a world_id and differ by source and backup_id.
  That is what makes them comparable: the Changes view diffs snapshots within a
  world, and splitting them into parallel world_ids would make the one
  interesting question -- what actually differs between the copies -- unaskable.

  AM4 still parses a world .db at startup for the in-memory endpoints (about 20
  routes read ZdoFlatStore rather than DuckDB), so the frozen world file stays on
  AM4. That file is what the am4-sourced snapshot must be built from, and the run
  fails closed if the SHA-256 of the two disagree.

.PARAMETER Push
  Actually publish to AM4. Without it the script builds and verifies artifacts
  locally and reports what it would transfer, touching nothing on AM4 beyond the
  read-only world snapshot pull.

.PARAMETER SkipAm4World
  Process only OMEN's local world. Useful when AM4 is unreachable; the published
  cache then contains the omen-sourced snapshot only.

.PARAMETER OmenWorldPath
  Explicit immutable world artifact to ingest instead of discovering the newest
  rotated backup in OmenWorldDir. Completed-era releases should use this path.

.PARAMETER ActivateWorld
  With -Push, also upload the explicit world artifact to AM4's Steward world
  directory, verify its SHA-256, and select it as the container's boot world.

.EXAMPLE
  # Dry run: build both worlds on OMEN, verify, report. Nothing published.
  powershell -ExecutionPolicy Bypass -File .\tools\Publish-Steward.ps1

.EXAMPLE
  # Also write each snapshot out as Parquet: lossless, ~10.5x smaller than the
  # DuckDB cache (113.7 MB vs 1,196 MB measured), and queryable in place --
  #   SELECT * FROM '<archive>/snapshot-*/zdo.parquet'
  powershell -ExecutionPolicy Bypass -File .\tools\Publish-Steward.ps1 -Archive

.EXAMPLE
  # Full pipeline including publish to AM4.
  powershell -ExecutionPolicy Bypass -File .\tools\Publish-Steward.ps1 -Push
#>
[CmdletBinding()]
param(
    [string]$SshTarget       = 'am4',
    [int]   $Port            = 7080,
    [string]$RemoteRoot      = '/home/derek/steward',
    [string]$Am4WorldSource  = '/home/derek/comfy-valheim-lab/server-state/config/worlds_local/ComfyEra16.db',
    [string]$OmenWorldDir    = 'C:\work\baseline\fieldlab\autonomous\state\server\config\worlds_local',
    [string]$OmenWorldPath   = '',
    # One world id, because these are all copies of the same Era16 save. What differs between
    # them is which host the copy came from and when, which is what `source` and `backup_id`
    # record. Giving them separate world_ids would split one world's history into parallel
    # timelines and make the Changes view unable to diff them.
    [string]$WorldId         = 'ComfyEra16',
    [string]$WorldName       = 'Comfy Era 16',
    [string]$OmenSource      = 'omen',
    [string]$OmenBackupId    = '',
    [string]$WorkDir         = "$env:LOCALAPPDATA\steward-publish",
    [string]$JavaHome        = '',
    [string]$JavaOpts        = '-Xmx8g -Djava.awt.headless=true',
    [int]   $TimeoutMinutes  = 30,
    [switch]$SkipAm4World,
    [switch]$Push,
    [switch]$ActivateWorld,
    # Deprecated no-op: archiving is now always on. The Parquet archive is the history of
    # record each publish rebuilds the live cache from (lossless, ~10x smaller, queryable
    # in place); it accumulates and is never pruned by this script.
    [switch]$Archive,
    # Scheduled-run mode: when both worlds are unchanged since the previous receipt, exit 0
    # quietly instead of throwing. Interactive runs keep the loud refusal.
    [switch]$NoOpIfUnchanged,
    [string]$ArchiveDir = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$repoRoot  = Split-Path -Parent $PSScriptRoot
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$jar       = Join-Path $repoRoot 'viewer\target\world-viewer-1.0.0.jar'

if (-not $JavaHome) { $JavaHome = Join-Path $repoRoot '.tools\jdk-17.0.19+10' }
$java = Join-Path $JavaHome 'bin\java.exe'

function Invoke-Ssh {
    param([string]$Command, [switch]$AllowFailure)
    $out = ssh -o BatchMode=yes $SshTarget $Command
    if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) {
        throw "ssh command failed (exit $LASTEXITCODE): $Command"
    }
    return $out
}

function Invoke-Batch {
    param([string[]]$Arguments, [string]$Label)
    Write-Host "      $Label"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $javaArgs = @()
    $javaArgs += ($JavaOpts.Split(' ') | Where-Object { $_ })
    $javaArgs += '-jar'
    $javaArgs += $jar
    $javaArgs += $Arguments
    & $java $javaArgs
    if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)" }
    Write-Host ("      done in {0:n0}s" -f $sw.Elapsed.TotalSeconds)
}

function Get-ImageDimensions {
    param([Parameter(Mandatory=$true)][string]$Path)
    $image = $null
    try {
        $image = [System.Drawing.Image]::FromFile($Path)
        return [pscustomobject]@{ Width = $image.Width; Height = $image.Height }
    } catch {
        throw "image decode failed for ${Path}: $($_.Exception.Message)"
    } finally {
        if ($image) { $image.Dispose() }
    }
}

# --- 1. Preflight ---------------------------------------------------------
Write-Host '[1/7] Preflight...'
# Single-publisher lock: two overlapping publishes share one workdir cache and one AM4
# volume, and interleaving them corrupts both. Stale locks (>2h) are assumed crashed.
$lockFile = Join-Path $WorkDir '.publish-lock'
if (Test-Path $lockFile) {
    $age = (Get-Date) - (Get-Item $lockFile).LastWriteTime
    if ($age.TotalHours -lt 2) { throw "another publish appears to be running (lock $lockFile, age $([int]$age.TotalMinutes) min); remove it if that's wrong" }
    Write-Host '      removing stale publish lock'
    Remove-Item $lockFile -Force
}
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
Set-Content -Path $lockFile -Value "$PID $(Get-Date -Format o)"
trap { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue; break }

if (-not (Test-Path $java)) { throw "java not found at $java (pass -JavaHome)" }
if (-not (Test-Path $jar))  { throw "viewer jar not found at $jar - run: mvn -f viewer/pom.xml package -DskipTests" }
if ($ActivateWorld -and -not $Push) { throw '-ActivateWorld requires -Push' }
if ($ActivateWorld -and -not $OmenWorldPath) { throw '-ActivateWorld requires -OmenWorldPath' }
if ($OmenWorldPath) {
    if (-not (Test-Path -LiteralPath $OmenWorldPath -PathType Leaf)) {
        throw "explicit world artifact not found: $OmenWorldPath"
    }
    if ([IO.Path]::GetExtension($OmenWorldPath) -ne '.db') {
        throw "explicit world artifact must be a .db file: $OmenWorldPath"
    }
    $worldLeaf = [IO.Path]::GetFileName($OmenWorldPath)
    if ($worldLeaf -notmatch '^[A-Za-z0-9._-]+$') {
        throw "world filename is not safe for remote activation: $worldLeaf"
    }
}
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

# The cache is disposable and rebuilt fresh each run from the Parquet archive (history of
# record) plus this run's new worlds. rendered/ and archive/ persist across publishes so
# retained snapshots keep their rasters and history accumulates.
$outDir    = Join-Path $WorkDir 'out'
$cacheFile = Join-Path $outDir 'world-cache.duckdb'
$renderDir = Join-Path $outDir 'rendered'
if (-not $ArchiveDir) { $ArchiveDir = Join-Path $WorkDir 'archive' }
New-Item -ItemType Directory -Force -Path $outDir, $renderDir, $ArchiveDir | Out-Null
Write-Host "      workdir: $WorkDir (archive: $ArchiveDir)"

# Live-cache window: the cache carries at most the latest 6 snapshots (the delta-matrix
# maximum); older history stays in the archive only.
$LiveWindow = 6

# Previous receipt: source for the continuity gate and same-world dedupe.
$prevReceiptPath = Join-Path $PSScriptRoot 'publish-steward-receipt.json'
$prevReceipt = $null
if (Test-Path $prevReceiptPath) {
    try { $prevReceipt = Get-Content $prevReceiptPath -Raw | ConvertFrom-Json } catch {}
}
$usePrevReceipt = $false
if ($prevReceipt -and [bool]$prevReceipt.pushed -and $prevReceipt.snapshots -and
        $prevReceipt.archive_dir) {
    $currentArchive = [IO.Path]::GetFullPath($ArchiveDir).TrimEnd('\')
    $previousArchive = [IO.Path]::GetFullPath([string]$prevReceipt.archive_dir).TrimEnd('\')
    $usePrevReceipt = $currentArchive -eq $previousArchive
}
$prevHashes = @()
if ($usePrevReceipt) {
    $prevHashes = @($prevReceipt.snapshots | ForEach-Object { [string]$_.file_hash } | Where-Object { $_ })
}

# --- 2. Acquire AM4's world ----------------------------------------------
# Snapshot on AM4 first (mtime-stable copy, so a live save cannot tear it),
# then pull that frozen copy. The frozen copy is also what AM4 serves, which is
# what makes the SHA-256 gate in stage 5 meaningful.
$am4World = $null
$am4Sha   = $null
if (-not $SkipAm4World) {
    Write-Host "[2/7] Snapshotting AM4 world and pulling to OMEN..."
    $worldName = Split-Path -Leaf $Am4WorldSource
    $worldDest = "$RemoteRoot/world/$worldName"
    Invoke-Ssh "mkdir -p $RemoteRoot/world" | Out-Null

    $snapScript = 'set -eu; SRC={0}; DST={1}; for i in 1 2 3; do m1=$(stat -c %Y "$SRC"); cp "$SRC" "$DST.tmp"; m2=$(stat -c %Y "$SRC"); if [ "$m1" = "$m2" ]; then mv "$DST.tmp" "$DST"; echo snapshot-ok; exit 0; fi; echo "source changed mid-copy, retrying"; sleep 5; done; rm -f "$DST.tmp"; echo snapshot-torn; exit 1' -f $Am4WorldSource, $worldDest
    $snapResult = Invoke-Ssh "bash -c '$snapScript'"
    if ($snapResult -notmatch 'snapshot-ok') { throw "AM4 world snapshot failed: $snapResult" }

    $am4Sha = (Invoke-Ssh "sha256sum $worldDest").Split(' ')[0]
    Write-Host "      AM4 frozen snapshot sha256: $am4Sha"

    if ($prevHashes -contains $am4Sha) {
        # Unchanged since the previous receipt: nothing to parse, so skip the 1.3 GB pull.
        # $am4Sha stays set for the SHA gate; $am4World stays null so no am4 run happens.
        Write-Host '      AM4 world unchanged since last publish; skipping pull.'
    } else {
        $am4World = Join-Path $WorkDir $worldName
        Write-Host "      pulling $worldDest (this is the large inbound transfer)..."
        scp -q "${SshTarget}:$worldDest" $am4World
        if ($LASTEXITCODE -ne 0) { throw "scp of AM4 world failed (exit $LASTEXITCODE)" }

        $localSha = (Get-FileHash $am4World -Algorithm SHA256).Hash.ToLower()
        if ($localSha -ne $am4Sha) { throw "AM4 world transfer corrupted: remote $am4Sha, local $localSha" }
        Write-Host ("      transfer verified ({0:n1} MB)" -f ((Get-Item $am4World).Length / 1MB))
    }
} else {
    Write-Host '[2/7] -SkipAm4World: publishing the omen-sourced copy only.'
}

# --- 3. Pick OMEN's world -------------------------------------------------
# Prefer the newest rotated backup over the live file: a backup_auto is immutable
# once written, so it needs no torn-copy dance.
Write-Host '[3/7] Selecting OMEN world save...'
$omenWorld = $null
if ($OmenWorldPath) {
    $omenWorld = Get-Item -LiteralPath $OmenWorldPath
    Write-Host '      explicit immutable release artifact'
} else {
    $omenWorld = Get-ChildItem $OmenWorldDir -Filter '*_backup_auto-*.db' -ErrorAction SilentlyContinue |
                 Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $omenWorld) { throw "no rotated backup found in $OmenWorldDir" }
}
Write-Host ("      {0} ({1:n1} MB, {2})" -f $omenWorld.Name, ($omenWorld.Length / 1MB), $omenWorld.LastWriteTime)

# --- 4. Build artifacts on OMEN ------------------------------------------
# Fresh cache each run: import the retained archive window first (unindexed bulk load),
# parse this run's new worlds with --defer-indexes so every append hits an unindexed
# table, and let the LAST batch run build the indexes once. Renders only fill in what
# the persistent render dir is missing. Worlds whose SHA-256 already appears in the
# previous receipt are unchanged and skipped (no duplicate snapshots).
Write-Host '[4/7] Building analytics cache on OMEN...'
$omenSha = (Get-FileHash $omenWorld.FullName -Algorithm SHA256).Hash.ToLower()
$doAm4  = [bool]$am4World -and ($prevHashes -notcontains $am4Sha)
$doOmen = $prevHashes -notcontains $omenSha
if ($am4World -and -not $doAm4) { Write-Host "      am4 world unchanged since last publish (sha match); skipping" }
if (-not $doOmen) { Write-Host "      omen world unchanged since last publish (sha match); skipping" }
if (-not $doAm4 -and -not $doOmen) {
    if ($NoOpIfUnchanged) {
        Write-Host 'nothing new to publish: both worlds match the previous receipt hashes (no-op exit)'
        Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
        exit 0
    }
    throw 'nothing new to publish: both worlds match the previous receipt hashes'
}
$newCount = @($doAm4, $doOmen).Where({ $_ }).Count
$importLatest = [Math]::Max(0, $LiveWindow - $newCount)

# Delete the old cache only now, after the dedupe decision: a refused publish must leave
# the previous cache intact (learned the hard way — deleting in preflight left an empty
# workdir when both worlds were unchanged).
Remove-Item $cacheFile, "$cacheFile.wal" -Force -ErrorAction SilentlyContinue

$runs = @()
if ($doAm4) {
    $runs += ,@{ Label = 'am4 copy: parse + cache + render'; World = $am4World; Source = 'am4'
                 BackupId = ("am4_{0}" -f (Get-Date -Format 'yyyyMMddHHmmss')) }
}
if ($doOmen) {
    $backupId = if ($OmenBackupId) { $OmenBackupId } else { [IO.Path]::GetFileNameWithoutExtension($omenWorld.Name) }
    $runs += ,@{ Label = "$OmenSource copy: parse + cache + render"; World = $omenWorld.FullName; Source = $OmenSource
                 BackupId = $backupId }
}
for ($i = 0; $i -lt $runs.Count; $i++) {
    $run = $runs[$i]
    $isFirst = $i -eq 0
    $isLast  = $i -eq ($runs.Count - 1)
    $runArgs = @(
        $run.World,
        $(if ($isFirst) { '--rebuild-cache' } else { '--build-cache' }),
        '--cache', $cacheFile,
        '--world-id', $WorldId, '--world-name', $WorldName,
        '--source', $run.Source, '--backup-id', $run.BackupId,
        '--batch-only', '--no-browser')
    if ($isFirst) { $runArgs += @('--import-archive', $ArchiveDir, '--import-latest', "$importLatest") }
    if ($isLast) {
        # Renders only on the final run: indexes exist by then, and Main fills in exactly
        # the absolute manifests and delta pairs the persistent render dir is missing.
        $runArgs += @('--render-layers', '--render-dir', $renderDir)
    } else {
        $runArgs += '--defer-indexes'
    }
    Invoke-Batch -Label $run.Label -Arguments $runArgs
}

# --- 5. Verify ------------------------------------------------------------
# Fail closed. The published cache must contain the expected worlds, and the
# am4-sourced snapshot must have been built from the exact bytes AM4 will serve.
Write-Host '[5/7] Verifying built artifacts...'
$duckJar = Join-Path $repoRoot 'viewer\lib\duckdb_jdbc-1.5.4.0.jar'
$verifyScript = Join-Path $WorkDir 'verify.jsh'
@'
var url = "jdbc:duckdb:" + System.getProperty("dbpath");
try (var c = java.sql.DriverManager.getConnection(url); var st = c.createStatement()) {
  var rs = st.executeQuery(
    "SELECT w.snapshot_id, w.world_id, w.source, w.file_hash, w.prefab_dictionary_version, COUNT(z.zdo_index) " +
    "FROM world_snapshot w LEFT JOIN zdo z ON z.snapshot_id = w.snapshot_id " +
    "GROUP BY 1,2,3,4,5 ORDER BY 1");
  while (rs.next())
    System.out.println("SNAP\t" + rs.getLong(1) + "\t" + rs.getString(2) + "\t" + rs.getString(3) +
                       "\t" + rs.getString(4) + "\t" + rs.getString(5) + "\t" + rs.getLong(6));
}
/exit
'@ | Set-Content -Path $verifyScript -Encoding ascii

$jshell = Join-Path $JavaHome 'bin\jshell.exe'
$rows = & $jshell --class-path $duckJar "-R-Ddbpath=$cacheFile" -q $verifyScript 2>&1 |
        Where-Object { $_ -match '^SNAP\t' } | ForEach-Object {
            $f = $_ -split "`t"
            [pscustomobject]@{ SnapshotId=$f[1]; WorldId=$f[2]; Source=$f[3]
                               FileHash=$f[4]; Dict=$f[5]; ZdoRows=[long]$f[6] }
        }
$rows | Format-Table -AutoSize | Out-String | Write-Host

if (-not $rows) { throw 'verification failed: no snapshots in the built cache' }

# Continuity gate: history must accumulate. Every snapshot the previous receipt shipped
# that still fits the live window must be present in this cache; the publish fails closed
# rather than silently shipping a history reset.
if ($usePrevReceipt) {
    $prevIds = @($prevReceipt.snapshots | ForEach-Object { [long]$_.snapshot_id } | Sort-Object)
    $retainCount = [Math]::Min($prevIds.Count, $LiveWindow - $newCount)
    $expectedRetained = @($prevIds | Select-Object -Last $retainCount)
    $currentIds = @($rows | ForEach-Object { [long]$_.SnapshotId })
    foreach ($id in $expectedRetained) {
        if ($currentIds -notcontains $id) {
            throw "continuity gate failed: snapshot $id from the previous publish is missing from the new cache (history would reset)"
        }
    }
    Write-Host ("      continuity gate passed: retained {0} of {1} prior snapshot(s), {2} new" -f `
        $expectedRetained.Count, $prevIds.Count, $newCount)
}

# Prune absolute render dirs for snapshots that aged out of the live window (delta pair
# pruning is handled by the builder itself).
$liveIds = @($rows | ForEach-Object { "$($_.SnapshotId)" })
Get-ChildItem $renderDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^[0-9]+$' -and $liveIds -notcontains $_.Name } |
    ForEach-Object {
        Write-Host "      pruning aged-out rendered dir $($_.Name)"
        Remove-Item $_.FullName -Recurse -Force
    }

foreach ($r in $rows) {
    if ($r.ZdoRows -le 0) { throw "snapshot $($r.SnapshotId) (source=$($r.Source)) has no ZDO rows" }
    if (-not $r.Dict)     { throw "snapshot $($r.SnapshotId) (source=$($r.Source)) has no prefab dictionary recorded" }
    $manifest = Join-Path $renderDir "$($r.SnapshotId)\manifest.json"
    if (-not (Test-Path $manifest)) { throw "snapshot $($r.SnapshotId) (source=$($r.Source)) has no rendered layer manifest at $manifest" }
    try { $absoluteManifest = Get-Content $manifest -Raw | ConvertFrom-Json }
    catch { throw "snapshot $($r.SnapshotId) has malformed rendered layer manifest: $($_.Exception.Message)" }
    if ([long]$absoluteManifest.snapshotId -ne [long]$r.SnapshotId) {
        throw "rendered manifest $manifest identifies snapshot $($absoluteManifest.snapshotId), expected $($r.SnapshotId)"
    }
    if (@($absoluteManifest.layers).Count -eq 0) {
        throw "snapshot $($r.SnapshotId) rendered manifest advertises no layers"
    }
    foreach ($layer in @($absoluteManifest.layers)) {
        if (-not $layer.file -or [IO.Path]::GetFileName([string]$layer.file) -ne [string]$layer.file) {
            throw "snapshot $($r.SnapshotId) has an invalid rendered layer filename '$($layer.file)'"
        }
        $layerFile = Join-Path (Split-Path -Parent $manifest) ([string]$layer.file)
        if (-not (Test-Path $layerFile -PathType Leaf)) {
            throw "snapshot $($r.SnapshotId) manifest references missing layer $layerFile"
        }
        $absoluteDimensions = Get-ImageDimensions $layerFile
        if ($absoluteDimensions.Width -le 0 -or $absoluteDimensions.Height -le 0) {
            throw "snapshot $($r.SnapshotId) layer has invalid dimensions: $layerFile"
        }
    }
}

# Delta rasters are a bounded, canonical matrix: for each world, every older->newer pair among
# its latest six snapshots (at most 15). Validate the manifest contract and every advertised PNG
# before any artifact can be transferred to AM4.
$expectedDeltaIds = @(
    'build-activity-64', 'all-zdos-64', 'dropped-items-64', 'coins-64',
    'build-activity-320', 'all-zdos-320', 'dropped-items-320', 'coins-320',
    'build-activity-500', 'all-zdos-500', 'dropped-items-500', 'coins-500',
    'build-activity-1000', 'all-zdos-1000', 'dropped-items-1000', 'coins-1000'
)
$deltaPairCount = 0
foreach ($worldGroup in @($rows | Group-Object WorldId)) {
    $recent = @($worldGroup.Group | Sort-Object { [long]$_.SnapshotId } -Descending | Select-Object -First 6)
    for ($newer = 0; $newer -lt ($recent.Count - 1); $newer++) {
        for ($older = $newer + 1; $older -lt $recent.Count; $older++) {
            $fromId = [long]$recent[$older].SnapshotId
            $toId   = [long]$recent[$newer].SnapshotId
            $pairDir = Join-Path (Join-Path $renderDir 'delta') ("{0}-{1}" -f $fromId, $toId)
            $deltaManifestPath = Join-Path $pairDir 'manifest.json'
            if (-not (Test-Path $deltaManifestPath -PathType Leaf)) {
                throw "world $($worldGroup.Name) is missing delta manifest for $fromId -> $toId at $deltaManifestPath"
            }
            try { $deltaManifest = Get-Content $deltaManifestPath -Raw | ConvertFrom-Json }
            catch { throw "delta manifest $deltaManifestPath is malformed: $($_.Exception.Message)" }

            if ([long]$deltaManifest.fromSnapshotId -ne $fromId -or [long]$deltaManifest.toSnapshotId -ne $toId) {
                throw "delta manifest $deltaManifestPath identifies $($deltaManifest.fromSnapshotId) -> $($deltaManifest.toSnapshotId), expected $fromId -> $toId"
            }
            if ([int]$deltaManifest.schemaVersion -ne 3) {
                throw "delta manifest $deltaManifestPath has unsupported schemaVersion '$($deltaManifest.schemaVersion)'"
            }
            if ([string]$deltaManifest.worldId -ne [string]$worldGroup.Name) {
                throw "delta manifest $deltaManifestPath identifies world '$($deltaManifest.worldId)', expected '$($worldGroup.Name)'"
            }
            if ([string]$deltaManifest.identity -ne 'prefab-hash+position-cm') {
                throw "delta manifest $deltaManifestPath has unsupported identity '$($deltaManifest.identity)'"
            }
            $topFields = @($deltaManifest.PSObject.Properties.Name)
            foreach ($requiredField in @('fromDictionaryVersion', 'toDictionaryVersion',
                    'dictionaryMismatch', 'dictionaryCompatibility', 'zdosAdded', 'zdosRemoved',
                    'spatialZdosAdded', 'spatialZdosRemoved', 'unrenderableZdosAdded',
                    'unrenderableZdosRemoved')) {
                if ($topFields -notcontains $requiredField) {
                    throw "delta manifest $deltaManifestPath does not declare $requiredField"
                }
            }
            $expectedFromDictionary = [string]$recent[$older].Dict
            $expectedToDictionary = [string]$recent[$newer].Dict
            if ([string]$deltaManifest.fromDictionaryVersion -ne $expectedFromDictionary -or
                    [string]$deltaManifest.toDictionaryVersion -ne $expectedToDictionary) {
                throw "delta manifest $deltaManifestPath dictionary versions do not match its snapshots"
            }
            $dictionaryCompatibility = [string]$deltaManifest.dictionaryCompatibility
            $expectedDictionaryMismatch = $expectedFromDictionary -ne $expectedToDictionary
            if (@('compatible', 'mismatch') -notcontains $dictionaryCompatibility -or
                    ([bool]$deltaManifest.dictionaryMismatch -ne $expectedDictionaryMismatch) -or
                    (($dictionaryCompatibility -eq 'mismatch') -ne $expectedDictionaryMismatch)) {
                throw "delta manifest $deltaManifestPath has inconsistent dictionary compatibility fields"
            }
            if ([double]$deltaManifest.zdosAdded -lt 0 -or [double]$deltaManifest.zdosRemoved -lt 0 -or
                    [double]$deltaManifest.spatialZdosAdded -lt 0 -or
                    [double]$deltaManifest.spatialZdosRemoved -lt 0 -or
                    [double]$deltaManifest.unrenderableZdosAdded -lt 0 -or
                    [double]$deltaManifest.unrenderableZdosRemoved -lt 0 -or
                    [double]$deltaManifest.zdosAdded -ne
                        ([double]$deltaManifest.spatialZdosAdded + [double]$deltaManifest.unrenderableZdosAdded) -or
                    [double]$deltaManifest.zdosRemoved -ne
                        ([double]$deltaManifest.spatialZdosRemoved + [double]$deltaManifest.unrenderableZdosRemoved)) {
                throw "delta manifest $deltaManifestPath has negative headline counts"
            }
            $deltaLayers = @($deltaManifest.layers)
            if ($deltaLayers.Count -ne $expectedDeltaIds.Count) {
                throw "delta manifest $deltaManifestPath advertises $($deltaLayers.Count) layers; expected $($expectedDeltaIds.Count)"
            }
            $actualIds = @($deltaLayers | ForEach-Object { [string]$_.id })
            foreach ($expectedId in $expectedDeltaIds) {
                if ($actualIds -notcontains $expectedId) {
                    throw "delta manifest $deltaManifestPath is missing layer '$expectedId'"
                }
            }
            foreach ($layer in $deltaLayers) {
                if ([string]$layer.encoding -ne 'gray8' -or -not $layer.bounds) {
                    throw "delta layer '$($layer.id)' in $deltaManifestPath has an invalid encoding or bounds"
                }
                $layerFields = @($layer.PSObject.Properties.Name)
                foreach ($requiredField in @('addedMaxRaw', 'removedMaxRaw', 'addedMaxLog',
                        'removedMaxLog', 'addedCellCount', 'removedCellCount', 'addedRawTotal',
                        'removedRawTotal', 'width', 'height', 'empty', 'units', 'identity')) {
                    if ($layerFields -notcontains $requiredField) {
                        throw "delta layer '$($layer.id)' in $deltaManifestPath does not declare $requiredField"
                    }
                }
                if ([double]$layer.addedMaxRaw -lt 0 -or [double]$layer.removedMaxRaw -lt 0 -or
                        [double]$layer.addedMaxLog -lt 0 -or [double]$layer.removedMaxLog -lt 0 -or
                        [double]$layer.addedCellCount -lt 0 -or [double]$layer.removedCellCount -lt 0 -or
                        [double]$layer.addedRawTotal -lt 0 -or [double]$layer.removedRawTotal -lt 0 -or
                        [int]$layer.width -le 0 -or [int]$layer.height -le 0) {
                    throw "delta layer '$($layer.id)' in $deltaManifestPath has invalid maxima or dimensions"
                }
                $channelDimensions = @{}
                foreach ($channelField in @('addedFile', 'removedFile')) {
                    $fileName = [string]$layer.$channelField
                    if (-not $fileName -or [IO.Path]::GetFileName($fileName) -ne $fileName) {
                        throw "delta layer '$($layer.id)' has invalid $channelField '$fileName'"
                    }
                    $channelFile = Join-Path $pairDir $fileName
                    if (-not (Test-Path $channelFile -PathType Leaf)) {
                        throw "delta layer '$($layer.id)' references missing channel $channelFile"
                    }
                    $channelDimensions[$channelField] = Get-ImageDimensions $channelFile
                }
                $addedDimensions = $channelDimensions['addedFile']
                $removedDimensions = $channelDimensions['removedFile']
                if ($addedDimensions.Width -ne $removedDimensions.Width -or
                        $addedDimensions.Height -ne $removedDimensions.Height) {
                    throw "delta layer '$($layer.id)' channels are not aligned"
                }
                if ([int]$layer.width -ne $addedDimensions.Width -or
                        [int]$layer.height -ne $addedDimensions.Height) {
                    throw "delta layer '$($layer.id)' PNG dimensions disagree with its manifest"
                }
            }
            $deltaPairCount++
        }
    }
}
Write-Host "      verified $deltaPairCount canonical delta raster pair(s)."
if ($am4Sha) {
    # Selected by source, not world_id: every snapshot shares one world_id by design.
    # Keyed on the sha, not the pulled file: an unchanged AM4 world skips the pull but
    # the gate must still confirm the retained snapshot matches what AM4 serves.
    # LATEST am4 snapshot: a cumulative cache carries am4 rows from prior publishes whose
    # hashes legitimately differ from what AM4 serves now.
    $am4Row = $rows | Where-Object { $_.Source -eq 'am4' } |
              Sort-Object { [long]$_.SnapshotId } -Descending | Select-Object -First 1
    if (-not $am4Row) { throw "no am4-sourced snapshot in the built cache" }
    if ($am4Row.FileHash -ne $am4Sha) {
        throw "consistency gate failed: cache was built from $($am4Row.FileHash) but AM4 serves $am4Sha"
    }
    Write-Host "      consistency gate passed: cache matches the world AM4 serves."
}

$cacheMB  = [math]::Round((Get-Item $cacheFile).Length / 1MB, 1)
$renderMB = [math]::Round(((Get-ChildItem $renderDir -Recurse -File -ErrorAction SilentlyContinue |
             Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host "      artifacts: cache ${cacheMB} MB, rendered ${renderMB} MB"

# --- 5b. Archive ----------------------------------------------------------
# Always on: the archive is the history of record the next publish rebuilds from.
# Only snapshots not yet archived are exported; nothing is ever deleted here.
$archiveTotalMB = 0
if ($true) {
    Write-Host "[5b/7] Archiving new snapshots as Parquet to $ArchiveDir ..."

    $stmts = @()
    foreach ($r in $rows) {
        $src = if ($r.Source) { $r.Source } else { 'unknown' }   # no ternary: Windows PowerShell 5.1
        $snapDirName = "snapshot-{0}-{1}" -f $r.SnapshotId, $src
        $snapDir = Join-Path $ArchiveDir $snapDirName
        if (Test-Path (Join-Path $snapDir 'world_snapshot.parquet')) { continue }
        New-Item -ItemType Directory -Force -Path $snapDir | Out-Null
        $p = $snapDir -replace '\\', '/'
        $id = $r.SnapshotId
        # zdo_field is normally empty (--cache-fields is off); skipped deliberately rather than
        # writing an empty file per snapshot.
        $stmts += "  st.execute(`"COPY (SELECT * FROM zdo WHERE snapshot_id = $id) TO '$p/zdo.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)`");"
        $stmts += "  st.execute(`"COPY (SELECT * FROM container_item WHERE snapshot_id = $id) TO '$p/container_item.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)`");"
        $stmts += "  st.execute(`"COPY (SELECT * FROM world_snapshot WHERE snapshot_id = $id) TO '$p/world_snapshot.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)`");"
    }
    if ($stmts.Count -eq 0) {
        Write-Host '      nothing new to archive.'
    } else {
        $archScript = Join-Path $WorkDir 'archive.jsh'
        @(
            'var url = "jdbc:duckdb:" + System.getProperty("dbpath");'
            'try (var c = java.sql.DriverManager.getConnection(url); var st = c.createStatement()) {'
            $stmts
            '  System.out.println("archive-ok");'
            '}'
            '/exit'
        ) | Set-Content -Path $archScript -Encoding ascii

        $archOut = & $jshell --class-path $duckJar "-R-Ddbpath=$cacheFile" -q $archScript 2>&1
        if ("$archOut" -notmatch 'archive-ok') { throw "parquet archive failed:`n$archOut" }
    }

    $archiveTotalMB = [math]::Round(((Get-ChildItem $ArchiveDir -Recurse -File -Filter '*.parquet' |
                       Measure-Object Length -Sum).Sum / 1MB), 1)
    Get-ChildItem $ArchiveDir -Directory | ForEach-Object {
        $mb = [math]::Round(((Get-ChildItem $_.FullName -File -Filter '*.parquet' |
               Measure-Object Length -Sum).Sum / 1MB), 1)
        Write-Host ("      {0}: {1} MB" -f $_.Name, $mb)
    }
    Write-Host ("      archive total {0} MB vs {1} MB live cache ({2:n1}x smaller)" -f `
        $archiveTotalMB, $cacheMB, ($(if ($archiveTotalMB -gt 0) { $cacheMB / $archiveTotalMB } else { 0 })))
    Write-Host "      Parquet is queryable in place: SELECT * FROM '$($ArchiveDir -replace '\\','/')/snapshot-*/zdo.parquet'"
}

# --- 6. Publish -----------------------------------------------------------
if (-not $Push) {
    Write-Host ''
    Write-Host "[6/7] DRY RUN - nothing published. Would transfer ${cacheMB} MB + ${renderMB} MB to ${SshTarget}:${RemoteRoot}/publish"
    Write-Host '      Re-run with -Push to publish.'
} else {
    Write-Host "[6/7] Publishing to $SshTarget..."
    Invoke-Ssh "mkdir -p $RemoteRoot/publish/rendered" | Out-Null

    $activeWorldRemote = $null
    if ($ActivateWorld) {
        $activeWorldName = $omenWorld.Name
        $activeWorldRemote = "$RemoteRoot/world/$activeWorldName"
        $activeWorldUpload = "$activeWorldRemote.upload"
        Write-Host "      uploading active boot world $activeWorldName..."
        Invoke-Ssh "mkdir -p $RemoteRoot/world && rm -f $activeWorldUpload" | Out-Null
        scp -q $omenWorld.FullName "${SshTarget}:$activeWorldUpload"
        if ($LASTEXITCODE -ne 0) { throw "scp of active world failed (exit $LASTEXITCODE)" }
        $remoteActiveSha = (Invoke-Ssh "sha256sum $activeWorldUpload").Split(' ')[0]
        if ($remoteActiveSha -ne $omenSha) {
            Invoke-Ssh "rm -f $activeWorldUpload" -AllowFailure | Out-Null
            throw "active world transfer corrupted: local $omenSha, remote $remoteActiveSha"
        }
        Invoke-Ssh "mv $activeWorldUpload $activeWorldRemote" | Out-Null
        Write-Host "      active world transfer verified: $omenSha"
    }

    Write-Host "      uploading cache (${cacheMB} MB)..."
    scp -q $cacheFile "${SshTarget}:$RemoteRoot/publish/world-cache.duckdb"
    if ($LASTEXITCODE -ne 0) { throw "scp of cache failed (exit $LASTEXITCODE)" }

    if (Test-Path $renderDir) {
        Write-Host "      uploading rendered layers (${renderMB} MB)..."
        scp -q -r "$renderDir\*" "${SshTarget}:$RemoteRoot/publish/rendered/"
        if ($LASTEXITCODE -ne 0) { throw "scp of rendered layers failed (exit $LASTEXITCODE)" }
    }

    # Stop the container before swapping the cache it has open, then move the
    # artifacts into the named volume through a helper container (no sudo, and no
    # assumptions about where docker keeps volume data).
    Write-Host '      stopping container and installing artifacts into steward-data...'
    Invoke-Ssh "cd $RemoteRoot/build && docker compose --env-file $RemoteRoot/.env -f docker-compose.am4.yml stop" -AllowFailure | Out-Null
    $install = @(
        "docker run --rm -v steward_steward-data:/data -v $RemoteRoot/publish:/in:ro alpine sh -c '"
        'set -eu; '
        'rm -rf /data/rendered; mkdir -p /data/rendered; '
        'cp /in/world-cache.duckdb /data/world-cache.duckdb.new; '
        'mv /data/world-cache.duckdb.new /data/world-cache.duckdb; '
        'rm -f /data/world-cache.duckdb.wal; '
        'cp -r /in/rendered/. /data/rendered/ 2>/dev/null || true; '
        'touch /data/.cache-complete; '
        "echo install-ok'"
    ) -join ''
    $installResult = Invoke-Ssh $install
    if ("$installResult" -notmatch 'install-ok') { throw "artifact install failed: $installResult" }

    if ($ActivateWorld) {
        $activeWorldName = $omenWorld.Name
        Invoke-Ssh "umask 077; sed '/^STEWARD_WORLD_FILE=/d' $RemoteRoot/.env > $RemoteRoot/.env.new && printf 'STEWARD_WORLD_FILE=/world/$activeWorldName\n' >> $RemoteRoot/.env.new && mv $RemoteRoot/.env.new $RemoteRoot/.env && chmod 600 $RemoteRoot/.env" | Out-Null
        Write-Host "      selected /world/$activeWorldName as the Steward boot world"
    }

    Write-Host '      starting container...'
    Invoke-Ssh "cd $RemoteRoot/build && docker compose --env-file $RemoteRoot/.env -f docker-compose.am4.yml up -d" | Out-Null

    Write-Host "[7/7] Waiting for readiness (up to $TimeoutMinutes min; serve mode only, no rebuild)..."
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        $status = Invoke-Ssh "curl -fsS -m 5 http://127.0.0.1:$Port/api/v1/status" -AllowFailure
        if ("$status" -match '"done"\s*:\s*true') { $ready = $true; break }
        Start-Sleep -Seconds 10
    }
    if (-not $ready) {
        Invoke-Ssh 'docker logs --tail 40 comfy-steward-view' -AllowFailure | Write-Host
        throw "viewer not ready within $TimeoutMinutes minutes - logs above"
    }
    $snapCheck = Invoke-Ssh "curl -fsS -m 10 http://127.0.0.1:$Port/api/v1/db/snapshots" -AllowFailure
    Write-Host "      /api/v1/db/snapshots: $snapCheck"
    if ($ActivateWorld) {
        $bootStatus = Invoke-Ssh "curl -fsS -m 10 http://127.0.0.1:$Port/api/v1/status" -AllowFailure
        $expectedBootRows = ($rows | Where-Object { $_.FileHash -eq $omenSha } |
                            Sort-Object { [long]$_.SnapshotId } -Descending |
                            Select-Object -First 1).ZdoRows
        if (-not $expectedBootRows -or "$bootStatus" -notmatch ('"parsed"\s*:\s*' + $expectedBootRows)) {
            throw "active-world gate failed: boot status does not report $expectedBootRows parsed ZDOs: $bootStatus"
        }
        Write-Host "      active-world gate passed: boot parse and release snapshot both contain $expectedBootRows ZDOs."
    }
    Write-Host '      Ready.'
}

# --- Receipt --------------------------------------------------------------
$receipt = [ordered]@{
    started_at      = $startedAt
    finished_at     = (Get-Date).ToUniversalTime().ToString('o')
    pushed          = [bool]$Push
    ssh_target      = $SshTarget
    git_sha         = (git -C $repoRoot rev-parse --short HEAD)
    am4_world_sha256 = $am4Sha
    omen_world      = $omenWorld.Name
    omen_world_sha256 = $omenSha
    activated_world = $(if ($ActivateWorld) { $omenWorld.Name } else { $null })
    cache_mb        = $cacheMB
    rendered_mb     = $renderMB
    delta_pairs     = $deltaPairCount
    archived        = $true
    archive_dir     = $ArchiveDir
    archive_mb      = $archiveTotalMB
    live_window     = $LiveWindow
    new_snapshots   = $newCount
    snapshots       = @($rows | ForEach-Object { [ordered]@{
        snapshot_id = $_.SnapshotId; world_id = $_.WorldId; source = $_.Source
        file_hash   = $_.FileHash
        dictionary  = $_.Dict;       zdo_rows = $_.ZdoRows } })
}
$receiptPath = Join-Path $PSScriptRoot 'publish-steward-receipt.json'
$receipt | ConvertTo-Json -Depth 5 | Set-Content -Path $receiptPath -Encoding utf8
Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "Receipt: $receiptPath"
