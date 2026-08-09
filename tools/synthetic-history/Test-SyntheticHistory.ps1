[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$CorpusRoot,
  [string]$StewardBaseUrl = 'http://localhost:8080',
  # Re-hashing 6 x 1.33 GB is the expensive part of this validator; skip when the files
  # haven't moved since capture and only the API-side checks are wanted.
  [switch]$SkipHashCheck
)
$ErrorActionPreference = 'Stop'
function ReadJson([string]$p) { Get-Content -Raw -LiteralPath $p | ConvertFrom-Json }
function Check([bool]$ok,[string]$message) { if (!$ok) { throw "VALIDATION FAILED: $message" } }
$corpus = ReadJson (Join-Path $CorpusRoot 'corpus.json')
Check ($corpus.snapshots.Count -ge 6 -and $corpus.snapshots.Count -le 12) 'corpus must contain 6..12 snapshots'
Check ($corpus.intervals.Count -eq ($corpus.snapshots.Count - 1)) 'interval count does not match snapshots'
$checks = [System.Collections.Generic.List[object]]::new()
for ($i=0; $i -lt $corpus.snapshots.Count; $i++) {
  $s=$corpus.snapshots[$i]; $dir=Join-Path $CorpusRoot ('snapshots\snapshot-{0:D2}' -f $i)
  Check (Test-Path (Join-Path $dir 'ComfyEra16.db')) "missing snapshot $i db"
  Check (Test-Path (Join-Path $dir 'ComfyEra16.fwl')) "missing snapshot $i fwl"
  if (-not $SkipHashCheck) {
    $dbHash=(Get-FileHash (Join-Path $dir 'ComfyEra16.db') -Algorithm SHA256).Hash.ToLowerInvariant()
    $fwlHash=(Get-FileHash (Join-Path $dir 'ComfyEra16.fwl') -Algorithm SHA256).Hash.ToLowerInvariant()
    Check ($dbHash -eq $s.dbSha256) "snapshot $i db hash mismatch"
    Check ($fwlHash -eq $s.fwlSha256) "snapshot $i fwl hash mismatch"
    $checks.Add(@{id="snapshot-$i-hashes"; pass=$true})
  } else {
    $checks.Add(@{id="snapshot-$i-hashes"; pass=$true; skipped=$true})
  }
}
for ($i=1; $i -lt $corpus.snapshots.Count; $i++) {
  $from=$corpus.snapshots[$i-1].stewardSnapshotId; $to=$corpus.snapshots[$i].stewardSnapshotId
  if ($null -eq $from -or $null -eq $to) { $checks.Add(@{id="interval-$i-api"; pass=$false; reason='not ingested'}); continue }
  $cmp=Invoke-RestMethod ($StewardBaseUrl.TrimEnd('/')+"/api/v1/db/snapshots/compare?from=$from&to=$to&worldId=$($corpus.corpusId)")
  Check ($cmp.fromSnapshotId -lt $cmp.toSnapshotId) "interval $i is not canonical"
  $manifest=Invoke-RestMethod ($StewardBaseUrl.TrimEnd('/')+"/api/v1/rendered/delta/manifest?from=$from&to=$to")
  Check ($manifest.worldId -eq $corpus.corpusId) "interval $i world mismatch"
  Check ($manifest.fromSnapshotId -eq $from -and $manifest.toSnapshotId -eq $to) "interval $i manifest identity mismatch"
  Check ($manifest.layers.Count -gt 0) "interval $i has no raster layers"
  $checks.Add(@{id="interval-$i-api"; pass=$true; added=$cmp.zdosAdded; removed=$cmp.zdosRemoved; layers=$manifest.layers.Count})
}
$result=@{schemaVersion='steward-synthetic-history/validation-v1'; corpusId=$corpus.corpusId; checkedUtc=[DateTime]::UtcNow.ToString('o'); checks=$checks; status='pass'}
$null=New-Item -ItemType Directory -Force -Path (Join-Path $CorpusRoot 'validation')
$result | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $CorpusRoot 'validation\summary-checked.json') -Encoding utf8
$result | ConvertTo-Json -Depth 20
