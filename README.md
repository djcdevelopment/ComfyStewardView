# Steward Spatial Lab

An intentionally disposable interaction lab for Steward's spatial analysis loop:

> choose a lens → see the large-scale signal → box-zoom → receive finer evidence → inspect exact objects

The lab is a separate repository so scale, menus, gestures, image generation, and instrumentation
can be changed aggressively without destabilizing the deployed Steward UI. It reads Steward's
DuckDB analytics cache; world saves and generated artifacts are deliberately excluded from Git.

## Start with the existing local publish cache

```powershell
.\lab.ps1 serve
```

The default cache is `%LOCALAPPDATA%\steward-publish\out\world-cache.duckdb` when present.
Open `http://127.0.0.1:8091`.

To keep job activity visible in a terminal, run this in a second window:

```powershell
.\lab.ps1 watch-jobs
```

It polls every 15 seconds and prints active progress, current phase, elapsed time, the last log
line, and the cached-versus-created outcome. Change the cadence with `-IntervalSeconds 5`, or
launch the monitor automatically beside the server with `.\lab.ps1 serve -JobMonitor`.

An authoritative full-world terrain/biome PNG can replace the inferred land mask without changing
the interaction model:

```powershell
.\lab.ps1 serve -ContextImage 'D:\worlds\MyWorld-map.png'
```

The first pass aligns that image to Steward's standard playable-world bounds.

To generate the first scale ladder from the command line:

```powershell
.\lab.ps1 render -Snapshot 108 -Lens 'build-density,birch-trees,all-zdos' `
  -Resolutions '320,64,16'
```

The same job can be launched from the lab's Job bench, where query time, image time, file size,
total duration, cache hits, cancellation, simulated latency, and injected failure are visible.
The result explicitly distinguishes newly generated rasters from cached artifacts, so a fast cache
hit cannot masquerade as expensive generation.

Hold `Shift` and drag anywhere on the map for a temporary gold dashed zoom window. The persistent
**Box zoom** tool offers the same marquee without holding a modifier. Both gestures change only the
viewport; **Render active lens** creates the checked full-world resolution ladder.

The map prompt names the current semantic scale and the payoff of the next step. Its gold action
activates Box zoom directly, then changes to **Inspect an area** once exact objects are available.

## Prepare a cache from a save

The lab does not duplicate Steward's hand-written save parser. It emits the exact command that
uses the neighboring production JAR to create a lab cache:

```powershell
.\lab.ps1 prepare-command -WorldPath 'D:\worlds\MyWorld.db' `
  -CachePath "$PWD\data\world-cache.duckdb"
```

Run the printed command, then start the lab with the same `-CachePath`. The command never writes
to the source save. Use a copied or immutable save artifact, not a live server file.

## First-pass lenses

- Build density — where construction and likely server load concentrate.
- Dropped items — where unattended objects accumulate.
- All ZDOs — where persistent world state concentrates; also used as the inferred land mask.
- Coins — where container wealth concentrates.
- Birch trees — a real custom prefab lens over `Birch1`, `Birch2`, and autumn variants.
- Tombstones — where player deaths concentrate.

Every lens is rendered as an aligned gray8 raster. Color is applied in the browser, allowing
palette and opacity changes without rebuilding images. The first scale ladder is 1000, 320, 64,
and 16 metre cells; exact points appear after the raster has done its job.

## Safety and data boundary

- The HTTP server binds to `127.0.0.1` only.
- SQL is assembled only from built-in lens definitions; browser input cannot supply SQL.
- Cache access is read-only.
- `.db`, `.duckdb`, generated images, and local configuration are ignored by Git.
- The production repository and production deployment are not modified by this lab.
