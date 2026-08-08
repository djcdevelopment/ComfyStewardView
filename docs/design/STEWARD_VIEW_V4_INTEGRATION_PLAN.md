# Steward View v4 — unified UI and raster comparison roadmap

**Canonical design:** [`design_mocks/Steward View v4 - Raster Compare.dc.html`](../../design_mocks/Steward%20View%20v4%20-%20Raster%20Compare.dc.html)

Steward View v4 is the north-star UI and information architecture. It extends v3 rather
than replacing its working detail views: v4 is authoritative for the shell, navigation,
Map controls, raster comparison, provenance, and state language; v3 remains a supporting
reference for unchanged tables until each milestone migrates them.

The mock is an interactive Design Canvas component (`support.js`, `sc-if`/`sc-for`, and a
`DCLogic` class). Its default 1600 × 1000 preview intentionally opens **World → Map** with
**Raster Field → Changes** selected so the new behavior is visible immediately. Component
props expose `ready`, `loading`, `missing`, `stale`, and `unavailable` artifact states; the
card switch demonstrates raster-off. Snapshot mode retains Build density, Dropped, All
ZDOs, and Coins.

**Delivery status:** M0–M4 are implemented, deployed, and release-verified. The core M5
workbench/navigation set is deployed; its broad cross-view regression exit criteria remain open.
M6 is partially implemented on the Map, Changes, History, and Explore surfaces. The milestones
below remain the dependency-ordered delivery record and acceptance checklist.

| Milestone | Disposition | Delivered boundary |
|---|---|---|
| M0 — North Star | Complete | Canonical v4 mock and interaction/state contract |
| M1 — True North Shell | Complete | Unified shell, grouped navigation, scope registry, deep-link redirects |
| M2 — Raster Baseline | Complete | Four absolute layers, four advertised cell sizes, local recolor/opacity, raster states |
| M3 — Time Lens | Complete | Snapshot-aware DB queries, History, Explore, selection context, honest boot-pinned labels |
| M4 — Change Field | Complete | Publisher, manifest/file API, two-layer compositor, pair synchronization, table-only fallback |
| M5 — Steward Workbench | Core delivered | Coin trail and v4 workbench patterns are live; full cross-view regression remains |
| M6 — Operational Polish | Partial | Core async/stale states are live; spawn aggregate, full accessibility/responsive pass, and telemetry remain |

### Release verification record

- A clean Maven package passed all three `RenderedDeltaLayerBuilder` tests.
- The code lane and data lane both completed against AM4, including the publish consistency gate
  and post-restart readiness check.
- Live snapshot discovery advertised an eligible delta pair. Its manifest exposed Build activity
  and All ZDO change at 64/320/500/1000 m, and both added and removed PNG channels decoded.
- Browser smoke covered the Changes availability state, “View spatial change” transition,
  client compositor, and dual legend with no runtime JavaScript errors.

The record intentionally omits snapshot IDs and wall-clock measurements: those describe one
publish, not the enduring contract.

## Product and architecture invariants

- OMEN computes and publishes analytics and raster artifacts; AM4 serves already-built
  artifacts and never performs an expensive raster build in a request.
- The selected world owns the valid snapshot list. Switching worlds must select a valid
  snapshot for that world before any dependent request is issued.
- Every visible dataset states one of four scopes: selected snapshot, comparison pair,
  all snapshots, or boot snapshot.
- Snapshot and Changes raster modes share the same Map canvas and point overlays. Raster
  provenance and point provenance stay separate until point endpoints become snapshot-aware.
- The Changes view and Map Changes mode share one ordered From/To pair. Changing it in
  either place updates the other.
- Absolute rasters are one gray8 channel colorized in the browser. Change rasters are two
  aligned gray8 channels, composited in the browser as removed red, added green, and
  overlap neutral/ivory. Opacity and color treatment never require a refetch.
- Tabulator remains the table engine and the production frontend remains the existing
  no-build Alpine/Leaflet single-page app.

## Incremental milestones

Each milestone is independently deployable and leaves all existing leaf views reachable.
The sequence reflects dependencies: build the honest shell first, then absolute raster UX,
then snapshot correctness, and only then publish and consume delta raster artifacts.

### M0 — North Star (design contract)

**Feature set**

- Adopt v4 as the canonical shell and Map specification while preserving earlier mocks as
  design history.
- Lock the Snapshot / Changes mode switch, shared snapshot-pair control, two change layers,
  dual-log legend, point/raster provenance split, and artifact-state vocabulary.
- Document responsive behavior: the 286 px Map controls rail collapses below 1360 px and
  the map remains the dominant surface.

**Exit criteria**

- The v4 component loads with `support.js`, its default Changes raster is visually complete,
  both raster modes are interactive, and all alternate artifact states render legibly.

### M1 — True North Shell

**Feature set**

- Introduce v4 tokens, IBM Plex typography, header, primary tabs, grouped World subnavigation,
  reusable cards/badges/segments, and responsive secondary navigation.
- Drive the scope chip and badges from one capability registry rather than scattered markup.
  Mark Map rasters, Changes, and Explore as snapshot-aware; mark in-memory views and Map
  points as boot-pinned; mark History as all-snapshots.
- Keep current leaf IDs and redirects. The former Top caches, Issuers, and Guild gear links
  resolve to the corresponding Coin trail segment.

**Exit criteria**

- Every current leaf view and historical deep link remains reachable; scope labels match the
  request each view actually sends; world/snapshot selectors remain functional.

### M2 — Raster Baseline

**Feature set**

- Rebuild the Map sidebar around the existing absolute manifest: Build density, Dropped,
  All ZDOs, and Coins at 64/320/500/1000 m where advertised.
- Add visibility, opacity, and Ember/Moss/Viridis controls. Cache the decoded gray8 image;
  opacity changes update the Leaflet overlay and ramp changes recolor locally.
- Bind the map pill, logarithmic legend, bounds, and maxima to the selected manifest entry.
- Standardize absolute-raster states: idle/off, loading, ready, empty/missing, error, and
  stale-last-success. Keep the previous successful image visible during refreshes.
- Preserve point overlay counts, viewport budgets, “showing N of M; zoom in” messaging,
  region selection, and Fly to Map behavior.

**Exit criteria**

- Every advertised layer/cell combination loads for the selected snapshot; cancellation
  prevents a slower old request from replacing a newer selection; ramp and opacity changes
  do not refetch; missing and stale artifacts never blank the whole Map.

### M3 — Time Lens

**Feature set**

- Validate optional `snapshot=N` on DB-backed ZDO, container-item, and selection-summary
  queries; omitted snapshot continues to mean latest for compatibility.
- Reset the snapshot selector atomically when the world changes, then reload dependent views.
- Make Explore and region-selection summaries use the selected snapshot and preserve snapshot
  plus bounds when moving between Map and Explore.
- Enrich History rows with ZDO count and raster availability. Restyle History and Changes with
  v4 provenance, reconciliation, dictionary-mismatch, loading, empty, and error patterns.
- Keep remaining in-memory views explicitly boot-pinned until their data sources migrate.

**Exit criteria**

- A snapshot change cannot produce a mixed-world request; Explore and selection totals match
  the selected snapshot; every view visibly identifies its time scope.

### M4 — Change Field

**Feature set**

- On OMEN, generate change rasters for every ordered older→newer pair among the latest six
  snapshots of each world (at most 15 pairs). Publish Build activity and All ZDO change at
  64/320/500/1000 m.
- Use the delta engine's object identity definition for both table counts and raster channels.
  Added and removed channels use the same cell size, dimensions, and union bounds.
- Publish a delta manifest with pair/world identity, dictionary compatibility, bounds, channel
  files, encoding, and independent `addedMaxRaw` / `removedMaxRaw` values.
- Add the v4 Map Changes mode. Fetch both channels, composite added green / removed red /
  overlap neutral, show independent logarithmic maxima, and share From/To with Changes.
- When a pair is outside the recent matrix, keep the tabular comparison available and render
  the explicit “spatial raster unavailable for this pair” state. Never compute on demand.
- Verify all files referenced by a manifest before AM4 activates a publish.

**Exit criteria**

- Spatial added/removed totals reconcile with tabular delta fixtures under the documented
  identity model; the pair remains synchronized across Map and Changes; an incomplete publish
  cannot become active; old pairs degrade to table-only without an API retry loop.

### M5 — Steward Workbench

**Feature set**

- Apply v4 filter bars, status badges, stat cards, endpoint echoes, and Tabulator styling to
  the remaining World views.
- Complete the Coin trail merge (Top caches / Issuers / Guild gear), preserving redirects.
- Move region selection into the Map drawer and preserve bounds, world, and snapshot when
  opening Explore. Standardize Fly to Map actions for coordinate-bearing rows.
- Add Alerts severity navigation/counts, Portal status filters, and visible virtual-scroll
  row/filter counts.

**Exit criteria**

- No legacy view is stranded outside the two-level navigation; all redirects and cross-view
  transitions retain context; table sort and virtual scrolling still work at production scale.

### M6 — Operational Polish

**Feature set**

- Standardize `idle/loading/ready/empty/error/stale` state transitions and retry behavior for
  each view. Retain the last successful result on refresh failure and label its provenance.
- Add the spawn-time histogram and draggable range only after a bounded DB aggregate endpoint
  exists; keep numeric range inputs usable independently.
- Complete keyboard focus, accessible names, reduced-motion behavior, and responsive checks.
- Add publish telemetry for manifest age, missing artifacts, dictionary mismatch, and last
  successful activation; update this handoff as boot-pinned views migrate.

**Exit criteria**

- State transitions, keyboard use, responsive layouts, and stale-data recovery pass browser
  regression checks; operators can distinguish compute, publish, and client failures.

## HTTP and artifact contracts

### Baseline absolute raster contract

```text
GET /api/v1/rendered/manifest?snapshot=N
GET /api/v1/rendered/{file}?snapshot=N
```

The manifest is authoritative for layer names, cell sizes, bounds, encoding, filenames, and
raw maxima. `snapshot` remains optional and defaults to the active/latest snapshot. A raster
filename must come from its manifest; clients must not synthesize paths.

### Implemented delta raster contract (M4)

```text
GET /api/v1/rendered/delta/manifest?from=N&to=M
GET /api/v1/rendered/delta/{file}?from=N&to=M
```

The delta manifest identifies `worldId`, `fromSnapshotId`, `toSnapshotId`, and dictionary
compatibility. Every layer/cell entry points to `addedFile` and `removedFile`, supplies one
union `bounds` object shared by those channels, uses `encoding: gray8`, and exposes the exact
independent-maximum fields `addedMaxRaw` and `removedMaxRaw`.
Invalid IDs, reversed/equal pairs, and cross-world pairs return a specific 4xx response.
A well-formed pair with no published raster returns 404; AM4 does not enqueue work.

### Snapshot-aware query additions

DB-backed query and selection endpoints accept optional `snapshot=N`; the server validates
snapshot existence and, when `worldId` is supplied, world membership. The snapshot-list response
puts `zdoCount` and `absoluteRasterAvailable` on each snapshot and advertises eligible pairs in
the top-level `deltaPairs` array (`fromSnapshotId`, `toSnapshotId`, `worldId`, `available`, and
dictionary metadata). History and pair controls therefore do not probe files speculatively.
Existing clients that omit `snapshot` retain latest-snapshot behavior.

## Verification matrix

- **Raster math:** fixtures for added, removed, unchanged, empty, duplicate-position, and
  category-filtered objects; channels share exact dimensions/bounds; maxima match pixels.
- **Pair policy:** 1–6 snapshots produce every older→newer pair; the seventh and older remain
  table-only; world changes invalidate and replace both pair values.
- **API:** valid, missing, malformed, reversed/equal, cross-world, dictionary-mismatch, and
  interrupted-publish requests return stable status and error bodies.
- **Browser:** both modes, four absolute layers, two delta layers, four cell sizes, recoloring,
  opacity, off/loading/missing/stale/unavailable states, request races, legend values, and
  Map↔Changes pair synchronization.
- **Regression:** all leaf views/deep links, Coin trail redirects, Tabulator sort/scroll,
  selection→Explore, Fly to Map, and boot-pinned provenance.
- **Publish gate:** every manifest reference exists and decodes before activation; a failed
  candidate leaves the last successful publish active.

## Chosen defaults

- v4 is canonical; v3 and earlier mocks remain unchanged as historical/supporting references.
- The mock defaults to Changes at #0146 → #0148 so the new visual contract is immediately
  visible. The production frontend deliberately defaults to Snapshot mode; entering Changes
  initializes the newest eligible adjacent pair and thereafter shares the user's pair choice.
- Delta coverage is Build activity and All ZDO change for the latest six snapshots per world.
  Coin and dropped-item change rasters are deferred.
- Older/non-matrix pairs remain fully available as tabular comparisons.
- OMEN precomputes; AM4 only validates, publishes, and serves artifacts.
