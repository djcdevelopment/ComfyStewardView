# Shell A ("Two-level tabs") integration plan — historical

> Superseded by the [Steward View v4 unified UI and raster comparison roadmap](STEWARD_VIEW_V4_INTEGRATION_PLAN.md).
> Keep this document as the implementation history for the original two-level shell. The v4
> mock is canonical for current shell, Map, provenance, raster-mode, and milestone decisions.

Source mock: `design_mocks/Shell A - Two-level tabs.dc.html`. It is a design-component
prototype (`sc-if`/`sc-for` templates + a `DCLogic` mock class), not usable HTML — this
plan translates its visual system and information architecture into the real app at
`viewer/src/main/resources/static/index.html` (Alpine.js + Leaflet + Tabulator, no build
step). The heatmap raster consolidation (2026-08-08) is a prerequisite and is already in;
the mock's RASTER LAYER card maps 1:1 onto the consolidated controls.

## Outcome

- Phases 1–3 shipped and now form the v4 shell/workbench baseline: the two-level navigation,
  Map cards and chrome, view headers, table styling, and Coin trail merge are in production.
- Phase 4 shipped for the snapshot-aware and DB-backed surfaces (Map, Changes, History, and
  Explore), including loading/error/retry and stale-raster behavior. Applying that state model
  consistently to every boot-pinned leaf remains part of v4 M6.
- The v4 work added snapshot and Changes raster modes beyond this mock's original absolute-raster
  design. Current behavior and remaining work are tracked only in the v4 plan.

## What the mock changes, structurally

| Mock | Pre-integration UI | Kind of change |
|---|---|---|
| Two-level nav: 4 primary tabs + grouped pill row inside World | One flat strip of ~18 tabs | Nav restructure |
| SPATIAL / INVENTORIES / FORENSICS / POPULATION groups | Ungrouped | Nav restructure |
| One **Coin trail** view with Top caches / Issuers / Guild gear segments | 3 separate tabs (`caches`, `issuers`, `guildgear`) | IA merge |
| Card-based map sidebar (RASTER LAYER / POINT OVERLAYS / SPAWN TIME FILTER) | Flat bordered sections | Restyle + small features |
| Overlay rows show live counts; spawn filter shows day-range + sparkline | No counts; raw 0–2 fraction inputs | Small data features |
| Loading skeleton / empty state / error card per view | Nothing (views just sit empty) | New UX pattern |
| Endpoint echo in view headers (`/economy · top 80…`), "scopes N of M views" chip | Nothing | Honesty affordances |
| IBM Plex Sans + Mono, token palette, panel cards, mono micro-labels | Tailwind defaults, emoji tab labels | Visual system |

## Approach: 4 phases, each shippable

The file is one 1,800-line SPA; a big-bang rewrite risks breaking 15 working views.
Each phase below leaves the app fully functional and is a natural commit.

### Phase 1 — Design tokens + shell (header, two-level nav)
- Add IBM Plex Sans/Mono via Google Fonts `<link>` (CDN precedent exists).
- Add a `<style>` block defining the palette as CSS custom properties
  (`--bg:#0e1118; --panel:#161b26; --panel2:#12161f; --line:#232936; --line2:#242b3a;
  --accent:#5fa8e0; --accent-dim:#2a4d78; --accent-border:#3a6ea8; --ok:#5fae7f;
  --warn:#d9a34a; --err:#d9635f; --text:#dfe4ec; --text-dim:#8b95a7; --mono-label:#6d7789`)
  plus a handful of component classes (`panel-card`, `mono-label`, `pill`, `seg`,
  `stat-card`) so the markup isn't wall-to-wall arbitrary-value Tailwind.
- Rebuild the header per mock: brand + `WORLD INTELLIGENCE` micro-label, WORLD and
  SNAPSHOT pickers (existing `selectedWorldId` / `selectedSnapshotId` selects, restyled,
  green status dot from `/status`), stat trio ZDOS / PLAYERS / PORTALS (already in
  `summary`) in Plex Mono.
- Replace the flat tab strip: primary underline tabs World / Changes / History / Explore;
  secondary grouped pill row shown only in World. Alpine state: keep `activeTab` as the
  leaf view id; add `primaryTab` (already exists) and a static `tabGroups` structure:
  `SPATIAL: map, structures, portals, selection · INVENTORIES: economy, dropped, signs,
  tombstones · FORENSICS: forensics, alerts · POPULATION: players, creatures`.
  Drop the emoji from labels (mock uses plain text).
- Keep deep links working: `#tab=<id>` ids unchanged.

### Phase 2 — Map sidebar cards + map chrome
- Recast the three sidebar sections as `panel-card`s per mock:
  - **RASTER LAYER**: 2×2 layer button grid (Build density / Dropped / All ZDOs / Coins),
    CELL SIZE segmented control (64 / 320 / 500 / 1000) replacing the `<select>`,
    OPACITY slider with live % readout, COLOR SCHEME as three gradient swatches
    (render each swatch's gradient from the existing `heatColorRgb` ramp so swatch and
    raster can never disagree). Snapshot chip in the card header (`#N`, green).
    All of this drives the existing `applyRasterLayer` / `recolorizeRaster` — no logic change.
  - **POINT OVERLAYS**: row style per mock (checkbox, color dot, name, count). Counts
    come from `summary.categories` (portals/beds/tombstones/containers already there;
    verify field names, else `/api/v1/world-summary`). Count display is passive — no new
    endpoint.
  - **SPAWN TIME FILTER**: keep the 0–2 world-fraction inputs functional but present
    day-range labels when day span is derivable; sparkline histogram is **deferred**
    (needs a spawn-time distribution source; candidate: tiny `/api/v1/db` aggregate later).
    Ship the card restyle without the sparkline first.
- Map chrome: legend pill top-left ("Build density · 320 m cells · snapshot #N") bound to
  `activeRasterLayer`/`rasterCellSize`/`selectedSnapshotId`; coords bar bottom-left
  (exists as `mapCoords`, restyle); "Copied" toast on click-to-copy (exists, add the toast);
  keep Leaflet zoom control, restyled via CSS.

### Phase 3 — Content views: headers, stat cards, tables, Coin trail merge
- Per-view header row: view title + endpoint echo in Plex Mono (`/economy · top 80
  prefabs by value`), filters right-aligned. Endpoint strings are static per view.
- Stat-card rows where the mock has them: Economy (total value, containers, distinct
  prefabs, top-10 share — all derivable from the existing `/api/v1/economy` payload;
  deltas vs previous snapshot **deferred** until a compare call is wired), Changes
  (added/removed/net/prefabs touched/span — all in the existing compare result).
- **Coin trail merge**: one `forensics` view with segmented Top caches / Issuers /
  Guild gear reusing the three existing loaders/tables; SCOPE bar per mock. Old tab ids
  (`caches`, `issuers`, `guildgear`) redirect to `forensics` with the right segment so
  old `#tab=` links keep working.
- Tabulator restyle: override its theme with the token palette (header = `--panel`,
  rows = `--panel2`, borders `--line`, Plex Mono numeric columns). One CSS block; do not
  replace Tabulator — sorting/virtual scroll on 9k-row tables is load-bearing.
- Changes view: FROM/TO pickers + Compare button in the header (exists, restyle), stat
  cards, the unresolved-prefab warning banner (data exists in the compare payload),
  two-column added/removed tables with share bars.

### Phase 4 — Async-state patterns (loading / empty / error)
- One Alpine partial per pattern, matching the mock: skeleton cards + spinner row while
  a view's first fetch is in flight; centered empty state with "Clear filters / Change
  snapshot" actions; error card with the failed `GET <endpoint> → <status>`, retry
  button, and "other views keep their last-loaded data" copy.
- Implement as a per-view `viewState` map (`ready|loading|empty|error`) set inside the
  existing load functions' try/catch — mechanical, view by view. Start with the
  DB-backed views (they're the ones that can 404/503 during publishes).
- The "scopes N of M views" honesty chip (header, amber): shows how many views respect
  the snapshot selector. Static map of view→snapshot-aware (true for map rasters,
  changes, explore; false for the in-memory views until they're migrated). Cheap to
  ship and matches the design brief's honesty theme.

## Historical deferrals and disposition

1. **Forensics merge — delivered.** Top caches, Issuers, and Guild gear are Coin trail
   segments; the old `#tab=` targets redirect to the correct segment.
2. **Spawn-time sparkline — still deferred.** It needs a bounded aggregate endpoint. Numeric
   range inputs remain usable without it.
3. **Economy deltas vs previous snapshot — still deferred.** The Changes surface owns the
   implemented comparison workflow.
4. **History tab — delivered.** It uses the v4 header, provenance, raster-availability, and
   loading/error patterns.
5. The mock's fixed 1600×1000 frame remains a canvas artifact; the real app is fluid.

## Files
- `viewer/src/main/resources/static/index.html` — all four phases (single-file app).
- `viewer/HANDOFF.md` — nav/IA notes after Phase 1 and the Coin trail merge.
- `design_mocks/Shell A - Two-level tabs.dc.html` — historical reference only.

## Original verification checklist

Run the local server against a rendered cache (`--cache … --render-dir … --port 8013`),
then: Phase 1 — all leaf views are reachable through the new nav and `#tab=` deep links
land correctly; Phase 2 — raster layer/cell/opacity/scheme all drive the overlay and counts
match the summary payload; Phase 3 — Coin trail segments hit all three forensics endpoints
and Tabulator sort/scroll remains intact; Phase 4 — interrupt a request and confirm error,
retry, stale-last-success, and empty states. The shipped v4 release additionally passed a live
AM4 browser smoke of Map and Changes after its code and data publishes.
