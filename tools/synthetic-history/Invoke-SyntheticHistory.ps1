[CmdletBinding()]
param(
  [ValidateSet('Plan','Prepare','ApplyStep','RecordSnapshot','Ingest','Validate','Restore')]
  [string]$Action = 'Plan',
  [string]$CorpusId = 'steward-synthetic-history-v1',
  [string]$Scenario = '',
  [string]$RunRoot = '',
  [string]$WorldDirectory = '',
  [int]$SnapshotIndex = -1,
  [int]$Step = -1,
  [string]$MailboxPath = '',
  [string]$StewardBaseUrl = 'http://localhost:8080',
  [string]$Jar = '',
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($Scenario)) { $Scenario = Join-Path $scriptDir 'scenario-v1.json' }
if ([string]::IsNullOrWhiteSpace($RunRoot)) { $RunRoot = Join-Path (Join-Path $scriptDir '..\..') 'artifacts\synthetic-history' }
if ([string]::IsNullOrWhiteSpace($Jar)) { $Jar = Join-Path (Join-Path $scriptDir '..\..') 'viewer\target\world-viewer.jar' }
function Require-Stopped {
  if (Get-Process valheim_server,valheim -ErrorAction SilentlyContinue) {
    throw 'Stop Valheim before manipulating a save or recording a snapshot.'
  }
}
function Sha256([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return $null }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function CorpusPath { Join-Path (Join-Path $RunRoot $CorpusId) 'corpus.json' }
function Read-Corpus {
  $p = CorpusPath
  if (!(Test-Path -LiteralPath $p)) { throw "Corpus is not planned: $p" }
  return Get-Content -Raw -LiteralPath $p | ConvertFrom-Json
}
function Write-Json([object]$Value,[string]$Path) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path -Encoding utf8
}
function Save-Paths {
  if ([string]::IsNullOrWhiteSpace($WorldDirectory)) { throw '-WorldDirectory is required for this action.' }
  $db = Join-Path $WorldDirectory 'ComfyEra16.db'
  $fwl = Join-Path $WorldDirectory 'ComfyEra16.fwl'
  if (!(Test-Path -LiteralPath $db) -or !(Test-Path -LiteralPath $fwl)) { throw "Expected ComfyEra16.db/.fwl under $WorldDirectory" }
  return @($db,$fwl)
}
switch ($Action) {
  'Plan' {
    $scenarioDoc = Get-Content -Raw -LiteralPath $Scenario | ConvertFrom-Json
    if ([string]$scenarioDoc.corpusId -ne [string]$CorpusId) { throw "Scenario corpusId '$($scenarioDoc.corpusId)' does not match -CorpusId '$CorpusId'." }
    $root = Join-Path $RunRoot $CorpusId
    if ((Test-Path -LiteralPath $root) -and !$Force) { throw "Run already exists: $root (use -Force to replace metadata only)." }
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'snapshots'),(Join-Path $root 'receipts'),(Join-Path $root 'validation') | Out-Null
    $paths = Save-Paths
    $corpus = [ordered]@{
      schemaVersion='steward-synthetic-history/corpus-v1'; corpusId=$CorpusId
      scenarioFile=(Resolve-Path -LiteralPath $Scenario).Path; scenarioSha256=(Sha256 $Scenario)
      createdUtc=[DateTime]::UtcNow.ToString('o'); baseline=@{worldDirectory=(Resolve-Path $WorldDirectory).Path; dbSha256=(Sha256 $paths[0]); fwlSha256=(Sha256 $paths[1])}
      snapshots=@(0..5 | ForEach-Object { $label = if ($_ -eq 0) { 'baseline' } else { 'interval-'+$_ }; @{index=$_; label=('{0:D2}' -f $_)+'-'+$label; dbSha256=$null; fwlSha256=$null; stewardSnapshotId=$null} })
      intervals=$scenarioDoc.intervals
    }
    Write-Json $corpus (CorpusPath)
    for ($i=1; $i -le 5; $i++) {
      $interval = $scenarioDoc.intervals[$i-1]
      Write-Json ([ordered]@{schema='comfy-quest-lab-history-step/v1'; corpusId=$CorpusId; step=$i; seed=($scenarioDoc.sequenceSeed + $i); expectedPreviousStep=($i-1); interval=$interval; generatedUtc=[DateTime]::UtcNow.ToString('o'); mutationMode='cumulative-plan-only'; note='QuestLab applies the bounded event plan in this file; applied ledger is authoritative.'}) (Join-Path $root ('plans\step-{0:D2}.json' -f $i))
    }
    Write-Json @{action='plan'; completedUtc=[DateTime]::UtcNow.ToString('o'); corpusId=$CorpusId; baseline=$corpus.baseline} (Join-Path $root 'receipts\plan.json')
    Write-Host "Planned $CorpusId under $root"
  }
  'Prepare' {
    Require-Stopped; $paths=Save-Paths; $root=Join-Path $RunRoot $CorpusId; $c=Read-Corpus
    $backup=Join-Path $root 'baseline'; New-Item -ItemType Directory -Force -Path $backup | Out-Null
    Copy-Item -LiteralPath $paths[0] -Destination (Join-Path $backup 'ComfyEra16.db') -Force
    Copy-Item -LiteralPath $paths[1] -Destination (Join-Path $backup 'ComfyEra16.fwl') -Force
    Write-Json @{action='prepare'; completedUtc=[DateTime]::UtcNow.ToString('o'); baselineDbSha256=(Sha256 (Join-Path $backup 'ComfyEra16.db')); baselineFwlSha256=(Sha256 (Join-Path $backup 'ComfyEra16.fwl')); note='Baseline copied; apply QuestLab step plans cumulatively, then RecordSnapshot after each interval.'} (Join-Path $root 'receipts\prepare.json')
  }
  'RecordSnapshot' {
    Require-Stopped; if ($SnapshotIndex -lt 0 -or $SnapshotIndex -gt 5) { throw '-SnapshotIndex must be 0..5.' }
    $paths=Save-Paths; $c=Read-Corpus; $root=Join-Path $RunRoot $CorpusId; $dest=Join-Path $root ('snapshots\snapshot-{0:D2}' -f $SnapshotIndex)
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -LiteralPath $paths[0] -Destination (Join-Path $dest 'ComfyEra16.db') -Force
    Copy-Item -LiteralPath $paths[1] -Destination (Join-Path $dest 'ComfyEra16.fwl') -Force
    $c.snapshots[$SnapshotIndex].dbSha256=Sha256 (Join-Path $dest 'ComfyEra16.db'); $c.snapshots[$SnapshotIndex].fwlSha256=Sha256 (Join-Path $dest 'ComfyEra16.fwl')
    $c | Add-Member -NotePropertyName updatedUtc -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
    Write-Json $c (CorpusPath)
    Write-Json @{action='record'; index=$SnapshotIndex; completedUtc=[DateTime]::UtcNow.ToString('o'); dbSha256=$c.snapshots[$SnapshotIndex].dbSha256; fwlSha256=$c.snapshots[$SnapshotIndex].fwlSha256} (Join-Path $root ('receipts\snapshot-{0:D2}.json' -f $SnapshotIndex))
  }
  'ApplyStep' {
    if ($Step -lt 1 -or $Step -gt 5) { throw '-Step must be 1..5.' }
    $root=Join-Path $RunRoot $CorpusId; $plan=Join-Path $root ('plans\step-{0:D2}.json' -f $Step)
    if (!(Test-Path -LiteralPath $plan)) { throw "Missing step plan: $plan (run Plan first)." }
    if ([string]::IsNullOrWhiteSpace($MailboxPath)) { throw '-MailboxPath must point to QuestLab requests/questlab-batch-request.json.' }
    $doc=Get-Content -Raw -LiteralPath $plan | ConvertFrom-Json
    $now=[DateTime]::UtcNow; $request=[ordered]@{schema='comfy-questlab-batch-request/v1'; request_id=('history-'+$CorpusId+'-'+$Step+'-'+[guid]::NewGuid().ToString('N')); operation='history_step'; corpus=$CorpusId; step=$Step; seed=[int]$doc.seed; expected_previous_step=[int]$doc.expectedPreviousStep; created_utc=$now.ToString('o'); expires_utc=$now.AddMinutes(10).ToString('o')}
    Write-Json $request $MailboxPath
    Write-Json @{action='apply-step'; step=$Step; requestId=$request.request_id; mailbox=$MailboxPath; submittedUtc=$now.ToString('o')} (Join-Path $root ('receipts\apply-step-{0:D2}.json' -f $Step))
    Write-Host "Submitted QuestLab history step $Step; wait for its request receipt before saving."
  }
  'Ingest' {
    $c=Read-Corpus; $root=Join-Path $RunRoot $CorpusId; if (!(Test-Path -LiteralPath $Jar)) { throw "Missing jar: $Jar" }
    $cache=Join-Path $root 'steward-cache'; $first=Join-Path $root 'snapshots\snapshot-00\ComfyEra16.db'
    $args=@('-jar',$Jar,'--rebuild-cache','--batch-only','--cache',$cache,'--world-id',$CorpusId,'--world-name','Synthetic validation corpus','--source','synthetic-history','--backup-id','snapshot-00',$first)
    & java @args | Tee-Object -FilePath (Join-Path $root 'receipts\ingest-00.log')
    $listed=Invoke-RestMethod ($StewardBaseUrl.TrimEnd('/')+'/api/v1/db/snapshots?worldId='+$CorpusId)
    $firstRow=@($listed.snapshots | Where-Object { $_.backupId -eq 'snapshot-00' -or $_.backup_id -eq 'snapshot-00' } | Select-Object -First 1)
    if ($firstRow.Count -ne 1) {
      # The CLI rebuild above wrote <root>\steward-cache, but the server at $StewardBaseUrl serves
      # a different cache file — snapshots 01-05 would append to the wrong baseline. Fail loudly.
      throw ("snapshot-00 not visible at $StewardBaseUrl after the CLI build. Start the Steward " +
             "server against this corpus cache first: java -jar $Jar <any.db> --cache $cache --no-browser")
    }
    $firstId = $firstRow[0].snapshotId
    if ($null -eq $firstId) { $firstId = $firstRow[0].snapshot_id }
    $c.snapshots[0].stewardSnapshotId = [int64]$firstId
    for ($i=1;$i -le 5;$i++) {
      $db=Join-Path $root ('snapshots\snapshot-{0:D2}\ComfyEra16.db' -f $i); if (!(Test-Path $db)) { throw "Missing snapshot $i; record it first." }
      # Reuse the hash captured at record time; the server recomputes and verifies its own copy,
      # so re-hashing the 1.3 GB file here was pure duplication.
      $knownHash = [string]$c.snapshots[$i].dbSha256
      if (-not $knownHash) { $knownHash = Sha256 $db }
      $body=@{worldId=$CorpusId; worldName='Synthetic validation corpus'; source='synthetic-history'; backupId=('snapshot-{0:D2}' -f $i); filePath=(Resolve-Path $db).Path; fileHash=$knownHash} | ConvertTo-Json
      $r=Invoke-RestMethod -Method Post -Uri ($StewardBaseUrl.TrimEnd('/')+'/api/v1/db/snapshots/ingest') -ContentType 'application/json' -Body $body
      $c.snapshots[$i].stewardSnapshotId=$r.snapshotId; Write-Json $r (Join-Path $root ('receipts\ingest-{0:D2}.json' -f $i))
    }
    Write-Json $c (CorpusPath)
  }
  'Validate' {
    $c=Read-Corpus; $root=Join-Path $RunRoot $CorpusId; $out=@()
    for ($i=1;$i -le 5;$i++) {
      $from=$c.snapshots[$i-1].stewardSnapshotId; $to=$c.snapshots[$i].stewardSnapshotId
      if ($null -eq $from -or $null -eq $to) { throw "Missing Steward IDs; run Ingest first." }
      $cmp=Invoke-RestMethod ($StewardBaseUrl.TrimEnd('/')+"/api/v1/db/snapshots/compare?from=$from&to=$to&worldId=$CorpusId")
      $man=Invoke-RestMethod ($StewardBaseUrl.TrimEnd('/')+"/api/v1/rendered/delta/manifest?from=$from&to=$to")
      $row=@{interval=$i; from=$from; to=$to; compare=$cmp; manifest=$man; checkedUtc=[DateTime]::UtcNow.ToString('o')}
      $out += $row; Write-Json $row (Join-Path $root ('validation\interval-{0:D2}.json' -f $i))
    }
    Write-Json @{schemaVersion='steward-synthetic-history/observation-summary-v1'; corpusId=$CorpusId; intervals=$out; status='observed'} (Join-Path $root 'validation\summary.json')
  }
  'Restore' {
    Require-Stopped; $paths=Save-Paths; $root=Join-Path $RunRoot $CorpusId; $backup=Join-Path $root 'baseline'
    if (!(Test-Path (Join-Path $backup 'ComfyEra16.db'))) { throw 'No baseline backup found.' }
    Copy-Item (Join-Path $backup 'ComfyEra16.db') $paths[0] -Force; Copy-Item (Join-Path $backup 'ComfyEra16.fwl') $paths[1] -Force
    Write-Json @{action='restore'; completedUtc=[DateTime]::UtcNow.ToString('o'); dbSha256=(Sha256 $paths[0]); fwlSha256=(Sha256 $paths[1])} (Join-Path $root 'receipts\restore.json')
  }
}
