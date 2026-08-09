param(
    [string]$WorldDb,
    [int]$Port = 7080,
    [switch]$NoBrowser,
    # Point at the artifacts the publish lane produces, so local runs see the real snapshot
    # history, deltas and rendered rasters instead of an empty cache next to the jar.
    [string]$Cache     = "$env:LOCALAPPDATA\steward-publish\out\world-cache.duckdb",
    [string]$RenderDir = "$env:LOCALAPPDATA\steward-publish\out\rendered",
    # Serve the UI straight from the working copy. Editing index.html then refreshing the
    # browser is the whole loop - no rebuild, no restart. Defaults to the repo's static dir.
    [string]$StaticDir = '',
    # The jar only needs rebuilding when Java changes; skip it when iterating on the UI.
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Fail([string]$Message) {
    Write-Host ""
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

function Get-RepoRoot {
    $PSScriptRoot
}

function Get-JavaCommand {
    $cmd = Get-Command java -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }

    if ($env:JAVA_HOME) {
        $javaFromHome = Join-Path $env:JAVA_HOME 'bin\java.exe'
        if (Test-Path $javaFromHome) {
            return $javaFromHome
        }
    }

    # The repo vendors its own JDK under .tools, the same one tools\Publish-Steward.ps1 defaults
    # to. This machine has no Java on PATH and no JAVA_HOME, so without this the launcher fails
    # on a box where the publish lane runs fine.
    $vendored = Join-Path (Get-RepoRoot) '.tools\jdk-17.0.19+10\bin\java.exe'
    if (Test-Path $vendored) {
        return $vendored
    }

    return $null
}

function Test-Java17OrNewer([string]$JavaExe) {
    $versionOutput = cmd /c "`"$JavaExe`" -version 2>&1"
    $joined = ($versionOutput | Out-String)
    if ($joined -match 'version "(\d+)') {
        return [int]$matches[1] -ge 17
    }
    return $false
}

function Get-MavenCommand([string]$RepoRoot) {
    $mvn = Get-Command mvn -ErrorAction SilentlyContinue
    if ($mvn) {
        return $mvn.Source
    }

    $toolsDir = Join-Path $RepoRoot '.tools'
    $mavenVersion = '3.9.6'
    $mavenHome = Join-Path $toolsDir ("apache-maven-" + $mavenVersion)
    $mavenCmd = Join-Path $mavenHome 'bin\mvn.cmd'
    if (Test-Path $mavenCmd) {
        return $mavenCmd
    }

    Write-Step "Maven not found. Downloading a local copy for this repo"
    New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
    $zipPath = Join-Path $toolsDir ("apache-maven-" + $mavenVersion + "-bin.zip")
    $downloadUrl = "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/$mavenVersion/apache-maven-$mavenVersion-bin.zip"
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath
    Expand-Archive -Path $zipPath -DestinationPath $toolsDir -Force
    Remove-Item $zipPath -Force

    if (!(Test-Path $mavenCmd)) {
        Fail "Downloaded Maven, but could not find $mavenCmd"
    }
    return $mavenCmd
}

# Remembering the last save keeps this a one-command loop. Prompting on every run is fine when
# you launch the viewer occasionally; it is friction when you are restarting it to pick up a
# Java change while iterating.
function Get-LastWorldDbPath {
    Join-Path $env:LOCALAPPDATA 'steward-publish\last-world.txt'
}

function Resolve-WorldDb([string]$InitialValue) {
    $value = $InitialValue
    $memo  = Get-LastWorldDbPath

    if ([string]::IsNullOrWhiteSpace($value) -and (Test-Path -LiteralPath $memo)) {
        $remembered = (Get-Content -LiteralPath $memo -Raw).Trim()
        if (![string]::IsNullOrWhiteSpace($remembered) -and (Test-Path -LiteralPath $remembered)) {
            Write-Host "Using the last world: $remembered" -ForegroundColor DarkGray
            Write-Host "  (pass -WorldDb to change it)" -ForegroundColor DarkGray
            $value = $remembered
        }
    }

    while ([string]::IsNullOrWhiteSpace($value) -or !(Test-Path -LiteralPath $value)) {
        if (![string]::IsNullOrWhiteSpace($value)) {
            Write-Host "File not found: $value" -ForegroundColor Yellow
        }
        $value = Read-Host "Enter the full path to the Valheim world .db file"
    }

    $resolved = (Resolve-Path -LiteralPath $value).Path
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $memo) | Out-Null
    Set-Content -LiteralPath $memo -Value $resolved -Encoding utf8
    return $resolved
}

function Ensure-LocalValheimSaveTools([string]$MavenCmd, [string]$RepoRoot) {
    $artifactDir = Join-Path $env:USERPROFILE '.m2\repository\net\kakoen\valheim\valheim-save-tools\1.0-fixed'
    $artifactJar = Join-Path $artifactDir 'valheim-save-tools-1.0-fixed.jar'
    if (Test-Path $artifactJar) {
        return
    }

    $sourceJar = Join-Path $RepoRoot 'valheim-save-tools-fixed.jar'
    if (!(Test-Path $sourceJar)) {
        Fail "Missing required local dependency jar: $sourceJar"
    }

    Write-Step "Installing the bundled Valheim save tools jar into the local Maven cache"
    & $MavenCmd install:install-file `
        "-Dfile=$sourceJar" `
        "-DgroupId=net.kakoen.valheim" `
        "-DartifactId=valheim-save-tools" `
        "-Dversion=1.0-fixed" `
        "-Dpackaging=jar"

    if ($LASTEXITCODE -ne 0) {
        Fail "Failed to install the bundled Valheim save tools jar into the local Maven cache."
    }
}

function Stop-ExistingPortProcess([int]$PortNumber) {
    $existing = Get-NetTCPConnection -LocalPort $PortNumber -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty OwningProcess
    if ($existing) {
        Write-Step "Stopping the existing viewer on port $PortNumber"
        Stop-Process -Id $existing -Force
        Start-Sleep -Seconds 1
    }
}

function Wait-ForViewer([int]$PortNumber, [int]$TimeoutSeconds) {
    $base = "http://localhost:$PortNumber/api/v1/status"
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Seconds 2
        try {
            $status = (Invoke-WebRequest -Uri $base -UseBasicParsing -TimeoutSec 3).Content | ConvertFrom-Json
            if ($status.done -eq $true) {
                return $true
            }
        } catch {
        }
    } while ((Get-Date) -lt $deadline)
    return $false
}

$repoRoot = Get-RepoRoot
$viewerDir = Join-Path $repoRoot 'viewer'
$logsDir = Join-Path $viewerDir 'logs'
$targetJar = Join-Path $viewerDir 'target\world-viewer-1.0.0.jar'

Write-Host "ComfyStewardView launcher" -ForegroundColor Green
Write-Host "This script builds the app, starts it, waits for it to finish loading, and opens the browser."

$javaExe = Get-JavaCommand
if (!$javaExe) {
    Fail "Java was not found. Install Java 17 or newer, then run this script again."
}
if (!(Test-Java17OrNewer $javaExe)) {
    Fail "Java 17 or newer is required. The Java found on this machine is too old."
}

$mvnCmd = Get-MavenCommand $repoRoot
$resolvedDb = Resolve-WorldDb $WorldDb
Ensure-LocalValheimSaveTools -MavenCmd $mvnCmd -RepoRoot $repoRoot

if ($SkipBuild) {
    Write-Step "Skipping the build (-SkipBuild)"
} else {
    Write-Step "Building the viewer jar"
    & $mvnCmd -f (Join-Path $viewerDir 'pom.xml') package -DskipTests
    if ($LASTEXITCODE -ne 0) {
        Fail "Build failed. Scroll up to the Maven error output."
    }
}

if (!(Test-Path $targetJar)) {
    Fail "The runnable jar was not found at $targetJar. Run without -SkipBuild to build it."
}

New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
Stop-ExistingPortProcess $Port

$stdoutLog = Join-Path $logsDir 'run.log'
$stderrLog = Join-Path $logsDir 'run.err'

if (-not $StaticDir) {
    $StaticDir = Join-Path $repoRoot 'viewer\src\main\resources\static'
}

# The cache is what carries snapshot history, the Changes comparisons and the delta rasters.
# Warn rather than fail without it: the endpoints served from the boot parse still work, so a
# run against a bare save is useful, just not for anything snapshot-scoped.
if (!(Test-Path $Cache)) {
    Write-Host "WARNING: no analytics cache at $Cache - History and Changes will be empty." -ForegroundColor Yellow
    Write-Host "         Run tools\Publish-Steward.ps1 (without -Push) to produce one." -ForegroundColor Yellow
}

Write-Step "Starting the viewer"
Write-Host "  cache:  $Cache"
Write-Host "  render: $RenderDir"
Write-Host "  ui:     $StaticDir  (edit + refresh; no restart needed)"

$arguments = @(
    '-Xmx3g',
    '-jar',
    $targetJar,
    $resolvedDb,
    '--cache',
    $Cache,
    '--render-dir',
    $RenderDir,
    '--static-dir',
    $StaticDir,
    '--port',
    $Port,
    '--no-browser'
)

Start-Process -FilePath $javaExe `
    -ArgumentList $arguments `
    -WorkingDirectory $viewerDir `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -WindowStyle Hidden

Write-Step "Waiting for the viewer to finish loading"
if (!(Wait-ForViewer -PortNumber $Port -TimeoutSeconds 300)) {
    Write-Host ""
    Write-Host "The viewer did not become ready within 5 minutes." -ForegroundColor Red
    Write-Host "Check these log files for details:" -ForegroundColor Yellow
    Write-Host "  $stdoutLog"
    Write-Host "  $stderrLog"
    exit 1
}

$url = "http://localhost:$Port/"
Write-Host ""
Write-Host "Viewer is ready: $url" -ForegroundColor Green
Write-Host "Log files:" -ForegroundColor Green
Write-Host "  $stdoutLog"
Write-Host "  $stderrLog"

if (!$NoBrowser) {
    Start-Process $url
}
