# Build guide — what you build, what it emits, how to verify

This is the contract for taking the source in this repo and producing the running daemon you saw screenshots of. Every step says **what** you're doing, **why**, **what's emitted**, and the **verify command** that proves it worked. If a verify fails, fix that step before continuing.

**Final outcome:** a Java daemon on `http://localhost:7080/` that parses `ComfyEra14.db` in ~8 seconds and serves a categorized, forensics-enriched UI matching the screenshots in [`screenshots/`](screenshots/).

**Time budget:** ~15 minutes if Java 17 is already installed. Add ~5 minutes if you need to download it.

**Total artifacts you'll produce:** 1 JAR (~9.3 MB), 13 .class files (~80 KB total), a running JVM process.

## Skill assumptions

You can:
- Run PowerShell or bash
- Read a stack trace
- Open a browser

You don't need to know:
- Maven (we bypass it — see step 4)
- The Valheim binary format (LESSONS_LEARNED.md if curious)
- Alpine.js (you can change HTML directly)

## Pre-flight checks

Before the build, three things must be true. Skipping these wastes time later.

### Pre-flight 1 — Java 17 is installed

**Why:** the daemon JAR is compiled to Java 17 bytecode. Older JVMs reject it; newer JVMs run it but you'll be compiling with mismatched targets.

**Verify:**

```powershell
# Look for any Java 17 install
java -version
# Should see "17.x.x" in the output, or "openjdk version "17..."
```

If java isn't on PATH but you have one installed (e.g., from Gradle JDKs):

```powershell
# Typical Gradle-managed JDK
Test-Path "C:\Users\$env:USERNAME\.gradle\jdks\eclipse_adoptium-17-amd64-windows.2\bin\java.exe"
# → True if it exists
```

**If you have no Java 17:** download Eclipse Temurin 17 (zip distribution, no admin needed):

```powershell
Invoke-WebRequest -Uri "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk" -OutFile jdk17.zip
Expand-Archive jdk17.zip -DestinationPath C:\jdks\
# JDK lands at C:\jdks\jdk-17.0.x.x+x\
```

Set `$jdk` to the path with the `bin\` subfolder. Used in every later step:

```powershell
$jdk = "C:\Users\$env:USERNAME\.gradle\jdks\eclipse_adoptium-17-amd64-windows.2"
# or wherever yours is. ENSURE: Test-Path "$jdk\bin\java.exe" → True
```

### Pre-flight 2 — The save file is available

**Why:** the daemon takes a `.db` path as its argument. Without one, it dies on startup.

**Verify:**

```powershell
Test-Path "D:\work\temp\ComfyEra14.db"
# → True; file is 1.1 GB. Listed in .gitignore so it's not in the repo.
```

If `False`: get the `.db` from whoever has it (Discord, the previous dev). Put it at `D:\work\temp\ComfyEra14.db` or note the path you'll use.

### Pre-flight 3 — Repo is checked out

**Verify:**

```powershell
Test-Path "D:\work\temp\viewer\src\main\java\com\valheim\viewer\parser\WorldParser.java"
# → True

Test-Path "D:\work\temp\viewer\classification.json"
# → True (this file ships in the repo; it's the 617-item categorization)
```

If `False`: `git clone https://github.com/djcdevelopment/ComfyStewardView.git D:\work\temp` (or pull the latest).

---

## Components — what each part is and why

Before you build, know what you're building. Six source files combine into one running JAR.

### Component A — `WorldParser.java` (patched)

**Where:** `viewer/src/main/java/com/valheim/viewer/parser/WorldParser.java`

**What it is:** the binary parser that reads `.db` bytes into the in-memory `ZdoFlatStore`. ~800 lines.

**Why it changed:** the original bailed on `if (version > 105) return;` for inventory format v106 — which is 99% of containers in current saves. Patch added the 5-byte v106 read (int32 `worldLevel` + byte `pickedUp`) and added forensics capture (per-item quality, crafter name, customData keys).

**Emits when compiled:** `target/classes/com/valheim/viewer/parser/WorldParser.class` (~22 KB) + `WorldParser$ParseProgress.class` (~600 B, the inner progress-tracking class).

**Verify the patch is in the source:**

```powershell
Select-String "version >= 106" "D:\work\temp\viewer\src\main\java\com\valheim\viewer\parser\WorldParser.java"
# → Should match 1 line at ~line 700:
#   if (version >= 106) {     // worldLevel
```

If that returns nothing, the source doesn't have our patch — re-pull the repo.

### Component B — `ZdoFlatStore.java` (patched)

**Where:** `viewer/src/main/java/com/valheim/viewer/store/ZdoFlatStore.java`

**What it is:** the in-memory data structure for parsed ZDOs. Parallel primitive arrays + lookup maps + heatmap grids.

**Why it changed:** added 5 forensics fields (`qualityOverflowSamples`, `serverIssuedItemCount`, `engravingsTrackedCount`, `serverIssuerCatalog`, `topCoinCaches`) and one nested class (`CoinCache`).

**Emits:** `ZdoFlatStore.class` (~6.4 KB) + `ZdoFlatStore$Categories.class` + `ZdoFlatStore$PlayerRecord.class` + `ZdoFlatStore$CoinCache.class` (NEW).

**Verify:**

```powershell
Select-String "topCoinCaches" "D:\work\temp\viewer\src\main\java\com\valheim\viewer\store\ZdoFlatStore.java"
# → Should match the field declaration + the inner class refs
```

### Component C — `ClassificationStore.java` (NEW)

**Where:** `viewer/src/main/java/com/valheim/viewer/extractor/ClassificationStore.java`

**What it is:** a brand new class that loads `classification.json` at startup. Maps item names to `{category, subcategory, tier, biome, source, mod}` objects.

**Why it exists:** their existing `TaxonomyClassifier` has ~250 hand-mapped items applied only to dropped items. Ours covers 617 items including modded surface and reaches every endpoint that handles item names. Without this, `/api/v1/economy` items all have `category: null`.

**Emits:** `ClassificationStore.class` + `ClassificationStore$Entry.class` (the inner DTO).

**Verify:**

```powershell
Test-Path "D:\work\temp\viewer\src\main\java\com\valheim\viewer\extractor\ClassificationStore.java"
# → True (this is a NEW file, didn't exist in the original repo)
```

### Component D — `AlertBuilder.java` (patched)

**Where:** `viewer/src/main/java/com/valheim/viewer/extractor/AlertBuilder.java`

**What it is:** generates severity-ranked operational alerts (orphaned portals, hotspots, etc.). Pre-existing class.

**Why it changed:** added `build(contracts, metrics, store)` overload + `buildForensicsAlerts()` method. Three new alert types: `quality_overflow` (CRITICAL, detects DeerStew-style int overflow), `server_issued_items` (LOW info), `engravings_tracked` (LOW info).

**Emits:** `AlertBuilder.class` (~15 KB).

**Verify:**

```powershell
Select-String "buildForensicsAlerts" "D:\work\temp\viewer\src\main\java\com\valheim\viewer\extractor\AlertBuilder.java"
# → Should match 2 lines (method declaration + call from build())
```

### Component E — `Main.java` (patched)

**Where:** `viewer/src/main/java/com/valheim/viewer/Main.java`

**What it is:** the JAR's entry point. Parses args, calls all the builders in order, starts the HTTP server.

**Why it changed:** loads `ClassificationStore` at startup, passes it to `ApiServer` + `AlertBuilder`.

**Emits:** `Main.class` (~10 KB).

**Verify:**

```powershell
Select-String "ClassificationStore" "D:\work\temp\viewer\src\main\java\com\valheim\viewer\Main.java"
# → Should match 3 lines: import + load + pass
```

### Component F — `ApiServer.java` (patched)

**Where:** `viewer/src/main/java/com/valheim/viewer/api/ApiServer.java`

**What it is:** registers REST endpoints, handles each route. Pre-existing class.

**Why it changed:** `handleEconomy` enriches each item with classification data + emits `byCategory`/`byTier` aggregates. Three new handlers: `handleTopCoinCaches`, `handleServerIssuers`, `handleGuildGear`. New setter `setClassification`.

**Emits:** `ApiServer.class` (~33 KB).

**Verify:**

```powershell
Select-String "handleTopCoinCaches|handleServerIssuers|handleGuildGear" "D:\work\temp\viewer\src\main\java\com\valheim\viewer\api\ApiServer.java"
# → Should match 6 lines (3 route registrations + 3 method declarations)
```

### Component G — `index.html` (patched, static resource)

**Where:** `viewer/src/main/resources/static/index.html`

**What it is:** the entire SPA (Alpine + Tabulator + Leaflet, ~63 KB).

**Why it changed:** 3 new tab buttons + 3 new DOM sections + 3 new loader methods. Economy tab gains category/tier chip rows. New issuer rendering uses `x-html` to show Valheim color tags as actual colors.

**Emits when bundled:** the JAR's `static/index.html` resource (Javalin serves it via the `staticFiles` plugin).

**Verify:**

```powershell
Select-String "Coin Caches|Server Issuers|Guild Gear" "D:\work\temp\viewer\src\main\resources\static\index.html"
# → Should match ~6 lines (tab labels + DOM section headers)
```

### Data file — `classification.json`

**Where:** `viewer/classification.json`

**What it is:** the 617-item classification map. NOT compiled; loaded at runtime by `ClassificationStore`.

**Why it ships in the repo:** the daemon reads it at startup. Without it `ClassificationStore` loads empty and the economy endpoint returns `category: null` on every item.

**Verify:**

```powershell
$cls = Get-Content "D:\work\temp\viewer\classification.json" -Raw | ConvertFrom-Json
$cls.PSObject.Properties.Name.Count
# → 617
$cls.Coins
# → @{category=Currency; subcategory=Coin; source=Crafted}
```

---

## Build steps — do these in order, verify each

### Step 1 — Set the JDK path

**What:** stash the JDK location in a variable so every later command can use it.

**Why:** ensures we use exactly one Java version. Avoids picking up a stale system Java by accident.

**Command:**

```powershell
$jdk = "C:\Users\$env:USERNAME\.gradle\jdks\eclipse_adoptium-17-amd64-windows.2"
# Or wherever yours is from Pre-flight 1.
```

**Emits:** a `$jdk` variable in your shell session. No files.

**Verify:**

```powershell
& "$jdk\bin\java.exe" -version
# Expected: "openjdk version "17.0.x" ..." on stderr (PowerShell shows it as red but it's fine)

& "$jdk\bin\javac.exe" -version
# Expected: "javac 17.0.x"
```

**If it fails:** `$jdk` is wrong. Re-do Pre-flight 1 and pick the right path.

### Step 2 — Compile the 6 changed/new Java files

**What:** translate `.java` source → `.class` bytecode files. Just the 6 files we touched, not the full 50+ in their codebase.

**Why:** the daemon JAR has stale `.class` files inside it; we need to replace them with the patched ones. We compile only what changed because:
- (a) `mvn package` is blocked by `lib/jetty-servlet.jar` being a 554-byte corrupt stub; and
- (b) compiling just the changed files is ~3 seconds vs ~30 seconds for a full build.

**Command:**

```powershell
$lib = "D:\work\temp\viewer\lib"
$src = "D:\work\temp\viewer\src\main\java"
$classes = "D:\work\temp\viewer\target\classes"

# Build classpath excluding the corrupt jetty-servlet.jar
$jars = @(
  "jackson-annotations-2.17.2.jar","jackson-core-2.17.2.jar","jackson-databind-2.17.2.jar",
  "javalin-6.3.0.jar","slf4j-api-2.0.13.jar",
  "jetty-http.jar","jetty-io.jar","jetty-server.jar","jetty-util.jar"
) | ForEach-Object { "$lib\$_" }
$cp = "$classes;" + ($jars -join ';')

# Compile the 6 files
& "$jdk\bin\javac.exe" -cp $cp -d $classes `
  "$src\com\valheim\viewer\parser\WorldParser.java" `
  "$src\com\valheim\viewer\store\ZdoFlatStore.java" `
  "$src\com\valheim\viewer\extractor\ClassificationStore.java" `
  "$src\com\valheim\viewer\extractor\AlertBuilder.java" `
  "$src\com\valheim\viewer\Main.java" `
  "$src\com\valheim\viewer\api\ApiServer.java"
```

**Emits:** 9-13 new/updated `.class` files under `target/classes/com/valheim/viewer/`:
- `parser/WorldParser.class` (~22 KB) + `parser/WorldParser$ParseProgress.class`
- `store/ZdoFlatStore.class` (~6 KB) + 3 inner-class .class files (`$Categories`, `$PlayerRecord`, `$CoinCache`)
- `extractor/ClassificationStore.class` + `extractor/ClassificationStore$Entry.class`
- `extractor/AlertBuilder.class` (~15 KB)
- `Main.class` (~10 KB)
- `api/ApiServer.class` (~33 KB)

**Verify:**

```powershell
$LASTEXITCODE
# Expected: 0 (success). Anything else = compile error printed above.

# Confirm the freshly-compiled classes exist and were modified in the last minute
Get-ChildItem $classes -Recurse -Filter "*.class" |
  Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-2) } |
  Measure-Object | Select-Object -ExpandProperty Count
# Expected: 9 to 13 (depending on whether the inner classes existed before)
```

**If it fails:** the compile output will tell you which file/line. Common causes:
- `error: cannot find symbol` — a referenced class doesn't exist. Check Pre-flight 3 (full source is checked out).
- `error: package X does not exist` — a JAR is missing from the classpath. Make sure all 9 JARs in `$jars` exist with `Test-Path`.
- "zip END header not found" on `jetty-servlet.jar` — you accidentally included it in `$jars`. Remove it.

### Step 3 — Bundle the new .class files into the shaded JAR

**What:** update the existing fat JAR in place with the patched class files. We don't rebuild the JAR from scratch (that would need Maven); we just patch the changed entries.

**Why:** the daemon launches from `target/world-viewer-1.0.0.jar`. That JAR contains all the dependencies + our app code. We need our patched classes to be the ones loaded at runtime.

**Command:**

```powershell
Set-Location $classes

& "$jdk\bin\jar.exe" uf "D:\work\temp\viewer\target\world-viewer-1.0.0-shaded.jar" `
  "com\valheim\viewer\store\ZdoFlatStore.class" `
  "com\valheim\viewer\store\ZdoFlatStore`$CoinCache.class" `
  "com\valheim\viewer\store\ZdoFlatStore`$Categories.class" `
  "com\valheim\viewer\store\ZdoFlatStore`$PlayerRecord.class" `
  "com\valheim\viewer\parser\WorldParser.class" `
  "com\valheim\viewer\parser\WorldParser`$ParseProgress.class" `
  "com\valheim\viewer\extractor\ClassificationStore.class" `
  "com\valheim\viewer\extractor\ClassificationStore`$Entry.class" `
  "com\valheim\viewer\extractor\AlertBuilder.class" `
  "com\valheim\viewer\Main.class" `
  "com\valheim\viewer\api\ApiServer.class"
```

(The backtick-dollar `` `$ `` is PowerShell's escape for a literal `$` — Java's inner classes use `$` in their filenames.)

**Emits:** mutates `target/world-viewer-1.0.0-shaded.jar` in place (the file grows or stays roughly the same size; entries are replaced).

**Verify:**

```powershell
$LASTEXITCODE
# Expected: 0

# Confirm ClassificationStore (a NEW file) is now inside the JAR
& "$jdk\bin\jar.exe" tf "D:\work\temp\viewer\target\world-viewer-1.0.0-shaded.jar" |
  Select-String "ClassificationStore"
# Expected: 2 lines (ClassificationStore.class + ClassificationStore$Entry.class)
```

**If it fails:** the most common cause is paths. `jar uf` expects relative paths from CWD (which is why we `Set-Location $classes` first). If you forget that, you'll get "no such file" errors.

### Step 4 — Bundle the patched index.html

**What:** the SPA is bundled inside the JAR (Javalin serves it via `staticFiles.add("/static")`). Need to update that copy too.

**Why:** the JAR's classpath includes a `static/index.html` resource. Even though we have the source file in `src/main/resources/static/`, what gets served is whatever the JAR holds.

**Command:**

```powershell
Copy-Item "D:\work\temp\viewer\src\main\resources\static\index.html" `
          "D:\work\temp\viewer\target\classes\static\index.html" -Force

Set-Location "$classes"
& "$jdk\bin\jar.exe" uf "D:\work\temp\viewer\target\world-viewer-1.0.0-shaded.jar" `
  "static\index.html"
```

**Emits:** mutates `target/world-viewer-1.0.0-shaded.jar` in place.

**Verify:**

```powershell
& "$jdk\bin\jar.exe" tf "D:\work\temp\viewer\target\world-viewer-1.0.0-shaded.jar" |
  Select-String "static/index.html"
# Expected: 1 match

# Confirm the JAR's copy has our changes
& "$jdk\bin\jar.exe" xf "D:\work\temp\viewer\target\world-viewer-1.0.0-shaded.jar" "static/index.html"
Select-String "Coin Caches" "static/index.html"
Remove-Item "static\" -Recurse -Force  # cleanup
# Expected: matches found for 'Coin Caches'
```

### Step 5 — Sync the two JARs

**What:** Maven shade plugin produces both `world-viewer-1.0.0.jar` and `world-viewer-1.0.0-shaded.jar` as duplicates. They should always have the same content. The daemon launches from the unsuffixed one.

**Why:** otherwise the daemon launches an old version while you've only patched the shaded copy. Subtle, frustrating bug.

**Command:**

```powershell
Copy-Item "D:\work\temp\viewer\target\world-viewer-1.0.0-shaded.jar" `
          "D:\work\temp\viewer\target\world-viewer-1.0.0.jar" -Force
```

**Emits:** overwrites `target/world-viewer-1.0.0.jar` with the patched content.

**Verify:**

```powershell
# The two JARs should now be identical sizes
$a = (Get-Item "D:\work\temp\viewer\target\world-viewer-1.0.0.jar").Length
$b = (Get-Item "D:\work\temp\viewer\target\world-viewer-1.0.0-shaded.jar").Length
"unsuffixed: $a  shaded: $b  match: $($a -eq $b)"
# Expected: match: True
```

### Step 6 — Verify classification.json is in place

**What:** the JAR doesn't include `classification.json` — it's read from disk at startup. Make sure it's where the daemon will look.

**Why:** without it, the daemon starts fine but every endpoint returns `category: null`. Hard to notice unless you specifically check.

**Verify:**

```powershell
$jPath = "D:\work\temp\viewer\classification.json"
Test-Path $jPath
# Expected: True

(Get-Content $jPath -Raw | ConvertFrom-Json).PSObject.Properties.Name.Count
# Expected: 617
```

If `False`: the file should be in the repo; `git pull` to refresh. As a fallback you can copy from `docs/comfy-integration/reference/classification.json` (same content).

### Step 7 — Stop any existing daemon

**What:** if port 7080 is already bound, the new daemon will fail to start.

**Why:** Javalin/Jetty doesn't reuse ports; binding fails fast on conflict.

**Command:**

```powershell
$existing = (Get-NetTCPConnection -LocalPort 7080 -ErrorAction SilentlyContinue).OwningProcess |
            Select-Object -First 1
if ($existing) {
  Stop-Process -Id $existing -Force
  Start-Sleep -Seconds 1
  "Stopped PID $existing"
} else {
  "Port 7080 free"
}
```

**Verify:**

```powershell
(Get-NetTCPConnection -LocalPort 7080 -ErrorAction SilentlyContinue) -eq $null
# Expected: True
```

### Step 8 — Launch the daemon

**What:** start the JAR. Parses the `.db` for ~3 seconds, then serves on `:7080`.

**Why:** this is the actual thing you're trying to run.

**Command:**

```powershell
# Adjust the .db path if yours is elsewhere
$db = "D:\work\temp\ComfyEra14.db"

# Launch in background so this shell stays free
Start-Process -FilePath "$jdk\bin\java.exe" `
  -ArgumentList "-Xmx3g","-jar","D:\work\temp\viewer\target\world-viewer-1.0.0.jar",$db,"--port","7080","--no-browser" `
  -RedirectStandardOutput "D:\work\temp\viewer\logs\run.log" `
  -RedirectStandardError "D:\work\temp\viewer\logs\run.err" `
  -WindowStyle Hidden
```

**Emits:** a Java process. Logs in `viewer/logs/run.log`. Listens on `:7080`.

**Verify (with timeout — first parse takes a few seconds):**

```powershell
$ok = $false
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 2
  try {
    $s = (Invoke-WebRequest -Uri "http://localhost:7080/api/v1/status" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop).Content | ConvertFrom-Json
    if ($s.done) { "READY after $($i*2+2)s — parsed $($s.parsed) ZDOs"; $ok = $true; break }
  } catch {}
}
if (-not $ok) { "FAILED — check viewer/logs/run.log + run.err"; Get-Content "D:\work\temp\viewer\logs\run.err" -Tail 20 }
```

**Expected:** `READY after ~8s — parsed 8016512 ZDOs`.

**If it fails:** check the log files. Common causes:
- `Save file not found` → wrong `$db` path
- `ClassificationStore: loaded 0 entries` → `classification.json` not at expected location (the daemon tries `viewer/classification.json`, then the db's parent dir, then `D:/work/comfy/out/`)
- `OutOfMemoryError` → bump `-Xmx3g` to `-Xmx6g`

### Step 9 — Run the smoke test

**What:** exercises every patched and new endpoint, asserts the patches landed correctly. 17 checks.

**Why:** this is the contract — passes mean "all 6 PA slices are live." Fails mean a specific thing went wrong; the test tells you which.

**Command:**

```powershell
& powershell.exe -ExecutionPolicy Bypass -File "D:\work\temp\docs\comfy-integration\smoke-test.ps1"
```

**Verify:** exit code 0 + all 17 lines say `PASS` in green.

**Expected output:**

```
=== Comfy steward-view smoke test ===
Target: http://localhost:7080

  PASS  daemon /status is done
  PASS  world version is 35

--- PA1: v106 inventory patch ---
  PASS  uniqueItemTypes >= 600
  PASS  totalItemCount > 10M
  PASS  top item is Coins

--- PA3: classification injection ---
  PASS  top item has category
  PASS  byCategory present
  PASS  byTier present

--- PA4: forensics alerts ---
  PASS  at least 1 critical alert
  PASS  forensics alert types appear

--- PA5: forensics endpoints ---
  PASS  /forensics/top-coin-caches
  PASS  /forensics/server-issuers
  PASS  /forensics/guild-gear?issuer=...

--- PA6: UI integration ---
  PASS  Coin Caches tab in UI
  PASS  Server Issuers tab in UI
  PASS  Guild Gear tab in UI
  PASS  By Category section in Economy

=== Result: 17 passed, 0 failed ===
```

**If any check fails:** the test prints the assertion + error. Map by section:
- `--- PA1 fails ---` → Step 2 or 3 failed (WorldParser patch didn't make it into the JAR)
- `--- PA3 fails ---` → `classification.json` not loaded (Pre-flight 2 or Step 6)
- `--- PA4 fails ---` → AlertBuilder.class didn't make it into the JAR (Step 3)
- `--- PA5 fails ---` → ApiServer.class didn't make it (Step 3)
- `--- PA6 fails ---` → `index.html` not bundled (Step 4)

### Step 10 — Open the UI

**What:** the final visual confirmation.

**Command:**

```powershell
Start-Process "http://localhost:7080/"
```

**Verify:** the tab strip shows (left to right): Map, Portals, Players, Economy, Tombstones, Signs, Dropped, Alerts, Structures, Creatures, **🪙 Coin Caches**, **👑 Server Issuers**, **🎁 Guild Gear**, Selection. The three starred tabs are new.

Cross-reference against [`screenshots/`](screenshots/) — your UI should match.

---

## Outcome contract

If all 10 steps verify, you have:

- A running daemon at `http://localhost:7080/` with parsed `ComfyEra14.db` data in memory
- Correct chest economy data (618 unique item types, 13.7M total items — vs the pre-patch 110 / 65k)
- Item-level classification (every economy/forensics response carries `category`/`subcategory`/`tier`/`biome`/`source`)
- Three new alert types in `/api/v1/alerts`, including 1 CRITICAL (the DeerStew quality-overflow exploit detector)
- Three new forensics REST endpoints exposing coin caches, server issuers, and guild gear catalogs
- Three new SPA tabs visually surfacing all of the above
- An economy tab enhanced with category + tier aggregate chips

All 7 source-file changes are isolated and small (the largest diff is `index.html` at ~150 added lines). The data file `classification.json` is the only large asset (60 KB, 617 entries).

If the smoke test passes but the UI looks wrong, hard-refresh the browser (Ctrl+F5) — the SPA caches aggressively.

## Rebuild cycle for ongoing work

Every time you change a `.java` file, repeat Steps 2-3 (compile + bundle) for that file only. Step 5 (sync JARs) every time. Steps 7-8 to restart. Step 9 to verify.

For `index.html` changes: repeat Step 4 instead of Step 2-3.

Typical edit/test cycle: ~15 seconds end to end.

## Troubleshooting cheat-sheet

| Symptom | Likely cause | Fix |
|---|---|---|
| "Save file not found" on launch | wrong `.db` path | Step 8: check `$db` |
| Smoke test PA1 fails (`uniqueItemTypes` is 110) | WorldParser.class not in JAR | Step 3: re-run jar uf for `WorldParser.class` |
| Smoke test PA3 fails (`category` is null) | classification.json not loaded | Step 6 verify; check `viewer/logs/run.log` for `ClassificationStore: loaded N entries` (must be > 0) |
| Smoke test PA6 fails (tabs missing) | index.html not in JAR | Step 4: re-run |
| `Port 7080 in use` error on launch | stale daemon | Step 7 |
| UI shows old tabs after refresh | browser cache | Ctrl+F5 |
| All smoke tests pass but UI shows nothing | first-time Tabulator init on a tab requires it to be visible | click each new tab once |
| `OutOfMemoryError` | save too large for -Xmx3g | bump to -Xmx6g |
| Compile fails on jetty-servlet.jar | corrupt stub in lib/ | the `$jars` list in Step 2 excludes it; make sure you used that list |
