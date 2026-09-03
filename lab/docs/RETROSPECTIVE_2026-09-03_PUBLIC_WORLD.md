# Public world launch retrospective — 2026-09-03

## Outcome

The Comfy Era 17 world view is live at
[am4.tail8e749c.ts.net/world](https://am4.tail8e749c.ts.net/world/). It publishes snapshot 107 as a
terrain-first map with optional construction Heatmap and Biomes questions, bounded evidence inspection,
and anonymous-first feedback. The existing Steward application at `/steward` was not changed.

The initial go-live was verified as release `0445fe2-20260903122756-dirty`. “Dirty” described the
uncommitted launch changeset, not a failed verification; this retrospective and the accompanying ADRs
were written as that work was landed.

## What shipped

- A neutral, contour-forward terrain start instead of an analysis-first or three-basemap chooser.
- A semantic Build density ladder from world overview through 8/4 m local surfaces and exact objects.
- Snapshot-matched biome territories with authoritative query membership, presentation-only outline
  cleanup, complete totals, representative map samples, and paged object results.
- A server-enforced public profile exposing only snapshot 107 and Build density from an isolated cache.
- A one-time Quick Start that teaches the progressive interaction without competing with a returning
  feedback dialog.
- Anonymous feedback with optional short-lived Discord `identify` verification.
- A read-only, resource-limited `/world/` container and a deployment script that validates snapshot and
  asset hashes before checking both the new route and the unchanged production service.

## What went well

### Evidence and presentation stayed separate

The terrain pipeline produces an indexed biome mask for membership and a separate display mask for
cartographic cleanup. That let the map close hairline fractures and improve outlines without silently
changing counts. The same principle carried through density rendering: display copies, opacity, color,
and interpolation can change, while source cells, totals, and bounds remain fixed.

### The public boundary is enforced at more than one layer

The browser hides the lab, but the server independently filters bootstrap and manifests, rejects
out-of-scope artifact and query requests, and omits render-job routes. Deployment then supplies a
snapshot-only derived cache. A UI regression therefore cannot expose the broader lab by itself.

### The launch path was rehearsable

Local public mode and the live URL use the same JAR flags, context manifest, and browser scenarios. The
deployment script records checksums, validates the live health contract, exercises biome and paging
queries, and rechecks `/steward`. The launch was repeatable rather than a collection of shell history.

### The interaction became simpler late in the work

Earlier iterations treated Topographical, Heatmap, and Biomes as three peer modes. Making terrain the
canvas and the other two optional questions removed a mode whose only job was “show the world.” It also
gave the start state a clear promise: follow the terrain first, then add the question you want to ask.

## What was difficult

### Map layers have independent asynchronous lifetimes

Context images, world rasters, local rasters, biome tiles, exact points, selections, and legends do not
finish together. Moving to an explicit `terrain` / `heatmap` / `biomes` state machine, cancelling stale
detail work, and asserting absence as well as presence were necessary to prevent a previous mode from
leaking into the next one.

### “Complete” means different things at different scales

Millions of objects cannot be useful as browser dots, but an arbitrary prefix would look authoritative.
The resulting contract distinguishes complete aggregate totals, deterministic representative map
samples, a 5,000-point display budget, and cursor-paged individual records. That vocabulary should have
been defined before the first inspection UI was built.

### Snapshot provenance crossed several systems

The release depends on a save DB/FWL pair, generated Valheim caches, an analytics snapshot, raster
artifacts, terrain variants, biome masks, and a derived public cache. Binding them with world IDs,
snapshot hashes, dimensions, bounds, and per-file checksums took more work than rendering the images,
but it is what makes “snapshot-matched” defensible.

### The broad local lab fixture lagged behind the public schema

The checked-out default lab cache was a small pre-biome fixture, so the legacy all-lens browser exercise
could not validate new biome queries. The focused local and live public suites used the current public
cache and passed. A refreshed non-public fixture remains worthwhile so the broad exercise can join the
release gate instead of being an opportunistic check.

## Verification at launch

| Layer | Result |
|---|---|
| Java build and tests | `mvnw clean package` passed |
| Terrain builder | 8 Python unit tests passed |
| Client and browser harness syntax | Both Node syntax checks passed |
| Local public browser | Terrain, Quick Start, Heatmap, Biomes, inspection, paging, and scale scenarios passed |
| Live public browser | The same focused scenarios passed at `/world/` with no JavaScript errors |
| Deployment | Snapshot/cache/context checksums, public denials, Discord OAuth shape, and production health passed |

## Follow-ups

- Observe qualitative feedback before adding more lenses or controls; the public boundary should expand
  only in response to a clear question.
- Refresh or generate a representative non-public test cache and make the full lab browser exercise a
  reliable release gate.
- Move release-specific constants such as snapshot 107 and the world label into one versioned release
  profile before publishing another era.
- Add automated retention for old remote release directories and container images once several clean
  releases have accumulated.
- Keep Quick Start copy versioned with meaningful interaction changes so returning visitors see a guide
  only when the mental model has actually changed.

## Lasting lesson

The map works best when terrain is treated as the stable object and analysis as a reversible question.
The architecture should preserve the same distinction: immutable evidence underneath, optional
interpretation above it, and explicit boundaries around what the public service is allowed to answer.

## Follow-on: exact selection-to-3D

Later on launch day, the inspection boundary became the entry point for a second representation of the
same evidence. A selected green area can open an exact, selection-local WebGPU scene in a new tab. This
did not add a general ZDO endpoint or modify the production viewer: the current public-cache schema v4
carries only sanitized BUILDING transforms, prefab envelopes, and a checksummed exact-name representation
catalog, while the server repeats snapshot, lens, bounds, biome, capacity, and override validation.

The follow-on preserves the launch lesson. Terrain remains the stable starting object; Heatmap and
Biomes remain reversible map questions; 3D is available only after an explicit inspection gives it a
bounded question to answer. The initial 5,000-piece lane opens directly, 5,001–250,000 requires inline
consent from the same right-column card in either mode, and anything larger returns to selection rather
than sampling. The confirmed lane also exposes browser-side PNG capture. Oversized environmental proxy
envelopes remain counted but render as explicit pivot markers, while kilometre-scale selections open on
a deterministic dense **Home** cluster and retain **Frame all** for the full relationship. See
[ADR 0006](adr/0006-exact-selection-webgpu-scene.md) and the
[selection-to-3D R&D retrospective](RND_SELECTION_3D_2026-09-03.md) for the implementation boundary,
source receipts, transform decisions, and hardware measurements.

The subsequent gallery-calibrated fidelity pass preserved that boundary. Private selfie-stick images,
camera receipts, and bounds-only in-game probes are available only through the local `/rnd/fidelity`
workbench. Exact-name context markers are hidden by default, scene v2 distinguishes exact ZDO pieces from
render instances, and runtime compounds require tuning and holdout metrics. The first four-box windmill
candidate looked substantially better but failed its depth and holdout gates, so the deployed catalog
uses an explicit unresolved marker. See [ADR 0007](adr/0007-metrics-gated-prefab-representations.md).
