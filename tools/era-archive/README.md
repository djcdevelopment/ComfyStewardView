# Multi-era community archive

This repository owns the save intake, community analysis, gallery creator pages and
multi-era world catalog. The migrated selfie-stick helpers have a pinned Baseline
source receipt in `../selfie-stick/source-provenance.json`. Baseline retains discovery
and historical evidence; it is not an executable dependency.

The archive processes Eras 7, 8, 9, 10, 11, 12, 14 and 16. It preserves the active
Era 17 gallery and world view. Current-client terrain sessions produce source-bound
terrain caches without modifying the frozen historical saves.
The [quiet AM4 campaign](QUIET-CAPTURE.md) runs capture batches locally without
requiring historical runtime parity or transferring images while OMEN is gaming.
The older publication-review contract below is separate from this capture route.

## Run the CPU pipeline

Build `viewer` and `lab` with Java 17 and their Maven wrappers. Install this directory's
`requirements.txt` into the processing Python environment. Use explicit input and
output directories in separate trees:

```powershell
.\tools\era-archive\Invoke-EraArchive.ps1 `
  -InputRoot <original-world-pairs> -OutputRoot <processing-root> [-WhatIf]
```

The driver takes every cross-era flag from `<processing-root>/run-manifest.json`
(`steward-run-manifest/v1`: `legacyGalleries`, `links`, every `captures` manifest, the
parser and lab jars, `java`), never from the command line. Omitting one of those flags
is not "none", it is "drop what you had" -- it cost 535 albums on 2026-09-10 and every
photograph on 2026-09-12. A run snapshots `analysis/` to `analysis-backup-<stamp>-auto`
(the last three are kept), ingests every pending era with `--no-rebuild`, runs payloads,
community, community tables, rasters and pilots over the verified eras, rebuilds the read
model once, verifies, removes stale read-model candidates, headless-Chrome `profile/`
directories under receipts and `analysis/*.bak-*`, and writes
`runs/<stamp>/run-receipt.json` (with a transcript). `run_receipt.py` fails the run if the
projection imported fewer capture manifests than the run manifest names; `community.py`
refuses that on its own too (`--allow-fewer-captures` to say the loss is intended).
`-WhatIf` prints every command and every deletion without doing anything. `-Era <slug>`
restricts ingest; later stages still cover all verified eras.

Each intake pair is identified by both SHA-256 hashes and byte counts. Directory
dates are not save timestamps. `inventory` judges each `.db` on its own and writes
`intake-report.json` (`accepted`, `rejected` with reasons, `missingSources`): one
unreadable save never stops the others, and a catalogued era whose source did not
answer the scan stays catalogued. The era comes from the FWL world name (`ComfyEraN`) or,
for the two pre-convention worlds (`Booty`, `comfy`), from the archive folder; the entry
records `worldId` (what the game calls the save -- every stage that copies a save or
reads the client's caches keys on it) beside `archiveWorldId` (`ComfyEraN`, stamped into
every snapshot). Versions 26-30 use length-delimited legacy records (26 has no
byte-array group); 31/32 use compact byte counts; 33-37 use compact extended counts.
The one version gate is `records.MIN_WORLD_VERSION`/`MAX_WORLD_VERSION` (26/37),
mirrored by `WorldParser` and asserted equal by a test. Formats 26, 27, 28, 29, 32, 33,
34, 35, 36 and 37 have all been exercised against the sixteen-era archive.

The writer freezes its parser JAR and stages each extraction separately. A package
is promoted only after source rechecks, declared/actual object reconciliation,
unique object-index checks, inventory extraction, typed-field export and geometry
membership checks. Failed candidates remain evidence. Reruns use the catalog's newest
accepted parser. A rebuilt parser is admitted by `archive.py parser-check --jar <new>
--era era7 --era era16`: it re-parses the named verified eras into scratch, requires every
content table (and the geometry parquet) to be row-identical to the frozen package, and
records the jar in `catalog.parsers` as superseding the digests it reproduced. A jar not
in that lineage still refuses verified eras.

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

### Participation and kinship

There is no backend and no sign-in anywhere in this archive, by design. Claims, photo
requests and kinship tags are written to the visitor's own browser under
`creators-participation-v1` (schema `steward-creator-participation-local/v1`), whose
`kinshipTags` map is keyed `<buildKey>:<contributorKey>` — one tag per co-builder per
build. Confirming a tag also emits the wire event
`{"schema": "steward-creator-participation-event/v1", "eventType": "kinshipTag",
"kinshipTag": {…}}` to the configured participation endpoint if one is set, and hands the
volunteer the same payload to copy if it is not. **Forget my participation** clears the
kinship tags along with the claims and the handle: a tag names a second person, so it is
the first thing that control has to drop.

Only the majority owner of a build may tag its co-builders. Ownership is read from the
saved construction pieces: a share of 0.5 or more is `majority`, and below that the single
strictly largest known share still counts from 0.25 up as `largest`. A tie, a share under
a quarter, and a legacy import (which carries no share at all) own nothing. A tag never
edits the credited contributors — those come from the pieces and nothing else moves them.

A tag is made in either of two places with the same record: on the kinship page (a Tag
button beside a co-builder, with a build select) or on the build card of a builder's page
(**Tag another basemate**, with the person picked from that build's own credits; `basemate`
starts ticked because that is the word on the control). A tag recorded on this device and
not yet confirmed shows beside the credit as a dashed "recorded" chip; a confirmed one as a
solid chip.

A claim carries `kind`: `built` ("I built this") or `disavow` ("Not mine"). One record per
build either way — a disavowal replaces a claim and a claim replaces a disavowal — because
both are the same person saying the same kind of thing about the same build. A ledger
written before disavowal existed carries no `kind` and reads as `built`. Standing follows
the built claim only: a disavowed build offers no photo request and rides in no kinship
export, and the card says "Disavowed by …" rather than "Claimed by …".

**Pair view.** Picking a name off the Top 8 ribbon opens `section#pair-view` under it:
the builder whose page this is, that one co-builder, the builds the two of them placed
pieces on, and how those pieces divide. `web/pair.js` derives all of it in the browser
from the thread, `directory.json` and `participation.json` — there is no pair file and no
endpoint, and `buildKinshipPair()` publishes nothing the thread does not already state.
Kinship affinity is `Σ min(shareA, shareB) × max(0, log10(pieces))` over the shared
builds: the smaller share, because the overlap two people can claim on one structure is
bounded by the smaller contribution, and the log because a 40,000-piece keep is a bigger
shared work than a 400-piece hut but not a hundred times bigger. A legacy import, which
knows no shares, scores zero rather than a guess, and so does a one-piece build. Tiers
band the Top 8 ranking — I for 1–2, II for 3–5, III for 6–8 — and a co-builder outside
the first eight still gets a pair view, just no tier. A pair is **confirmed kin** once a
coordinator has confirmed a tag naming both of them on a build they share, in either
direction, and **recorded kin** otherwise: the saved world shows they built together,
which is a real thing to say and is nobody's claim about anybody. The ally and the active
build ride in the URL as `?kin=&build=`, so a pair is a link (a `?view=` from a link shared
before pass 3 is dropped: the pair view keeps to the pairing -- the page's carousel shows
the photographs and every build carries its own world-viewer link).

**Portraits.** Every face on the creators lane -- the hero, the Top 8 ribbon, the kinship
tree, the pair card -- comes from one resolver, `web/portraits.js`
(`StewardPortraits.portraitFor(builder, manifest)`), against `/chronicles/portraits.json`:
a portrait chosen on this device (the picker's ledger) first, then the choice the archive
published for the builder (`builder.portrait`, once the coordinator confirms one), then the
default library's slot (`parseInt(key[:8], 16) % count`, unchanged since the first tile), then
the archive emblem. `web/portrait-picker.js` is the drawer on the profile where a builder with
standing (a built claim on one of the profile's builds, in this browser) narrows the library by
Trade, Presentation, Age, Mood, Hair, Setting, Palette, Kit and Theme -- the era viewer's
live-count mechanic, ported -- opens a portrait's takes, previews the hero and the 40-px cut,
and chooses. Preview mode (S2): the choice is recorded on this device (`state.portraits`,
"Portrait recorded on this device"), repaints every face on the page, and does not ride the
copied payload yet; that is S3, with `coordinate.py`'s validation. The control exists only
when the manifest carries libraries.

`gallery.py` publishes `participation.json` beside the directory: schema
`steward-creator-participation-public/v1`, carrying the counts (`participants`, `claims`,
`disavowals`, `requests`, `openRequests`) plus `confirmedTags`. It is projected from the
coordinator's own file at `analysis/participation.json`:

```json
{"schema": "steward-creator-participation/v1", "generatedAt": "…", "updatedAt": "…",
 "participants": 0, "claims": 0, "disavowals": 0, "requests": 0, "openRequests": 0,
 "confirmedTags": [{"buildKey": "<64 hex>", "contributorKey": "<32 hex>",
                    "builderKey": "<32 hex>", "tags": ["basemate", "mason"],
                    "confirmedAt": "…"}],
 "claimRecords": [], "requestRecords": [], "tagRecords": []}
```

`sanitize_confirmed_tags()` keeps exactly those five keys, drops any entry whose keys are
not hex of the right length and any tag id outside the closed vocabulary
(`basemate`, `collab`, `helping-hand`, `visitor`, `mason`, `roof`, `fields`, `portal`,
`defense`, `interior`), and never copies the participant handle, note, contact or claim id
that the coordinator's file may hold beside them. `disavowals` is additive: an older
coordinator file has no such key and reads as zero, and the public schema string does not
move for a new count.

#### coordinate.py — the coordinator's end of the lane

`coordinate.py` owns that file. It is the receiving half of a flow that has no endpoint:
a volunteer copies a payload out of their own browser and sends it on through Discord, and
this is what happens next.

Beside the counts and the confirmed tags it keeps **the full records as received** —
`claimRecords`, `requestRecords`, `tagRecords`, with the volunteer's handle, their
free-text note and any contact address they offered. That is personal data, and it lives on
the coordinator's own disk and nowhere else: `export_participation()` reads only the counts
and `confirmedTags`, and `sanitize_confirmed_tags()` whitelists five keys out of each of
those, so a handle, a note, a contact or a claim id has no path to a public page.

```powershell
python tools/era-archive/coordinate.py --output-root <root> seed
python tools/era-archive/coordinate.py --output-root <root> ingest <payload.json | ->
python tools/era-archive/coordinate.py --output-root <root> confirm-tag <buildKey>:<contributorKey>
python tools/era-archive/coordinate.py --output-root <root> revoke-tag <buildKey>:<contributorKey>
python tools/era-archive/coordinate.py --output-root <root> forget "<handle>"
python tools/era-archive/coordinate.py --output-root <root> status
```

`seed` refuses to overwrite an existing file. `ingest` reads all three shapes a browser can
hand over — `steward-creator-participation-export/v1` (the whole ledger),
`steward-creator-build-participation/v1` (one card) and
`steward-creator-participation-event/v1` (`claim`, `photoRequest`, `kinshipTag`) — upserts
by `claimId` / `requestId` / `tagId` so a re-sent record replaces its earlier copy rather
than doubling it, stamps `receivedAt`, drops anything whose keys are not the hex they claim
to be, and drops tag ids outside the closed vocabulary along with any record left holding
none. `confirm-tag` copies one ingested tag's public fields into `confirmedTags` with a
`confirmedAt` stamp and the source `tagId` as its receipt; `revoke-tag` unpublishes it
without forgetting the record.

`forget <handle>` is the retention answer the design note left open: every record that
handle sent, and every confirmed tag that arrived on one of them, removed in one command,
matched case-insensitively. Counts are recomputed on every write — `participants` is
distinct normalised handles, `claims` is built claims, `disavowals` is disavow claims,
`openRequests` is requests with no `closedAt`. Every mutating command takes `--dry-run`,
and every write goes through `archive.save`. `status` prints the counts, the open requests,
the pending tags and the three commands that publish what has been confirmed.

### Bed evidence

The standing invariant first, because everything below is shaped by it: **identity is never
derived from nearby structures.** A bed inside a footprint proves somebody slept there, not
that they laid a single piece of the roof over it. So bed ownership lands as its own
evidence type, `bed-owner-in-footprint`, in its own key beside `contributors[]` and never
inside it — a reader has to be able to see which claim rests on a piece and which rests on
a bed, and to reject the second without losing the first.

`community.py`'s `bed_residency()` joins every BED with a nonzero `owner_id` and a finite
position against each build's bounding box, expanded by `marginXZ` 4 m and `marginY` 3 m.
The margins differ on purpose: sideways, a bed pushed against the inside of a wall sits
outside the bounding box of the pieces enclosing it, while three metres up is the next
storey of the same house and a taller vertical margin would hand a ground floor its
neighbour's sleeper. A bed inside two boxes — a longhouse standing in a walled compound,
which clusters as its own build — belongs to the **smallest XZ footprint**: the compound
contains the bed only by containing the house. Ties break on `buildKey`, so the answer is
stable. Only `build_key`, the owning character and a count leave the function; coordinates
and `zdo_index` never do.

**It does not ride `RECIPE_HASH`.** That hash is baked into every `buildKey`
(`sha256(sourceKey + RECIPE_HASH + membership_hash)`) and into the analysis cache directory
name, so bumping it would rotate all 318,319 keys and break every published album URL,
capture manifest and volunteer claim. `BED_RECIPE` is hashed separately as
`BED_RECIPE_HASH`. When `analyze_era` finds a cached receipt whose `bedRecipeSha256` does
not match, it re-derives residents in place over the same verified package — reading only
`zdo` — stamps `bedRecipe`, `bedRecipeSha256` and `bedResidencyGeneratedAt`, saves, and
prints `residents re-derived (bed recipe …), build keys unchanged`. Clustering never runs
again, `membership.parquet` is not rewritten, and no key moves. There is no new flag and
`Invoke-EraArchive.ps1` is unchanged.

`project()` maps each resident's character through `builder_key()` **directly, never through
`ensure()`**. `ensure()` appends the buildKey to `builder["builds"]`, and `gallery.py` turns
every key there into an album on that builder's thread with a fallback full credit of
`{pieces: <every piece>, share: 1.0}` — crediting somebody with an entire house because
their bed is in it is exactly the inference this archive refuses to make. The merged list is
always reassigned, never inherited from the analysis receipt: that copy holds raw character
IDs, and the build is a shallow copy. Public albums carry

```json
"residents": [{"builderKey": "<32 hex>", "beds": 2, "evidence": "bed-owner-in-footprint"}]
```

whitelisted field by field in `gallery.py`, the way `sanitize_confirmed_tags()` whitelists a
tag. Legacy imports never carry the key at all.

**Known limitation — "Recorded builder".** A resident usually has no public name. A builder
record exists because a saved piece creator or a recorded `ownerName` put one there; a bed
whose ZDO carries neither gives no record at all, and even a resident who does have one is
skipped by the directory when they hold no builds (`gallery.py` requires `builder["builds"]`).
The album shows those sleepers as "Recorded builder" and leaves it there. Publishing a name
the archive has never published would be the worse answer. This is also why `verify.py`
reconciles `build_resident` **to the build only** — a residency pointing at a build that is
not in the table is a lost join and still fails, but a residency whose builder has no row is
the normal case, counted as `build_resident_without_builder` rather than raised.

The rest of the plumbing: `community_store.py` writes a `build_resident` table
(`build_key`, `builder_key`, `beds`, `evidence_type`) — its own table, not extra columns on
`build_contributor`, so the two evidence types stay separable; `archive.py`'s community table
allowlist admits it; `verify.py` counts it only after finding it in `information_schema`,
because `write()` skips a table with no rows and the view is genuinely absent on an archive
that has none. `analysis/catalog.json` records `bedRecipe` beside `recipe`.

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
Use `--eras era16` with the current `ready-inputs.json` as the base to append a newly
processed era without re-exporting the existing eras. `prepare_world_era.py` then
turns that one ready input into a self-contained incremental catalog package.

For terrain regenerated in a current client, `terrain_provenance.py` binds an
observed `steward-terrain-generation/v1` receipt to the context. It checks the original
DB and all four source hashes (FWL, map, height and forest caches). The public viewer
labels that terrain as regenerated; it does not present it as historical terrain.
Eras without terrain begin in Heatmap mode and cannot submit biome-filtered queries.
`omen_terrain_cache.py` accepts both legacy PNG caches and Valheim 1.0's gzip-compressed
RGBA/half-float minimap caches. The latter are seed-checked against the archived FWL,
converted to the established north-up PNG contract, and retain hashes for every raw
input. `--recover-valheim-data` promotes a completed parked session without relaunching
the game.

When an AM4 photo campaign already owns the current client, install
`am4_terrain_cache.py` as a separate worker. Give it the campaign `status.json`, the
capture service name, the archive catalog and the hash-verified `staged-worlds`
directory. The worker waits without touching the game while photography is active.
It accepts a handoff only after the campaign completes or stops at its configured
storage limit, and only after both the capture service and Valheim have exited. Each
era runs in an isolated XDG save directory and produces 2048-pixel map, height and
forest caches plus a source-bound receipt. Operator-stopped and failed photography
never trigger the terrain workload.
`am4_biome_context.py` can wait on that worker and then run the established terrain
builder on AM4. It emits both the authoritative query mask and the separately
smoothed display mask, verifies every declared variant, and binds the observed game,
Unity and world-generator versions from the per-era Player log into provenance.

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

`deploy_world.py` is the bundle lane: use it only when the immutable era catalog changes.
For the common catalog-expansion case, `deploy_world_era.py` adds one verified
`prepare_world_era.py` package instead. It transfers only that era and the thin JAR,
hard-link clones the live immutable catalog, and performs the same candidate-before-swap
checks without building an image.
For Java-only releases, package the lab and pass Maven's small `target/original-*.jar` to
`deploy_world_code.py`. The code lane uploads only that thin application JAR, places it
ahead of the live image's dependency JAR on the classpath, reuses the verified read-only
catalog mount, and runs the same candidate-before-swap rollback discipline without an
image build. Static-only changes still go through `tools/Push-StewardWorldUi.ps1` and do
not restart the container.

For schema-3 terrain contexts, use `deploy_world_terrain.py` with matching, repeatable
`--era` and `--context` arguments plus the same thin application JAR. A single pair remains
valid; a batch transfers all named contexts in one archive and performs one candidate check
and one container swap. On the server it hard-link clones the live immutable catalog,
replaces only the selected eras' contexts on new inodes, rewrites their checksummed
inventories, and verifies every selected heightfield and generation mode before promotion.
It neither uploads the multi-era catalog nor builds an image; the preceding catalog tree
remains intact for rollback.

```powershell
python -m unittest discover -s tools/era-archive/tests -v
python -m unittest discover -s lab/tools/tests -v
# Run mvnw.cmd test in viewer and lab.
node tools/era-archive/browser-smoke.mjs <creator-base-url> <world-base-url> <receipt-dir>
node tools/era-archive/browser-smoke.mjs <creator-base-url> <world-base-url> <receipt-dir> --strict-world
node tools/era-archive/world-browser-smoke.mjs <world-base-url> <build-cases.json> <receipt-dir>
```

`browser-smoke.mjs` gates the creator release, so its world leg is reported rather than
fatal: if the spatial lane is down the run writes `"status": "passed-with-spatial-failure"`
with the reason under `spatial`, and still exits 0. `--strict-world` (or
`SMOKE_STRICT_WORLD=1`) re-arms it for a run that is gating the world lane — the receipt
is written first either way, on success and on failure, because the verdict is the
artifact and an exit code cannot say which wait timed out. An empty world URL skips the
leg entirely. The leg reads `<world>/api/eras` and waits for whichever raster the opening
era actually draws (`.context-raster` where terrain exists, `.analysis-raster` where it
does not) rather than naming a layer: era 7 gained a context on 2026-09-10 and a hard-coded
analysis-raster wait became unreachable.

Operational data and screenshots belong outside Git. Keep the original archive,
parser artifact, private identity registry, curated links, processing catalogs and
Parquet packages together in backups.
