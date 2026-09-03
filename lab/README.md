# Steward Spatial Lab

An interaction lab—and the focused public world view promoted from it—for Steward's spatial
analysis loop:

> choose a lens → see the large-scale signal → inspect an area → reveal exact objects → step inside the exact selection

The experimental lab remains separate so scale, menus, gestures, image generation, and
instrumentation can change aggressively without destabilizing the deployed Steward UI. The same
repository now owns the deliberately constrained public profile at
[am4.tail8e749c.ts.net/world](https://am4.tail8e749c.ts.net/world/). It reads derived DuckDB analytics
caches; world saves, generated artifacts, secrets, and deployment receipts are deliberately excluded
from Git.

Run commands in this README from the `lab/` directory.

## Public Comfy Era 17 view

The live public profile is deliberately narrower than the lab.
It exposes one polished tool: Comfy Era 17 build density over snapshot-matched terrain and water,
from the world overview through bounded inspection, exact objects, and a free-camera 3D view of an
exact bounded selection. The server, not a query string
or hidden CSS, enforces that boundary:
the public bootstrap contains only snapshot 107 and the Build density lens, render-job routes do not
exist, and artifact/query routes reject anything outside that scope. A muted topographic context is
built offline from Valheim's 2048 px map/height/forest caches and snapshot 107's TCData terrain edits;
the all-ZDO 320 m image remains available only as a fallback navigator layer.

The public map opens on the enhanced topographic terrain with no analysis or territory overlay.
Its header offers two optional, mutually exclusive questions over that neutral canvas:

- **Heatmap** adds construction intensity over the muted terrain. **Biomes** replaces it with
  snapshot-matched territory controls and brings the enhanced 20 m contours, widened 100 m index
  contours, and clearer coastlines fully forward. Selecting the active tool again returns to neutral
  terrain; switching tools directly keeps them mutually exclusive. Biome choices stay selected while
  the tool is closed. **None** leaves the enhanced terrain unmarked; clicking the map or a header choice adds
  only those highlighted territories, and multiple choices are OR-ed together. A green inspection area
  intersects that territory scope. Ocean includes water and the world beyond the 10.5 km playable edge. Deep North includes
  only the northern polar territory; Black Forest, scattered non-polar Mountain, and unclassified land are grouped as
  Mountains + Forest. Clicking the empty canvas beyond the circular globe is reserved for panning and does not select or inspect.

- **Quick start guide** opens automatically once per browser after the map is ready, unless the visitor
  is returning from Discord authentication. Every dismissal is remembered under a versioned key; the
  `?` action always opens the guide again.
- **Explore the build** appears in the inspector's right column in both Heatmap and Biomes. Up to 5,000
  pieces open directly; 5,001–250,000 require an inline confirmation in that same location; larger
  selections must be tightened. The new tab rebuilds the authoritative selection server-side, then
  renders oriented prefab envelopes with shaded or wireframe geometry. The default orbit camera uses
  mouse drag to look, WASD to travel, and Q/E for elevation; pointer-locked free flight remains available.
  It never substitutes a sample. A Biomes **Inspect** action means every matching territory across the
  published world and is labeled as worldwide through confirmation and in the scene. The same confirmed action can render the
  current GPU-authored view to PNG without asking the server for a second raster representation.
  Kilometre-scale and vertically separated selections start on a useful dense **Home** cluster;
  **Frame all** remains available for the complete scene.
- **Submit feedback** is anonymous by default. A visitor can optionally use Discord OAuth's
  `identify` scope to attach a verified display name. The access token is discarded immediately;
  the feedback is delivered by webhook to the private Steward feedback channel and explicitly pings
  the configured owner.

Build the snapshot-only public cache from the production analytics cache and the two geometry receipts:

```powershell
.\tools\Build-PublicCache.ps1 `
  -SourceCache 'E:\omen\steward-era17\out\world-cache.duckdb' `
  -ContextManifest '.\data\era17-context\107\manifest.json' `
  -BuildingGeometry 'E:\omen\steward-era17-arch\building-geometry.parquet' `
  -PieceGeometry 'C:\work\baseline\tools\selfie-stick\out\era17\arch\piece-geometry.json'
```

Public-cache schema v3 remains a derived lab artifact. It contains only the published BUILDING rows,
sanitized coordinates and rotations, biome membership, and a 974-prefab geometry lexicon with source
receipts. It does not alter the production `viewer` cache schema and does not expose creator/owner
identity, flags, raw fields, or source paths. Scene responses additionally withhold absolute Y and the
exact 3D world origin; only selection-local transforms leave the server.

Run that same profile locally with the prepared Era 17 cache and artifacts:

```powershell
java -jar target/steward-spatial-lab-0.1.0-SNAPSHOT.jar serve `
  --cache data/era17-public.duckdb `
  --artifacts data/era17-artifacts `
  --context-manifest data/era17-context/107/manifest.json `
  --snapshot 107 --public --port 8092 --no-browser
```

### One-time Discord setup on AM4

1. Create a private `#steward-feedback` channel and an incoming webhook for that channel.
2. Create a Discord application, add
   `https://am4.tail8e749c.ts.net/world/api/auth/discord/callback` as an OAuth2 redirect, and use only
   the `identify` scope.
3. Enable Discord Developer Mode and copy the user ID that should be pinged.
4. On OMEN, copy [.env.example](.env.example) alongside this README as `.env` and fill in the four
   Discord values. The file is Git-ignored; the deploy script transfers it into AM4's private
   deployment directory and applies mode `600`. No secrets need to be typed into AM4.

No bot token is needed. Deploy with:

```powershell
.\tools\Deploy-World.ps1
```

The deploy builds a separate 3 GB-capped `steward-world` container on loopback port 7081. On first
use it derives a compact, snapshot-107-only Build density and geometry query cache and the terrain/biome context
on OMEN, then stages those immutable assets with the prebuilt Era 17 image ladder. The public
process never opens or mounts the production DuckDB file. Before starting anything, deployment verifies
snapshot 107's file hash against the running production cache and verifies every context image checksum.
Deployment requires a clean worktree and archives its source from the committed `lab/` tree through Git, ensuring
the release ID, staged bytes, and Linux shell line endings describe the same revision.
It then checks the narrow API contract, exact 862-piece pilot package, 22,387-piece confirmed stress
package, both capacity denials, and confirms `/steward` stayed healthy. If the public route has
not been mounted, it prints the single additive
`tailscale funnel --set-path` command; it never resets existing Funnel routes.

### Architecture and launch record

- [Spatial lab and public map contract](docs/LAB_CONTRACT.md)
- [Public world launch retrospective](docs/RETROSPECTIVE_2026-09-03_PUBLIC_WORLD.md)
- [Selection-to-3D R&D retrospective](docs/RND_SELECTION_3D_2026-09-03.md)
- [Architecture decision records](docs/adr/README.md)

The generated `tools/deploy-world-receipt.json` records the deployed release, snapshot and asset
checksums, public verification result, and confirmation that the production container was untouched.
It is intentionally ignored because it describes a workstation-specific deployment event.

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

Build a save-matched terrain package from a release DB/FWL pair and Valheim's generated cache files:

```powershell
.\tools\Build-TerrainContext.ps1
.\lab.ps1 serve -ContextManifest '.\data\era17-context\107\manifest.json'
```

The builder is read-only and refuses a live AppData world database. It validates the DB hash and FWL
world ID against the rendered artifact manifest, then applies height, paint, and legacy road records
from the save. It emits restrained and contour-forward 2048 px overview/4096 px detail pairs, a stable
indexed biome mask, and a private provenance manifest. The browser switches resolution as you zoom; all images share exact `[-12288, 12288]`
world-edge bounds. A standalone `-ContextImage` remains supported for local experiments.

To generate the first scale ladder from the command line:

```powershell
.\lab.ps1 render -Snapshot 108 -Lens 'build-density,birch-trees,all-zdos' `
  -Resolutions '320,160,80,64,16'
```

The same job can be launched from the lab's Job bench, where query time, image time, file size,
total duration, cache hits, cancellation, simulated latency, and injected failure are visible.
The result explicitly distinguishes newly generated rasters from cached artifacts, so a fast cache
hit cannot masquerade as expensive generation.

The wheel or trackpad is the primary zoom control. Hold `Shift` and drag anywhere on the map for an
optional precision gold dashed zoom window; the persistent **Box zoom** tool offers the same marquee
without holding a modifier. Both gestures change only the viewport; **Render active lens** creates the
checked full-world resolution ladder.

The map prompt names the current semantic scale and the payoff of the next step. Whenever a raster is
visible, its gold action is **Inspect an area**; zoom remains on the wheel at every scale. Inspection
results open in the right-column **Inspect** tab, where the selection summary and ranked prefab
explanation can use the full vertical workspace without covering the map. The first response explicitly
shows the top 10 of the complete category count, and **Show all in selection** expands the real grouped
result rather than a client-side sample.

The cache chip names the worlds actually present in the attached read-only cache. Dense exact queries
never draw an arbitrary database-order prefix: the complete raster remains visible until every exact
object in the viewport fits within the 5,000-point display budget. Inspection is independent of that
display budget: a green selection returns its complete aggregate count and explanation, and identifies
when exact dots remain hidden. Once the count is known, **Show items** draws every selected position when
the green area contains at most 5,000 positions. A larger selection stays as a complete raster-backed
summary and asks for a tighter green area instead of showing a biased prefix. In Pan mode, hold and
drag the map; the grab cursor changes to a closed hand for the duration of the gesture.

Inspection also freezes the authoritative snapshot, lens, bounds, and biome scope used by the 3D link.
The scene URL carries that declarative scope, not object data; opening or sharing it causes the server to
re-run and revalidate the exact selection. For a fixed release and scope, the binary package is
family-sorted and deterministic. It contains a compact transform and envelope per piece plus an
integrity-bound manifest, so one fetch can
drive both shared-cube shaded and wireframe pipelines. Unknown prefabs remain visible as red pivot
markers instead of being discarded. The browser converts Unity coordinates to a right-handed,
selection-local frame and deliberately withholds absolute Y and origin values from the public UI.

Biome mode is outline-first at world and regional scales. A presentation-only lasso mask closes 36 m
hairline fractures and rounds isolated pixel tendrils without changing the authoritative biome mask used
for object membership. Its selected territories use a clear translucent wash and a brighter, slightly
wider supersampled border rather than enlarging the source pixels. Object dots appear automatically only when a
close viewport fits the 5,000-point display budget.
An explicit biome or green-area inspection may instead draw a deterministic representative sample of at
most 5,000 matching objects while keeping exact aggregate totals. Its individual-object list is
cursor-paged in groups of 100, so visitors can traverse the complete result without requesting millions
of markers at once. Every biome and area query is constrained to the published
`[-26500, 26500] × [-20500, 27500]` world bounds.

The 16 metre image remains the finest full-world artifact. Once a bounded viewport fits within the
exact-object budget, the browser derives 8 metre and then 4 metre local density surfaces from that same
complete query. The finer surface and the dots therefore describe the same objects; a truncated result
produces neither, and the complete 16 metre raster remains authoritative until the view is tighter.
When local detail arrives it replaces, rather than stacks over, the 16 metre analysis image. The terrain
context remains at the chosen opacity so land and coastlines stay readable beneath 8/4 metre cells and
exact points; hold **peek beneath the analysis** to temporarily mute the analysis.
Close-detail transitions are double-buffered: movement pauses the exact dots but retains the last complete
8/4 metre surface until its replacement image has decoded. Hidden full-world rasters refresh without a
crossfade, so they cannot flash back over a valid local surface.

Raster surfaces use smooth browser interpolation by default across the entire 1000/320/160/80/64/16/8/4 metre
ladder, so neighboring cells read as a continuous field while zooming. **Cell grid** switches every raster
back to hard pixel edges for auditing the underlying bins. This display choice never changes cell values,
legend thresholds, point queries, or generated artifacts.

The analysis palette uses a scale-locked focus curve: 320 m and coarser overviews retain their absolute
maximum, then 160/80 m surfaces progressively introduce the occupied-cell P99.5 cap used at 64 m and finer.
This keeps a large parent cell from painting an implausibly broad coral region while preserving strong local
highlights. The 1 km overview also uses a quieter contrast exponent so its physically enormous cells locate
regions without flooding them with hotspot color. Capped values share the brightest color and the legend marks them with `+`; the narrative still
reports the absolute hottest cell. Coarse analysis artifacts receive a nearest-neighbor display copy
before smooth browser interpolation—3x at the 320 m settlement-region step and 2x elsewhere—tightening
cell transitions without changing their values or bounds. The newly sharper 320 m layer is capped at 92%
overview opacity so it does not overpower the terrain.
World-overview zooms below z-4 otherwise hold analysis at 100% opacity; at z-4 and inward, the detail-opacity
control takes over so enlarged cells do not become glare. The enhanced terrain is the neutral starting
canvas. It uses the restrained 62% treatment beneath the Heatmap, then comes fully forward again when
Heatmap is closed or Biomes is active. The all-ZDO
fallback keeps the earlier subordinate neutral mapping.

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
palette and opacity changes without rebuilding images. The full-world scale ladder is 1000, 320, 160, 80,
64, and 16 metre cells. Bounded 8 and 4 metre client-side surfaces bridge the last step into exact
points without allocating enormous full-world images.

## Safety and data boundary

- The local lab binds to `127.0.0.1` by default. The public container listens internally on all
  interfaces, but Docker publishes it only on AM4 loopback (`127.0.0.1:7081`).
- SQL is assembled only from built-in lens definitions; browser input cannot supply SQL.
- Cache access is read-only.
- The public 3D endpoint has a dedicated one-at-a-time concurrency gate and six-requests-per-minute
  client limit. It serves only exact selections: 5,000 direct, 250,000 after an explicit override, and
  no server or client sampling. It counts before materializing so an over-limit scope is rejected
  without allocating a scene package.
- The scene is a geometry-envelope explorer, not a claim of native mesh, terrain, collision, or material
  fidelity. Estimated envelopes and unknown markers are labeled in the UI and package manifest.
  Oversized environmental or compound catalog envelopes are preserved as small red pivot markers;
  this keeps every ZDO in the exact result without presenting a tree or location proxy as a giant block.
- `.db`, `.duckdb`, generated images, and local configuration are ignored by Git.
- The production repository and production deployment are not modified by this lab.

## Verification

```powershell
.\mvnw.cmd test
python -m unittest discover -s tools\tests -p 'test_*.py'
node --check src\main\resources\static\lab.js
node --check src\main\resources\static\scene.js
node tools\browser-smoke.mjs http://127.0.0.1:8092/ data\map-smoke.png --public-inspect --terrain --biomes --terrain-close
node tools\scene-browser-smoke.mjs http://127.0.0.1:8092/ data\scene-smoke
```

The scene browser gate uses hardware WebGPU and checks the exact pilot and stress populations, package
receipts, shaded/wireframe controls, Home/full-selection framing, orbit-WASD and free-flight camera movement, GPU-authored PNG
capture, browser/validation errors, device loss, startup under 2 seconds, and p95 frame time at or below
20 ms. Passing `--large` also exercises the confirmed whole-Meadows scene against its explicit 10-second
startup and 50 ms p95 forced-scene budgets. It intentionally has no WebGL fallback: visitors
without WebGPU receive an explicit unsupported screen and can return to the map.

## Why this remains a lab

The 3D release is the latest result of the lab's `/rnd` mode: isolate one uncertain edge, write down a
falsifiable prediction, test the smallest real-data fixture that can disprove it, retain raw receipts,
and only then turn the stable behavior into tests and a public contract. That method took the project
from CAD import experiments and geometry lexicons through clustered architecture reconstruction to an
exact browser scene without pretending early prototypes were product promises. The full lineage,
measurements, reversals, and remaining unknowns are in the
[R&D retrospective](docs/RND_SELECTION_3D_2026-09-03.md).
