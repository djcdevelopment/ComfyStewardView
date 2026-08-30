<#
.SYNOPSIS
  Deploy ComfyStewardView to AM4 as the public /steward sample.

.DESCRIPTION
  Push-from-workstation deploy (modeled on baseline's Deploy-NetworkSense.ps1,
  simplified): stages the whitelisted build context to AM4 over SSH, takes a
  static frozen snapshot of the ComfyEra16 world file (mtime-stable copy so a
  live server save cannot tear it), builds and starts the container on AM4,
  waits for readiness, and emits a JSON receipt.

  The tailscale funnel mount is a one-time manual sudo step; the script prints
  the exact command and verifies the public URL if the route already exists.

.PARAMETER RefreshWorld
  Re-snapshot the world file and clear only rebuildable analytics artifacts so
  the next boot rebuilds cache + rendered layers against the new snapshot.
  Imported Quest evidence remains in its dedicated database.

.PARAMETER QuestImportToken
  Optional 64-hex operator secret. An existing remote token is preserved when
  omitted; a new one is generated and shown once only when none exists.
#>
[CmdletBinding()]
param(
    [string]$SshTarget   = 'am4',
    [int]   $Port        = 7080,
    [string]$RemoteRoot  = '/home/derek/steward',
    [string]$WorldSource = '/home/derek/comfy-valheim-lab/server-state/config/worlds_local/ComfyEra16.db',
    [string]$PublicBaseUrl = 'https://am4.tail8e749c.ts.net',
    [string]$PublicPath  = '/steward',
    [string]$QuestImportToken = '',
    [int]   $TimeoutMinutes = 30,
    [switch]$RefreshWorld
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$sourceRevision = "$(git -C $repoRoot rev-parse HEAD 2>$null)".Trim()
if ($LASTEXITCODE -ne 0 -or $sourceRevision -notmatch '^[0-9a-fA-F]{40}$') {
    throw 'could not resolve the full Steward source revision for the image'
}
$dirty = @(git -C $repoRoot status --porcelain --untracked-files=normal)
if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
    throw 'deployment requires a clean Steward checkout so STEWARD_SOURCE_REVISION names the exact image source'
}
$questImportTokenProvided = -not [string]::IsNullOrWhiteSpace($QuestImportToken)
if ($questImportTokenProvided -and $QuestImportToken -notmatch '^[0-9a-fA-F]{64}$') {
    throw '-QuestImportToken must be exactly 64 hexadecimal characters'
}
$generatedQuestImportToken = $false
$questImportTokenRotated = $false

function Invoke-Ssh {
    param([string]$Command, [switch]$AllowFailure)
    $out = ssh -o BatchMode=yes $SshTarget $Command
    if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) {
        throw "ssh command failed (exit $LASTEXITCODE): $Command"
    }
    return $out
}

# --- 1. Preflight ---------------------------------------------------------
Write-Host "[1/7] SSH preflight to '$SshTarget'..."
Invoke-Ssh 'true' | Out-Null
Invoke-Ssh "mkdir -p $RemoteRoot/world" | Out-Null
Invoke-Ssh "umask 077; test -f $RemoteRoot/.env || printf 'STEWARD_WORLD_FILE=/world/ComfyEra16.db\n' > $RemoteRoot/.env; chmod 600 $RemoteRoot/.env" | Out-Null
$existingQuestImportToken = "$(Invoke-Ssh "sed -n 's/^STEWARD_QUEST_IMPORT_TOKEN=//p' $RemoteRoot/.env | tail -n 1")".Trim()
if (-not $questImportTokenProvided) {
    if ($existingQuestImportToken -match '^[0-9a-fA-F]{64}$') {
        $QuestImportToken = $existingQuestImportToken
    } else {
        $tokenBytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($tokenBytes) } finally { $rng.Dispose() }
        $QuestImportToken = ([BitConverter]::ToString($tokenBytes)).Replace('-', '').ToLowerInvariant()
        $generatedQuestImportToken = $true
    }
}
$questImportTokenRotated = -not [string]::Equals(
    $existingQuestImportToken, $QuestImportToken, [StringComparison]::Ordinal)
Invoke-Ssh "umask 077; sed '/^STEWARD_SOURCE_REVISION=/d' $RemoteRoot/.env > $RemoteRoot/.env.new && printf 'STEWARD_SOURCE_REVISION=$sourceRevision\n' >> $RemoteRoot/.env.new && mv $RemoteRoot/.env.new $RemoteRoot/.env && chmod 600 $RemoteRoot/.env" | Out-Null
Invoke-Ssh "umask 077; sed '/^STEWARD_QUEST_IMPORT_TOKEN=/d' $RemoteRoot/.env > $RemoteRoot/.env.new && printf 'STEWARD_QUEST_IMPORT_TOKEN=$QuestImportToken\n' >> $RemoteRoot/.env.new && mv $RemoteRoot/.env.new $RemoteRoot/.env && chmod 600 $RemoteRoot/.env" | Out-Null
if ($generatedQuestImportToken) {
    Write-Warning "Generated a new Quest evidence import token; save it in your password manager: $QuestImportToken"
}

# --- 2. Stage build context ----------------------------------------------
Write-Host '[2/7] Staging build context...'
$contextFiles = @(
    'Dockerfile', 'entrypoint.sh', '.dockerignore', 'docker-compose.am4.yml',
    'valheim-save-tools-fixed.jar',
    'viewer/pom.xml', 'viewer/src',
    'viewer/classification.json', 'viewer/steward-config.json'
)
foreach ($f in $contextFiles) {
    if (-not (Test-Path (Join-Path $repoRoot $f))) { throw "missing context file: $f" }
}
$tgz = Join-Path $env:TEMP 'steward-src.tgz'
Push-Location $repoRoot
try {
    tar -czf $tgz $contextFiles
    if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
} finally { Pop-Location }

scp -o BatchMode=yes $tgz "${SshTarget}:$RemoteRoot/src.tgz"
if ($LASTEXITCODE -ne 0) { throw 'scp failed' }
Invoke-Ssh "rm -rf $RemoteRoot/build && mkdir -p $RemoteRoot/build && tar -xzf $RemoteRoot/src.tgz -C $RemoteRoot/build" | Out-Null

# --- 3. World snapshot (static frozen; mtime-stable copy) -----------------
$worldName = Split-Path -Leaf $WorldSource
$worldDest = "$RemoteRoot/world/$worldName"
$haveSnapshot = (Invoke-Ssh "test -f $worldDest && echo yes || echo no").Trim() -eq 'yes'

if ($haveSnapshot -and -not $RefreshWorld) {
    Write-Host "[3/7] World snapshot already present ($worldDest) - keeping frozen copy."
} else {
    if ($RefreshWorld) {
        Write-Host '[3/7] -RefreshWorld: stopping container and clearing rebuildable cache artifacts...'
        Invoke-Ssh "cd $RemoteRoot/build && docker compose --env-file $RemoteRoot/.env -f docker-compose.am4.yml down" -AllowFailure | Out-Null
        Invoke-Ssh "docker run --rm -v steward_steward-data:/data alpine sh -c 'rm -f /data/world-cache.duckdb /data/world-cache.duckdb.wal /data/.cache-complete; rm -rf /data/rendered'" -AllowFailure | Out-Null
    }
    Write-Host "[3/7] Snapshotting $WorldSource -> $worldDest ..."
    $snapScript = 'set -eu; SRC={0}; DST={1}; for i in 1 2 3; do m1=$(stat -c %Y "$SRC"); cp "$SRC" "$DST.tmp"; m2=$(stat -c %Y "$SRC"); if [ "$m1" = "$m2" ]; then mv "$DST.tmp" "$DST"; echo snapshot-ok; exit 0; fi; echo "source changed mid-copy, retrying"; sleep 5; done; rm -f "$DST.tmp"; echo snapshot-torn; exit 1' -f $WorldSource, $worldDest
    $snapResult = Invoke-Ssh "bash -c '$snapScript'"
    if ($snapResult -notmatch 'snapshot-ok') { throw "world snapshot failed: $snapResult" }
}

# --- 4. Port check --------------------------------------------------------
Write-Host "[4/7] Checking port $Port..."
$ourContainer = (Invoke-Ssh 'docker ps --filter name=comfy-steward-view --format "{{.Names}}"' -AllowFailure)
if ("$ourContainer".Trim() -eq 'comfy-steward-view') {
    Write-Host '      comfy-steward-view already running - redeploy.'
} else {
    $listener = Invoke-Ssh "ss -ltn 'sport = :$Port' | tail -n +2" -AllowFailure
    if ("$listener".Trim()) { throw "port $Port is already in use on $SshTarget by another service:`n$listener" }
}

# --- 5. Build + start -----------------------------------------------------
Write-Host '[5/7] docker compose up -d --build (build runs on AM4)...'
Invoke-Ssh "cd $RemoteRoot/build && docker compose --env-file $RemoteRoot/.env -f docker-compose.am4.yml up -d --build" | Write-Host

# --- 6. Readiness ---------------------------------------------------------
Write-Host "[6/7] Waiting for /api/v1/status done:true (up to $TimeoutMinutes min; first boot parses twice + renders layers)..."
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$ready = $false
while ((Get-Date) -lt $deadline) {
    $status = Invoke-Ssh "curl -fsS -m 5 http://127.0.0.1:$Port/api/v1/status" -AllowFailure
    if ("$status" -match '"done"\s*:\s*true') { $ready = $true; break }
    Start-Sleep -Seconds 20
}
if (-not $ready) {
    Invoke-Ssh 'docker logs --tail 40 comfy-steward-view' -AllowFailure | Write-Host
    throw "viewer not ready within $TimeoutMinutes minutes - container logs above"
}
Write-Host '      Ready.'

# --- 7. Public exposure ---------------------------------------------------
$publicUrl = "$PublicBaseUrl$PublicPath/"
Write-Host '[7/7] Verifying public URL...'
$publicStatus = ''
try {
    $publicStatus = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 "$($publicUrl)api/v1/status").Content
} catch {}
$publicOk = "$publicStatus" -match '"done"\s*:\s*true'
if (-not $publicOk) {
    Write-Host ''
    Write-Host 'Funnel route not live yet. One-time manual step on AM4 (needs sudo, persists):'
    Write-Host "  sudo tailscale funnel --bg --yes --set-path=$PublicPath http://127.0.0.1:$Port"
    Write-Host 'NEVER use "tailscale funnel reset" - it destroys every public route on the host.'
}

# --- Receipt --------------------------------------------------------------
$receipt = [ordered]@{
    deployed_at   = $startedAt
    finished_at   = (Get-Date).ToUniversalTime().ToString('o')
    ssh_target    = $SshTarget
    git_sha       = $sourceRevision
    world_source  = $WorldSource
    world_dest    = $worldDest
    world_refreshed = [bool]$RefreshWorld
    quest_import_token_rotated = $questImportTokenRotated
    port          = $Port
    public_url    = $publicUrl
    public_verified = $publicOk
}
$receiptPath = Join-Path $PSScriptRoot 'deploy-steward-receipt.json'
$receipt | ConvertTo-Json | Out-File -Encoding utf8 $receiptPath
Write-Host ''
Write-Host "Receipt: $receiptPath"
if ($publicOk) { Write-Host "Live: $publicUrl" } else { Write-Host "Local-ready on ${SshTarget}:$Port - add the funnel route, then browse $publicUrl" }
