<#
.SYNOPSIS
  Re-parse the synthetic-history corpus with the current classifier and rewrite its Parquet archive.

.DESCRIPTION
  Snapshot categories are frozen into zdo.category at parse time, so a classifier change (here:
  dictionary-confirmed construction pieces becoming BUILDING, parser 1.1.0) does nothing to
  snapshots that are already ingested. Re-ingest is the only lever.

  No Docker replay is involved. The six mutated saves were captured and SHA-256'd when the corpus
  was built, so this is purely a re-parse of files already on disk.

  One snapshot at a time, into a scratch cache that is deleted between iterations. Building all six
  into one cache would need ~7 GB; this peaks at ~1.3 GB, which matters because the publish workdir
  lives on a volume with very little headroom. The output is the Parquet archive — the history of
  record that Publish-Steward rebuilds the live cache from on every run — so replacing those six
  directories is what carries the new categories through to AM4.

  Writes nothing into the real archive: the new Parquet lands in -OutDir for inspection, and
  Install-Archive.ps1-style promotion is a separate, deliberate step.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\Reingest-SyntheticCorpus.ps1
#>
[CmdletBinding()]
param(
    [string]$CorpusRoot = 'D:\steward-synthetic-history-v1\steward-synthetic-history-v1',
    [string]$WorkRoot   = 'D:\steward-reingest',
    [string]$CorpusId   = 'steward-synthetic-history-v1',
    # Accurate, unlike 'Synthetic validation corpus': these are the real ComfyEra16 save replayed
    # forward through the Docker lab with scripted events, not a synthesised world.
    [string]$WorldName  = 'ComfyEra16 - scripted replay',
    [string]$Source     = 'synthetic',
    # The live ids the corpus occupies. Offset by 100 so it cannot collide with the ComfyEra16
    # publish ids (1..3); the archive directory names encode these.
    [int]   $FirstId    = 101,
    [string]$JavaHome   = '',
    [string]$JavaOpts   = '-Xmx6g -Djava.awt.headless=true'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$jar      = Join-Path $repoRoot 'viewer\target\world-viewer-1.0.0.jar'
$duckJar  = Join-Path $repoRoot 'viewer\lib\duckdb_jdbc-1.5.4.0.jar'
if (-not $JavaHome) { $JavaHome = Join-Path $repoRoot '.tools\jdk-17.0.19+10' }
$java   = Join-Path $JavaHome 'bin\java.exe'
$jshell = Join-Path $JavaHome 'bin\jshell.exe'

foreach ($p in @($jar, $duckJar, $java, $jshell)) {
    if (-not (Test-Path $p)) { throw "missing required tool: $p" }
}

$outDir   = Join-Path $WorkRoot 'archive-new'
$tmpCache = Join-Path $WorkRoot 'scratch-cache.duckdb'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$results = @()

Write-Host "Re-ingesting 6 corpus snapshots with parser from $jar"
Write-Host "  world:   $CorpusId / '$WorldName'"
Write-Host "  scratch: $tmpCache  (deleted between snapshots)"
Write-Host "  output:  $outDir"
Write-Host ''

for ($i = 0; $i -le 5; $i++) {
    $backupId = 'snapshot-{0:D2}' -f $i
    $save     = Join-Path $CorpusRoot "snapshots\$backupId\ComfyEra16.db"
    $liveId   = $FirstId + $i
    if (-not (Test-Path $save)) { throw "missing corpus save: $save" }

    Write-Host ("[{0}/6] {1} -> snapshot_id {2}" -f ($i + 1), $backupId, $liveId)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    # Fresh single-snapshot cache. --rebuild-cache every time is what keeps the peak small.
    Remove-Item $tmpCache, "$tmpCache.wal" -Force -ErrorAction SilentlyContinue
    $args = @(
        $JavaOpts.Split(' ') | Where-Object { $_ }
        '-jar', $jar, $save,
        '--rebuild-cache', '--cache', $tmpCache,
        '--world-id', $CorpusId, '--world-name', $WorldName,
        '--source', $Source, '--backup-id', $backupId,
        '--batch-only', '--no-browser'
    )
    # No 2>&1 and no pipe, matching Invoke-Batch in Publish-Steward.ps1: Windows PowerShell wraps
    # a native command's stderr lines in ErrorRecords, which $ErrorActionPreference='Stop' then
    # treats as fatal even when the process exits 0. The parse logs to stderr, so redirecting it
    # kills the run on the first SLF4J warning. Exit code is the only status that matters here.
    & $java @args
    if ($LASTEXITCODE -ne 0) { throw "parse failed for $backupId (exit $LASTEXITCODE)" }

    # Renumber to the live id, then export. The parse always yields snapshot_id 1 because the
    # cache was just rebuilt; importArchiveSnapshots preserves whatever id the Parquet carries.
    $snapDir = Join-Path $outDir ("snapshot-{0}-{1}" -f $liveId, $Source)
    New-Item -ItemType Directory -Force -Path $snapDir | Out-Null
    $p = $snapDir -replace '\\', '/'
    $script = Join-Path $WorkRoot 'export.jsh'
    @(
        'var url = "jdbc:duckdb:" + System.getProperty("dbpath");'
        'try (var c = java.sql.DriverManager.getConnection(url); var st = c.createStatement()) {'
        "  st.execute(`"UPDATE zdo SET snapshot_id = $liveId WHERE snapshot_id = 1`");"
        "  st.execute(`"UPDATE container_item SET snapshot_id = $liveId WHERE snapshot_id = 1`");"
        "  st.execute(`"UPDATE world_snapshot SET snapshot_id = $liveId WHERE snapshot_id = 1`");"
        "  var rs = st.executeQuery(`"SELECT category, COUNT(*) n FROM zdo GROUP BY category ORDER BY n DESC`");"
        '  while (rs.next()) System.out.println("CENSUS " + rs.getString(1) + "=" + rs.getLong(2));'
        "  st.execute(`"COPY (SELECT * FROM zdo) TO '$p/zdo.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)`");"
        "  st.execute(`"COPY (SELECT * FROM container_item) TO '$p/container_item.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)`");"
        "  st.execute(`"COPY (SELECT * FROM world_snapshot) TO '$p/world_snapshot.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)`");"
        '  System.out.println("export-ok");'
        '}'
        '/exit'
    ) | Set-Content -Path $script -Encoding ascii

    $out = & $jshell --class-path $duckJar "-R-Ddbpath=$tmpCache" -q $script 2>&1
    if ("$out" -notmatch 'export-ok') { throw "parquet export failed for ${backupId}:`n$out" }

    $census = @{}
    foreach ($line in $out) {
        if ("$line" -match '^CENSUS\s+(\S+)=(\d+)') { $census[$Matches[1]] = [int64]$Matches[2] }
    }
    $sw.Stop()
    $mb = [math]::Round(((Get-ChildItem $snapDir -File -Filter *.parquet | Measure-Object Length -Sum).Sum / 1MB), 1)
    Write-Host ("        BUILDING={0:N0}  UNKNOWN={1:N0}  ({2} MB, {3}s)" -f
        $census['BUILDING'], $census['UNKNOWN'], $mb, [math]::Round($sw.Elapsed.TotalSeconds, 0))

    $results += [ordered]@{ backupId = $backupId; snapshotId = $liveId; parquetMB = $mb
                            building = $census['BUILDING']; unknown = $census['UNKNOWN']
                            seconds = [math]::Round($sw.Elapsed.TotalSeconds, 0) }
}

Remove-Item $tmpCache, "$tmpCache.wal" -Force -ErrorAction SilentlyContinue

$receipt = [ordered]@{
    started_at = $startedAt
    finished_at = (Get-Date).ToUniversalTime().ToString('o')
    corpus_id = $CorpusId
    world_name = $WorldName
    parser_jar_sha256 = (Get-FileHash $jar -Algorithm SHA256).Hash.ToLower()
    git_sha = (git -C $repoRoot rev-parse --short HEAD)
    out_dir = $outDir
    snapshots = $results
}
$receiptPath = Join-Path $WorkRoot 'reingest-receipt.json'
$receipt | ConvertTo-Json -Depth 5 | Set-Content -Path $receiptPath -Encoding utf8

Write-Host ''
Write-Host "Done. New Parquet in $outDir"
Write-Host "Receipt: $receiptPath"
Write-Host ''
Write-Host 'Nothing in the real archive has been touched. To promote:'
Write-Host "  1. move the existing snapshot-1??-$Source dirs out of the publish archive"
Write-Host "  2. copy these in"
Write-Host '  3. delete the rendered dirs for those ids and their delta pairs so they re-render'
Write-Host '  4. run tools\Publish-Steward.ps1 -Push'
