[CmdletBinding()]
param(
    [ValidateSet('serve', 'render', 'prepare-command')]
    [string]$Command = 'serve',
    [string]$CachePath = '',
    [long]$Snapshot = 0,
    [string]$Lens = 'build-density,birch-trees,all-zdos',
    [string]$Resolutions = '320,64,16',
    [string]$WorldPath = '',
    [string]$ContextImage = '',
    [int]$Port = 8091,
    [switch]$NoBrowser,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$shared = Join-Path (Split-Path $repo -Parent) 'comfystewardview\.tools'
$java = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin\java.exe' } else { Join-Path $shared 'jdk-17.0.19+10\bin\java.exe' }
$jar = Join-Path $repo 'target\steward-spatial-lab-0.1.0-SNAPSHOT.jar'

if (-not $CachePath) {
    $candidate = Join-Path $env:LOCALAPPDATA 'steward-publish\out\world-cache.duckdb'
    $CachePath = if (Test-Path -LiteralPath $candidate) { $candidate } else { Join-Path $repo 'data\world-cache.duckdb' }
}

if ($Command -eq 'prepare-command') {
    if (-not $WorldPath) { throw 'prepare-command requires -WorldPath' }
    $stewardJar = Join-Path (Split-Path $repo -Parent) 'comfystewardview\viewer\target\world-viewer-1.0.0.jar'
    Write-Output ('& "{0}" -Xmx8g -jar "{1}" "{2}" --build-cache --batch-only --cache "{3}" --world-id spatial-lab --world-name "Spatial Lab" --source local-lab --backup-id manual' -f $java, $stewardJar, $WorldPath, $CachePath)
    exit 0
}

if (-not (Test-Path -LiteralPath $java)) { throw "Java 17 not found at $java" }
if (-not (Test-Path -LiteralPath $jar)) {
    & (Join-Path $repo 'mvnw.cmd') package
    if ($LASTEXITCODE -ne 0) { throw "Lab build failed with exit code $LASTEXITCODE" }
}

$arguments = @('-Xmx2g', '-jar', $jar, $Command, '--cache', $CachePath, '--artifacts', (Join-Path $repo 'data\artifacts'))
if ($Command -eq 'serve') {
    $arguments += @('--port', [string]$Port)
    if ($ContextImage) { $arguments += @('--context-image', $ContextImage) }
    if ($NoBrowser) { $arguments += '--no-browser' }
} else {
    if ($Snapshot -gt 0) { $arguments += @('--snapshot', [string]$Snapshot) }
    $arguments += @('--lenses', $Lens, '--resolutions', $Resolutions)
    if ($Force) { $arguments += '--force' }
}

& $java @arguments
exit $LASTEXITCODE
