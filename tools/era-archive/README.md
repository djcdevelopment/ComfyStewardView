# Multi-era community archive

This repository owns the save intake, community analysis, gallery creator pages and
multi-era world catalog. The migrated selfie-stick helpers have a pinned Baseline
source receipt in `../selfie-stick/source-provenance.json`. Baseline retains discovery
and historical evidence; it is not an executable dependency.

The first release processes Eras 7, 8, 9, 10, 11, 12 and 14. It preserves the active
Era 17 gallery and world view, and the archived Era 16 photo URLs. A current-client
Era 14 run has now produced native 4K photographs and all three terrain caches.
The [quiet AM4 campaign](QUIET-CAPTURE.md) runs capture batches locally without
requiring historical runtime parity or transferring images while OMEN is gaming.
The older publication-review contract below is separate from this capture route.

## Run the CPU pipeline

Build `viewer` and `lab` with Java 17 and their Maven wrappers. Install this directory's
`requirements.txt` into the processing Python environment. Use explicit input and
output directories in separate trees:

```powershell
.\tools\era-archive\Invoke-EraArchive.ps1 `
  -InputRoot <original-world-pairs> -OutputRoot <processing-root> `
  -Java <java-executable> -Python <python-executable> `
  -LegacyGalleries <private-gallery-inputs.json>
```

Each intake pair is identified by both SHA-256 hashes and byte counts. Directory
dates are not save timestamps. Versions 29/30 use length-delimited legacy records;
31/32 use compact byte counts; 33–37 use compact extended counts. Only 29, 32, 33,
34 and 35 have been exercised against this seven-era archive.

The writer freezes its parser JAR and stages each extraction separately. A package
is promoted only after source rechecks, declared/actual object reconciliation,
unique object-index checks, inventory extraction, typed-field export and geometry
membership checks. Failed candidates remain evidence. Reruns use the frozen parser;
an explicit different parser requires a new processing catalog.

`payloads.py` retains exact binary fields and original inventory strings. These
supplement fields the older analytics schema represented only by length. `zdo_field_full`
joins the original values back onto the typed fields; immutable originals remain
the authority for network headers and complete game serialization.

`archive.py rebuild --output-root <root>` reconstructs `world-cache.duckdb` as views
over verified Parquet, including payloads and community tables. The database is a
read model, not the archive's only copy. `archive.py verify` rechecks original pairs
and extraction packages. All commands accept `--help`.

## Query the community

The private read model contains `world_snapshot`, `zdo`, `zdo_field`,
`container_item`, `zdo_payload`, `zdo_field_full`, `builder`, `builder_character`,
`name_observation`, `build`, `build_contributor`, `build_member` and `build_photo`.

```sql
-- Creator-era coverage, including shared builds.
SELECT b.era, c.builder_key, count(DISTINCT b.build_key) AS albums,
       count(DISTINCT p.photo_id) AS photos
FROM build b JOIN build_contributor c USING (build_key)
LEFT JOIN build_photo p USING (build_key)
GROUP BY 1, 2 ORDER BY photos, albums DESC;

-- Exact three-dimensional membership, not a rectangular approximation.
SELECT z.* FROM zdo z JOIN build_member m USING (snapshot_id, zdo_index)
WHERE m.build_key = '<opaque-build-key>';
```

Construction attribution, bed/tombstone ownership and item crafting are distinct
evidence types. Matching saved character IDs join observations; matching names do
not merge characters. Conflicting current names remain ambiguous and searchable.
Optional reviewed cross-character links use `steward-builder-links/v1`, with an
opaque `builderKey`, decimal-string `characterIds`, `evidence`, `reviewedBy` and
`reviewedAt`. Never derive identity from nearby structures or a photo label.

Primary grouping uses connected 16 m three-dimensional cells with four pieces per
cell. Residual construction uses connected 8 m cells, retaining even single pieces.
These are reproducible spatial groups, not claims that every group is an independent
architectural building. Opaque keys include source-pair identity, recipe and exact
membership. Non-finite positions are retained in a separate spatial quarantine and
reported in reconciliation totals.

Historical photos use the exact private index that produced their gallery. Their
recorded leading contributor is preserved; full historical membership remains
unresolved. An old cluster number is never replayed against a different snapshot.

## Runtime audit and capture queue

`analysis/unknown-assets.json` reports recurring unknown prefab hashes by era.
An unresolved dictionary name is not evidence that a runtime asset is missing.
Actual missing-construction fractions remain null until measured in a reviewed
historical runtime. Investigate before publishing affected content at **5% per era**
or **10% per selected build**. Small gaps remain documented. Historical modpack
records are helpful evidence but are not mandatory when the unknowns are immaterial.

`analysis/jobs.json` prioritizes the first photographic opportunity for each
creator-era pair, then architectural score. It is a candidate inventory, not a
promise to photograph hundreds of thousands of remnants. `pilot.py` prepares three
pilots per era (small, shared and landmark), four exterior shots each at 3840×2160.
Framing uses every member's XYZ. Clipped subjects are explicitly flagged. An interior
is selected only after runtime/visibility review. A pilot's numeric TSV cluster IDs
are local dispatch IDs; `plan.json` binds them to era, snapshot and opaque build keys.

To prepare a manual session:

```powershell
python tools/era-archive/jobs.py prepare-session --output-root <root> `
  --era era7 --runtime <reviewed-runtime.json>
```

A `steward-era-runtime/v1` receipt needs the source pair's `sourceKey`, `eraMatched: true`,
reviewer/time/version evidence, explicit launch instructions, pinned runtime files
(`path`, `bytes`, `sha256`) and measured `availability.missingConstructionFraction`.
When pilots exist, `availability.missingFractionByBuild` must measure every selected
opaque build key and keep each below 10%.
The command verifies and copies the originals into an isolated working directory;
it never launches Valheim. Keep one active session. Missing runtime, prefab audit
or adapter compatibility leaves the session blocked. Never substitute the current
game silently and never point a game session at the original archive.

After stopping the game, `jobs.py close-session --output-root <root> --completion <json>`
checks the originals again and releases the session. Its
`steward-era-session-completion/v1` document identifies `sourceKey`, confirms
`gameStopped: true` and supplies `outputs` receipts for `mapTexCache`, `heightTexCache`
and `forestMaskTexCache`, with paths relative to the prepared working directory.

CPU rasters are generated automatically at 320/160/80/64/16 m. Terrain textures still
require the era's map, height and forest caches. Feed these explicit paths and the
save/raster manifest into `lab/tools/build-terrain-context.py`. That reader now
accepts the legacy and compact layouts and retains saved TerrainCompiler edits.
Game photography needs a compatible capture plugin and observed runtime evidence.
Spatial previews can use the verified current prefab catalog with saved XYZ and
Euler transforms. Their scene receipts distinguish measured, estimated and unknown
geometry; they do not claim that the historical game assets have been recreated.

## Publish and verify

`gallery.py` produces an immutable static projection with a strict public allowlist.
The creator directory and per-era threads exclude raw IDs, inventories, source
paths, coordinates, seed and private review evidence. Existing photos link to their
original thumbnail/large URLs. New albums deep-link to `/world/?era=era7&build=…`.

`world_bundle.py` accepts an explicit `ready-inputs.json`: `defaultEra`, and an `eras`
list containing `slug`, `snapshotId`, `cache`, optional `context` (the directory containing its
manifest), `artifacts` (parent of the numeric snapshot directory), and optional exact
`membership` Parquet.
Archived-era entries require verified exact membership and the inventoried snapshot
hash. Historical runtime parity is not a prerequisite for spatial publication.
Every ready cache must first be exported by
`dev.steward.lab.PublicCacheExporter` with matching geometry, representations and
promotion receipt. Schema 4 includes matching terrain and classified biomes; schema
5 explicitly has no terrain and stores `unclassified` biome values. Pass `-` as the
exporter's context argument for schema 5. The bundle refuses private attribution
columns and pins every served file. A ready era can open its construction map,
inspection and 3D previews before terrain is generated.

`prepare_public.py` verifies the archive, membership and raster receipts and exports
all historical eras using an explicit current geometry artifact and SHA-256. Its
`--terrain-inputs` JSON maps only eras with available context directories. Known
non-finite positions are retained in the archive and recorded in an input receipt;
they can be excluded from spatial export only when absent from exact membership.
The exporter still rejects mismatched geometry and invalid transforms.

For terrain regenerated in a current client, `terrain_provenance.py` binds an
observed `steward-terrain-generation/v1` receipt to the context. It checks the original
DB and all four source hashes (FWL, map, height and forest caches). The public viewer
labels that terrain as regenerated; it does not present it as historical terrain.
Eras without terrain begin in Heatmap mode and cannot submit biome-filtered queries.

The server independently validates hashes, world identity, snapshot, context and
public cache schema at startup. `--era-catalog <catalog.json>` enables request-local
era selection. Exact build membership filters item queries and 3D instances, even for
vertically overlapping structures. Era switching performs a navigation so stale
requests, image caches and item cursors cannot cross eras. Existing public rate,
memory, concurrency and scene limits remain; 3D export is the existing scene and PNG.

After committing the tested implementation, use `deploy_gallery.py` and
`deploy_world.py` with explicit projection/bundle/JAR, full revision and receipt paths.
The former stages checked files and switches only `/valheim/creators`, adding links
to existing gallery pages. The latter tests a separate candidate on AM4:7083, then
replaces only `steward-world` on 7081, preserving its environment and a stopped prior
container for rollback. Neither changes Funnel routing or `/steward` on 7080.

```powershell
python -m unittest discover -s tools/era-archive/tests -v
python -m unittest discover -s lab/tools/tests -v
# Run mvnw.cmd test in viewer and lab.
node tools/era-archive/browser-smoke.mjs <creator-base-url> <world-base-url> <receipt-dir>
node tools/era-archive/world-browser-smoke.mjs <world-base-url> <build-cases.json> <receipt-dir>
```

Operational data and screenshots belong outside Git. Keep the original archive,
parser artifact, private identity registry, curated links, processing catalogs and
Parquet packages together in backups.
