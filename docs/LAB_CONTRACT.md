# Spatial lab contract

## Product loop

1. The world overview states what the selected lens measures and why it may matter.
2. A coarse raster reveals concentrations without pretending to explain them.
3. Box zoom loads the next useful resolution and reports the transition.
4. Inspect selects a region and answers why it is bright: total, density, world share, and top prefabs.
5. At close range, bounded exact points replace aggregate ambiguity.

## Independent dimensions

| Dimension | User question | First-pass control |
|---|---|---|
| Lens | What am I investigating? | Build, dropped, all ZDOs, coins, birch, tombstones |
| Time | When, or what changed? | One snapshot; delta is deliberately deferred |
| Scale | How much detail? | Auto, 1000, 320, 64, 16 m, then exact points |
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
- Clear the browser decode cache without deleting generated artifacts.

## Artifact package

`data/artifacts/{snapshotId}/manifest.json` advertises every available lens/resolution image,
its fixed world bounds, value semantics, logarithmic maximum, cell count, total value, render
timings, and file size. PNGs are intensity-only gray8 images with binary alpha.

An optional authoritative terrain image can be supplied at server startup. Until then, the
all-ZDO surface raster is labeled as an inferred land mask, never as a terrain heightmap.
