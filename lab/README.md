# Steward Spatial Lab

An interaction lab—and the focused public world view promoted from it—for Steward's spatial
analysis loop:

> choose a lens → see the large-scale signal → scroll closer → inspect an area → reveal exact objects

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
from the world overview through bounded inspection and exact objects. The server, not a query string
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
- **Submit feedback** is anonymous by default. A visitor can optionally use Discord OAuth's
  `identify` scope to attach a verified display name. The access token is discarded immediately;
  the feedback is delivered by webhook to the private Steward feedback channel and explicitly pings
  the configured owner.

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
use it derives a compact, snapshot-107-only Build density query cache and the terrain/biome context
on OMEN, then stages those immutable assets with the prebuilt Era 17 image ladder. The public
process never opens or mounts the production DuckDB file. Before starting anything, deployment verifies
snapshot 107's file hash against the running production cache and verifies every context image checksum.
It then checks the narrow API contract and confirms `/steward` stayed healthy. If the public route has
not been mounted, it prints the single additive
`tailscale funnel --set-path` command; it never resets existing Funnel routes.

### Architecture and launch record

- [Spatial lab and public map contract](docs/LAB_CONTRACT.md)
- [Public world launch retrospective](docs/RETROSPECTIVE_2026-09-03_PUBLIC_WORLD.md)
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
- `.db`, `.duckdb`, generated images, and local configuration are ignored by Git.
- The production repository and production deployment are not modified by this lab.
