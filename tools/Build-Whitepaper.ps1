<#
.SYNOPSIS
  Inline the architecture diagrams into the white paper and emit a single self-contained HTML file.

.DESCRIPTION
  docs/comfy-integration/WHITEPAPER.html is the editable source. It carries
  {{FIG_*}} placeholders rather than copies of the diagrams, so
  docs/comfy-integration/diagrams/ stays the single source of truth — edit a
  diagram, re-run this, and the paper follows.

  Each SVG is embedded as a base64 data: URI inside an <img>. That is deliberate
  over inlining the <svg> markup: the diagrams carry internal <style> blocks with
  generic class names (.box, .label, .title), and SVG styles are not scoped, so
  five inlined diagrams would collide with each other and with the page. A data
  URI is fully isolated and still renders as vector at any zoom.

  The output is standalone — no external fonts, scripts, or images — so it can be
  opened from disk, mailed, or published as an artifact unchanged.

.PARAMETER OutFile
  Where to write the built page. Defaults into the viewer's static resources, so the
  paper ships inside the jar and is served at /steward/whitepaper.html alongside the
  application it documents. That output is committed — like the vendored prefab
  dictionary, it is a generated artifact the running app depends on, so a fresh clone
  builds a complete image without having to remember a pre-build step.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\Build-Whitepaper.ps1
#>
[CmdletBinding()]
param(
    [string]$Source      = '',
    [string]$DiagramDir  = '',
    [string]$OutFile     = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Source)     { $Source     = Join-Path $repoRoot 'docs\comfy-integration\WHITEPAPER.html' }
if (-not $DiagramDir) { $DiagramDir = Join-Path $repoRoot 'docs\comfy-integration\diagrams' }
if (-not $OutFile)    { $OutFile    = Join-Path $repoRoot 'viewer\src\main\resources\static\whitepaper.html' }

# Explicit UTF-8 both directions. Get-Content/Set-Content on Windows PowerShell 5.1
# fall back to the ANSI codepage for a file with no BOM, which silently turns every
# em-dash in this document into three mojibake characters. Learned the hard way.
$utf8 = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path $Source))     { throw "white paper source not found: $Source" }
if (-not (Test-Path $DiagramDir)) { throw "diagram directory not found: $DiagramDir" }

$figures = [ordered]@{
    FIG_OVERVIEW  = '10-system-overview.svg'
    FIG_DATAFLOW  = '11-data-flow.svg'
    FIG_CONTRACTS = '12-contracts.svg'
    FIG_STACK     = '13-tech-stack.svg'
    FIG_TOOLING   = '14-tooling-and-lanes.svg'
}

Write-Host "Building white paper from $Source"
$html = [IO.File]::ReadAllText($Source, $utf8)

foreach ($key in $figures.Keys) {
    $svgPath = Join-Path $DiagramDir $figures[$key]
    if (-not (Test-Path $svgPath)) { throw "missing diagram: $svgPath" }

    # Parse before embedding: a malformed SVG becomes an invisibly broken image
    # otherwise, and the page still "builds".
    try { [xml]$null = [IO.File]::ReadAllText($svgPath, $utf8) }
    catch { throw "diagram is not well-formed XML: $svgPath -- $($_.Exception.Message)" }

    $uri = 'data:image/svg+xml;base64,' + [Convert]::ToBase64String([IO.File]::ReadAllBytes($svgPath))
    if ($html -notmatch [regex]::Escape("{{$key}}")) { throw "placeholder {{$key}} not present in the source" }
    $html = $html.Replace("{{$key}}", $uri)
    Write-Host ("  {0,-14} <- {1,-28} {2:n1} KB" -f $key, $figures[$key], ($uri.Length / 1KB))
}

$left = [regex]::Matches($html, '\{\{[A-Z_]+\}\}')
if ($left.Count -gt 0) { throw "unsubstituted placeholders remain: $(($left | ForEach-Object { $_.Value }) -join ', ')" }

# Wrap into a complete document.
#
# The source is deliberately wrapper-free because the artifact publisher supplies
# its own doctype, head and body. Served directly by Javalin it needs its own, and
# the two omissions that actually bite are the doctype (without it the browser
# renders in quirks mode) and the charset (without it a UTF-8 file with no BOM gets
# decoded as windows-1252, and every em-dash turns to mojibake — the same failure
# this build already guards against on the input side).
# The source opens with <title> and <style>, which belong in head, and everything
# from the first top-level container onward is body content.
$splitAt = $html.IndexOf('<div class="wrap">')
if ($splitAt -lt 0) { throw 'could not find the body content marker <div class="wrap"> in the source' }
$head = $html.Substring(0, $splitAt)
$body = $html.Substring($splitAt)
$doc = "<!doctype html>`n<html lang=`"en`">`n<head>`n<meta charset=`"utf-8`">`n" +
       "<meta name=`"viewport`" content=`"width=device-width, initial-scale=1`">`n" +
       $head + "</head>`n<body>`n" + $body + "`n</body>`n</html>`n"

[IO.File]::WriteAllText($OutFile, $doc, $utf8)
$html = $doc

# Cheap post-conditions worth having: mojibake is silent, and a broken embed only
# shows up as a blank figure in a browser.
#
# The mojibake markers are built from codepoints rather than written literally.
# An earlier revision spelled them out, and PowerShell 5.1 read this very file as
# ANSI and mangled them until it would not parse - the check corrupted itself.
$check    = [IO.File]::ReadAllText($OutFile, $utf8)
$emDash   = [string][char]0x2014   # the character this document is full of
$mojiLead = [string][char]0x00C3   # capital A-tilde: UTF-8 read as ANSI always starts here

$moji = [regex]::Matches($check, [regex]::Escape($mojiLead)).Count
$dash = [regex]::Matches($check, [regex]::Escape($emDash)).Count
$imgs = [regex]::Matches($check, 'src="data:image/svg\+xml;base64,').Count

if ($moji -gt 0) { throw "encoding damage in the output ($moji markers) - check the UTF-8 handling" }
if ($dash -lt 1) { throw "no em-dashes survived; the source was probably decoded as ANSI" }
if ($imgs -ne $figures.Count) { throw "expected $($figures.Count) embedded figures, found $imgs" }

Write-Host ""
Write-Host ("Wrote {0} ({1:n1} KB, {2} figures, self-contained)" -f $OutFile, ((Get-Item $OutFile).Length / 1KB), $imgs)
