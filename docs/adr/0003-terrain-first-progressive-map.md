# ADR 0003: Terrain-first progressive map

- Status: Accepted
- Date: 2026-09-03

## Context

A three-way Topographical / Heatmap / Biomes switch made the basemap look like another analytical mode
and opened directly on an answer before visitors had read the world. It also made “turn analysis off”
less obvious and left the first-use guide teaching controls instead of a progression.

## Decision

Use three internal view states—`terrain`, `heatmap`, and `biomes`—with `terrain` as the public default.
Expose only Heatmap and Biomes under **EXPLORE WITH**:

- selecting an inactive tool activates it and deactivates the other;
- selecting the active tool returns to terrain;
- biome choices persist while Biomes is closed;
- Biomes + None shows the same unmarked enhanced terrain as the start state; and
- blank canvas outside the globe pans but never selects or inspects.

Terrain and Biomes use the contour-forward context assets. Heatmap keeps the restrained context,
construction raster, opacity behavior, and legend. Terrain renders none of the analytical layers.

Open a versioned Quick Start once per browser after readiness. Every close path records dismissal, the
`?` control always reopens it, and Discord authentication returns take priority over automatic guidance.

## Consequences

The stable object is the world; Heatmap and Biomes become reversible questions layered on it. The state
machine must actively remove stale rasters, outlines, exact points, legends, and inspections during
transitions. Copy and browser tests now form part of the interaction contract because first-visit state
is product behavior, not incidental markup.
