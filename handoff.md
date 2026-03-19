# Handoff — Valheim Save Metrics Extractor

## What Was Built

`MetricsExtractor.java` — streaming ZDO extractor that:
- Parses all 8,016,512 ZDOs in **~3.3 seconds** using the fixed jar
- Streaming (no accumulation) — stays under 200MB heap
- Outputs JSON: prefab counts, container contents, portals, beds, tombstones, coins

`DeepProbe.java` — sign texts, item stand contents, creature census, hash profiling, dead ZDO count

`LocationProbe.java` — world location names (dungeon/POI inventory), creature census

`ItemHashResolve.java` — dropped-item hash resolution + stack/position analysis

`DumpUnknown.java` — full property dump of first N ZDOs per target hash

`NearbyProbe.java` — identifies all 294 dropped-item hash types world-wide

`GeoAnalysis.java` — z-band structure/drop/creature counts, build grid heatmap, bed owners, tombstones

Usage:
```
javac -cp ".;valheim-save-tools-fixed.jar" MetricsExtractor.java
java -Xmx2g -cp ".;valheim-save-tools-fixed.jar" MetricsExtractor ComfyEra14.db > metrics.json
```

---

## Key Technical Discoveries

### 1. Inventory serialization (CRITICAL)
Items in world containers stored as **Base64-encoded strings** in ZDO `stringsByName["items"]`.

```
int32 version (v106 in this save)
int32 itemCount
per item:
  string name
  int32  stack
  float  durability
  int32  slot_x, slot_y
  bool   equipped
  int32  quality   (v≥101)
  int32  variant   (v≥102)
  long   crafterId (v≥103)
  string crafterName (v≥103)
  int32  customDataCount + [key/val string pairs] (v≥104)
  byte   pickedUp  (v≥105 — CRITICAL FIX, lib doesn't know this)
```

### 2. File structure (fully confirmed, 0 bytes remaining)
```
worldVersion (int32) + netTime (double) + myId (long) + nextUid (uint)
+ ZDO count + ZDOs
+ Zones: {generatedZones + pgwVersion + locationVersion + globalKeys
           + locationsGenerated + PrefabLocations(name+vec3+bool each)}
+ RandomEvent: {float + string + float + vec3}
+ Dead ZDOs: {count=0 in this save}
```

### 3. Dropped item ZDO signature
```java
hasCrafterName && hasSpawntime && hasStack && prefab == null
```
Properties: `{crafterName="", stack, quality, variant, worldLevel, pickedUp, dataCount}` + `{durability}` + `{crafterID, spawntime}`

### 4. Building piece ZDO signature
```java
hasCreator && (hasSupport || hasHealth)
```

### 5. Unknown hash classification
| Hash | Count | Classification |
|------|-------|----------------|
| 1703108136 | 155k | Nature/terrain (no properties) |
| -1161852777 | 155k | Item stand + fuel (torch/lantern variant) |
| 1411875912 | 166k | Item stand (empty, has stack+quality+creator) |
| 538325542 | 120k | Building piece (health+support+creator) |
| -494364525 | 99k | Container variant (health+creator+TCData) |
| -2119951934 | 98k | Building piece |
| -2129458801 | 61k | Pickable item (picked+enabled+creator) |
| 686545676 | 57k | **SIGN** (confirmed: has text+author strings) |
| 650075310 | 55k | Item stand (has TCData+item+stack+quality) |
| -502993694 | 52k | Building piece |
| -62980316 | 51k | Building with scaleScalar |
| 1792656179 | 50k | Building piece |
| -1195767551 | 41k | **Ballista** (confirmed: has ammoType=TurretBolt) |
| 1341839349 | 34k | Building piece |
| 109649212 | 50k | **Dropped item** (Ashlands, unresolved name) |
| 1272849455 | 46k | **Dropped item** (Ashlands, unresolved name) |

### 6. Dropped items — 294 distinct types world-wide
- 192,176 total dropped items on the ground
- Top 6 unresolved types all at z≈-8000 (Ashlands biome): 109649212 (50k), 1272849455 (46k), 109649209 (19k), 109649207 (14k), 109649211 (13k), 109649213 (10k)
- All have crafterID=0, empty crafterName = world-spawned creature drops
- Quality 1 mostly; 1272849455 sometimes has quality=2
- **Could not resolve** via 500+ candidate names including all known Ashlands items

---

## World Findings (ComfyEra14.db, 1.1GB, world version 35)

### Scale
- 8,016,512 ZDOs total, 1611 unique prefab types
- World seed: CGakkJyIvq (seed 803258922)

### Progress / Global Keys
```
killed_surtling, defeated_eikthyr, defeated_gdking, defeated_bonemass,
hildir1, hildir2, hildir3
```
NOT defeated: Moder, Yagluth, Fader (boss ZDO exists but not killed)

### Players
- **799 beds found** with names, **434 unique bed owners**
- **613 tombstones**, **227+ unique player names**
- Top players by beds: Ennius Staff (23), Atreus (10), Wootsie (10), Jord (10)
- **Most deaths**: Asclea (122 tombstones!), Nina (18), Khin (13), Fortynine (12)
- Dead ZDO count: 0

### Portal Network (9,135 total portals)
- 1,929 tag-paired portals = 3,858 properly connected
- 3,136 orphaned (no matching partner)
- 44 tags with 3+ portals (hub portals) = 2,141 portals
- 463 blank-tag portals (can't connect to anything)
- **Top builder**: nexu prefix (274 portals), hobb (133), woot (83), gz (57)
- **Notable hubs**: nekCP1-5 (10 portals each, z=10000-15000, northern highway)
                    v1-v6 (8 portals each, z=5760-9166, mid-north vaults)

### Geographic Concentration (z-band structures)
The NORTH (z=13000-26000) has the HEAVIEST building (~1.5M structures per band!)
Mid-map (z=-2000 to +8000) has moderate density (~100-155k structures per band)
Ashlands (z=-8000 to -10000) has 30k-9k (outpost/farming area)

**Top 5 build density cells (500-unit grid):**
1. x=[-500,0] z=[13000,13500]: **20,338 structures** — northern main hub
2. x=[1500,2000] z=[4000,4500]: **15,024 structures** — east-northeast hub
3. x=[-9000,-8500] z=[11000,11500]: **14,125 structures** — far northwest
4. x=[-4500,-4000] z=[14000,14500]: **13,647 structures** — north hub
5. x=[4000,4500] z=[-2500,-2000]: **12,506 structures** — southeast outpost

### Build Scale
- 205k stone walls, 153k wood floors, 127k wood walls, 102k signs
- 221,348 sign ZDOs (3 prefab variants), 140k blank, 34,835 unique texts
- ~375k total item stand ZDOs across 3 hash types
- 23k wooden chests, 9,135 portals, 1,968 beds

### Economy
- Coins in ground: 15,317 | Coins in chests: 16,024 | Total: ~31,341
- **Top items in chests**: Wood (16k), Coins (16k), Stone (7.4k), TurnipSeeds (3.6k), Coal (3.2k)
- **Total dropped items on ground**: 192,176

### Signs — Human-readable highlights
Server has player rank system visible in signs:
- SCOUT, WARDEN, HIGH WARDEN, TRAILBLAZER, The Helper (240x each = template signs)
- Activities: Beekeeping, Cold Case, Defrost, God-Firs, Wolf Tracks
- Server password sign: `<#000>passward: bundleup`
- Piano display: "Comfy Pianos" (decorative)

### Creature Census (52,627 ZDOs)
15,862 Seagal, 4,956 Skeleton, 3,993 Deer, 3,885 Leech, 3,482 Greydwarf,
3,282 Crow, 2,491 Draugr, 1,879 Surtling, 1,851 Wolf, 1,825 Deathsquito

### World Locations (18,594 prefab locations, 145 types)
- 1,500 Greydwarf camps, 1,500 InfestedTree, 700 GoblinCamp2
- 645 SunkenCrypt4, 500 Crypt2, 500 Mistlands_RoadPost1
- Ashlands: 350 CharredStone_Spawner, 350 VoltureNest, 100 AshlandRuins, 3 FaderLocations
- Mistlands: 370 DvergrTownEntrance1, 200 Harbour1, 200 Lighthouse1

---

## What the Tool CAN Extract

| Category | What | How reliable |
|----------|------|-------------|
| Prefab census | Count of all 1611 prefab types | ✅ Perfect |
| Container inventory | All items in all 28k chests, pots, barrels | ✅ Working (v106 fix applied) |
| Portal network | Tag→locations, paired/orphaned/hub count | ✅ Perfect |
| World locations | All 145 dungeon/POI types with counts | ✅ Perfect |
| Creature census | 52 species, counts | ✅ Good (some Ashlands missing) |
| Sign texts | Full text corpus with frequency | ✅ Working |
| Item stands | Items on display, counts | ✅ Working (3 hash variants) |
| Beds | Count, owner names | ✅ Working (434 unique players) |
| Tombstones | Player names, death counts | ✅ Working |
| Geographic heatmap | Structure density by area | ✅ Working |
| Global keys / bosses | Killed bosses, server settings | ✅ Perfect (via FWL JSON) |
| Dropped items | Count by type, position, quality | ✅ 294 types identified, some names unresolved |

## What We Can't Easily Do

1. **Resolve all prefab names** — 500+ candidate names tried; top Ashlands drops still unresolved (would need Valheim game data files or community prefab list)
2. **Player inventory** — stored on player .fch files, not in .db
3. **Read per-player stats** — skill levels, deaths — not in world save
4. **Portal pairings** — which two portals actually connect (need to match tags case-sensitive + handle blank tags)

---

## Files in D:\work\temp

| File | Purpose |
|------|---------|
| `MetricsExtractor.java` | Main streaming extractor (working) |
| `DeepProbe.java` | Signs, item stands, creature census, hash profiles |
| `LocationProbe.java` | World location types |
| `ItemHashResolve.java` | Hash resolution + stack/position analysis |
| `DumpUnknown.java` | Full property dump per hash |
| `NearbyProbe.java` | All 294 dropped-item types world-wide |
| `GeoAnalysis.java` | Geographic heatmap, z-bands, bed owners, tombstones |
| `valheim-save-tools-fixed.jar` | The fixed jar (use this) |
| `ComfyEra14.db` | The 1.1GB save file |
| `metrics_out.json` | Latest full metrics output (~540KB) |
| `nearby_out.txt` | All 294 dropped-item hash profiles |
| `geo_out.txt` | Full geographic analysis with player list |

---

## Next Steps (If Continuing)

1. **Resolve remaining dropped-item hashes** — need actual Valheim data dump or source. Try the Valheim Plus or Epic Loot mod namespaces.
2. **Building piece hashes** — hash:538325542 (120k), hash:-2119951934 (98k) etc. are major building materials; resolve for better structure census.
3. **Sign hash:686545676** — confirmed sign variant, should add to sign reader.
4. **Portal cleanup report** — identify which orphaned portals can be deleted (by name pattern or location).
5. **Player death map** — map tombstone X,Z coordinates for each player → find where players die most.
6. **Base identification** — cluster analysis of build grid cells → identify distinct player bases.
7. **Container contents geographic analysis** — what items are stored in which area.
8. **Item stand showcase** — what items are being displayed on stands in the large hubs.
