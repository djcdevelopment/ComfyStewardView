# Feedback on Shell A for the high-fidelity pass

Context for the designer: the app is a no-build-step single-file SPA (Alpine.js +
Leaflet + Tabulator). Everything below is implementable in that stack; items marked
**(data gap)** need small backend work we've already scoped, so design them but expect
phased delivery.

## Structural

1. **Selection doesn't belong in the tab row.** A selection is created by shift+drag on
   the map; a "Selection" tab you can open with nothing selected is a dead end. Prefer:
   selection results open as a drawer/panel over the Map view (right side or bottom),
   with the tab removed — or if the tab stays, design its empty state as an instruction
   card ("shift+drag on the Map to select a region") that deep-links to Map.

2. **Design the missing views, at least as one blessed template.** Mocked: Map, Economy,
   Coin trail, Changes, Explore, and the async states. Not mocked: Portals, Structures,
   Dropped, Signs, Tombstones, Alerts, Players, Creatures, History. Most can inherit a
   generic "filter bar + table card" template — please bless that template explicitly.
   Three need their own attention:
   - **Alerts**: severity is the organizing principle (critical/high/medium/low chips,
     type filter). Also: should the Alerts pill in the nav carry a count badge? We have
     the number and it's a steward tool — recommend yes, design the badge.
   - **History**: the snapshot timeline (source am4/omen, file hash, parse date, ZDO
     count per snapshot). This is the provenance/trust view; deserves better than a
     plain table.
   - **Portals**: pairing status (paired/orphaned/hub/blank-tag) filters + fly-to-map
     actions on rows.

3. **The scope/honesty model needs its interaction designed.** The "scopes 3 of 14
   views" chip is the right instinct — our real situation is that some views are
   snapshot-aware (map rasters, Changes, Explore) and some reflect only the world the
   server parsed at boot. Two asks:
   - What happens on hover/click of the chip? (A popover listing views, live vs pinned?)
   - A per-view affordance in the view header for the pinned case — e.g. a small badge
     "pinned to boot snapshot" where the endpoint echo sits. This is the single most
     important honesty element; make it unmissable but not alarming.

## Map view

4. **The raster layer needs an off state.** Current app has Hide/Show; the mock's 2×2
   layer grid has no way to turn the heatmap off. Either clicking the active layer
   deselects it, or add a visibility toggle in the RASTER LAYER card header. Pick one
   and show both states.

5. **Intensity legend.** The status pill says what layer is shown but not what the
   colors mean. We have real min/max values per layer (e.g. "max 15,275 pieces/cell").
   A compact gradient legend — bottom-right of the map or in the card — with min→max
   labels would make the heatmap readable. Log-scaled, so mark that honestly (e.g.
   tick labels at real values, not linear).

6. **Color scheme swatches need names, a selected state, and final ramps.** The three
   gradient swatches are unlabeled. Also: the ramps ARE the product here — the raster is
   grayscale and colorized client-side, so whatever three ramps you design become the
   actual palettes (current placeholders: blue→red "hot", green, viridis). Design the
   three ramps you want against the dark map background; we'll implement them exactly.

7. **Point overlay scale honesty.** Counts per overlay are great. But Containers is
   ~74k points and Signs ~115k — rendering all of them is not viable. Design the
   over-budget state: e.g. count shown amber with "showing 5,000 of 74,752 (zoom in)".

8. **Spawn time filter (data gap).** Love the day-range + histogram treatment. Two
   things: spec the drag interaction (two handles on the strip? drag the shaded region?),
   and know the histogram ships one phase later than the rest (needs a small aggregate
   endpoint). The card should degrade gracefully to inputs-only.

## Tables

9. **Pick one scrolling model.** Explore shows Prev/Next pagination; our large tables
   (9k portals) use virtual scroll today and that should stay. Recommend: virtual scroll
   + "N rows" indicator for all in-memory tables; keep pagination only for Explore,
   whose queries are server-side limit/offset. Design sort indicators and active-filter
   chips for the virtual-scroll case (we keep Tabulator underneath — it can match the
   visual spec, but it needs the spec).

10. **Row → map linking.** "rows link to map · ↵ to open" is the right idea; make the
    affordance visible per-row (the "Fly to →" cell in Coin trail is good — apply it
    consistently wherever a row has coordinates).

## Changes view

11. **A few real fields are missing.** The compare payload also carries container-items
    delta, new portals, new tombstones, and a "snapshots named by different prefab
    dictionaries" condition (a stronger warning than the unresolved-prefabs banner —
    counts may be incomparable). Add stat-card slots for the first three and design the
    dictionary-mismatch banner variant.

## States

12. **Add a "stale data" state.** The error card's copy says other views keep
    last-loaded data — design that state too: a view showing old data after a failed
    refresh (e.g. amber "showing data from 12:04 · refresh failed" strip above the
    content). This will happen routinely during publishes.

13. **Confirm auto-retry.** The error card promises "retry automatically in 15 s" —
    fine by us, just confirming it's intended behavior spec and not filler copy.

## Practicalities

14. The 1600×1000 frame is understood as canvas; the real app is fluid full-viewport.
    Spec minimum comfortable width and what gives first (the secondary pill row already
    scrolls horizontally — good; does the map sidebar collapse?).
15. The map background/heat glow in the mock is illustrative; the real map is a Leaflet
    canvas with our own dark styling — the token palette applies, the radial gradients
    don't need to be reproduced.
16. Fonts via Google Fonts CDN and all styling via plain CSS custom properties are fine;
    no build step exists, so no CSS preprocessing.
