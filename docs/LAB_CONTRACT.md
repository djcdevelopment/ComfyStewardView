# Spatial lab contract

## Product loop

1. The world overview states what the selected lens measures and why it may matter.
2. A coarse raster reveals concentrations without pretending to explain them. The in-map prompt names the current scale, the next payoff, and a direct action.
3. Shift-drag, the prompt action, or persistent Box zoom shows the same gold dashed window, then loads the next useful resolution and reports the transition.
4. Inspect is a one-shot gesture available from the last two raster stages, before exact points are drawable: selecting a region opens the right-column Inspect tab, pins the green evidence window, and immediately returns the map to Pan. The explanation shows the complete aggregate total, density, world share, and top prefabs; switching to Job Bench and back preserves the selection.
5. At close range, bounded 8 m and 4 m density surfaces bridge the full-world 16 m raster into exact points. Each local surface and its points come from the same complete bounded query.
6. If a viewport exceeds the 5,000-point display budget, no spatially biased prefix is shown; the complete raster remains authoritative and offers Inspect. A green selection is not constrained by the dot budget: it reports its complete aggregate count and explains when exact dots remain hidden.
7. Pan mode uses a grab cursor and visibly closes the hand only while the held drag is moving the map.
8. A local surface replaces the 16 m analysis raster instead of blending two analytical grids. Inferred context becomes a faint locator layer, while press-and-hold peek restores it for orientation.
9. Close-detail surfaces are double-buffered. The last complete surface remains authoritative during movement and is replaced only after the next surface image loads; hidden coarse rasters never crossfade over it.
10. Smooth surface sampling is the default at every raster scale. Cell grid reveals the same discrete bins with hard edges; changing this display mode never changes data, thresholds, or queries.
11. Analysis tone is scale-locked: 320 m and coarser layers use their absolute maximum, the 1 km overview additionally quiets its midrange contrast, 160/80 m progressively introduce focus, and 64 m and finer use the occupied-cell P99.5 cap. The 160/80 m rungs keep spatial refinement near 2× per transition. Coarse artifacts use a 2x display copy to tighten smooth interpolation without changing evidence. The legend names the mode, marks capped thresholds with `+`, and retains the absolute maximum in the narrative.
12. Analysis opacity is semantic by zoom: world overviews below z-4 stay at 100%, while z-4 and closer use the adjustable detail-opacity target. The effective value is explicit beside the control.

## Independent dimensions

| Dimension | User question | First-pass control |
|---|---|---|
| Lens | What am I investigating? | Build, dropped, all ZDOs, coins, birch, tombstones |
| Time | When, or what changed? | One snapshot; delta is deliberately deferred |
| Scale | How much detail? | Auto, 1000, 320, 160, 80, 64, 16 m world, 8/4 m local, then exact points |
| Surface | How should raster cells read? | Smooth interpolated field or explicit cell grid; display only |
| Context | Where is it? | Inferred land mask or supplied terrain image |
| Selection | Why is this place notable? | Cell click or box inspect |

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

`Shift` + drag is the universal transient box-zoom gesture. Its white-edged gold dashed marquee
must be visible before mouse-up. The persistent Box zoom tool uses the same visual language.

## Artifact package

`data/artifacts/{snapshotId}/manifest.json` advertises every available lens/resolution image,
its fixed world bounds, value semantics, logarithmic maximum, cell count, total value, render
timings, and file size. PNGs are intensity-only gray8 images with binary alpha.

The 8 m and 4 m close-detail surfaces are disposable browser artifacts, not entries in the full-world
manifest. They may only be derived when the exact query is complete. A result marked `truncated` must
yield neither a local surface nor points, preventing a database-order prefix from looking authoritative.

An optional authoritative terrain image can be supplied at server startup. Until then, the
all-ZDO surface raster is labeled as an inferred land mask, never as a terrain heightmap.
