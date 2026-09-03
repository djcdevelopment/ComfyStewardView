# Spatial lab and public map contract

## Experience profiles

| Profile | Purpose | Enforced scope |
|---|---|---|
| Lab | Explore lenses, rendering, scale transitions, gestures, and failure behavior. | All built-in lenses, available snapshots, job controls, and test instrumentation. |
| Public world | Let the community read and step inside bounded parts of Comfy Era 17 without exposing the experimental workbench or private cache. | Snapshot 107, Build density evidence, snapshot-matched terrain and biomes, bounded read-only queries, exact selection-local 3D, and feedback. |

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
7. Inspection exposes the same **Explore the build** card in the right column for Heatmap and Biomes.
   It can open an exact selection in a separate 3D tab or render that GPU view to PNG. The links preserve
   the inspected snapshot, lens, bounds, biome scope, and explicit large-selection override; the server
   revalidates and rebuilds that scope instead of trusting client-supplied objects.
8. Quick Start opens after the public map becomes ready once per browser-versioned dismissal key.
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
   experience calls for map context and otherwise ask for a tighter area. That representative sample
   is a 2D map aid only and is never passed to the 3D scene.
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

## Exact selection-to-3D contract

1. The selection summary is the authority for the link. At most 5,000 pieces open directly. A result
   from 5,001 through 250,000 requires an explicit inline confirmation in the inspector's right column
   that writes `override=true` into the new-tab URL. More than 250,000 pieces cannot be opened and asks
   the visitor to tighten the area. Heatmap and Biomes use the same placement and gate. A Biomes-wide
   result spans every matching territory inside the published world bounds; the inspector, confirmation,
   links, and scene label it as worldwide rather than presenting it as a local green-area selection.
2. `/api/scene` accepts only the published snapshot and Build density lens, finite ordered bounds,
   canonical public biome groups, and the override bit. The repository repeats those checks and always
   executes an exact count/query; it never accepts client object IDs or a client-generated package.
3. A schema-v2 package is deterministic for a fixed cache, release label, and scope. The header contains
   `SV3D`, package version 2, a JSON-manifest length, fixed 80-byte instance stride, and an integrity hash
   for the instance region. `pieces` is always the exact selected ZDO count; `renderInstances` is the
   presentation count and may be larger for a compound or smaller than its desired expansion when the
   500,000-instance presentation cap collapses compounds to one marker. Membership is never sampled or
   dropped. One response supplies the whole scene.
4. Every safe known piece is an oriented prefab envelope unless an exact-name representation entry says
   otherwise. Rotation follows Unity Euler order `Ry × Rx × Rz`; the prefab center offset is rotated
   before translation. The browser mirrors X into a right-handed, selection-local coordinate frame.
   Unknown prefabs and unsafe uncataloged envelopes render as red pivot markers rather than vanishing.
   Thirty-nine explicitly named vegetation/context prefabs render as smaller green pivots, are hidden by
   default, and do not influence framing. Exact name and hash must agree with the geometry catalog; no
   substring classifier exists, and fires, furniture, logs, and stumps are not treated as context.
5. A runtime compound requires a bounds-only renderer receipt plus a metrics-gated promotion receipt.
   Its 1–32 local box matrices are transformed per ZDO; animated parts receive a deterministic static
   phase derived from `zdo_index` because saved runtime animation state is unavailable. A known compound
   that fails promotion is one explicit unresolved marker. The current four-box windmill candidate failed
   depth and holdout gates and is therefore local `/rnd` evidence, not public presentation geometry.
6. Public scene data omits creator/owner identity, flags, raw ZDO fields, source paths, absolute Y, and
   absolute world origin. The manifest exposes only relative floor and bounds plus aggregate provenance
   hashes and explicit measured/estimated/context/unresolved/capped coverage counts.
7. The browser is dependency-free WebGPU with no WebGL fallback. Shaded and wireframe views use shared
   cube geometry and instancing; family toggles change visibility without refetching. Mouse orbit with
   WASD travel and Q/E elevation, pan, wheel, frame, reset, and pointer-locked WASD/QE/Shift free flight
   are all local presentation controls. PNG
   export captures the current WebGPU canvas, camera, surface, and visible families in the browser.
   Compact scopes frame the full selection; scopes spanning more than 600 m on any axis start at a
   deterministic dense local Home cluster and retain an explicit Frame all action.
8. Scene generation has its own six-per-minute client rate limit and one-query concurrency gate. The
   unsupported, capacity, validation, network, and device-loss states are explicit and recover to the map.
9. `/rnd/fidelity`, its API, and external gallery-image streaming exist only in non-public mode. The
   workbench joins external selfie-stick images, exact camera receipts, gallery clusters, scene scopes,
   and local renderer candidates without copying images into this repository. Public mode does not
   register any of those routes and never loads a local candidate receipt.

Binary layout is deliberately small and versioned:

| Offset | Size | Value |
|---:|---:|---|
| 0 | 4 | ASCII `SV3D` |
| 4 | 4 | Little-endian package version (`2`) |
| 8 | 4 | UTF-8 JSON manifest length |
| 12 | 4 | Four-byte-aligned instance-region offset |
| 16 | variable | Manifest, followed by zero alignment padding |
| instance + 0 | 64 | Column-major `mat4x4<f32>` selection-local model transform |
| instance + 64 | 16 | RGBA family color (`vec4<f32>`) |

The manifest's contiguous draw groups give each otherwise anonymous 80-byte instance its semantic class,
default visibility, piece membership count, and draw range. The instance-region SHA-256 covers exactly
`renderInstances × 80` bytes.

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
| Representation | How should this bounded evidence be read? | 2D raster/points and experimental renderings | 2D map or exact shaded/wireframe envelope scene |

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

The public map regression additionally covers the clean initial state, every Quick Start dismissal
path, Discord-return priority, mode activation/deactivation and direct switching, retained biome
choices, Biomes + None, off-globe clicks, semantic raster scales, bounded inspection, representative
samples, item pagination, and the inline exact-3D/PNG gate in both Heatmap and Biomes. A separate hardware-WebGPU regression
covers the 862-piece pilot and 22,387-piece forced stress selection, package integrity, exact pieces
versus render instances, representation quality, shaded/wireframe switching, group controls,
orbit-WASD movement, both camera modes, browser and WebGPU
validation errors, device loss, PNG capture, startup at or below 2,000 ms, and p95 frame time at or below
20 ms. Its opt-in large case covers the confirmed 193,008-piece whole-Meadows scope, proxy-outlier
receipt, dense-cluster Home/full-selection framing, and separate 10,000 ms startup / 50 ms p95
forced-scene budgets. Fidelity fixtures add 3,937 pieces/914 hidden vines (611), 864 pieces/one
unresolved windmill (713), and 705 pieces/two unresolved windmills (1364). A private workbench browser
gate separately proves exact 65° camera matching, candidate/baseline comparison, wipe, overlay, and
isolation without making the candidate public.

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

`data/era17-public.duckdb` schema v4 is a replaceable, snapshot-only derivative. Its public `zdo`
table carries BUILDING position, rotation, prefab identity, and biome membership; `prefab_geometry`
carries the 974-entry envelope lexicon and its source class; `prefab_representation` and
`prefab_representation_primitive` carry only checked-in, exact-name presentation decisions and promoted
box matrices. `release_metadata` binds the cache to the source snapshot, context, building-geometry
Parquet, piece-geometry JSON, representation catalog, promotion receipt, row counts, and coverage counts.
Export fails unless the Parquet BUILDING rows join exactly to the source snapshot by ZDO index,
name/hash, and X/Z, and unless representation names and hashes agree with the geometry catalog. This
extension does not change the production `viewer` schema.

`/api/scene` emits `application/vnd.comfysteward.scene` packages for exact, bounded public selections.
The URL is a shareable query recipe, not a stored scene: each open rebuilds the package from the active
immutable public cache and therefore remains subject to current server validation and limits.

A standalone authoritative context image remains available for local experiments. Without either
context source, the all-ZDO surface is labeled as an inferred land mask, never a terrain heightmap.

## Related decisions

See the [architecture decision record index](adr/README.md) for the public boundary, terrain package,
terrain-first interaction, isolated deployment, optional Discord identity, exact WebGPU scene, and
metrics-gated prefab representation decisions.
