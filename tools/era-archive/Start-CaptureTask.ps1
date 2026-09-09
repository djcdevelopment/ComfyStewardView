<#
.SYNOPSIS
Run a capture on a Windows host the way AM4 runs one on Linux: detached from the shell
that started it, but still inside the user's graphical session.

.DESCRIPTION
AM4 uses `systemd-run --user`, which hands the worker to the user's service manager --
it keeps running when the ssh session ends, and it still has DISPLAY=:0. Start-Process
over ssh is not the Windows equivalent: OpenSSH puts the child in a job object and
Windows tears it down when the session closes. On i5 that killed the run after it had
parked the mod tree but before it launched the game, which is exactly the half-state the
runner's `finally` exists to prevent.

The real equivalent is a scheduled task with an Interactive principal. Interactive means
"only when this user is logged on", which is what gives the task the desktop and the GPU
a game needs -- and it needs no stored password, unlike a task that runs whether or not
anyone is signed in.

The command is written to a .bat first so that quoting is settled once, on disk, instead
of surviving a trip through ssh, PowerShell and the task scheduler.

.EXAMPLE
Start-CaptureTask.ps1 -TaskName steward-era12 -Python C:\...\python.exe `
  -Script C:\Users\Admin\i5stage\omen_capture.py -Arguments '--campaign "..." --output "..."'

.EXAMPLE
Start-CaptureTask.ps1 -TaskName steward-era12 -Status
Start-CaptureTask.ps1 -TaskName steward-era12 -Stop
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $TaskName,
    [string] $Python,
    [string] $Script,
    [string] $Arguments,
    [string] $LogPath,
    [string] $UserId,
    [switch] $Status,
    [switch] $Stop
)

$ErrorActionPreference = 'Stop'

if ($Status) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { "task '$TaskName' does not exist"; return }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    [pscustomobject]@{
        Task      = $TaskName
        State     = $task.State
        LastRun   = $info.LastRunTime
        LastResult= $info.LastTaskResult
        NextRun   = $info.NextRunTime
    } | Format-List | Out-String
    return
}

if ($Stop) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        "task '$TaskName' stopped and removed"
    } else { "task '$TaskName' does not exist" }
    return
}

foreach ($required in 'Python', 'Script', 'Arguments') {
    if (-not (Get-Variable $required -ValueOnly)) { throw "-$required is required to start a task" }
}
if (-not (Test-Path -LiteralPath $Python)) { throw "Python not found: $Python" }
if (-not (Test-Path -LiteralPath $Script)) { throw "Script not found: $Script" }
if (-not $LogPath) { $LogPath = Join-Path $env:USERPROFILE "$TaskName.log" }

# Quoting is settled once, here, rather than surviving ssh -> PowerShell -> scheduler.
$bat = Join-Path $env:USERPROFILE "$TaskName.bat"
@(
    '@echo off',
    ('"{0}" "{1}" {2} > "{3}" 2>&1' -f $Python, $Script, $Arguments, $LogPath)
) | Set-Content -LiteralPath $bat -Encoding ASCII

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "{0}"' -f $bat) `
    -WorkingDirectory (Split-Path -Parent $Script)
# Interactive: runs in the signed-in session, so it has a desktop and a GPU, and needs
# no stored credential. RunLevel Limited because capture needs no elevation.
# $env:USERDOMAIN is not reliably populated over ssh, and an unresolvable UserId fails
# registration with "No mapping between account names and security IDs was done".
# WindowsIdentity always yields a name the scheduler can resolve.
if (-not $UserId) { $UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name }
$principal = New-ScheduledTaskPrincipal -UserId $UserId `
    -LogonType Interactive -RunLevel Limited
# A laptop is a capture host too: do not refuse to start on battery, do not stop when it
# is unplugged, and do not impose the default three-day execution cap.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
    -DontStopOnIdleEnd -RestartCount 0

Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal `
    -Settings $settings -Description 'Steward era capture' | Out-Null
Start-ScheduledTask -TaskName $TaskName

[pscustomobject]@{
    Task    = $TaskName
    Batch   = $bat
    Log     = $LogPath
    State   = (Get-ScheduledTask -TaskName $TaskName).State
} | Format-List | Out-String
