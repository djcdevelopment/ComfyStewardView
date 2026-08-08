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

.EXAMPLE
  # Dry run: build both worlds on OMEN, verify, report. Nothing published.
  powershell -ExecutionPolicy Bypass -File .\tools\Publish-Steward.ps1

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
    # One world id, because these are all copies of the same Era16 save. What differs between
    # them is which host the copy came from and when, which is what `source` and `backup_id`
    # record. Giving them separate world_ids would split one world's history into parallel
    # timelines and make the Changes view unable to diff them.
    [string]$WorldId         = 'ComfyEra16',
    [string]$WorldName       = 'Comfy Era 16',
    [string]$WorkDir         = "$env:LOCALAPPDATA\steward-publish",
    [string]$JavaHome        = '',
    [string]$JavaOpts        = '-Xmx8g -Djava.awt.headless=true',
    [int]   $TimeoutMinutes  = 30,
    [switch]$SkipAm4World,
    [switch]$Push
)

$ErrorActionPreference = 'Stop'
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

# --- 1. Preflight ---------------------------------------------------------
Write-Host '[1/7] Preflight...'
if (-not (Test-Path $java)) { throw "java not found at $java (pass -JavaHome)" }
if (-not (Test-Path $jar))  { throw "viewer jar not found at $jar - run: mvn -f viewer/pom.xml package -DskipTests" }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

$outDir    = Join-Path $WorkDir 'out'
$cacheFile = Join-Path $outDir 'world-cache.duckdb'
$renderDir = Join-Path $outDir 'rendered'
if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Write-Host "      workdir: $WorkDir"

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

    $am4World = Join-Path $WorkDir $worldName
    Write-Host "      pulling $worldDest (this is the large inbound transfer)..."
    scp -q "${SshTarget}:$worldDest" $am4World
    if ($LASTEXITCODE -ne 0) { throw "scp of AM4 world failed (exit $LASTEXITCODE)" }

    $localSha = (Get-FileHash $am4World -Algorithm SHA256).Hash.ToLower()
    if ($localSha -ne $am4Sha) { throw "AM4 world transfer corrupted: remote $am4Sha, local $localSha" }
    Write-Host ("      transfer verified ({0:n1} MB)" -f ((Get-Item $am4World).Length / 1MB))
} else {
    Write-Host '[2/7] -SkipAm4World: publishing the omen-sourced copy only.'
}

# --- 3. Pick OMEN's world -------------------------------------------------
# Prefer the newest rotated backup over the live file: a backup_auto is immutable
# once written, so it needs no torn-copy dance.
Write-Host '[3/7] Selecting OMEN world save...'
$omenWorld = Get-ChildItem $OmenWorldDir -Filter '*_backup_auto-*.db' -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $omenWorld) { throw "no rotated backup found in $OmenWorldDir" }
Write-Host ("      {0} ({1:n1} MB, {2})" -f $omenWorld.Name, ($omenWorld.Length / 1MB), $omenWorld.LastWriteTime)

# --- 4. Build artifacts on OMEN ------------------------------------------
# The AM4 world goes first and carries --render-layers: RenderedLayerBuilder
# renders for the cache's current snapshot, and the layers must match the world
# AM4 parses in memory. The lab world is appended afterwards without rendering.
# Measured on a 9.16M-ZDO world: ~53s for the first (--rebuild-cache) world, which uses the
# DuckDB Appender against an empty, unindexed database. Appending a second world is far slower
# because finish() has already built the indexes and the append writes through them.
Write-Host '[4/7] Building analytics cache on OMEN...'
$first = $true
if ($am4World) {
    Invoke-Batch -Label "am4 copy: parse + cache + render" -Arguments @(
        $am4World, '--rebuild-cache', '--cache', $cacheFile,
        '--render-layers', '--render-dir', $renderDir,
        '--world-id', $WorldId, '--world-name', $WorldName,
        '--source', 'am4', '--backup-id', ("am4_{0}" -f (Get-Date -Format 'yyyyMMddHHmmss')),
        '--batch-only', '--no-browser')
    $first = $false
}
$omenArgs = @(
    $omenWorld.FullName,
    $(if ($first) { '--rebuild-cache' } else { '--build-cache' }),
    '--cache', $cacheFile,
    '--world-id', $WorldId, '--world-name', $WorldName,
    '--source', 'omen', '--backup-id', [IO.Path]::GetFileNameWithoutExtension($omenWorld.Name),
    '--batch-only', '--no-browser')
if ($first) { $omenArgs += @('--render-layers', '--render-dir', $renderDir) }
Invoke-Batch -Label "omen copy: parse + cache" -Arguments $omenArgs

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
foreach ($r in $rows) {
    if ($r.ZdoRows -le 0) { throw "snapshot $($r.SnapshotId) (source=$($r.Source)) has no ZDO rows" }
    if (-not $r.Dict)     { throw "snapshot $($r.SnapshotId) (source=$($r.Source)) has no prefab dictionary recorded" }
}
if ($am4World) {
    # Selected by source, not world_id: every snapshot shares one world_id by design.
    $am4Row = $rows | Where-Object { $_.Source -eq 'am4' } | Select-Object -First 1
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

# --- 6. Publish -----------------------------------------------------------
if (-not $Push) {
    Write-Host ''
    Write-Host "[6/7] DRY RUN - nothing published. Would transfer ${cacheMB} MB + ${renderMB} MB to ${SshTarget}:${RemoteRoot}/publish"
    Write-Host '      Re-run with -Push to publish.'
} else {
    Write-Host "[6/7] Publishing to $SshTarget..."
    Invoke-Ssh "mkdir -p $RemoteRoot/publish/rendered" | Out-Null

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
    Invoke-Ssh "cd $RemoteRoot/build && docker compose -f docker-compose.am4.yml stop" -AllowFailure | Out-Null
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

    Write-Host '      starting container...'
    Invoke-Ssh "cd $RemoteRoot/build && docker compose -f docker-compose.am4.yml up -d" | Out-Null

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
    cache_mb        = $cacheMB
    rendered_mb     = $renderMB
    snapshots       = @($rows | ForEach-Object { [ordered]@{
        snapshot_id = $_.SnapshotId; world_id = $_.WorldId
        dictionary  = $_.Dict;       zdo_rows = $_.ZdoRows } })
}
$receiptPath = Join-Path $PSScriptRoot 'publish-steward-receipt.json'
$receipt | ConvertTo-Json -Depth 5 | Set-Content -Path $receiptPath -Encoding utf8
Write-Host ''
Write-Host "Receipt: $receiptPath"
