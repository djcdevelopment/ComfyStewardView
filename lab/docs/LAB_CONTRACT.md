# Spatial lab and public map contract

## Experience profiles

| Profile | Purpose | Enforced scope |
|---|---|---|
| Lab | Explore lenses, rendering, scale transitions, gestures, and failure behavior. | All built-in lenses, available snapshots, job controls, and test instrumentation. |
| Public world | Let the community read Comfy Era 17 without exposing the experimental workbench or private cache. | Snapshot 107, Build density evidence, snapshot-matched terrain and biomes, bounded read-only queries, and feedback. |

Public scope is a server contract, not a hidden-client convention. Public bootstrap and manifests
contain only the published snapshot and lens. Requests for other snapshots, lenses, or artifacts are
rejected, and render-job routes are not registered. The public process reads a separately exported
cache rather than the production cache.

## Public terrain-first loop

1. The map opens in `terrain`: enhanced shorelines and elevation contours are visible, with no
   analysis raster, exact-object dots, biome outline, construction marks, or legend. The story is
   **Follow the shape of the world**.
2. **Heatmap** adds the construction-density ladder over the restrained terrain. Selecting Heatmap
   again closes it and returns to terrain.
3. **Biomes** replaces Heatmap with territory controls over the enhanced terrain. Biome selections
   are retained when the tool is closed and restored when it reopens. **None** keeps the controls open
   while leaving the terrain visually unmarked.
4. Heatmap and Biomes are mutually exclusive. They are questions layered over the world, not peer
   basemaps.
5. Wheel or trackpad scrolling zooms. Holding and dragging pans. Clicking blank canvas outside the
   circular globe never selects or inspects in any state.
6. A green area enables inspection. Inspection returns complete aggregates, a deterministic map
   sample when necessary, and cursor-paged objects rather than implying that a database-order prefix
   is complete.
7. Quick Start opens after the public map becomes ready once per browser-versioned dismissal key.
   CTA, close button, Escape, and backdrop all record dismissal; `?` always reopens it. A Discord OAuth
   return suppresses automatic opening so feedback retains dialog priority.

## Analytical evidence contract

1. A coarse raster reveals concentrations without pretending to explain them. The in-map prompt names
   the current scale, the next payoff, and a direct action.
2. Wheel or trackpad scrolling is the primary zoom gesture. Shift-drag or persistent Box zoom remains
   an optional lab precision shortcut: both show the same gold dashed window and change only the
   viewport.
3. Inspect is a one-shot gesture. Selecting a region opens Inspect, pins the green evidence window,
   and returns the map to Pan. The explanation reports the complete aggregate total, density, world
   share, and an explicit top-10-of-N prefab preview. The lab can retrieve the complete grouped list;
   the public item view is cursor-paged in groups of 100.
4. At close range, bounded 8 m and 4 m density surfaces bridge the full-world 16 m raster into exact
   points. Each local surface and its points come from the same complete bounded query.
5. If a viewport exceeds the 5,000-point display budget, no spatially biased prefix is shown. A green
   selection still reports its complete aggregate count. Exact selected positions are drawn at or
   below the budget; larger results use a deterministic representative sample where the public
   experience calls for map context and otherwise ask for a tighter area.
6. Pan mode uses a grab cursor and visibly closes the hand only while a held drag moves the map.
7. A local surface replaces the 16 m analysis raster instead of blending two analytical grids. With
   snapshot-matched context, terrain remains readable at the requested opacity; press-and-hold peek
   temporarily mutes the analysis. The inferred all-ZDO fallback remains a subordinate locator layer.
8. Close-detail surfaces are double-buffered. The last complete surface remains authoritative during
   movement and is replaced only after the next surface image loads; hidden coarse rasters never
   crossfade over it.
9. Smooth surface sampling is the default at every raster scale. Cell grid reveals the same discrete
   bins with hard edges; changing this display mode never changes data, thresholds, or queries.
10. Analysis tone is scale-locked. The 1 km overview quiets its midrange, the 320 m settlement step
    keeps its absolute maximum, 160/80 m progressively introduce focus, and 64 m and finer use the
    occupied-cell P99.5 cap. The 320 m layer uses a 3× display copy and other coarse artifacts use 2×
    copies to tighten smooth interpolation without changing evidence. The legend names the mode,
    marks capped thresholds with `+`, and retains the absolute maximum in the narrative.
11. Heatmap opacity is semantic by scale. The 320 m layer is capped at 92%; z-4 and closer use the
    adjustable detail-opacity target, normally 82%. Terrain is shown at the manifest's restrained
    opacity under Heatmap and at full opacity in terrain or Biomes.

## Independent dimensions

| Dimension | User question | Lab control | Public control |
|---|---|---|---|
| Question | What am I investigating? | Build, dropped, all ZDOs, coins, birch, tombstones | Neutral terrain, Heatmap, or Biomes |
| Time | When, or what changed? | One selected snapshot; delta is deferred | Published snapshot 107 |
| Scale | How much detail? | Auto, 1000/320/160/80/64/16 m world, 8/4 m local, exact points | Semantic zoom through the same Build density ladder |
| Surface | How should raster cells read? | Smooth field or explicit cell grid | Smooth Heatmap |
| Context | Where is it? | Inferred land mask, supplied image, or terrain package | Snapshot-matched overview/detail terrain package |
| Territory | Which world regions matter? | Context-dependent | Zero or more biome groups, OR-ed together |
| Selection | Why is this place notable? | Cell click or box inspect | Green area intersected with the active biome scope |

## Test controls

- Select one lens or a full scale ladder.
- Select output resolutions independently.
- Force a cold render or permit an artifact cache hit.
- Add artificial delay after each phase to inspect loading behavior.
- Inject a failure after the first completed layer.
- Cancel queued/running work between phases.
- Observe queue, query, encode, manifest, and total timers.
- Observe cells, values, pixels, bytes, and cache-hit status.
- Tune semantic-zoom thresholds and crossfade duration in the browser.
- Observe and tune the 8 m to 4 m local-detail transition independently of full-world rendering.
- Clear the browser decode cache without deleting generated artifacts.
- Distinguish newly generated layers from artifact hits in the summary and completion feedback.
- Mirror active job phase, progress, elapsed time, and outcome in the 15-second terminal monitor.

`Shift` + drag is the lab's universal transient box-zoom gesture. Its white-edged gold dashed marquee
must be visible before mouse-up. The persistent Box zoom tool uses the same visual language.

The public browser regression additionally covers the clean initial state, every Quick Start dismissal
path, Discord-return priority, mode activation/deactivation and direct switching, retained biome
choices, Biomes + None, off-globe clicks, semantic raster scales, bounded inspection, representative
samples, and item pagination.

## Artifact packages

`data/artifacts/{snapshotId}/manifest.json` advertises every available lens/resolution image, its fixed
world bounds, value semantics, logarithmic maximum, cell count, total value, render timings, and file
size. PNGs are intensity-only gray8 images with binary alpha.

The 8 m and 4 m close-detail surfaces are disposable browser artifacts, not entries in the full-world
manifest. They may only be derived when the exact query is complete. A result marked `truncated` must
yield neither a local surface nor points.

`data/era17-context/{snapshotId}/manifest.json` binds the terrain package to the snapshot hash and world
ID and checksums six variants: restrained overview/detail, contour-forward topographic overview/detail,
the authoritative indexed biome mask, and the presentation-only biome display mask. All variants share
the exact `[-12288, 12288]` world-edge bounds. The display mask may close cartographic fractures but
must never determine query membership. Public bootstrap exposes safe presentation metadata, never
private source paths or provenance details.

A standalone authoritative context image remains available for local experiments. Without either
context source, the all-ZDO surface is labeled as an inferred land mask, never a terrain heightmap.

## Related decisions

See the [architecture decision record index](adr/README.md) for the public boundary, terrain package,
terrain-first interaction, isolated deployment, and optional Discord identity decisions.
