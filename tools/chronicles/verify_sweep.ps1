# Post-deploy verification sweep for the Chronicles go-live (plain HTTP; never the in-app browser pane).
#   powershell -File tools\chronicles\verify_sweep.ps1 [-SkipChronicles] [-SkipCreators] [-SkipViewer]
param([switch]$SkipChronicles, [switch]$SkipCreators, [switch]$SkipViewer)
$ErrorActionPreference = 'Continue'
$base = 'https://fx99.tail8e749c.ts.net'
$fail = 0
function Check($path, [string[]]$mustContain = @(), [string[]]$mustNotContain = @(), [string]$cacheMust = '') {
    try {
        $r = Invoke-WebRequest -Uri ($base + $path) -UseBasicParsing -TimeoutSec 30
        $cc = [string]$r.Headers['Cache-Control']
        $ok = $true; $notes = @()
        foreach ($m in $mustContain) { if ($r.Content -notmatch [regex]::Escape($m)) { $ok = $false; $notes += "missing '$m'" } }
        foreach ($m in $mustNotContain) { if ($r.Content -match [regex]::Escape($m)) { $ok = $false; $notes += "contains '$m'" } }
        if ($cacheMust -and $cc -notmatch [regex]::Escape($cacheMust)) { $ok = $false; $notes += "cache-control '$cc'" }
        $tag = if ($ok) { 'OK  ' } else { 'FAIL' }
        if (-not $ok) { $script:fail++ }
        "{0} {1,-52} {2} {3,9} B  {4}" -f $tag, $path, $r.StatusCode, $r.RawContentLength, ($notes -join '; ')
    } catch {
        $script:fail++
        "FAIL {0,-52} {1}" -f $path, (($_.Exception.Message -split "`n")[0])
    }
}
function ExpectStatus($path, $code) {
    try {
        $r = Invoke-WebRequest -Uri ($base + $path) -UseBasicParsing -TimeoutSec 30 -MaximumRedirection 0 -ErrorAction Stop
        $got = $r.StatusCode
    } catch { $got = try { [int]$_.Exception.Response.StatusCode } catch { -1 } }
    $tag = if ($got -eq $code) { 'OK  ' } else { $script:fail++; 'FAIL' }
    "{0} {1,-52} {2} (want {3})" -f $tag, $path, $got, $code
}

"== front door"
ExpectStatus '/' 404
ExpectStatus '/chronicles' 308
if (-not $SkipChronicles) {
    Check '/chronicles/' @('<h1', 'href="/valheim/"', 'href="/chronicles/guide/"', 'role="combobox"', 'id="suggestions"', 'id="portrait-manifest"') @('character', 'archetype', 'class="path"', 'cdn.tailwindcss', 'fonts.googleapis')
    # Slate retired 2026-09-12: no slot tiles ship; viking96 is the default library.
    Check '/chronicles/portraits.json' @('"count": 0', '"tiles"', '"libraries"', '"viking96"', '"facets"', '"default": true') @('character', 'archetype', '"slate48"') 'no-cache'
    # One painted take of the library, all three cuts, immutable like the slate tiles.
    try {
        $pm = (Invoke-WebRequest -Uri ($base + '/chronicles/portraits.json') -UseBasicParsing -TimeoutSec 30).Content | ConvertFrom-Json
        $lib = $pm.tiles | Where-Object { $_.library -eq 'viking96' } | Select-Object -First 1
        if ($null -eq $lib) { $script:fail++; "FAIL portraits.json carries no viking96 tile" }
        else {
            $take = $lib.takes[0].id
            foreach ($cut in 'bust128', 'bust256', 'wide768') {
                $rel = ([string]$lib.cuts.$cut).Replace('{take}', $take)
                Check ('/chronicles/img/portraits/' + $rel) @() @() 'immutable'
            }
        }
    } catch { $script:fail++; "FAIL portrait library probe: $($_.Exception.Message)" }
    Check '/chronicles/img/cutouts/find.webp' @() @() 'immutable'
    Check '/chronicles/guide/' @('<h1', 'id="claims"') @('character', 'archetype', 'fonts.googleapis')
    Check '/chronicles/build.json' @('"counts"')
    try {
        $rec = (Invoke-WebRequest -Uri ($base + '/chronicles/receipt.json') -UseBasicParsing -TimeoutSec 30).Content | ConvertFrom-Json
        $n = 0; $bad = 0
        foreach ($f in $rec.files) {
            $n++
            try {
                $x = Invoke-WebRequest -Uri ($base + '/chronicles/' + $f.path) -UseBasicParsing -TimeoutSec 30
                if ($x.RawContentLength -ne $f.bytes) { $bad++; "FAIL size  /chronicles/$($f.path)  got $($x.RawContentLength) want $($f.bytes)" }
                if ($f.path -like 'img/*' -and ([string]$x.Headers['Cache-Control']) -notmatch 'immutable') { $bad++; "FAIL cache /chronicles/$($f.path)  '$($x.Headers['Cache-Control'])'" }
            } catch { $bad++; "FAIL fetch /chronicles/$($f.path)  $($_.Exception.Message)" }
        }
        if ($bad) { $script:fail += $bad }
        "receipt: $n files checked, $bad problems"
        # every href on the gateway + guide resolves
        foreach ($page in '/chronicles/', '/chronicles/guide/') {
            $html = (Invoke-WebRequest -Uri ($base + $page) -UseBasicParsing -TimeoutSec 30).Content
            $hrefs = [regex]::Matches($html, 'href="([^"#][^"]*)"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
            foreach ($h in $hrefs) {
                $u = if ($h -match '^https?://') { $h } elseif ($h -match '^/') { $base + $h } else { $base + $page + $h }
                $u = $u -replace '#.*$', ''
                try { $s = (Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 30 -Method Head).StatusCode } catch { $s = try { [int]$_.Exception.Response.StatusCode } catch { -1 } }
                if ($s -ne 200) { $script:fail++; "FAIL link $page -> $h ($s)" }
            }
            "links on $page checked: $($hrefs.Count)"
        }
    } catch { $script:fail++; "FAIL receipt.json: $($_.Exception.Message)" }
}

if (-not $SkipViewer) {
    "== era viewer"
    foreach ($d in '/valheim/', '/valheim/era7/', '/valheim/era8/', '/valheim/era9/', '/valheim/era10/', '/valheim/era11/', '/valheim/era12/', '/valheim/era14/', '/valheim/era16/') {
        Check $d @('--flame', 'href="/chronicles/"', "fetch('index.json'")
    }
    Check '/valheim/index.json' @('"images"') @() 'no-cache'
}

if (-not $SkipCreators) {
    "== creators"
    Check '/valheim/creators/' @('creators.css?v=15', 'id="stats-link"', 'href="/chronicles/"', 'src="./portraits.js"')
    Check '/valheim/creators/creators.css?v=15' @('--flame', '@font-face', '#portrait-picker')
    Check '/valheim/creators/creators.js' @('Top 8', 'portraitIndex', 'StewardParticipation', 'buildKinshipTree')
    # The pair view is mounted by creators.js and drawn entirely by this script, so the
    # section itself cannot be probed in the served HTML -- the script's own presence and
    # the two names it is reached by are what there is to check.
    Check '/valheim/creators/pair.js' @('buildKinshipPair', 'StewardPair')
    Check '/valheim/creators/kin-tree.js' @('layoutKinshipTree', 'drawKinshipTree')
    # One resolver for every face, and the picker drawer, both linted for the words the
    # archive never says about the people in it.
    Check '/valheim/creators/portraits.js' @('StewardPortraits', 'portraitFor') @('character', 'archetype', 'seed', 'gender')
    Check '/valheim/creators/portrait-picker.js' @('StewardPortraitPicker', 'Clear all') @('character', 'archetype', 'seed', 'gender')
    Check '/valheim/creators/stats/' @('Archive Statistics', 'href="/chronicles/"')
    # The kinship page is served from its own directory, so its assets climb one level.
    # The two banned words and the participation deep link all belong to other pages.
    Check '/valheim/creators/kinship/' @('id="kin-tree"', '../creators.css?v=15', 'src="../portraits.js?v=15"', 'src="../kin-tree.js?v=15"', 'data-steward-page="kinship"', 'href="/chronicles/"') @('character', 'archetype', 'href="#participation-details"')
    Check '/valheim/creators/kinship.js' @('initKinshipPage', 'drawKinshipTree(')
    # The builder's own page: the picker, sign-in (switched off until a client id is set), the
    # opt-out levels. Linted like every other shell.
    Check '/valheim/creators/profile/' @('data-steward-page="profile"', '../creators.css?v=15', 'src="../creators.js?v=15"', 'src="../portraits.js?v=15"', 'src="../portrait-picker.js?v=15"', 'src="../profile.js"', 'id="profile-optout"', 'value="erase"', '@Tugcow', 'id="optout-message"', 'href="/chronicles/"') @('character', 'archetype', 'submitted', 'discord-client-id', 'href="#participation-details"')
    Check '/valheim/creators/profile.js' @('initProfilePage', 'portrait-beacon.txt', "COORDINATOR_HANDLE = 'Tugcow'") @('character', 'archetype', 'seed', 'gender', 'submitted', 'discord.com')
    # The beacon the profile page requests: a four-byte file whose query string the access log keeps.
    Check '/valheim/creators/portrait-beacon.txt' @('ok')
    Check '/valheim/creators/directory.json' @('"builders"') @() 'no-cache'
    try {
        $d = (Invoke-WebRequest -Uri ($base + '/valheim/creators/directory.json') -UseBasicParsing -TimeoutSec 60).Content | ConvertFrom-Json
        $top = $d.builders | Sort-Object -Property albums -Descending | Select-Object -First 1
        Check ('/valheim/creators/' + $top.builderKey + '/') @('../creators.css?v=15', 'src="../pair.js"', 'src="../kin-tree.js"', 'src="../portraits.js"', 'href="/chronicles/"', 'id="builder-hero"', '<a id="hero-avatar"', 'id="look-out"', 'id="thread-notes"')
        # Every record wears a face by the archive's pick (or the builder's confirmed one).
        $noface = @($d.builders | Where-Object { -not $_.portrait }).Count
        if ($noface) { $script:fail++; "FAIL directory.json: $noface builder(s) carry no portrait" } else { "OK   directory.json: every builder carries a portrait" }
        Check ('/valheim/creators/threads/' + $top.builderKey + '.json') @('"contributors"')
        # A named anchor has to reach the same shell the bare page does.
        Check ('/valheim/creators/kinship/?builder=' + $top.builderKey) @('id="kin-tree"')
    } catch { $script:fail++; "FAIL thread probe: $($_.Exception.Message)" }
}

""
if ($fail) { "SWEEP: $fail problem(s)"; exit 1 } else { "SWEEP: all clear"; exit 0 }
