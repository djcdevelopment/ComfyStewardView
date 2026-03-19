# Valheim World Viewer — Handoff Document

**Last updated:** 2026-03-19
**Status:** All 5 phases complete and working.
**Server:** `http://localhost:7070` — run from `D:\work\temp\viewer\`

---

## What This Is

A self-contained Java web application that reads a Valheim `.db` save file, runs a full analysis pipeline, and serves an interactive dark-theme web UI. No Valheim installation required. No external database. One fat JAR, one save file, done.

**Save file in use:** `D:\work\temp\ComfyEra14.db` — 1.1GB, 8M ZDOs, world version 35, seed CGakkJyIvq.

---

## How to Build and Run

```bash
# Prereqs: Java 17, Maven (at /c/Users/derek/AppData/Local/Temp/apache-maven-3.9.6/bin/mvn)

cd D:/work/temp/viewer

# Build
/c/Users/derek/AppData/Local/Temp/apache-maven-3.9.6/bin/mvn package -q -DskipTests

# Run
java -Xmx3g -jar target/world-viewer-1.0.0.jar ../ComfyEra14.db
# With options:
java -Xmx3g -jar target/world-viewer-1.0.0.jar ../ComfyEra14.db --port 7070 --no-browser
```

**Static files are embedded in the JAR.** Editing `src/main/resources/static/index.html` requires a rebuild (`mvn package`) for changes to take effect in the JAR. During development you can also serve the file directly since all API calls use relative `/api/v1/...` paths.

**Kill a running server:**
```bash
netstat -ano | grep ":7070 "        # find PID
powershell -Command "Stop-Process -Id <PID> -Force"
```

---

## Project Structure

```
D:\work\temp\viewer\
├── pom.xml                                          # Maven: Java 17, Javalin 6.3.0, Jackson 2.17.2
├── HANDOFF.md                                       # this file
├── steward-config.json                              # auto-generated on first run, tunable
├── target/world-viewer-1.0.0.jar                    # built fat JAR
└── src/main/
    ├── java/com/valheim/viewer/
    │   ├── Main.java                                # entry point, pipeline orchestration
    │   ├── api/ApiServer.java                       # Javalin HTTP routes
    │   ├── config/StConfig.java                     # config singleton (steward-config.json)
    │   ├── contract/                                # DTOs (pure data, no logic)
    │   │   ├── WorldContracts.java                  # container for all contract lists
    │   │   ├── WorldSummary.java                    # aggregate stats (nested Stats class)
    │   │   ├── Portal.java, ContractEntity.java
    │   │   ├── ContractContainer.java, ContractRecord.java
    │   │   ├── DroppedItem.java, Structure.java
    │   │   ├── Sector.java, Alert.java
    │   │   ├── Classification.java, Region.java
    │   │   └── Vec2.java, Vec3.java
    │   ├── extractor/                               # pipeline stages
    │   │   ├── ContractBuilder.java                 # ZdoFlatStore → WorldContracts (only class that reads store)
    │   │   ├── EntityClassifier.java                # stamps entity_type + hostility + biome_affinity
    │   │   ├── ContainerClassifier.java             # stamps container classification
    │   │   ├── TaxonomyClassifier.java              # names dropped items + flags unknown economy items
    │   │   ├── MetricsBuilder.java                  # portal clusters, zone budgets, hotspot detection
    │   │   ├── MetricsResult.java
    │   │   ├── RegionLoader.java                    # loads optional regions.json for zone budgets
    │   │   ├── SectorBuilder.java                   # grid sectors, density classification, sector_id back-fill
    │   │   ├── SectorResult.java
    │   │   ├── StructureDetector.java               # classifies structures active/likely_cleared/unknown
    │   │   ├── AlertBuilder.java                    # generates typed severity-ranked alerts
    │   │   └── AlertResult.java
    │   ├── parser/WorldParser.java                  # streaming binary ZDO parser (no external library)
    │   └── store/
    │       ├── ZdoFlatStore.java                    # parallel primitive arrays, 3 heatmaps, index lists
    │       └── HeatmapGrid.java                     # 2D count grid with cell encoding
    └── resources/static/index.html                  # entire frontend (Alpine.js + Leaflet + Tabulator, CDN)
```

---

## Pipeline (Main.java order)

```
WorldParser.parse(dbFile)
    → ZdoFlatStore (raw parallel arrays + 3 heatmaps)

ContractBuilder.build(store)
    → WorldContracts (portals, entities, containers, records, structures, dropped, summary)
    → internally runs EntityClassifier, ContainerClassifier, TaxonomyClassifier

RegionLoader.load()
    → List<Region> (from regions.json if present, else empty)

MetricsBuilder.build(contracts, regions)
    → MetricsResult (portalClusters, zoneBudgets, hotspots, droppedHotspots, densityStats)
    → back-fills: contracts.summary.stats.portals.clusters

SectorBuilder.build(contracts, metrics)
    → SectorResult (sectors list, cell_size_m, counts)
    → back-fills: sector_id on EVERY contract record (portals, entities, containers, records, structures)
    → back-fills: contracts.summary.stats.sectors.*

StructureDetector.classify(contracts, cell_size_m)
    → mutates contracts.structures in place (status, confidence, biome, spawner_active)
    → back-fills: contracts.summary.stats.structures.*

AlertBuilder.build(contracts, metrics)
    → AlertResult (alerts list + severity counts)
    → back-fills: contracts.summary.stats.alerts.*

ApiServer.start(port)
    → serves static index.html + all /api/v1/* routes
```

**Key architectural rule:** `ContractBuilder` is the only class that reads `ZdoFlatStore` internals. All downstream stages receive `WorldContracts` only. This boundary is documented in every extractor class javadoc.

---

## API Reference

All endpoints return JSON. Legacy endpoints (portals, players, etc.) use a `{ apiVersion, schemaVersion, snapshotNetTime, ...data }` envelope. Contract endpoints use `{ schema_version, generated_at, total, offset, limit, data: [...] }`.

| Method | Endpoint | Query Params | Notes |
|--------|----------|--------------|-------|
| GET | `/api/v1/status` | — | Parse progress; polled by frontend during load |
| GET | `/api/v1/summary` | — | Store-level stats (ZDOs, categories, player/portal counts) |
| GET | `/api/v1/world-summary` | — | Full WorldSummary contract with nested stats |
| GET | `/api/v1/heatmap` | `type=BUILDING\|DROPPED_ITEM\|ALL` | Cell array `[[cx,cz,count],...]` |
| GET | `/api/v1/points` | `cat=PORTAL\|BED\|TOMBSTONE\|CONTAINER` `minX/maxX/minZ/maxZ` `limit` | Map overlay points |
| GET | `/api/v1/portals` | — | Full portal list with pairing info and status |
| GET | `/api/v1/players` | `sortBy=beds\|deaths\|builds\|portals` | Player records |
| GET | `/api/v1/economy` | `topN=80` | Chest item totals, sorted by count |
| GET | `/api/v1/tombstones` | `player=<name>` | Tombstone list |
| GET | `/api/v1/signs` | `search=<text>` `limit=300` | Sign text corpus |
| GET | `/api/v1/beds` | `player=<name>` | Bed locations |
| GET | `/api/v1/dropped` | — | Dropped item counts by hash |
| GET | `/api/v1/containers` | `limit` `offset` | Container locations (no inventory detail) |
| GET | `/api/v1/entities` | `type=monster\|boss\|npc\|animal` `hostility=hostile\|passive\|neutral` `biome=` `source=` `limit` `offset` | Creature/NPC entities |
| GET | `/api/v1/alerts` | `severity=critical\|high\|medium\|low` `type=portal_orphaned\|...` `limit` `offset` | Steward alerts |
| GET | `/api/v1/sectors` | `density=normal\|high\|hotspot` `minX/maxX/minZ/maxZ` `limit` `offset` | World grid sectors |
| GET | `/api/v1/structures` | `type=dungeon_entrance\|cave_entrance\|camp\|boss_altar\|ruin` `status=active\|likely_cleared\|unknown` `biome=` `limit` `offset` | Detected structures |
| GET | `/api/v1/metrics/summary` | — | Full MetricsResult |

---

## Frontend UI (index.html)

Single HTML file, all dependencies via CDN. No build step. Tech stack:
- **Alpine.js 3.13.5** — reactive state and DOM
- **Leaflet 1.9.4** — map (`L.CRS.Simple`, world coords = lat/lng, Z=lat X=lng)
- **Tabulator 6.2.1** — data tables (midnight theme)
- **Tailwind 3 CDN** — dark mode CSS

### Tabs

| Tab | Data Source | Notes |
|-----|-------------|-------|
| 🗺 Map | `/api/v1/heatmap` + `/api/v1/points` | Canvas heatmap overlay; point overlays for portals/beds/tombstones/containers/structures |
| 🌀 Portals | `/api/v1/portals` | Filter by status; click row → fly to map |
| 👤 Players | `/api/v1/players` | Sort by beds/deaths/builds/portals; click → jump to tombstones |
| 💰 Economy | `/api/v1/economy` | Bar chart of top 80 items in chests |
| 💀 Tombstones | `/api/v1/tombstones` | Filter by player name; click → fly to map |
| 📋 Signs | `/api/v1/signs` | Text search; grid card layout |
| 🎒 Dropped | `/api/v1/dropped` | Bar chart of all dropped item types |
| 🚨 Alerts | `/api/v1/alerts` | Severity filter + type dropdown; click → fly to map |
| 🏛 Structures | `/api/v1/structures` | Status/type/biome filters; click → fly to map |
| 🐾 Creatures | `/api/v1/entities` | Census: stat cards + entity-type bars + top-25 prefab bars |

### Map Coordinate System

```javascript
// World space: Valheim X = east/west, Z = north/south
// Leaflet: lat = Z (north), lng = X (east)
function worldToLatLng(x, z) { return L.latLng(z, x); }
function latLngToWorld(ll)    { return { x: ll.lng, z: ll.lat }; }
```

World bounds for ComfyEra14: X [-26500, 26500], Z [-20500, 27500].
Grid lines every 5000 units. NORTH label = positive Z.

### Heatmap Canvas

The heatmap canvas is placed **directly in the map container** (not in Leaflet's overlay pane). This prevents the CSS transform applied to `leaflet-map-pane` during panning from double-transforming the canvas. Cells are drawn using `latLngToContainerPoint()` which is always correct regardless of pan state. Redrawn on `move`, `zoomend`, `resize` events via `requestAnimationFrame` (deduplicated).

---

## WorldParser — Critical Notes

`WorldParser.java` is a hand-written streaming binary parser of the Valheim ZDO format. It does NOT use the `valheim-save-tools` library for ZDO parsing — it reads the raw `ByteBuffer` directly for performance (~3-4 seconds for 8M ZDOs).

### ZDO Wire Format (per ZDO in parseZdo())
```
uid_userId (long) + uid_id (int)    -- 12 bytes ZDO identity
ownerRevision (int)
dataRevision (int)
persistent (bool)
owner (long)
timeCreated (long)
pgwVersion (int)
type (int?)
distant (bool)
prefabHash (int)                    -- StableHashCode of prefab name
x, y, z (float x3)                 -- world position
rot (float x4 quaternion)
flags (short)                       -- bit field: which property groups follow
[property groups if flags != 0]
```

### flags bit field
```
bit 0 = floats present
bit 1 = vec3s present
bit 2 = quats present
bit 3 = ints present
bit 4 = longs present
bit 5 = strings present
bit 6 = byte arrays present
(flags & 0xFF) == 0 means no property groups — pure positional ZDO
```

### CRITICAL: ENTRANCE_HASHES must come before the (flags & 0xFF) == 0 guard

Dungeon entrance ZDOs (Crypt*, FrostCaves, etc.) have no property flags — they are pure positional. The check for `ENTRANCE_HASHES.contains(hash)` **must** be placed BEFORE the `if ((flags & 0xFF) == 0) { return; }` early-return, or entrances are silently discarded. Boss altar ZDOs (BossStone_*) DO have property flags, but the fix handles both cases:

```java
// CORRECT ORDER in parseZdo():
if (ENTRANCE_HASHES.contains(hash)) {
    if ((flags & 0xFF) != 0) skipProperties(buf, flags, worldVersion);
    store.structureIndices.add(store.add(..., Categories.STRUCTURE, ...));
    return;
}
if ((flags & 0xFF) == 0) {   // pure positional — discard after heatmap increment
    if (validPos) store.allHeatmap.increment(x, z);
    return;
}
```

### StableHashCode (sh() function, ~line 612)

Valheim's deterministic `string → int` hash. Used for ALL prefab and property name lookups. The parser builds `ENTRANCE_HASHES`, `CREATURE_HASHES`, `KNOWN_NAMES` etc. as pre-computed `Set<Integer>` and `Map<Integer,String>` from these hashes at class load time.

```java
private static int sh(String s) {
    int hash1 = 5381, hash2 = hash1;
    for (int i = 0; i < s.length(); i++) {
        char c = s.charAt(i);
        if (i % 2 == 0) hash1 = ((hash1 << 5) + hash1) ^ c;
        else             hash2 = ((hash2 << 5) + hash2) ^ c;
    }
    return hash1 + hash2 * 1566083941;
}
```

---

## ZdoFlatStore — Storage Layout

Parallel primitive arrays indexed 0..size-1. All arrays allocated once at capacity, grown via `Arrays.copyOf` as needed.

```java
int[]    prefabId        // StableHashCode of prefab name
float[]  posX, posY, posZ
byte[]   category        // Categories.BUILDING, PORTAL, BED, etc.
long[]   spawnTimeMicros // Valheim timeCreated field (microseconds of game time)
long[]   creatorId       // player/owner long ID
String[] label1          // context-dependent: portal tag, sign text, tombstone owner, bed owner
String[] label2          // context-dependent: portal author, sign author

// Index lists (subset of full array)
List<Integer> portalIndices, containerIndices, tombstoneIndices,
              signIndices, bedIndices, structureIndices, ballistaIndices

// Heatmaps (500m cell grid)
HeatmapGrid buildingHeatmap, droppedItemHeatmap, allHeatmap

// Aggregates
Map<Integer, Integer>  droppedItemCounts   // hash → count
Map<String,  Long>     chestItemTotals     // item name → total quantity
Map<Long, PlayerRecord> players             // creatorId → PlayerRecord
```

**Categories enum** (byte values 0-11):
`BUILDING, DROPPED_ITEM, ITEM_STAND, CONTAINER, CREATURE, PORTAL, BED, TOMBSTONE, SIGN, BALLISTA, NATURE, UNKNOWN, STRUCTURE`

---

## Key Data Facts (ComfyEra14.db)

- **8M ZDOs total**, ~3-4s parse time with `-Xmx3g`
- **89,846 creature entities** in contracts (all with properties — pure positional creatures excluded)
- **9,135 portals**: ~3,858 paired, ~3,136 orphaned, rest blank/hub
- **122 structures** — all `BossStone_*` variants (27 Eikthyr, 29 TheElder, 34 Bonemass, 32 Yagluth)
  - 0 dungeon/cave/camp = no crypts/frost caves/etc. visited yet in this save
- **3,852 alerts** — 0 critical, 43 high, 3,798 medium, 11 low
  - Medium is dominated by ~3,136 individual orphaned portal alerts + ~600 build hotspot alerts
  - 43 high = portal duplicate-tag groups (portals sharing a tag with 3+ others)
- **434 unique players** (by bed ownership); 613 tombstones
  - Most deaths: Asclea (122 tombstones)
  - Top builder: nexu (274 portals)
- **MASSIVE northern base**: z=13000–26000, ~1.5M build ZDOs per 500m band
  - Top cell: x=[-500,0] z=[13000,13500] → 20,338 ZDOs
- Boss progress: Eikthyr ✓, Elder ✓, Bonemass ✓, Hildir 1-3 ✓ — Moder/Yagluth/Fader NOT killed
- Economy: 31k coins total; top items in chests: Wood (16k), Coins (16k), Stone (7.4k)
- 192,176 dropped items on ground; 294 distinct types

---

## Configuration (steward-config.json)

Auto-generated with defaults on first run. Lives in the working directory.

```json
{
  "sector_size_m": 200,
  "cluster": {
    "portal_radius_m": 200,
    "portal_min_size": 5,
    "entity_radius_m": 100
  },
  "density": {
    "build_risk_zdo_count": 800,
    "hotspot_sigma_multiplier": 2.0,
    "hotspot_min_cells": 10,
    "high_density_sector_zdo_count": 500
  },
  "budgets": {
    "default_spawn_radius_m": 500,
    "default_spawn_max_zdos": 2000
  },
  "structures": {
    "spawner_scan_radius_m": 300
  },
  "taxonomy": {
    "unknown_surge_threshold_pct": 20
  },
  "metrics": {
    "top_prefabs_global_n": 20
  }
}
```

**Tuning for large worlds:** If alert noise is too high (too many medium orphaned portal alerts), consider suppressing `portal_orphaned` in the frontend filter. The AlertBuilder generates one alert per orphaned portal — 3,136 of them for this save.

---

## Known Gaps and Potential Next Work

### Unresolved Hashes
These prefab names haven't been identified yet (they appear in ZdoFlatStore as `hash:NNNN`):

| Hash | Count | Type | Notes |
|------|-------|------|-------|
| 538325542 | ~120k | building piece | Unknown vanilla piece |
| -2119951934 | ~98k | building piece | Unknown vanilla piece |
| 1411875912 | ~166k | item stand variant | Empty item stand |
| -494364525 | ~99k | container variant | Has TCData field |
| 109649212 | ~50k | dropped item | Ashlands region (z≈-8000) |
| 1272849455 | ~46k | dropped item | Ashlands, quality=2 |

To resolve: cross-reference against the Valheim game files or try brute-force StableHashCode matching against the full prefab name list.

### Feature Ideas
- **Sector density overlay on map** — render hotspot/high sectors as colored rectangles on the heatmap canvas (data already in `/api/v1/sectors`)
- **Alert suppression / config** — toggle alert types in the UI or config file
- **Portal map overlay cleanup** — currently shows all 9k portals; could add a "paired only" filter
- **Player detail page** — click a player → show all their portals, beds, tombstones on the map simultaneously
- **Inventory drill-down** — click a container in `/api/v1/containers` → show its items (the store already has `chestItemTotals` but not per-container inventory; would need to re-parse)
- **Regions.json support** — place a `regions.json` next to the JAR to get zone budget alerts; currently no region file means no zone_budget alerts
- **Dungeon/cave visualization** — once players visit crypts/frost caves, those ZDOs will appear automatically; could add a "cleared dungeons" summary card
- **Live reload** — watch the `.db` file for changes and re-parse; useful for active servers

### Alert Volume Reduction
The 3,798 medium alerts are almost all individual `portal_orphaned` entries (one per orphaned portal). Options:
1. Aggregate into a single count alert (like `portal_blank_tag` already does)
2. Make per-portal orphaned alert severity `low` instead of `medium`
3. Add a configurable `max_portal_orphaned_alerts` to AlertBuilder

---

## Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| `io.javalin:javalin` | 6.3.0 | HTTP server (embedded Jetty) |
| `com.fasterxml.jackson.core:jackson-databind` | 2.17.2 | JSON serialization |
| `ch.qos.logback:logback-classic` | 1.5.6 | Logging |
| `net.kakoen.valheim:valheim-save-tools` | 1.0-fixed | Valheim file format library (installed to local Maven repo) |

The `valheim-save-tools` library is used only to locate and open the `.db` file. ZDO parsing is done entirely by `WorldParser.java` reading the raw `ByteBuffer` for performance.

**Frontend CDN (no local assets):**
- Tailwind 3 CDN (dark mode)
- Leaflet 1.9.4
- Alpine.js 3.13.5
- Tabulator 6.2.1 (midnight theme)
