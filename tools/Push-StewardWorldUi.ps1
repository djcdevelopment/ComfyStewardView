<#
.SYNOPSIS
  Push the /world/ UI to AM4 without re-transferring the era bundle or rebuilding the image.

.DESCRIPTION
  The world view serves lab.css, lab.js and index.html from /ui when files are present there
  (LabMain --static-dir, wired by deploy_world.py), falling back to the copy baked into the jar.
  That makes a UI change a ~200 KB file copy instead of the code lane: tar and transfer ~640 MB of
  era bundle, verify every catalog file by hash on AM4, rebuild the image, smoke-test a candidate
  on 7083, then replace the container on 7081 and re-open the port behind a full startup.

  Deliberately NOT a switch on deploy_world.py. That script replaces the release; this one moves a
  handful of files into the release that is already running and restarts nothing. Two operations
  with blast radii three orders of magnitude apart should not share an entry point you pick under
  time pressure.

  The override directory is created empty by each deploy and lives inside the release directory, so
  a push cannot outlive the code it was tuned against. This script asks the running container where
  that directory is rather than guessing, stages the transfer and renames each file into place so a
  half-copied file is never served, removes overrides whose source file no longer exists, and
  verifies the result by comparing local hashes against what the running server actually returns.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\Push-StewardWorldUi.ps1
#>
[CmdletBinding()]
param(
    [string]$SshTarget  = 'am4',
    [int]   $Port       = 7081,
    [string]$Container  = 'steward-world',
    # Where deploy_world.py mounts the override directory inside the container.
    [string]$MountPoint = '/ui',
    [string]$PublicUrl  = 'https://am4.tail8e749c.ts.net/world/',
    # Skip the public funnel check (it is the only step that leaves the tailnet).
    [switch]$SkipPublicCheck
)

$ErrorActionPreference = 'Stop'
$repoRoot  = Split-Path -Parent $PSScriptRoot
$staticSrc = Join-Path $repoRoot 'lab\src\main\resources\static'
$startedAt = (Get-Date).ToUniversalTime().ToString('o')

# A truncated editor write is the one failure this script could otherwise publish silently. These
# are the three files the world view cannot render without; the real ones are 22 KB, 37 KB and
# 133 KB, so the floors catch a truncation without tripping on ordinary editing.
$floors = @{ 'index.html' = 8KB; 'lab.css' = 8KB; 'lab.js' = 40KB }

# Remote paths and file names are interpolated into a POSIX shell command, so they are held to a
# character set that cannot word-split, glob or escape a directory.
$safeRelative = '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$'
$safeRemote   = '^/home/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'

function Invoke-Ssh {
    param([string]$Command, [switch]$AllowFailure)
    $out = ssh -o BatchMode=yes -o ConnectTimeout=10 $SshTarget $Command
    if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) {
        throw "ssh command failed (exit $LASTEXITCODE): $Command"
    }
    return $out
}

# --- 1. Sanity ------------------------------------------------------------
Write-Host '[1/5] Checking local UI files...'
if (-not (Test-Path -LiteralPath $staticSrc)) { throw "Lab static directory not found at $staticSrc" }
$staticRoot = (Get-Item -LiteralPath $staticSrc).FullName

$files = @()
foreach ($item in Get-ChildItem -LiteralPath $staticRoot -Recurse -File) {
    $relative = $item.FullName.Substring($staticRoot.Length + 1).Replace('\', '/')
    if ($relative -notmatch $safeRelative) {
        throw "Refusing to push '$relative' - only [A-Za-z0-9._-] path segments are supported"
    }
    if ($item.Length -eq 0) { throw "$relative is empty - refusing to push a zero-byte file" }
    $floor = $floors[$item.Name]
    if ($floor -and $item.Length -lt $floor) {
        $kb = [math]::Round($item.Length / 1KB, 1)
        throw "$relative is only ${kb} KB - refusing to push what looks like a truncated write"
    }
    $directory = [IO.Path]::GetDirectoryName($relative)
    if ($null -eq $directory) { $directory = '' }
    $files += [pscustomobject]@{
        Relative  = $relative
        Directory = $directory.Replace('\', '/')
        FullName  = $item.FullName
        Bytes     = $item.Length
        Sha256    = (Get-FileHash -Algorithm SHA256 -LiteralPath $item.FullName).Hash.ToLower()
    }
}
if ($files.Count -eq 0) { throw "No files under $staticRoot" }
$totalKB = [math]::Round((($files | Measure-Object -Property Bytes -Sum).Sum) / 1KB, 1)
Write-Host "      $($files.Count) file(s), ${totalKB} KB total"

# --- 2. Find the override directory the container is actually reading -----
# Asking the container beats guessing: deploy_world.py puts the override inside the release
# directory, so the path changes with every release and only the container knows the current one.
Write-Host "[2/5] Locating the UI override mount on ${SshTarget}..."
$format = '{{if .State.Running}}running{{else}}stopped{{end}} {{range .Mounts}}{{.Destination}}={{.Source}} {{end}}'
$inspect = ([string](Invoke-Ssh "docker inspect -f '$format' $Container")).Trim()
$fields = $inspect -split '\s+'
if ($fields[0] -ne 'running') { throw "$Container is not running on $SshTarget (state: $($fields[0]))" }
$overrideDir = ''
foreach ($field in $fields) {
    if ($field.StartsWith($MountPoint + '=')) { $overrideDir = $field.Substring($MountPoint.Length + 1) }
}
if (-not $overrideDir) {
    throw "$Container has no $MountPoint mount, so it cannot read a pushed UI. Check that the container runs with --static-dir (tools/era-archive/deploy_world.py) - it needs one deploy to pick that up."
}
if ($overrideDir -notmatch $safeRemote) { throw "Unexpected override directory: $overrideDir" }
$stageDir = $overrideDir + '.push'
Write-Host "      $overrideDir"

# --- 3. Upload to a staging directory beside the override -----------------
# Staged as a sibling so it is on the same filesystem, which is what makes the rename in step 4
# atomic. A reader never sees a partially written file.
Write-Host '[3/5] Uploading...'
$subdirectories = @($files | ForEach-Object { $_.Directory } | Where-Object { $_ } | Sort-Object -Unique)
$makeDirs = @("$stageDir/static")
foreach ($subdirectory in $subdirectories) { $makeDirs += "$stageDir/static/$subdirectory" }
$prepare = "rm -rf $stageDir; mkdir -p $overrideDir " + ($makeDirs -join ' ') + '; echo stage-ok'
$prepared = Invoke-Ssh $prepare
if ("$prepared" -notmatch 'stage-ok') { throw "Could not prepare the staging directory: $prepared" }

foreach ($group in ($files | Group-Object -Property Directory)) {
    $remoteDir = "$stageDir/static"
    if ($group.Name) { $remoteDir = "$stageDir/static/$($group.Name)" }
    $sources = @($group.Group | ForEach-Object { $_.FullName })
    scp -q -o BatchMode=yes -o ConnectTimeout=10 @sources "${SshTarget}:$remoteDir/"
    if ($LASTEXITCODE -ne 0) { throw "scp into $remoteDir failed (exit $LASTEXITCODE)" }
}

# --- 4. Install into the override (container keeps running) ---------------
# Rename each file into place, then drop overrides whose source file is gone. Pushing before
# pruning means no file is ever missing from the override mid-push; the only cost is that an
# orphan survives a few hundred milliseconds longer, and an orphan just resolves to the jar copy.
Write-Host '[4/5] Installing into the override (no restart)...'
$installTemplate = @(
    'set -eu; '
    'cd {0}; '
    'find . -type f -print > {1}/manifest; '
    'find . -type f | while read -r f; do mkdir -p {2}/$(dirname $f); mv $f {2}/$f; done; '
    'cd {2}; '
    'find . -type f | while read -r f; do grep -qxF $f {1}/manifest || rm -f $f; done; '
    'find . -mindepth 1 -type d -empty -delete; '
    'rm -rf {1}; '
    'echo world-ui-ok'
) -join ''
$install = $installTemplate -f "$stageDir/static", $stageDir, $overrideDir
$installed = Invoke-Ssh $install
if ("$installed" -notmatch 'world-ui-ok') { throw "UI install failed: $installed" }

# --- 5. Verify what the server actually serves ----------------------------
# Proving it rather than assuming it: if this ever fails, the no-restart premise is wrong and that
# is worth knowing immediately. Do not "fix" a failure here by redeploying - avoiding the 640 MB
# lane is the entire reason this script exists.
Write-Host '[5/5] Verifying served bytes...'
$paths = @($files | ForEach-Object { $_.Relative })
$verifyTemplate = @(
    'for p in {0}; do printf {1} $p; curl -fsS -m 15 http://127.0.0.1:{2}/$p | sha256sum | cut -d{3} -f1; done; '
    'printf {1} ROOT; curl -fsS -m 15 http://127.0.0.1:{2}/ | sha256sum | cut -d{3} -f1'
) -join ''
$verify = $verifyTemplate -f ($paths -join ' '), "'%s '", $Port, "' '"
$servedLines = @(Invoke-Ssh $verify)

$served = @{}
foreach ($line in $servedLines) {
    $parts = ([string]$line).Trim() -split '\s+'
    if ($parts.Count -eq 2) { $served[$parts[0]] = $parts[1].ToLower() }
}
$indexHash = ($files | Where-Object { $_.Relative -eq 'index.html' } | Select-Object -First 1).Sha256
$mismatched = @()
foreach ($file in $files) {
    if ($served[$file.Relative] -ne $file.Sha256) {
        $mismatched += $file.Relative
        Write-Host "      $($file.Relative): local $($file.Sha256.Substring(0,12))... served $($served[$file.Relative])"
    }
}
if ($indexHash -and $served['ROOT'] -ne $indexHash) {
    $mismatched += '/'
    Write-Host "      /: local $($indexHash.Substring(0,12))... served $($served['ROOT'])"
}
if ($mismatched.Count -gt 0) {
    throw "the server is not serving the pushed files ($($mismatched -join ', ')). Check that the container runs with --static-dir (tools/era-archive/deploy_world.py) - it needs one deploy to pick that up."
}
Write-Host "      all $($files.Count) file(s) and / match"

$release = ''
$health = Invoke-Ssh "curl -fsS -m 10 http://127.0.0.1:$Port/api/health" -AllowFailure
try { $release = ("$health" | ConvertFrom-Json).release } catch { }

$publicOk = $null
if (-not $SkipPublicCheck) {
    try {
        $response = Invoke-WebRequest -Uri $PublicUrl -UseBasicParsing -TimeoutSec 20
        $publicOk = ($response.StatusCode -eq 200)
        Write-Host "      public URL $PublicUrl -> $($response.StatusCode)"
    } catch {
        $publicOk = $false
        Write-Host "      public URL check failed: $_"
    }
}

$receipt = [ordered]@{
    pushed_at    = $startedAt
    finished_at  = (Get-Date).ToUniversalTime().ToString('o')
    ssh_target   = $SshTarget
    container    = $Container
    release      = $release
    git_sha      = (git -C $repoRoot rev-parse --short HEAD)
    override_dir = $overrideDir
    total_kb     = $totalKB
    files        = @($files | ForEach-Object { [ordered]@{ path = $_.Relative; bytes = $_.Bytes; sha256 = $_.Sha256 } })
    served_match = $true
    public_url   = $PublicUrl
    public_ok    = $publicOk
    restarted    = $false
}
$receiptPath = Join-Path $PSScriptRoot 'push-steward-world-ui-receipt.json'
$receipt | ConvertTo-Json -Depth 5 | Set-Content -Path $receiptPath -Encoding utf8

Write-Host ''
Write-Host 'World UI pushed. No bundle transfer, no image rebuild, no container restart.'
Write-Host "Receipt: $receiptPath"
