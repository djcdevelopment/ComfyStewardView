# ComfyStewardView

Valheim world-file (`.db`) parser, steward API, and browser viewer for high-player-count community servers.

The app runs as a single Java fat JAR. In normal mode it parses the world into an in-memory steward dashboard. In batch analytics mode it also writes a full-fidelity DuckDB cache and pre-rendered map layers for large-world GM investigations.

It also acts as the world intelligence and read model for the wider server stack: it retains a history of ingested saves with provenance, computes deltas between them, and serves a unified World / Changes / History / Explore shell. The ingest contract is in [ISLET_INTEGRATION_SPEC.md](docs/comfy-integration/ISLET_INTEGRATION_SPEC.md); prefab naming, which everything downstream depends on, is in [PREFAB_DICTIONARY.md](docs/comfy-integration/PREFAB_DICTIONARY.md).

For the architecture, the findings behind it, and the measurements, read the white paper — served alongside the app at **[/steward/whitepaper.html](https://am4.tail8e749c.ts.net/steward/whitepaper.html)**. Its source is [WHITEPAPER.html](docs/comfy-integration/WHITEPAPER.html), built into the jar by [tools/Build-Whitepaper.ps1](tools/Build-Whitepaper.ps1); the diagrams alone live in [docs/comfy-integration/diagrams/](docs/comfy-integration/diagrams/).

Processing and serving run on different hosts. OMEN parses saves and builds the DuckDB cache and map layers (~53 s and ~1.2 GB per 9M-ZDO world, and it keeps the growing snapshot history); AM4 only serves the published artifacts. [tools/Publish-Steward.ps1](tools/Publish-Steward.ps1) is the data lane — dry-run by default, `-Push` to publish. [tools/Deploy-Steward.ps1](tools/Deploy-Steward.ps1) remains the code lane. Deploy when the jar changes, publish when the world changes.

The v4 shell and spatial comparison release has been deployed through both lanes and verified at [the AM4 Steward endpoint](https://am4.tail8e749c.ts.net/steward/). This is a release verification record, not a guarantee that the live data will remain on any particular snapshot pair.

## Quick start

Recommended path for Windows users:

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-Viewer.ps1
```

This is the tested path for non-developers.

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

Manual build/run path for advanced users:

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

Primary tabs are **World**, **Changes**, **History**, and **Explore**. World retains the existing data-bearing views under grouped secondary navigation (Spatial, Inventories, Forensics, and Population); the three coin-forensics views now share a **Coin trail** surface. The selected snapshot and every comparison pair are shown explicitly in the shell.

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

The project docs are centered in [`docs/comfy-integration/README.md`](docs/comfy-integration/README.md). The unified raster/comparison UI contract and incremental milestone record are in [`docs/design/STEWARD_VIEW_V4_INTEGRATION_PLAN.md`](docs/design/STEWARD_VIEW_V4_INTEGRATION_PLAN.md).

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
- Unified World / Changes / History / Explore shell with grouped World navigation, explicit time-scope badges, legacy deep-link redirects, and a segmented Coin trail view.
- Snapshot-aware Map, Explore, and selection workflows; boot-snapshot views are labeled rather than silently following the snapshot selector.
- Snapshot Map rasters for Build density, Dropped, All ZDOs, and Coins at every cell size advertised by the manifest, with client-side ramp and opacity controls.
- Changes Map rasters for Build activity and All ZDO change, composited from aligned added/removed gray8 channels with a dual logarithmic legend. Changes and Map share the same ordered comparison pair.
- Rendered overlay and DB-backed drilldown routes:
  - `/api/v1/rendered/manifest`
  - `/api/v1/rendered/{file}`
  - `/api/v1/rendered/delta/manifest?from=N&to=M`
  - `/api/v1/rendered/delta/{file}?from=N&to=M`
  - `/api/v1/db/zdo/query`
  - `/api/v1/db/containers/items`
  - `/api/v1/db/selection-summary`
- OMEN precomputes aligned added/removed gray8 rasters for every ordered pair among up to each world's latest six snapshots; AM4 serves only manifest-advertised artifacts and never rasterizes on demand.

Release verification covered a clean Maven package with all three delta-raster tests passing, live status and snapshot discovery, an advertised comparison manifest with both layers at four cell sizes, both PNG channels, and browser rendering of the Changes compositor and dual legend without runtime errors.

## Still to build

This is the consolidated backlog pulled from the handoff docs and batch analytics plan:

- Semantic location masks such as known-world radius and space-island filters.
- Build analytics and leaderboards by creator, prefab, sector, and zone.
- Container wealth reports by area, item type, crafter, and inferred owner.
- Creator-ID inference across beds, tombstones, portals, signs, wards, and build clusters.
- Portal hub analysis with outgoing destination mapping.
- Targeted custom-field watchlists backed by `--cache-fields`.
- Local bounded 3D prefab viewer.
- Per-container inventory drill-down in the live UI.
- Alert noise reduction for orphaned portals.
- Snapshot-aware point overlays; they are intentionally labeled as pinned to the boot snapshot today.
- The remaining v4 operational-polish work: consistent stale/retry states across every leaf view, spawn-time aggregate/histogram, accessibility and reduced-motion checks, responsive regression coverage, and publish telemetry.
- Naming the residual unresolved prefab hashes (129 hashes / 0.54% of ZDOs on ComfyEra16, mostly modded and ZoneSystem location prefabs). The bundled dictionary resolves 99.5%; `GET /api/v1/prefabs/unresolved` is the live worklist. See [docs/comfy-integration/PREFAB_DICTIONARY.md](docs/comfy-integration/PREFAB_DICTIONARY.md).

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
