# Historical world terrain and biome publication

The six archived eras that opened as construction maps now carry terrain, topographic
and biome layers. All eight published eras are biome-classified; none is served
`unclassified`.

| Era | Construction pieces | Terrain before | Terrain now |
| --- | ---: | --- | --- |
| 7 | 2,746,682 | Construction map | Regenerated in Valheim 0.221.12 |
| 8 | 3,092,090 | Construction map | Regenerated in Valheim 0.221.12 |
| 9 | 3,153,849 | Construction map | Regenerated in Valheim 0.221.12 |
| 10 | 3,291,909 | Construction map | Regenerated in Valheim 0.221.12 |
| 11 | 3,008,433 | Construction map | Regenerated in Valheim 0.221.12 |
| 12 | 3,105,792 | Construction map | Regenerated in Valheim 0.221.12 |
| 14 | 3,652,409 | Regenerated | Unchanged; the AM4 context is reused in place |
| 17 | — | Regenerated | Unchanged |

Nothing was photographed or re-parsed for this. The map, height and forest caches were
generated on OMEN by `omen_terrain_cache.py` on 2026-09-09 and had been sitting unused
since; the [spatial publication receipt](era-archive-spatial-publication-2026-09-08.md)
was written the morning before the last five of them finished. What was missing was the
step that turns caches into a context, and the only implementation of that step,
`am4_biome_context.py`, is shaped around AM4: it blocks on a photography handoff,
rebuilds the world pair from a staged-worlds directory, and stamps host AM4. Run against
OMEN it waits forever. `omen_biome_context.py` is the sibling that does not.

The AM4 attempt is retained as evidence and produced no contexts:
`terrain-cache-20260909/status.json` failed on an unresolved `era10-attempt-01`, and
`historical-terrain-20260909/status.json` refused two handoffs after an operator stop.

## Biome classification

Construction pieces per biome, from each public cache's `biomeCounts`. These are counts
of built objects standing in each territory, not areas.

| Era | Ocean | Meadows | Mountains + Forest | Plains | Swamps | Mistlands | Ashlands | Deep North |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 7 | 924,141 | 299,708 | 716,750 | 359,258 | 55,784 | 248,965 | 31,311 | 110,765 |
| 8 | 1,141,039 | 308,154 | 697,814 | 390,537 | 37,543 | 394,631 | 30,955 | 91,417 |
| 9 | 1,417,741 | 229,706 | 522,181 | 390,346 | 34,518 | 419,733 | 29,864 | 109,760 |
| 10 | 1,525,080 | 245,273 | 544,798 | 367,944 | 45,381 | 405,948 | 38,412 | 119,073 |
| 11 | 1,447,582 | 227,980 | 459,777 | 376,868 | 28,403 | 392,979 | 8,590 | 66,254 |
| 12 | 1,507,031 | 219,908 | 455,084 | 355,661 | 34,083 | 451,186 | 2,987 | 79,852 |
| 14 | 2,144,068 | 224,538 | 393,719 | 307,089 | 30,997 | 478,577 | 4,759 | 68,662 |

Classification is `comfy-era17-territories-v1` with the separately smoothed
`plurality-lasso-r3-v1` display mask. Ocean absorbs water, so a piece over water counts
there regardless of the land beneath it. Every era classifies into all eight territories
with no empty bucket. Ashlands and Deep North counts are small and fall sharply after
era 10; that is what the data says, not a claim about why.

## Terrain packages

Six new contexts, 36 files, 27,673,114 bytes, each six variants at 2048 and 4096 pixels.

| Era | Bytes | TerrainCompiler payloads | Height records | Paint records | Save layout | Context manifest SHA-256 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 7 | 4,510,862 | 18,856 | 5,187,133 | 8,294,984 | 29 | `3dd3ae3fe04fb0cbeba5c7ca3c0515c19ff58aee23900575f72026b567891ccf` |
| 8 | 4,614,445 | 19,665 | 5,212,800 | 8,260,896 | 29 | `d3899778b75b67406ec770b1e3bcf4adf92533351763d19a352cdaee07d0e6f6` |
| 9 | 4,648,996 | 16,189 | 4,474,635 | 6,926,341 | 32 | `50e5339744b4efdf31899b974f2db34e856f881af7b9cf3484f3d2216b7a723c` |
| 10 | 4,727,623 | 16,460 | 4,674,414 | 7,546,389 | 33 | `2a5b64fc8733ae983ea6134a1cd781767d87dd8ab1e8495de7705e0c39a436e6` |
| 11 | 4,653,459 | 22,859 | 4,229,075 | 28,834,026 | 34 | `d4af1771af29252335db9fc6aa28e762e84b48cb66954d5bf33c6ee91f4895bb` |
| 12 | 4,517,729 | 21,273 | 4,193,702 | 32,559,221 | 34 | `70914d3c6f62630dd897b1acb6390408bafa39e912911ad915b42ce38e75a334` |

Both legacy length-delimited saves (29) and compact ones (32–34) were read with the
frozen parser. Eras 11 and 12 carry roughly four times the ground paint of the earlier
eras.

Every context is bound to its source: `terrain_provenance.py` writes
`generation.mode = current-client` with the observed game, Unity and world-generator
versions taken from that run's own `Player.log` — Valheim 0.221.12, Unity
6000.0.61.7643309, world generator 2. `omen_biome_context.py` additionally asserts that
the finished manifest names the exact caches the run generated and the archived FWL, so
a context cannot be built from another era's caches. The public viewer labels this
regeneration; historical terrain fidelity is not certified.

## Publication

The public caches were re-exported for all seven archived eras. Eras 7–12 moved from
schema 5, which explicitly stores `unclassified` and forbids a biome mask, to schema 4
with matching terrain and classified biomes. The bundle holds 120 receipted files
totalling 1,598,581,704 bytes before transport compression, and every one of the eight
catalog entries now carries a `contextManifest`.

No Java changed. `PublicCacheExporter`, `TerrainContext`, `BiomeClassifier` and the
frontend already handled all of this — eras 14 and 17 were exercising the same code
path. The served jar is byte-identical to the one already running,
94,033,104 bytes, SHA-256
`a356d559a7bd4e1327041306497a7229f2680343445c6af12717bb3c5b867a42`. This release changes
data only.

`world-browser-smoke.mjs` carried four assertions that were true statements about a
terrain-free era written as facts about era 7: that it must refuse a biome query with
HTTP 400, that it opens on a construction raster, that it renders no context image with
its biome button disabled, and that switching back to it lands on a `construction-only`
body. All four failed against this release, correctly — the test was describing the
world as it was that morning.

Each is now driven by the catalog. Eras without terrain must still refuse biome queries,
render no context image and disable the button; eras with terrain must answer, draw a
context image and enable it. Era isolation no longer uses "era 7 has no terrain" as its
proxy: it asserts that every context image the page draws carries that era's own scope,
which is what isolation actually means and what `scopedUrl` actually stamps.

## Deployment

VERIFIED live at **2026-09-10 13:33 UTC**: [`/world/`](https://am4.tail8e749c.ts.net/world/?era=era7)
serves release `bb816e6d17c3-c8e581124189` from source revision
`bb816e6d17c3d7ca76615b34e986631001561500`. The transferred bundle is 674,358,921 bytes,
SHA-256 `c8e581124189c2c371c9e4bca59e7bcdd8927123e1ac68ca3718a82995510bc9`. AM4 stores the
release at `/home/derek/steward-world/releases/bb816e6d17c3-c8e581124189`. Only the
`steward-world` container on port 7081 was replaced; its stopped predecessor is retained
as `steward-world-before-bb816e6d17c3-c8e581124189` for rollback. Candidate and
active-service checks both passed.

`GET /api/eras` reports `terrainAvailable: true` for all eight eras. The check that
matters is the one that used to fail: era 7's build-density query filtered to Meadows
over a 4 km box returned HTTP 400 before this release and now returns 155,664 objects.
Era 7's bootstrap serves the full eight-territory catalog with per-territory item counts,
`generationMode: current-client`, and all six context variants.

`world-browser-smoke.mjs` passed against the public URL: all eight eras reported terrain
with `current-client` generation, except era 17 which remains snapshot-matched. Exact
build inspection returned 3,686 pieces for the era 7 case and 7,123 for the era 14 case,
both scenes rendered on hardware WebGPU and exported PNG files, and era switching
dropped build scope without leaking imagery. Live screenshots, scene receipts and the
exports are under `browser-live/`; era 7's opening view is `browser-live/era7-overview.png`.

VERIFIED locally: 64 archive Python tests, 12 lab Python tests and the lab Java suite
passed. Seven of the archive tests are new and cover the OMEN context builder.

Artifacts are retained under `E:\omen\steward-multi-era\world-view-v3`.
