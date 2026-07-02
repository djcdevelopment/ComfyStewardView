# ComfyStewardView

Valheim world-file (`.db`) parser + REST API + Leaflet/Tailwind SPA for stewarding high-player-count community servers.

Runs as a single Java fat-JAR. Loads a `.db` into memory in ~8 seconds, serves a categorized, forensics-enriched dashboard at `http://localhost:7080/`.

## Quick run

```
java -Xmx3g -jar viewer/target/world-viewer-1.0.0.jar path/to/ComfyEra14.db --port 7080 --no-browser
```

For million-ZDO investigation work, build an optional DuckDB analytics cache and pre-rendered map layers instead of pushing every point to the browser:

```
java -Xmx6g -jar viewer/target/world-viewer-1.0.0.jar path/to/ComfyEra16.db --rebuild-cache --cache viewer/target/world-cache.duckdb --render-layers --render-dir viewer/target/rendered --batch-only --no-browser
```

Then open `http://localhost:7080/` — tabs: Map, Portals, Players, Economy, Tombstones, Signs, Dropped, Alerts, Structures, Creatures, Coin Caches, Server Issuers, Guild Gear, Selection.

## Start here: `docs/comfy-integration/`

The integration handoff (everything new, plus how to build / extend / re-screenshot) lives at:

**[`docs/comfy-integration/README.md`](docs/comfy-integration/README.md)** — entry point with a "where to start" decision matrix.

Highlights:

- [`docs/comfy-integration/BATCH_ANALYTICS_PLAN.md`](docs/comfy-integration/BATCH_ANALYTICS_PLAN.md) - DuckDB cache, rendered layer, API, and next-milestone plan for all-ZDO GM investigations.
- [`docs/comfy-integration/RETROSPECTIVE_BATCH_ANALYTICS.md`](docs/comfy-integration/RETROSPECTIVE_BATCH_ANALYTICS.md) - implementation retrospective for the DB-backed analytics slice.
- [`docs/comfy-integration/BUILD_GUIDE.md`](docs/comfy-integration/BUILD_GUIDE.md) — 10 numbered build steps, every one with a verify command. ~15 min total.
- [`docs/comfy-integration/ENHANCEMENT_PLAYBOOK.md`](docs/comfy-integration/ENHANCEMENT_PLAYBOOK.md) — 5-tier ladder of extensions (any-world deeper queries -> multi-tenant). Each entry has architectural reasoning, code template, paste-ready prompt for free chat models, verify command.
- [`docs/comfy-integration/LESSONS_LEARNED.md`](docs/comfy-integration/LESSONS_LEARNED.md) — technical discoveries (v106 inventory format, Engravings mod quality repurposing, guild-gear pattern, BED_OWNER player attribution).
- [`docs/comfy-integration/diagrams/`](docs/comfy-integration/diagrams/) — 5 SVGs: architecture, data flow, build path, integration points, extension map.
- [`docs/comfy-integration/screenshots/`](docs/comfy-integration/screenshots/) — 5 UI captures (Map, Portals, Economy, Server Issuers, Guild Gear).
- [`docs/comfy-integration/smoke-test.ps1`](docs/comfy-integration/smoke-test.ps1) — 17 assertions; exit 0 = all patches landed.

## Repo layout

```
viewer/                          - integrated Javalin + Jetty + Leaflet/Tailwind SPA (the running app)
viewer/src/main/java/            - Java source
viewer/src/main/resources/static - SPA (single index.html)
viewer/classification.json       - 617-item taxonomy (loaded at startup)
viewer/target/                   - build outputs (JAR + .class files)
docs/comfy-integration/          - integration handoff (read this first)
docs/                            - broader planning docs (community survival platform)
LICENSE.md                       - license
```

## License

See [LICENSE.md](LICENSE.md).
