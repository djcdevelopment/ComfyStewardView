[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InputRoot,
    [Parameter(Mandatory)][string]$OutputRoot,
    [Parameter(Mandatory)][string]$Java,
    [string]$Python = 'python',
    [string]$LegacyGalleries = '',
    [string]$IdentityLinks = ''
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
function Run-Python {
    param([string[]]$Arguments)
    & $Python @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Archive command failed: $($Arguments[0])" }
}
Run-Python @((Join-Path $PSScriptRoot 'archive.py'),'inventory','--input-root',$InputRoot,'--output-root',$OutputRoot)
Run-Python @((Join-Path $PSScriptRoot 'archive.py'),'ingest','--output-root',$OutputRoot,'--java',$Java)
Run-Python @((Join-Path $PSScriptRoot 'payloads.py'),'--output-root',$OutputRoot)
$community = @((Join-Path $PSScriptRoot 'community.py'),'--output-root',$OutputRoot)
if ($LegacyGalleries) { $community += @('--legacy-galleries',$LegacyGalleries) }
if ($IdentityLinks) { $community += @('--links',$IdentityLinks) }
Run-Python $community
Run-Python @((Join-Path $PSScriptRoot 'community_store.py'),'--output-root',$OutputRoot)
Run-Python @((Join-Path $PSScriptRoot 'jobs.py'),'rasters','--output-root',$OutputRoot,'--java',$Java)
Run-Python @((Join-Path $PSScriptRoot 'pilot.py'),'--output-root',$OutputRoot)
Write-Host "CPU processing complete. Historical game sessions are explicitly dispatched through jobs.py."
