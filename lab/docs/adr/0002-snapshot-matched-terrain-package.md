# ADR 0002: Snapshot-matched terrain package

- Status: Accepted
- Date: 2026-09-03

## Context

An inferred all-object raster can orient a lab user, but it cannot honestly represent coastlines,
height, terrain edits, or biome territories. Generating terrain in the public request path would be
slow, would require mounting source world data, and would make provenance difficult to audit.

## Decision

Build terrain context offline from the release DB/FWL pair, Valheim's generated map/height/forest
caches, and saved terrain edits. Emit a versioned manifest bound to the snapshot hash and world ID with
checksums for six fixed-bound variants:

- restrained `overview` and `detail` images for Heatmap context;
- contour-forward `topographic-overview` and `topographic-detail` images for neutral terrain and
  Biomes;
- an indexed `biome-mask` used for authoritative query membership; and
- a `biome-display-mask` used only for outline presentation.

The builder refuses a live AppData world database. The server verifies manifest structure, snapshot,
dimensions, safe filenames, file sizes, and hashes at startup. Public metadata omits private source
paths. A standalone supplied image and the inferred all-ZDO layer remain local/fallback options.

## Consequences

Public requests stay read-only and cheap, and the displayed world can be traced to a particular
snapshot. Terrain packages are larger deployment artifacts and must be rebuilt when their source
snapshot changes. Visual cleanup cannot affect biome counts because the display and evidence masks are
separate by contract.
