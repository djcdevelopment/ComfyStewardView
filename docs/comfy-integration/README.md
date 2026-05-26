# Comfy Steward View — integration handoff

This folder is the entry point for the steward-tooling work that landed in late May 2026. Read this README, look at the diagrams, then go pull at whatever you want to extend.

**What's running:** `D:\work\temp\viewer\` (the Javalin + Leaflet app at `http://localhost:7080/`), now reading v106 inventories correctly, with 617-item classification, guild-gear awareness, server-issuer detection, and 3 new forensics endpoints. The parser used to drop 99% of containers silently — that's fixed.

## Quick verify (5 commands, ~30 seconds)

```bash
# 1. Daemon up?
curl -s http://localhost:7080/api/v1/status | jq '.done'                            # → true

# 2. v106 patch live? (was 110 before patch)
curl -s http://localhost:7080/api/v1/economy?topN=1 | jq '.uniqueItemTypes'         # → 618

# 3. Classification injected? (was null before)
curl -s http://localhost:7080/api/v1/economy?topN=1 | jq '.topItems[0].category'    # → "Currency"

# 4. Forensics endpoint live? (PA5)
curl -s 'http://localhost:7080/api/v1/forensics/top-coin-caches?limit=1' | jq '.totalCachesTracked'  # → 182

# 5. New alerts firing? (PA4)
curl -s http://localhost:7080/api/v1/alerts | jq '.critical'                        # → 1 (DeerStew detector)
```

A PowerShell version of these is at `smoke-test.ps1` next to this README.

## Table of contents

| Doc | What's in it |
|---|---|
| [README.md](README.md) | (this file) — index, quick verify, run instructions |
| [RETROSPECTIVE.md](RETROSPECTIVE.md) | Decision tree of the session: what worked, what we tried + reverted, why we ended up on Path A |
| [LESSONS_LEARNED.md](LESSONS_LEARNED.md) | Technical discoveries worth carrying forward: v106 format, Engravings mod, guild gear pattern, player attribution, etc. |
| [LLM_PROMPT_GUIDE.md](LLM_PROMPT_GUIDE.md) | ~10 paste-ready prompts for extending the system using any free chat model (ChatGPT free, Claude.ai free, Gemini free). Each prompt is self-contained. |
| [smoke-test.ps1](smoke-test.ps1) | PowerShell one-shot that exercises every endpoint and confirms the patches landed |
| [diagrams/](diagrams/) | SVG diagrams (5) — architecture, data flow, build, integration points, extension map |
| [reference/](reference/) | The full analysis docs and our standalone toolkit references |
| [screenshots/](screenshots/) | Five labeled screenshots of the integrated UI (Map / Portals / Economy / Server Issuers / Guild Gear) |

## Diagrams (visual orientation)

| File | Shows |
|---|---|
| [diagrams/01-architecture.svg](diagrams/01-architecture.svg) | Layered components — parser → store → contracts → API → SPA — and where ClassificationStore plugs in |
| [diagrams/02-data-flow.svg](diagrams/02-data-flow.svg) | Sequence: `.db` bytes → ZDO stream → per-type dispatch → inventory decode → forensics tally → REST response |
| [diagrams/03-build-path.svg](diagrams/03-build-path.svg) | Source → javac → JAR update → daemon restart loop. The "no Maven required" recompile path that works around the corrupt jetty-servlet.jar stub. |
| [diagrams/04-integration-points.svg](diagrams/04-integration-points.svg) | The 7 files we modified, what each change does, and which existing API/UI each lights up |
| [diagrams/05-extension-map.svg](diagrams/05-extension-map.svg) | Known LF (Looking For) extension areas, with priority + difficulty markers. Start here when planning the next sprint. |

## Run instructions

The daemon is a fat JAR. Same invocation as before, no Maven needed at runtime.

```bash
cd D:\work\temp\viewer
java -Xmx3g -jar target/world-viewer-1.0.0.jar ../ComfyEra14.db --port 7080 --no-browser
```

Open `http://localhost:7080/` in a browser. Tabs across the top: Map · Portals · Players · Economy · Tombstones · Signs · Dropped · Alerts · Structures · Creatures · **🪙 Coin Caches** · **👑 Server Issuers** · **🎁 Guild Gear** · Selection.

The starred three are new — see [LESSONS_LEARNED.md § Forensics tabs](LESSONS_LEARNED.md#forensics-tabs).

## Build / rebuild

If you change Java source, the fast path (no Maven) is:

```powershell
# 1. Recompile changed files (excluding the corrupt jetty-servlet.jar)
$jdk = "C:\Users\<you>\.gradle\jdks\eclipse_adoptium-17-amd64-windows.2"  # or wherever your JDK 17 lives
$lib = "D:\work\temp\viewer\lib"
$jars = "jackson-annotations-2.17.2.jar","jackson-core-2.17.2.jar","jackson-databind-2.17.2.jar","javalin-6.3.0.jar","slf4j-api-2.0.13.jar","jetty-http.jar","jetty-io.jar","jetty-server.jar","jetty-util.jar" | % { "$lib\$_" }
$cp = "D:\work\temp\viewer\target\classes;" + ($jars -join ';')
& "$jdk\bin\javac.exe" -cp $cp -d "D:\work\temp\viewer\target\classes" path/to/ChangedFile.java

# 2. Update the JAR in place
cd D:\work\temp\viewer\target\classes
& "$jdk\bin\jar.exe" uf D:\work\temp\viewer\target\world-viewer-1.0.0-shaded.jar com/valheim/viewer/<your changed paths>.class
Copy-Item D:\work\temp\viewer\target\world-viewer-1.0.0-shaded.jar D:\work\temp\viewer\target\world-viewer-1.0.0.jar -Force

# 3. Restart the daemon
Stop-Process -Id (Get-NetTCPConnection -LocalPort 7080).OwningProcess -Force
# then launch the java -jar command from "Run instructions" above
```

Why no Maven: `lib/jetty-servlet.jar` is a 554-byte stub (corrupted at some point). `mvn package` blows up on it; targeted `javac` calls that exclude it work fine. See [diagrams/03-build-path.svg](diagrams/03-build-path.svg). Fixing the stub jar is a 5-minute job for anyone with Maven Central access — left as an exercise.

## What changed (one-line summary)

| File | Change |
|---|---|
| `viewer/src/main/java/com/valheim/viewer/parser/WorldParser.java` | v106 inventory format support; capture qual + crafter + customData |
| `viewer/src/main/java/com/valheim/viewer/store/ZdoFlatStore.java` | New fields: qualityOverflowSamples, serverIssuerCatalog, topCoinCaches, etc. + CoinCache inner class |
| `viewer/src/main/java/com/valheim/viewer/extractor/ClassificationStore.java` | **NEW** — loads classification.json, exposes item → {category, subcategory, tier, biome, source, mod} |
| `viewer/src/main/java/com/valheim/viewer/extractor/AlertBuilder.java` | New `buildForensicsAlerts()` — quality_overflow + server_issued + engravings_tracked alerts |
| `viewer/src/main/java/com/valheim/viewer/Main.java` | Loads ClassificationStore at startup, passes to ApiServer + AlertBuilder |
| `viewer/src/main/java/com/valheim/viewer/api/ApiServer.java` | Enriched `/economy` topItems + added 3 forensics endpoints |
| `viewer/src/main/resources/static/index.html` | 3 new tabs (🪙 Coin Caches, 👑 Server Issuers, 🎁 Guild Gear) + category/tier chips in Economy |
| `viewer/classification.json` | **NEW** — 617 items classified by category/subcategory/tier/biome/source/mod |

All changes are in this git tree; see `git log --since="2026-05-26"` for individual commits.

## Where the data lives

- World save: `D:\work\temp\ComfyEra14.db` (1.1 GB)
- Source classification: `D:\work\temp\viewer\classification.json` (60 KB, 617 entries — also available at `D:\work\comfy\out\classification.json` from the standalone toolkit)
- Reference analyses: `docs/comfy-integration/reference/` (copies of the analysis docs from `D:\work\comfy\`)

## Where to look first

- Just want it running? — Run instructions above + screenshots in `screenshots/`.
- Want to extend? — Read [LESSONS_LEARNED.md](LESSONS_LEARNED.md), then look at [diagrams/05-extension-map.svg](diagrams/05-extension-map.svg), then [LLM_PROMPT_GUIDE.md](LLM_PROMPT_GUIDE.md) for paste-ready prompts.
- Want to understand why we did it this way? — Read [RETROSPECTIVE.md](RETROSPECTIVE.md).
- Want the deep-byte details? — `reference/ref_v106_inventory_format.md` + `reference/ref_valheim_save_format.md`.
