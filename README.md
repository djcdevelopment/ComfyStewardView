# ComfyStewardView

Valheim world-file (`.db`) parser, steward API, and browser viewer for high-player-count community servers.

The app runs as a single Java fat JAR. In normal mode it parses the world into an in-memory steward dashboard. In batch analytics mode it also writes a full-fidelity DuckDB cache and pre-rendered map layers for large-world GM investigations.

## Quick start

Simplest path on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-Viewer.ps1
```

The script will:
- ask for the world `.db` file path
- check that Java 17+ is installed
- download Maven locally for this repo if needed
- install the bundled `valheim-save-tools-fixed.jar` into the local Maven cache if needed
- build the jar
- start the viewer
- wait until it is ready
- open the browser automatically

If Windows blocks local scripts, use the exact command above from a PowerShell window.

Build the viewer jar before running it so the shaded artifact includes all runtime dependencies:

```powershell
cd viewer
mvn package -DskipTests
cd ..
```

Run the viewer against a save file:

```powershell
java -Xmx3g -jar viewer\target\world-viewer-1.0.0.jar `
  path\to\world.db `
  --port 7080 `
  --no-browser
```

Open `http://localhost:7080/`.

If startup fails with `NoClassDefFoundError: kotlin/jvm/internal/Intrinsics`, the jar was built without Kotlin stdlib. Rebuild after pulling the latest `viewer/pom.xml`.

Main tabs:
- Map
- Portals
- Players
- Economy
- Tombstones
- Signs
- Dropped
- Alerts
- Structures
- Creatures
- Coin Caches
- Server Issuers
- Guild Gear
- Selection

## Batch analytics mode

For million-ZDO investigation work, build a DuckDB cache and rendered overlays instead of sending raw point clouds to the browser:

```powershell
java -Xmx6g -jar viewer\target\world-viewer-1.0.0.jar `
  path\to\world.db `
  --rebuild-cache `
  --cache viewer\target\world-cache.duckdb `
  --render-layers `
  --render-dir viewer\target\rendered `
  --batch-only `
  --no-browser
```

Then start the viewer with the cache attached:

```powershell
java -Xmx6g -jar viewer\target\world-viewer-1.0.0.jar `
  path\to\world.db `
  --cache viewer\target\world-cache.duckdb `
  --render-dir viewer\target\rendered `
  --port 7080 `
  --no-browser
```

Supported analytics flags:

```text
--build-cache
--rebuild-cache
--cache <path>
--render-layers
--render-dir <dir>
--batch-only
--cache-fields
```

## Documentation

The project docs are centered in [`docs/comfy-integration/README.md`](docs/comfy-integration/README.md). The core integration and analytics docs are current through the July 2, 2026 DB-backed analytics work.

Useful entry points:

- [`docs/comfy-integration/BATCH_ANALYTICS_PLAN.md`](docs/comfy-integration/BATCH_ANALYTICS_PLAN.md) - DuckDB schema, rendered layers, DB-backed APIs, and next milestones.
- [`docs/comfy-integration/RETROSPECTIVE_BATCH_ANALYTICS.md`](docs/comfy-integration/RETROSPECTIVE_BATCH_ANALYTICS.md) - implementation retrospective for the analytics cache slice.
- [`docs/comfy-integration/BUILD_GUIDE.md`](docs/comfy-integration/BUILD_GUIDE.md) - build and rebuild workflow.
- [`docs/comfy-integration/ENHANCEMENT_PLAYBOOK.md`](docs/comfy-integration/ENHANCEMENT_PLAYBOOK.md) - extension roadmap and implementation patterns.
- [`docs/comfy-integration/LESSONS_LEARNED.md`](docs/comfy-integration/LESSONS_LEARNED.md) - format and domain discoveries worth preserving.
- [`docs/comfy-integration/smoke-test.ps1`](docs/comfy-integration/smoke-test.ps1) - quick endpoint verification script.

## Current feature surface

- Streaming world parse into `ZdoFlatStore` for the live steward dashboard.
- REST API for summaries, heatmaps, portals, players, economy, tombstones, signs, beds, dropped items, sectors, structures, alerts, and entity contracts.
- Item classification loaded from `viewer/classification.json`.
- Forensics routes for coin caches, server issuers, and guild gear.
- Optional DuckDB analytics cache with `world_snapshot`, `zdo`, `zdo_field`, `container_item`, and `render_cell`.
- Rendered overlay and DB-backed drilldown routes:
  - `/api/v1/rendered/manifest`
  - `/api/v1/rendered/{file}`
  - `/api/v1/db/zdo/query`
  - `/api/v1/db/containers/items`
  - `/api/v1/db/selection-summary`

## Still to build

This is the consolidated backlog pulled from the handoff docs and batch analytics plan:

- Cached ZDO explorer UI over `/api/v1/db/zdo/query`.
- Semantic location masks such as known-world radius and space-island filters.
- Build analytics and leaderboards by creator, prefab, sector, and zone.
- Container wealth reports by area, item type, crafter, and inferred owner.
- Creator-ID inference across beds, tombstones, portals, signs, wards, and build clusters.
- Portal hub analysis with outgoing destination mapping.
- Targeted custom-field watchlists backed by `--cache-fields`.
- Local bounded 3D prefab viewer.
- Per-container inventory drill-down in the live UI.
- Alert noise reduction for orphaned portals.
- Unresolved prefab/hash identification for several building, container, item-stand, and Ashlands dropped-item variants.

## Repo layout

```text
viewer/                          integrated Javalin app and frontend
viewer/src/main/java/            Java source
viewer/src/main/resources/static frontend assets
viewer/classification.json       item taxonomy loaded at startup
viewer/lib/                      runtime jars, including DuckDB
viewer/target/                   build outputs, jars, generated cache artifacts
docs/comfy-integration/          integration handoff and analytics docs
manual-zpackage-src/             patched ZPackage source used in earlier parser work
manual-zpackage-build/           compiled patched ZPackage classes
```

## License

See [LICENSE.md](LICENSE.md).
