[CmdletBinding()]
param(
  [string]$Container = 'comfy-valheim-lab-valheim-server-1',
  [string]$WorldDirectory = 'C:\work\baseline\fieldlab\autonomous\state\server\config\worlds_local',
  [string]$ServerConfigRoot = 'C:\work\baseline\fieldlab\autonomous\state\server\config',
  [string]$ServerDataRoot = 'C:\work\baseline\fieldlab\autonomous\state\server\data',
  [string]$QuestLabDll = 'C:\work\baseline\network\mod\ComfyQuestLab\bin\Release\ComfyQuestLab.dll',
  [string]$RunRoot = 'D:\steward-synthetic-history-v1',
  [string]$SourceCorpus = '',
  [int]$FirstPendingStep = 1
)
$ErrorActionPreference = 'Stop'
$corpusId='steward-synthetic-history-v1'
$corpus=Join-Path $RunRoot $corpusId
if ([string]::IsNullOrWhiteSpace($SourceCorpus)) { $SourceCorpus = $corpus }
$worldDb=Join-Path $WorldDirectory 'ComfyEra16.db'
$worldFwl=Join-Path $WorldDirectory 'ComfyEra16.fwl'
$mail=Join-Path $ServerDataRoot 'bepinex\BepInEx\config\comfy-quest-lab\requests\questlab-batch-request.json'
$requestReceipts=Join-Path $ServerDataRoot 'bepinex\BepInEx\config\comfy-quest-lab\receipts\requests'
$historyRoot=Join-Path $ServerDataRoot ('bepinex\BepInEx\config\comfy-quest-lab\history\'+$corpusId)

function WriteJson($value,[string]$path) {
  New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
  $value | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $path -Encoding utf8
}
function Hash([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function ServiceState {
  $line=& docker exec $Container supervisorctl status valheim-server 2>$null
  if ($line -match '\s(RUNNING|STOPPED|EXITED|STARTING|STOPPING|FATAL)\s') { return $Matches[1] }
  return 'UNKNOWN'
}
function WaitState([string]$wanted,[int]$seconds) {
  $deadline=[DateTime]::UtcNow.AddSeconds($seconds)
  do { $state=ServiceState; if($state -eq $wanted){return}; Start-Sleep -Seconds 2 } while([DateTime]::UtcNow -lt $deadline)
  throw "valheim-server did not reach $wanted; last state $state"
}
function StopServer {
  if((ServiceState) -eq 'RUNNING'){ & docker exec $Container supervisorctl stop valheim-server | Out-Null }
  WaitState 'STOPPED' 150
  $first=Get-Item $worldDb; Start-Sleep -Seconds 4; $second=Get-Item $worldDb
  if($first.Length -ne $second.Length -or $first.LastWriteTimeUtc -ne $second.LastWriteTimeUtc){throw 'world save did not stabilize'}
}
function StartServer { & docker exec $Container supervisorctl start valheim-server | Out-Null; WaitState 'RUNNING' 180 }
function Capture([int]$index) {
  $dest=Join-Path $corpus ('snapshots\snapshot-{0:D2}' -f $index)
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item -LiteralPath $worldDb -Destination (Join-Path $dest 'ComfyEra16.db') -Force
  Copy-Item -LiteralPath $worldFwl -Destination (Join-Path $dest 'ComfyEra16.fwl') -Force
  $doc=Get-Content -Raw (Join-Path $corpus 'corpus.json')|ConvertFrom-Json
  $doc.snapshots[$index].dbSha256=Hash (Join-Path $dest 'ComfyEra16.db')
  $doc.snapshots[$index].fwlSha256=Hash (Join-Path $dest 'ComfyEra16.fwl')
  WriteJson $doc (Join-Path $corpus 'corpus.json')
  if($index -gt 0 -and $doc.snapshots[$index-1].dbSha256 -eq $doc.snapshots[$index].dbSha256){throw "snapshot $index did not change"}
}
function QueueStep([int]$step) {
  $plan=Get-Content -Raw (Join-Path $corpus ('plans\step-{0:D2}.json' -f $step))|ConvertFrom-Json
  $now=[DateTime]::UtcNow; $id='history-'+$corpusId+'-'+$step+'-'+[guid]::NewGuid().ToString('N')
  WriteJson ([ordered]@{schema='comfy-questlab-batch-request/v1';request_id=$id;operation='history_step';corpus=$corpusId;step=$step;seed=[int]$plan.seed;expected_previous_step=$step-1;created_utc=$now.ToString('o');expires_utc=$now.AddMinutes(10).ToString('o')}) $mail
  return $id
}
function WaitReceipt([string]$id,[int]$seconds) {
  $path=Join-Path $requestReceipts ($id+'.json'); $deadline=[DateTime]::UtcNow.AddSeconds($seconds)
  do { if(Test-Path $path){$r=Get-Content -Raw $path|ConvertFrom-Json; if($r.state -ne 'completed'){throw "request $id $($r.state): $($r.detail)"}; return $r}; Start-Sleep -Seconds 2 } while([DateTime]::UtcNow -lt $deadline)
  throw "request receipt timed out: $id"
}

New-Item -ItemType Directory -Force -Path $corpus | Out-Null
$sourceCorpusResolved=(Resolve-Path -LiteralPath $SourceCorpus -ErrorAction Stop).Path
$corpusResolved=(Resolve-Path -LiteralPath $corpus -ErrorAction Stop).Path
if ($sourceCorpusResolved -ne $corpusResolved) {
  Copy-Item -LiteralPath (Join-Path $sourceCorpusResolved 'corpus.json') -Destination (Join-Path $corpusResolved 'corpus.json') -Force
  Copy-Item -LiteralPath (Join-Path $sourceCorpusResolved 'plans') -Destination $corpusResolved -Recurse -Force
}
if(!(Test-Path (Join-Path $corpus 'snapshots\snapshot-00\ComfyEra16.db'))){
  New-Item -ItemType Directory -Force -Path (Join-Path $corpus 'snapshots\snapshot-00') | Out-Null
  Copy-Item (Join-Path $sourceCorpusResolved 'snapshots\snapshot-00\ComfyEra16.db') (Join-Path $corpus 'snapshots\snapshot-00\ComfyEra16.db')
  Copy-Item (Join-Path $sourceCorpusResolved 'snapshots\snapshot-00\ComfyEra16.fwl') (Join-Path $corpus 'snapshots\snapshot-00\ComfyEra16.fwl')
}
$doc=Get-Content -Raw (Join-Path $corpus 'corpus.json')|ConvertFrom-Json
$doc.snapshots[0].dbSha256=Hash (Join-Path $corpus 'snapshots\snapshot-00\ComfyEra16.db')
$doc.snapshots[0].fwlSha256=Hash (Join-Path $corpus 'snapshots\snapshot-00\ComfyEra16.fwl')
WriteJson $doc (Join-Path $corpus 'corpus.json')

StopServer
New-Item -ItemType Directory -Force -Path (Join-Path $ServerConfigRoot 'bepinex\plugins') | Out-Null
Copy-Item $QuestLabDll (Join-Path $ServerConfigRoot 'bepinex\plugins\ComfyQuestLab.dll') -Force
Copy-Item $QuestLabDll (Join-Path $ServerDataRoot 'bepinex\BepInEx\plugins\ComfyQuestLab.dll') -Force

for($step=$FirstPendingStep;$step -le 5;$step++){
  $id=QueueStep $step
  StartServer
  WaitReceipt $id 300 | Out-Null
  StopServer
  Capture $step
  $truth=Join-Path $corpus 'ground-truth'
  New-Item -ItemType Directory -Force -Path $truth | Out-Null
  Copy-Item (Join-Path $historyRoot ('receipts\step-{0:D2}.json' -f $step)) $truth -Force
  Copy-Item (Join-Path $historyRoot ('ledgers\step-{0:D2}.jsonl' -f $step)) $truth -Force
}
if(Test-Path (Join-Path $historyRoot 'receipts\step-01.json')){
  $truth=Join-Path $corpus 'ground-truth'; New-Item -ItemType Directory -Force -Path $truth | Out-Null
  Copy-Item (Join-Path $historyRoot 'receipts\step-01.json') $truth -Force
  Copy-Item (Join-Path $historyRoot 'ledgers\step-01.jsonl') $truth -Force
}
StartServer
# Distinctness check reuses the hashes recorded at capture time (each file was already
# hashed once when frozen); re-reading 6 x 1.33 GB here was pure duplication.
$hashes=@((Get-Content (Join-Path $corpus 'corpus.json') -Raw | ConvertFrom-Json).snapshots | ForEach-Object { [string]$_.dbSha256 })
if($hashes.Count -ne 6 -or ($hashes|Select-Object -Unique).Count -ne 6){throw 'final corpus does not contain six distinct DB hashes'}
WriteJson @{schemaVersion='steward-synthetic-history/docker-replay-v1';corpusId=$corpusId;completedUtc=[DateTime]::UtcNow.ToString('o');container=$Container;snapshotHashes=$hashes;status='complete'} (Join-Path $corpus 'receipts\docker-replay.json')
Write-Host "Docker replay complete: $corpus"
