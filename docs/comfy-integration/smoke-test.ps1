# Smoke test — runs through every patched/new endpoint and asserts the patches landed.
# Usage:  pwsh smoke-test.ps1  (or just .\smoke-test.ps1 in a PowerShell window)
# Exit code 0 = all good, 1 = at least one check failed.

$ErrorActionPreference = 'Stop'
$BASE = 'http://localhost:7080'
$pass = 0
$fail = 0

function check([string]$name, [scriptblock]$assertion) {
  try {
    $r = & $assertion
    if ($r) {
      Write-Host "  PASS  $name" -ForegroundColor Green
      $script:pass++
    } else {
      Write-Host "  FAIL  $name (assertion returned false)" -ForegroundColor Red
      $script:fail++
    }
  } catch {
    Write-Host "  FAIL  $name ($_)" -ForegroundColor Red
    $script:fail++
  }
}

function get([string]$path) {
  (Invoke-WebRequest -Uri "$BASE$path" -UseBasicParsing -TimeoutSec 8 -ErrorAction Stop).Content | ConvertFrom-Json
}

Write-Host ""
Write-Host "=== Comfy steward-view smoke test ===" -ForegroundColor Cyan
Write-Host "Target: $BASE"
Write-Host ""

# Daemon reachable + ready
check "daemon /status is done"            { (get '/api/v1/status').done -eq $true }
check "world version is 35"               { (get '/api/v1/summary').worldVersion -eq 35 }

Write-Host ""
Write-Host "--- PA1: v106 inventory patch ---" -ForegroundColor Cyan

# Economy data correct
check "uniqueItemTypes >= 600"            { (get '/api/v1/economy?topN=1').uniqueItemTypes -ge 600 }
check "totalItemCount > 10M"              { (get '/api/v1/economy?topN=1').totalItemCount -gt 10000000 }
check "top item is Coins"                 { (get '/api/v1/economy?topN=1').topItems[0].name -eq 'Coins' }

Write-Host ""
Write-Host "--- PA3: classification injection ---" -ForegroundColor Cyan

check "top item has category"             { (get '/api/v1/economy?topN=1').topItems[0].category -eq 'Currency' }
check "byCategory present"                { (get '/api/v1/economy?topN=1').byCategory.PSObject.Properties.Count -ge 10 }
check "byTier present"                    { (get '/api/v1/economy?topN=1').byTier.PSObject.Properties.Count -ge 5 }

Write-Host ""
Write-Host "--- PA4: forensics alerts ---" -ForegroundColor Cyan

check "at least 1 critical alert"         { (get '/api/v1/alerts?limit=1').critical -ge 1 }
$forensicTypes = (get '/api/v1/alerts?limit=2000').data | Where-Object { $_.type -in @('quality_overflow','server_issued_items','engravings_tracked') } | Measure-Object | Select-Object -ExpandProperty Count
check "forensics alert types appear"      { $forensicTypes -ge 1 }

Write-Host ""
Write-Host "--- PA5: forensics endpoints ---" -ForegroundColor Cyan

check "/forensics/top-coin-caches"        { (get '/api/v1/forensics/top-coin-caches?limit=1').totalCachesTracked -ge 100 }
check "/forensics/server-issuers"         { (get '/api/v1/forensics/server-issuers?limit=1').distinctIssuers -ge 100 }
$firstIssuer = (get '/api/v1/forensics/server-issuers?limit=1').issuers[0].crafter
check "/forensics/guild-gear?issuer=..."  { (get ("/api/v1/forensics/guild-gear?issuer=" + [Uri]::EscapeDataString($firstIssuer))).totalItems -ge 1 }

Write-Host ""
Write-Host "--- PA6: UI integration ---" -ForegroundColor Cyan

$html = (Invoke-WebRequest -Uri "$BASE/" -UseBasicParsing).Content
check "Coin Caches tab in UI"             { $html.Contains('Coin Caches') }
check "Server Issuers tab in UI"          { $html.Contains('Server Issuers') }
check "Guild Gear tab in UI"              { $html.Contains('Guild Gear') }
check "By Category section in Economy"    { $html.Contains('By Category') }

Write-Host ""
Write-Host "=== Result: $pass passed, $fail failed ===" -ForegroundColor $(if ($fail -eq 0) {'Green'} else {'Red'})
if ($fail -eq 0) {
  Write-Host "Everything looks good. Open $BASE/ in a browser." -ForegroundColor Green
} else {
  Write-Host "Some checks failed. The daemon may not have all patches applied or may not be running." -ForegroundColor Red
  Write-Host "Common fixes:" -ForegroundColor Yellow
  Write-Host "  1. Daemon not running:  java -Xmx3g -jar D:\work\temp\viewer\target\world-viewer-1.0.0.jar D:\work\temp\ComfyEra14.db --port 7080 --no-browser"
  Write-Host "  2. Daemon running old jar: check target/world-viewer-1.0.0.jar mtime"
  Write-Host "  3. Daemon parsing: wait 10 seconds, re-run"
}
exit $fail
