# Prefab dictionary

How ComfyStewardView turns a prefab hash into a name, where the dictionary comes from, and how
to refresh it.

## Why

A Valheim ZDO stores its prefab as an `int` — the stable hash of the prefab name. The name itself
is never in the save file. Without a hash→name dictionary,
`ZdoFlatStore.nameForHash()` returns the literal string `hash:N`, and five downstream classifiers
(`ContainerClassifier`, `ContractBuilder`, `TaxonomyClassifier`, `EntityClassifier`, and the SPA)
treat that prefix as a hard failure and degrade to `unknown`.

Measured on ComfyEra16 (9,155,594 ZDOs) before this work: **1,424,914 resolved — 15.6%.**
After: **9,106,209 — 99.5%**, with 49,385 ZDOs across 129 hashes remaining.

## Source and provenance

| | |
|---|---|
| Vendored at | `viewer/src/main/resources/prefab-dump.json` (505,121 bytes) |
| Schema | `comfy-prefab-dump/v1` |
| Game version | 0.221.12 |
| Generated | 2026-08-07T11:23:01Z |
| Entries | 3,458 |
| Upstream copy | `C:\work\baseline\tools\component-packets\samples\prefab-dump.json` |
| Generator | `C:\work\baseline\tools\component-packets\Program.cs` (Mono.Cecil over `assembly_valheim.dll`) |

The generator lives in the baseline repo, not this one. **Record that path in any handoff.** The
previous dictionary — a 3,569-entry live `ZNetScene.m_namedPrefabs` dump referenced by
`LESSONS_LEARNED.md` as `D:\work\comfy\comfyera14_prefabs.csv` — was lost with the `D:` drive, and
`v3_coverage.txt` is now the only surviving evidence that it ever existed.

It is bundled as a classpath resource, so `viewer/pom.xml`'s default resource root puts it in the
shaded jar. `.dockerignore` already admits `viewer/src/**` and `Deploy-Steward.ps1` already tars
`viewer/src`, so no packaging changes were needed.

## Load order and precedence

`PrefabDictionary.load()` takes the first that exists:

1. `-Dprefab.dump=<path>` — hot-swap a newer dump without rebuilding
2. `./prefab-dump.json` (working directory)
3. `prefab-dump.json` beside the save file
4. `classpath:/prefab-dump.json` — the bundled copy, a guaranteed last resort

This mirrors `ClassificationStore.loadOrEmpty()` with one deliberate difference: because the
bundled resource always exists, a normal deployment can never silently run without a dictionary.

Names are then registered in trust order, **first writer wins**:

| order | source | entries | verified? |
|---|---|---|---|
| 1 | the dictionary | 3,458 | yes — `sh(name) == hash` checked per entry at load |
| 2 | `WorldParser.registerKnownNames()` | ~90 | no |
| 3 | dynamic (`registerHashName` at the item-stand and container-inventory sites) | unbounded | by construction — the key *is* `sh(name)` |

Every dictionary entry is validated at load with `WorldParser.sh(name) == hash`, the same stable-hash
function the parser uses to read the world file. A mismatched entry is rejected, never inserted, and
counted in the startup log. That invariant is what earns the dictionary its precedence; the
hand-maintained table carries no such check.

Source 2 cannot overwrite source 1, and a disagreement logs:

```
WARN Hand-registered name for hash N is 'X' but the verified dictionary says 'Y' — ignoring the hand entry
```

That warning is permanent drift detection, not a one-time migration aid.

**`registerKnownNames()` is still required.** The dump is a ZNetScene snapshot; ZoneSystem
*location* prefabs are a separate namespace and are absent from it. Verified absent: `Crypt2`,
`SunkenCrypt4`, `GoblinCamp`, `FrostCaves`, `Mistlands_DvergrTownEntrance1`, `TarPit1`,
`FaderAltar`. Only `BossStone_Eikthyr` is present. Absence from the dump means "outside this
dictionary's namespace", never "does not exist".

## The eight hand-written names that were wrong

Six were load-bearing — they drove classification through `ITEM_STAND_HASHES`, `CONTAINER_HASHES`,
`SIGN_HASHES` and `HASH_BALLISTA`, so a wrong name meant a wrong category for every ZDO of that hash.

`handoff.md` recorded two of them as **confirmed** by property inspection: `686545676` "has
text+author strings" and `-1195767551` "has ammoType=TurretBolt". Those claims did not survive
re-measurement. `Main --probe-hash` re-ran the check on ComfyEra16 with the shipping parser and
reported the *fraction* of each hash's ZDOs carrying the property:

| hash | ZDOs | was registered as | motivating property | measured | dictionary says |
|---|---|---|---|---|---|
| `686545676` | 79,881 | `sign_hmHildir`, in `SIGN_HASHES` | `text` | **1 ZDO — 0.001%** | `Piece_grausten_floor_4x4` |
| `-1195767551` | 41,651 | `turret`, `HASH_BALLISTA` | `ammoType` | **9 ZDOs — 0.022%** | `blackmarble_1x1` |
| `1411875912` | 173,040 | `itemstandh`, in `ITEM_STAND_HASHES` | `item` | **0 — absent** | `cliff_mistlands2` |
| `-1161852777` | 159,003 | `ArmorStand`, in `ITEM_STAND_HASHES` | `item` | **0 — absent** | `blackmarble_2x2x2` |
| `650075310` | 59,447 | `itemstand_rooster`, in `ITEM_STAND_HASHES` | `item` | **12 ZDOs — 0.020%** | `crystal_wall_1x1` |
| `-494364525` | 82,429 | in `CONTAINER_HASHES` | `items` | **0 — absent** | `caverock_ice_stalagtite` |

What each hash actually carries corroborates the dictionary: `686545676`, `-1195767551`,
`-1161852777` and `650075310` all show `health` + `support` on 96–99.9% of their ZDOs (a building
piece), `1411875912` shows `scaleScalar` on 98.5% (a scaled world prop — it is a cliff), and
`-494364525` carries essentially nothing on 98.4%.

The real names hash elsewhere, which is why the labels never matched anything:
`itemstandh` = `1822362821` (90,290 ZDOs on Era16, previously *never detected*),
`piece_turret` = `-816396091` (400 ZDOs — the world's real ballista count),
`ArmorStand` = `1580161127`. `turret`, `sign_hmHildir`, `itemstand_rooster` and `piece_chest_cart`
are not prefab names in any Valheim build.

Two more were display labels only, in the removed "dungeon interiors / crypt components" block:
`-1471593253` was labelled "Vegvisir (Boss Stone)" but is **`Pickable_Stone`** (207,730 ZDOs on
Era14 — the third most common prefab in the world), and `1620622954` was labelled "Crypt
Decoration" but is **`Spawner_Draugr`**, a spawner. Also in that block: `1577361568` "Burial Crypt
Item" → `BonePileSpawner`, `-258454714` "Crypt Decoration" → `root08`, `-446811472` "Crypt Exit" →
`DG_SunkenCrypt`, `-2019670596` "Iron Gate" → `iron_grate`.

### Why the original evidence was wrong

`DeepProbe.java:194` gates its property capture on `!profile.containsKey("strKeys")` — a latch that
stays open until a ZDO carrying *any* string appears. Until then `intKeys`/`floatKeys`/`longKeys`/
`baKeys` are overwritten on every ZDO, so the printed profile is a union of key sets harvested from
*different* ZDOs. The value aggregates at `:212-228` sit outside the latch and quantify the
contamination in `deep_out.txt`: the "ballista" reports
`items: {BarleyFlour=8, HoneyGlazedChicken=4, TrophyGoblinKing=4, ...}`.

`LESSONS_LEARNED.md` §6 supplies the mechanism: a sign-extension bug in the kakoen library's
`numItems` reader causes mid-file stream drift, and `DumpUnknown.java:96` swallows `Throwable` per
ZDO and keeps reading from the drifted offset. Every root-level probe runs on that library. They
should not be used to adjudicate hash identity — use `Main --probe-hash`, which runs on the
shipping parser and reports denominators.

## Classification changes that followed

Signs were the only category with no content-based fallback (`isContainer || hasItems` and
`isItemStand || (hasItem && hasCreator)` already had one), so dropping a hash from `SIGN_HASHES`
would have lost real signs. Signs now also match on content:

```java
if (isSign || text != null || author != null)
```

`valheim-component-atlas.json`'s `ZdoKeyIndex` records `Sign.SetText` as the only writer of `text`
and `Sign.UpdateText` as the only writer of `author` — nothing else in the game writes either key,
so this is exact rather than heuristic. It recovered **577 signs that were never detected before**
(hanging signs, Hildir boards, modded signs).

Measured category deltas on ComfyEra16 — removals and reassignments balance exactly at 564,026,
so no ZDO was lost or double-counted:

| category | before | after | delta |
|---|---|---|---|
| ITEM_STAND | 473,624 | 108,788 | −364,836 |
| SIGN | 194,774 | 115,470 | −79,304 |
| CONTAINER | 153,387 | 74,752 | −78,635 |
| BALLISTA | 41,651 | 400 | −41,251 |
| BUILDING | 3,475,009 | 3,621,945 | +146,936 |
| INTERIOR | 320,321 | 397,326 | +77,005 |
| UNKNOWN | 4,058,662 | 4,398,744 | +340,082 |

`ContainerClassifier` also lost four names that are not prefabs in any build
(`piece_chest_trailer`, `Longship`, `Sailraftr`, `piece_chest_cart`) and gained the 22
`TreasureChest_*` variants via prefix match.

## The building-piece filter

Until this landed, BUILDING was decided purely by property shape: a `creator` field plus `health`
or `support`. That is the residue a *player* placement leaves behind, so anything placed by
something other than a player was invisible to it. The synthetic-history corpus made the gap
concrete — its 288 `wood_floor` pieces carry no `creator`, no `health` and no `support`, so they
landed in UNKNOWN and showed up in the `all-zdos` raster but never in `build-activity`.

Prefab identity is now a second, independent sufficient signal. `PrefabDictionary.Entry.isBuildPiece()`
is `piece && wearNTear` — the assembly gives the prefab both a Piece and a WearNTear component —
and `WorldParser` classifies any such hash as BUILDING regardless of what properties the ZDO
carries.

Both halves of the pair are load-bearing:

| test | count | what it is | verdict |
|---|---|---|---|
| `piece && wearNTear` | 506 | the build menu: `wood_floor`, `woodwall`, `stone_wall_2x1`, `blackmarble_*`, `piece_workbench`, furniture, placeable food | construction |
| `piece`, no `wearNTear` | 29 | saplings, `cultivate`, `paved_road`, `raise`, `ship_construction` | not construction |
| `wearNTear`, no `piece` | 134 | world-gen props with no recipe: `vines`, `goblin_woodwall_1m`, `Ashlands_Wall_2x2`, `dvergrprops_wood_pole` | left UNKNOWN |

All 506 prefabs that carry both also carry a build-menu `category` (BuildingWorkbench,
BuildingStonecutter, Furniture, Crafting, Misc, Food, Meads, Feasts). Nothing in the other two
groups does. That independent agreement is why the pair is the test rather than either flag alone.

The check sits with the existing property-shape check, after every more specific branch has
returned — chests, beds, signs, portals, item stands and ballistas are all pieces too, and each
keeps its own category. `goblin_bed` is a piece by the dictionary but is short-circuited to
UNKNOWN earlier as an NPC furnishing, and stays there.

Measured on ComfyEra16 (9,155,594 ZDOs; every other category identical before and after):

| category | before | after | delta |
|---|---|---|---|
| BUILDING | 3,629,427 | 4,540,856 | +911,429 |
| UNKNOWN | 4,720,394 | 3,826,908 | −893,486 |
| INTERIOR | 399,410 | 381,467 | −17,943 |

The two decreases balance the increase exactly. Most of what moved is world-generated
construction with no creator — `blackmarble_2x2x2` (146,307), `stone_wall_2x1` (128,282),
`woodwall` (39,222), `wood_floor` (37,607) — which is genuinely construction and belongs in
build density. The 3.83M ZDOs still UNKNOWN are legitimately unknown: vegetation, rock,
pickables, `_ZoneCtrl`, `LocationProxy`, fish.

The INTERIOR loss is pieces above Y=3000, inside dungeon instances. BUILDING already outranked
INTERIOR for creator-bearing pieces, and the BUILDING category already spanned dungeon-instance
coordinates before this change, so nothing new appears in the raster's bounds.

**This only takes effect on ingest.** Both `RenderedLayerBuilder` and `RenderedDeltaLayerBuilder`
skip any snapshot or pair that already has a manifest, and a snapshot's categories are frozen into
`zdo.category` when it is parsed. Bumping the delta manifest `schemaVersion` would therefore
re-render old pairs from unchanged rows and produce identical bytes — it is not the lever. To pick
up the new classification, re-ingest; each ingest appends a new `snapshot_id`, which renders fresh.
`SnapshotProvenance.DEFAULT_PARSER_VERSION` moved to `1.1.0` so `world_snapshot.parser_version`
says which snapshots were classified which way. In a cache that mixes the two, delta identity is
still `prefab_hash` + position, so no phantom changes appear; only the `removed` channel of
`build-activity` under-counts, because it reads the older snapshot's category.

## Refresh procedure

1. Regenerate the dump in the baseline repo (`tools/component-packets`) against the new
   `assembly_valheim.dll`.
2. Copy it over `viewer/src/main/resources/prefab-dump.json` — byte-for-byte, no transformation.
   `piece` and `wearNTear` drive the building-piece filter below and `category` is the evidence
   that the pair is the right test; do not strip them.
3. Rebuild and check the startup log for **`0 rejected`**. A nonzero count means entries whose
   `sh(name) != hash` — a transcription error or a schema change, not a game change.
4. Confirm coverage did not regress: `GET /api/v1/summary` → `prefabCoverage.pctResolved`.
5. Re-check the worklist: `GET /api/v1/prefabs/unresolved?limit=100`.

To test a candidate dump without rebuilding:

```bash
java -jar world-viewer-1.0.0.jar world.db --batch-only --no-browser -Dprefab.dump=/path/to/new-dump.json
```

## Residual unknowns

129 hashes / 49,385 ZDOs (0.54%) remain unnamed on ComfyEra16, the largest at 4,512. Two expected
causes: modded prefabs (the dump is vanilla-assembly-only at 3,458 entries, where the lost live
`ZNetScene` dump had 3,569), and the ZoneSystem location namespace the dump does not cover.

`GET /api/v1/prefabs/unresolved` is the worklist. It exists so this residue stays visible instead
of silently reading as full coverage.

## Interaction with snapshot deltas

`SnapshotDeltaEngine` reports added/removed objects grouped by `prefab_name`, which this
dictionary supplies. Two consequences:

**Dictionary skew is flagged, not silently reported as world change.** Every snapshot records the
dictionary that named it (`world_snapshot.prefab_dictionary_version`). If two compared snapshots
disagree, `/api/v1/db/snapshots/compare` returns `dictionaryMismatch: true` plus a `warning`, and
the Changes view renders a banner above the stat cards. Without this, upgrading the dictionary
would make ~8.4M ZDOs appear to be demolished and rebuilt under new names. A cache written before
this column existed reports `null`, which reads as "cannot tell" rather than as a mismatch.

**Deltas are keyed on position, not name.** Prefab names are for display and grouping; object
identity is `prefab_hash` plus quantised position. See the class javadoc on
`SnapshotDeltaEngine` for why `zdo_index` cannot serve as identity.

After refreshing the dictionary, re-ingest the snapshots you intend to compare so both sides carry
the same dictionary version.

## Diagnostics

```bash
# What fraction of each hash's ZDOs actually carries each property?
java -jar world-viewer-1.0.0.jar world.db --batch-only --no-browser --probe-hash 686545676,-1195767551
```

Reports per hash: total count, a presence histogram with percentages, and three full property
dumps. Reading it: **the percentage column is the finding, not the count.** A property on a
handful of a hash's ZDOs identifies nothing — that is exactly how `ammoType` on 12 of 40,889
became a "confirmed" ballista.
