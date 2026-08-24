[CmdletBinding()]
param(
    [ValidateSet('serve', 'render', 'prepare-command', 'watch-jobs')]
    [string]$Command = 'serve',
    [string]$CachePath = '',
    [long]$Snapshot = 0,
    [string]$Lens = 'build-density,birch-trees,all-zdos',
    [string]$Resolutions = '320,160,80,64,16',
    [string]$WorldPath = '',
    [string]$ContextImage = '',
    [int]$Port = 8091,
    [string]$LabUrl = 'http://127.0.0.1:8091',
    [ValidateRange(1, 300)]
    [int]$IntervalSeconds = 15,
    [switch]$NoBrowser,
    [switch]$JobMonitor,
    [switch]$Once,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$shared = Join-Path (Split-Path $repo -Parent) 'comfystewardview\.tools'
$java = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin\java.exe' } else { Join-Path $shared 'jdk-17.0.19+10\bin\java.exe' }
$jar = Join-Path $repo 'target\steward-spatial-lab-0.1.0-SNAPSHOT.jar'

if ($Command -eq 'watch-jobs') {
    try { $Host.UI.RawUI.WindowTitle = 'Steward Spatial Lab - Job Monitor' } catch {}
    $endpoint = $LabUrl.TrimEnd('/') + '/api/jobs'
    Write-Host 'Steward Spatial Lab - Job Monitor' -ForegroundColor Cyan
    Write-Host "Polling $endpoint every $IntervalSeconds second(s). Ctrl+C stops the monitor." -ForegroundColor DarkGray

    do {
        $stamp = Get-Date -Format 'HH:mm:ss'
        try {
            $response = Invoke-RestMethod -UseBasicParsing -TimeoutSec 10 -Uri $endpoint
            $jobs = @($response)
            $active = @($jobs | Where-Object { $_.status -in @('queued', 'running') })
            if ($active.Count -gt 0) {
                Write-Host "[$stamp] $($active.Count) active job(s)" -ForegroundColor Yellow
                foreach ($job in $active) {
                    $total = [Math]::Max(0, [int]$job.totalUnits)
                    $done = [Math]::Max(0, [int]$job.completedUnits)
                    $percent = if ($total -gt 0) { [Math]::Round(($done / $total) * 100) } else { 0 }
                    $elapsed = ([double]$job.elapsedMs / 1000).ToString('0.000')
                    $jobPhases = @($job.phases)
                    $phase = if ($job.currentPhase) {
                        [string]$job.currentPhase
                    } elseif ($jobPhases.Count -gt 0) {
                        'after ' + [string]$jobPhases[-1].name
                    } else {
                        'waiting for worker'
                    }
                    $phase = (($phase -replace '[^\x20-\x7E]', ' ') -replace '\s+', ' ').Trim()
                    Write-Host ("  {0,-8} {1,-7} {2,3}%  {3}/{4}  {5}s  {6}" -f $job.id.Substring(0,8), $job.status.ToUpperInvariant(), $percent, $done, $total, $elapsed, $phase) -ForegroundColor White
                    $logLines = @($job.logs)
                    if ($logLines.Count -gt 0) {
                        $lastLog = ((([string]$logLines[-1]) -replace '[^\x20-\x7E]', ' ') -replace '\s+', ' ').Trim()
                        Write-Host "    $lastLog" -ForegroundColor DarkGray
                    }
                }
            } elseif ($jobs.Count -gt 0) {
                $latest = $jobs[0]
                $phaseHits = @($latest.phases | Where-Object { $_.name -match 'artifact hit' }).Count
                $cacheHits = if ($null -ne $latest.metrics.cacheHits) { [int]$latest.metrics.cacheHits } else { $phaseHits }
                $created = if ($null -ne $latest.metrics.createdLayers) { [int]$latest.metrics.createdLayers } else { [Math]::Max(0, [int]$latest.completedUnits - $cacheHits) }
                $elapsed = ([double]$latest.elapsedMs / 1000).ToString('0.000')
                $outcome = if ($latest.status -eq 'complete' -and $created -eq 0 -and $cacheHits -gt 0) {
                    "$cacheHits cached, no generation"
                } elseif ($latest.status -eq 'complete') {
                    "$created created, $cacheHits cached"
                } elseif ($latest.error) {
                    $latest.error
                } else {
                    "$($latest.completedUnits)/$($latest.totalUnits) layers"
                }
                Write-Host "[$stamp] idle - latest $($latest.id.Substring(0,8)) $($latest.status.ToUpperInvariant()) in ${elapsed}s - $outcome" -ForegroundColor Green
            } else {
                Write-Host "[$stamp] idle - no jobs in this server process" -ForegroundColor DarkGray
            }
        } catch {
            Write-Host "[$stamp] lab unavailable - $($_.Exception.Message)" -ForegroundColor Red
        }
        if (-not $Once) { Start-Sleep -Seconds $IntervalSeconds }
    } while (-not $Once)
    exit 0
}

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

if ($Command -eq 'serve' -and $JobMonitor) {
    $monitorUrl = "http://127.0.0.1:$Port"
    $monitorArguments = '-NoExit -ExecutionPolicy Bypass -File "{0}" watch-jobs -LabUrl "{1}" -IntervalSeconds {2}' -f $PSCommandPath, $monitorUrl, $IntervalSeconds
    Start-Process -FilePath 'powershell.exe' -ArgumentList $monitorArguments -WindowStyle Normal
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
