# Comfy Steward View — integration handoff

This folder is the entry point for the steward-tooling work that landed in late May 2026. Read this README, look at the diagrams, then go pull at whatever you want to extend.

**What's running:** `D:\work\temp\viewer\` (the Javalin + Leaflet app at `http://localhost:7080/`), now reading v106 inventories correctly, with 617-item classification, guild-gear awareness, server-issuer detection, and 3 new forensics endpoints. The parser used to drop 99% of containers silently — that's fixed.

## ⚡ Where to start — pick one

| Goal | Go to |
|---|---|
| **"I want to investigate all ZDOs, build pieces, or container items"** | [BATCH_ANALYTICS_PLAN.md](BATCH_ANALYTICS_PLAN.md) - DuckDB cache, rendered layers, DB-backed APIs, Era16 baseline, and next milestones. |
| **"I want to build this from scratch right now"** | [BUILD_GUIDE.md](BUILD_GUIDE.md) — 10 numbered steps, every one with a verify command. ~15 minutes if Java 17 is installed. |
| **"It's already running, I just want to confirm everything's wired"** | Run the quick-verify block below (~30 seconds) or `smoke-test.ps1` (17 assertions). |
| **"I want to understand what's here before I touch anything"** | Read [LESSONS_LEARNED.md](LESSONS_LEARNED.md) and look at [diagrams/01-architecture.svg](diagrams/01-architecture.svg). |
| **"I want to extend it / use it on a different world"** | [ENHANCEMENT_PLAYBOOK.md](ENHANCEMENT_PLAYBOOK.md) — tiered ladder of enhancements (1=hours, 5=weeks). Every entry has architectural reasoning + paste-ready prompt for free chat models + verify command. Calls out what's portable vs ComfyEra14-tuned. |
| **"I just want to copy-paste a prompt for one specific thing"** | [LLM_PROMPT_GUIDE.md](LLM_PROMPT_GUIDE.md) — 10 self-contained prompts for common tasks. |

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
| [**BATCH_ANALYTICS_PLAN.md**](BATCH_ANALYTICS_PLAN.md) | **All-ZDO analytics plan.** DuckDB schema, batch CLI, rendered layer outputs, DB-backed routes, generated Era16 counts, and prioritized GM feature milestones. |
| [RETROSPECTIVE_BATCH_ANALYTICS.md](RETROSPECTIVE_BATCH_ANALYTICS.md) | Retrospective for the DuckDB analytics implementation: decisions, failed attempts, validation, and follow-up plan. |
| [README.md](README.md) | (this file) — index, quick verify, run instructions |
| [**BUILD_GUIDE.md**](BUILD_GUIDE.md) | **Step-by-step build contract.** Pre-flight checks, component manifest (what each file emits + why), 10 numbered steps with verify command after every one. Read this if you're touching the code. |
| [**ENHANCEMENT_PLAYBOOK.md**](ENHANCEMENT_PLAYBOOK.md) | **How to grow this on any worldfile.** What's portable vs ComfyEra14-tuned. 5-tier ladder of enhancements (any-world deeper queries → multi-tenant federation). Each entry: architectural reasoning, code/schema template, paste-ready prompt for any free chat model, verify command. Read this when planning the next sprint. |
| [RETROSPECTIVE.md](RETROSPECTIVE.md) | Decision tree of the session: what worked, what we tried + reverted, why we ended up on Path A |
| [LESSONS_LEARNED.md](LESSONS_LEARNED.md) | Technical discoveries worth carrying forward: v106 format, Engravings mod, guild gear pattern, player attribution, etc. |
| [LLM_PROMPT_GUIDE.md](LLM_PROMPT_GUIDE.md) | ~10 paste-ready prompts for common tasks (add an item, add an alert, add an endpoint, debug a parse failure, etc.). Each prompt is self-contained. |
| [smoke-test.ps1](smoke-test.ps1) | PowerShell one-shot that exercises every endpoint and confirms the patches landed (17 assertions, exit 0 = all good) |
| [diagrams/](diagrams/) | SVG diagrams (5) — architecture, data flow, build, integration points, extension map |
| [reference/](reference/) | The full analysis docs and our standalone toolkit references |
| [screenshots/](screenshots/) | Five labeled screenshots of the integrated UI (Map / Portals / Economy / Server Issuers / Guild Gear) |

## Diagrams (visual orientation)

| File | Shows |
|---|---|
| [diagrams/01-architecture.svg](diagrams/01-architecture.svg) | Layered components — parser → store → contracts → API → SPA — and where ClassificationStore plugs in |
| [diagrams/02-data-flow.svg](diagrams/02-data-flow.svg) | Sequence: `.db` bytes → ZDO stream → per-type dispatch → inventory decode → forensics tally → REST response |
| [diagrams/03-build-path.svg](diagrams/03-build-path.svg) | Historical manual rebuild path from the pre-Maven packaging workflow. Keep it for context only; use `mvn package -DskipTests` for current builds. |
| [diagrams/04-integration-points.svg](diagrams/04-integration-points.svg) | The 7 files we modified, what each change does, and which existing API/UI each lights up |
| [diagrams/05-extension-map.svg](diagrams/05-extension-map.svg) | Known LF (Looking For) extension areas, with priority + difficulty markers. Start here when planning the next sprint. |

## Run instructions

Simplest path for Windows users:

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-Viewer.ps1
```

That script prompts for the save file path, downloads Maven locally if needed, builds the jar, starts the server, waits for readiness, and opens the browser.
It also installs the bundled `valheim-save-tools-fixed.jar` into the local Maven cache on first run if that dependency is missing.

Build the fat JAR once before running it:

```powershell
cd viewer
mvn package -DskipTests
cd ..
```

Then start it. Maven is not needed at runtime.

```bash
cd D:\work\temp\viewer
java -Xmx3g -jar target/world-viewer-1.0.0.jar ../ComfyEra14.db --port 7080 --no-browser
```

If you hit `NoClassDefFoundError: kotlin/jvm/internal/Intrinsics`, the jar was packaged without Kotlin stdlib. Rebuild after pulling the latest `viewer/pom.xml`.

Open `http://localhost:7080/` in a browser. Tabs across the top: Map · Portals · Players · Economy · Tombstones · Signs · Dropped · Alerts · Structures · Creatures · **🪙 Coin Caches** · **👑 Server Issuers** · **🎁 Guild Gear** · Selection.

The starred three are new — see [LESSONS_LEARNED.md § Forensics tabs](LESSONS_LEARNED.md#forensics-tabs).

## Batch analytics mode

For GM investigations that need every ZDO, build a DuckDB cache and static map overlays in a batch run:

```powershell
java -Xmx6g -jar target\world-viewer-1.0.0.jar `
  C:\work\comfy\erasave\ComfyEra16.db `
  --rebuild-cache `
  --cache target\ComfyEra16.duckdb `
  --render-layers `
  --render-dir target\rendered-era16 `
  --batch-only `
  --no-browser
```

Then attach the generated cache to the viewer:

```powershell
java -Xmx6g -jar target\world-viewer-1.0.0.jar `
  C:\work\comfy\erasave\ComfyEra16.db `
  --cache target\ComfyEra16.duckdb `
  --render-dir target\rendered-era16 `
  --port 7080 `
  --no-browser
```

The cache keeps all ZDO rows in DuckDB and the UI uses rendered overlays plus bounded drilldown routes. See [BATCH_ANALYTICS_PLAN.md](BATCH_ANALYTICS_PLAN.md) for schema, API details, and the generated Era16 baseline.

## Build / rebuild

**See [BUILD_GUIDE.md](BUILD_GUIDE.md)** for the full contracted walkthrough with verify commands at each step. The short version:

| What changed | What you re-do |
|---|---|
| Any code or resource under `viewer/` | `cd viewer && mvn package -DskipTests` |
| `viewer/classification.json` | Nothing to build — it's read from disk at startup. Restart the daemon (steps 7-8). |
| Any of the above | Restart the daemon, then run `smoke-test.ps1`. |

Typical cycle: rebuild, restart, smoke test.

**Historical note:** older handoff material described a manual rebuild path around a broken packaging setup. The current supported build is `mvn package -DskipTests`, and the current `pom.xml` explicitly includes Kotlin stdlib so the fat jar does not fail at runtime with `kotlin/jvm/internal/Intrinsics`.

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
