<#
.SYNOPSIS
  Push the Steward View UI to AM4 without rebuilding the image or restarting the container.

.DESCRIPTION
  The viewer serves index.html from /data/static when it is present (Main --static-dir, wired by
  entrypoint.sh), falling back to the copy baked into the jar. That makes a UI change a 157 KB file
  copy instead of the code lane: tar, scp, mvn package inside Docker on AM4, image rebuild,
  container restart, and a full re-parse of the 1.3 GB world before the port reopens.

  Deliberately NOT a switch on Deploy-Steward.ps1. That script rebuilds the image and allows itself
  thirty minutes to come back; this one moves one file and restarts nothing. Two operations with
  blast radii three orders of magnitude apart should not share an entry point you pick under time
  pressure.

  The transfer is staged and renamed into place so a half-copied file is never served, and the
  result is verified by comparing the local hash against what the running server actually returns.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\Push-StewardUi.ps1
#>
[CmdletBinding()]
param(
    [string]$SshTarget  = 'am4',
    [int]   $Port       = 7080,
    [string]$RemoteRoot = '/home/derek/steward',
    [string]$PublicUrl  = 'https://am4.tail8e749c.ts.net/steward/',
    # Skip the public funnel check (it is the only step that leaves the tailnet).
    [switch]$SkipPublicCheck
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$indexSrc = Join-Path $repoRoot 'viewer\src\main\resources\static\index.html'
$startedAt = (Get-Date).ToUniversalTime().ToString('o')

function Invoke-Ssh {
    param([string]$Command, [switch]$AllowFailure)
    $out = ssh -o BatchMode=yes $SshTarget $Command
    if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) {
        throw "ssh command failed (exit $LASTEXITCODE): $Command"
    }
    return $out
}

# --- 1. Sanity ------------------------------------------------------------
Write-Host '[1/4] Checking local UI file...'
if (-not (Test-Path $indexSrc)) { throw "index.html not found at $indexSrc" }
$srcInfo = Get-Item $indexSrc
$srcKB   = [math]::Round($srcInfo.Length / 1KB, 1)
# A truncated editor write is the one failure this script could otherwise publish silently.
# The real file is ~157 KB; anything under 50 KB is not a Steward UI.
if ($srcInfo.Length -lt 50KB) {
    throw "index.html is only ${srcKB} KB - refusing to push what looks like a truncated write"
}
$srcHash = (Get-FileHash -Algorithm SHA256 -Path $indexSrc).Hash.ToLower()
Write-Host "      ${srcKB} KB, sha256 $($srcHash.Substring(0,12))..."

# --- 2. Upload ------------------------------------------------------------
Write-Host "[2/4] Uploading to ${SshTarget}..."
Invoke-Ssh "mkdir -p $RemoteRoot/ui" | Out-Null
scp -q $indexSrc "${SshTarget}:$RemoteRoot/ui/index.html"
if ($LASTEXITCODE -ne 0) { throw "scp of index.html failed (exit $LASTEXITCODE)" }

# --- 3. Install into the volume ------------------------------------------
# Same helper-container mechanism the publish lane uses: no sudo, and no assumptions about
# where docker keeps volume data. Copy to .new then mv, so the rename into place is atomic
# and a reader never sees a partial file.
Write-Host '[3/4] Installing into steward-data (container keeps running)...'
$install = @(
    "docker run --rm -v steward_steward-data:/data -v $RemoteRoot/ui:/in:ro alpine sh -c '"
    'set -eu; '
    'mkdir -p /data/static; '
    'cp /in/index.html /data/static/index.html.new; '
    'mv /data/static/index.html.new /data/static/index.html; '
    "echo ui-ok'"
) -join ''
$installResult = Invoke-Ssh $install
if ("$installResult" -notmatch 'ui-ok') { throw "UI install failed: $installResult" }

# --- 4. Verify what the server actually serves ----------------------------
# Proving it rather than assuming it: if this ever fails, the no-restart premise is wrong and
# that is worth knowing immediately. Do not "fix" a failure here by adding a restart - avoiding
# the restart is the entire reason this script exists.
Write-Host '[4/4] Verifying served bytes...'
$servedHash = (Invoke-Ssh "curl -fsS -m 10 http://127.0.0.1:$Port/ | sha256sum | cut -d' ' -f1").Trim().ToLower()
if ($servedHash -ne $srcHash) {
    Write-Host "      local:  $srcHash"
    Write-Host "      served: $servedHash"
    throw "the server is not serving the pushed file. Check that the container runs with --static-dir (entrypoint.sh) - it needs one image rebuild via Deploy-Steward.ps1 to pick that up."
}
Write-Host "      served hash matches ($($servedHash.Substring(0,12))...)"

$publicOk = $null
if (-not $SkipPublicCheck) {
    try {
        $r = Invoke-WebRequest -Uri $PublicUrl -UseBasicParsing -TimeoutSec 20
        $publicOk = ($r.StatusCode -eq 200)
        Write-Host "      public URL $PublicUrl -> $($r.StatusCode)"
    } catch {
        $publicOk = $false
        Write-Host "      public URL check failed: $_"
    }
}

$receipt = [ordered]@{
    pushed_at     = $startedAt
    finished_at   = (Get-Date).ToUniversalTime().ToString('o')
    ssh_target    = $SshTarget
    git_sha       = (git -C $repoRoot rev-parse --short HEAD)
    index_kb      = $srcKB
    sha256        = $srcHash
    served_match  = $true
    public_url    = $PublicUrl
    public_ok     = $publicOk
    restarted     = $false
}
$receiptPath = Join-Path $PSScriptRoot 'push-steward-ui-receipt.json'
$receipt | ConvertTo-Json | Set-Content -Path $receiptPath -Encoding utf8

Write-Host ''
Write-Host "UI pushed. No image rebuild, no container restart, no world re-parse."
Write-Host "Receipt: $receiptPath"
