# Historical world spatial publication

> The six eras below that opened as construction maps received terrain and biomes on
> 2026-09-10. See the [terrain and biome publication](era-terrain-publication-2026-09-10.md).
> This receipt is left as written; it records what was true when it was written.

The seven archived eras contain **22,051,164 finite construction positions** in
their public spatial packages. Each package retains saved Euler transforms and
exact build membership. All 35 existing construction raster layers are included,
at 320, 160, 80, 64 and 16 meters per cell.

| Era | Construction pieces | Terrain |
| --- | ---: | --- |
| 7 | 2,746,682 | Construction map; terrain generation pending |
| 8 | 3,092,090 | Construction map; terrain generation pending |
| 9 | 3,153,849 | Construction map; terrain generation pending |
| 10 | 3,291,909 | Construction map; terrain generation pending |
| 11 | 3,008,433 | Construction map; terrain generation pending |
| 12 | 3,105,792 | Construction map; terrain generation pending |
| 14 | 3,652,409 | Regenerated with current Valheim 0.221.12 |

Era 17 retains its previous terrain and spatial data. Era 10's eight non-finite
positions remain in the immutable archive and are accounted for in the spatial
input receipt; none occurs in exact build membership. No valid-position geometry
mismatch or invalid rotation is silently removed by the exporter.

Era 14's six terrain variants total 4516560 bytes. They incorporate 19,617 saved
TerrainCompiler payloads, including 3,356,111 height and 27,551,541 paint records.
The terrain context manifest SHA-256 is
`321d874ef8e1508fc53eb9289e93bb81dab34e453ad36d5f3de337755ae98849`.
Its generation receipt matches the original DB and the verified FWL, map, height
and forest cache hashes from the [AM4 capture proof](era14-am4-current-client-capture-2026-09-08.md).
The public viewer labels this current-client regeneration; historical terrain
fidelity has not been certified.

Spatial readiness no longer depends on a historical game runtime. Schema 5 public
caches explicitly omit terrain and biome claims. They open a construction map with
inspection and 3D previews. Schema 4 retains the matching terrain and biome-mask
contract. The server rejects biome filters for a terrain-free era, even when the
default era has terrain. The [availability decision](../lab/docs/adr/0005-progressive-archive-availability.md)
records the resulting contract.

VERIFIED locally: 36 Java tests, 20 archive Python tests and 12 lab Python tests
passed. The browser exercised all eight eras, exact-build inspection, era switching,
cross-snapshot rejection, terrain isolation and scene return links. Hardware WebGPU
rendered the 3,686-piece Era 7 sample and the 7,123-piece Era 14 sample; both exported
PNG files. Scene receipts distinguish measured envelopes, estimated geometry and
unknown markers. These are spatial previews, not native game photographs.

Source implementation: `240bf940b612b8a17b01decdf51b2ff4aa3f7372`.
JAR: 94033045 bytes, SHA-256
`a4bcd878452ce8dcf7aa1e19047cdc8a27c7c12eb328787dee8af1c87dd4b102`.
The immutable bundle contains 78 receipted files totaling 1566674111 bytes before
transport compression. Operator artifacts, input receipts, the generation receipt,
public summaries, browser screenshots and exported PNGs are retained under
`E:\omen\steward-multi-era\world-view-v2`.

VERIFIED live deployment at **2026-09-09 06:17:00 UTC**:
[`/world/`](https://am4.tail8e749c.ts.net/world/?era=era7) serves release
`240bf940b612-55515317d64f`. Candidate and active-service checks passed for all eight
eras. The same browser checks then passed against the public URL, including both
hardware WebGPU scene renders and two downloaded PNG exports. Live screenshots,
scene receipts and exports are under `browser-live/`; `deployment.json` records
the immutable release and rollback state.

The transferred bundle is 643778938 bytes, SHA-256
`55515317d64f7775fdf379bc12585bb2c503694aee13676f49ef0b9b18f198cb`.
AM4 stores the release at
`/home/derek/steward-world/releases/240bf940b612-55515317d64f`.
Only the `steward-world` container on port 7081 was replaced. Its stopped predecessor
is retained as `steward-world-before-240bf940b612-55515317d64f` for rollback.

AM4 capture runs separately under `steward-era14-capture.service`; the web release
does not modify its game files, plugins, save copies, requests or image directory.
At 06:14:42 UTC, its first 400 photographs were journaled. All six additional world
save pairs completed staging at 05:25:36 UTC, with 5545801854 original bytes checked
on AM4 against the archive hashes.

VERIFIED after deployment at 06:21:45 UTC: the capture service remained active,
with 430 of 4,000 photographs completed and 4182589634 image bytes stored on AM4.
The supervisor had advanced to `batch-0001` (30 of 400 shots, game PID 1717037).
The campaign remains running; this receipt records spatial publication, not
completion of photography or terrain generation for the other six eras.
