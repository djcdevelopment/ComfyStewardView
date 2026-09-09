# ADR 0005: Open archive spatial data before terrain generation

- Status: Accepted
- Date: 2026-09-08

Historical archives already contain construction positions, rotations and exact
membership. Requiring a historical game runtime before showing any of that data
left seven eras behind a preparation screen despite verified extraction and zoom
rasters. Current-client generation also produced usable Era 14 terrain without
historical runtime parity.

A spatial package is ready when its public cache, exact membership and raster
artifacts validate against the archived snapshot. Terrain is an independent
capability. Schema 4 public caches retain the terrain/biome contract; schema 5
explicitly has no biome mask and every construction row is unclassified. The
server checks that distinction and resolves biome filters against the selected
era's context.

Eras with terrain retain the terrain-first interaction in ADR 0003. Other eras
open their construction heatmap with object inspection and 3D previews. Biome
controls remain unavailable until matching terrain is present. Era navigation
discards the prior build scope and imagery; returning from a scene preserves its
own era and build. Exact-build counts stay scoped while world-share denominators
refer to the full era.

Current prefab geometry supports spatial previews from saved transforms, with
existing measured/estimated/pivot-marker receipts. It is not a claim of historical
asset fidelity. Current-client terrain generation is labeled with its game version
and bound to the source DB and cache hashes. Source archives remain immutable, and
invalid positions remain accounted for outside the spatial projection.

The photo campaign and public world deployment have separate processes and data
directories. Publishing these read-only spatial packages does not switch the
capture world's game session or consume its GPU.
