# Batch analytics plan

Last updated: 2026-07-02

## Purpose

The original viewer keeps a compact in-memory subset of "interesting" ZDOs so the live UI stays fast. That is still useful for the dashboard, but it is the wrong foundation for GM investigation work where the interesting question is often unknown up front.

The batch analytics path solves that by writing a full-fidelity local DuckDB cache during parse, then serving pre-rendered map layers and bounded drilldown queries from that cache.

```text
Valheim .db
  -> WorldParser
  -> ZdoFlatStore for the existing live dashboard
  -> DuckDB analytics cache for all-ZDO investigation
  -> rendered PNG overlays and DB-backed drilldown APIs
```

## Current implementation

Code added:

- `viewer/src/main/java/com/valheim/viewer/db/AnalyticsCache.java`
- `viewer/src/main/java/com/valheim/viewer/db/AnalyticsCacheReader.java`
- `viewer/src/main/java/com/valheim/viewer/db/RenderedLayerBuilder.java`

Runtime dependency:

- `viewer/lib/duckdb_jdbc-1.5.4.0.jar`

CLI flags:

```text
--build-cache      Create/update the DuckDB analytics cache while parsing.
--rebuild-cache    Delete the existing cache first, then build it.
--cache <path>     Cache DB path. Default: world-cache.duckdb.
--render-layers    Generate static PNG overlays from the cache.
--render-dir <dir> Render output root. Default: rendered.
--batch-only       Exit after parse/cache/render; do not start the HTTP server.
--cache-fields     Also populate zdo_field. Off by default because it is much heavier.
```

## Current schema

```sql
world_snapshot(
  snapshot_id, source_path, file_size, file_mtime,
  parsed_at, world_version, net_time_seconds
)

zdo(
  snapshot_id, zdo_index, prefab_hash, prefab_name, category,
  x, y, z, sector_x, sector_z, zone_x, zone_z,
  creator_id, owner_id, spawn_time_micros, flags
)

zdo_field(
  snapshot_id, zdo_index, field_type, field_hash, field_name,
  int_value, long_value, float_value, string_value, blob_size
)

container_item(
  snapshot_id, container_zdo_index, item_name, stack, durability,
  quality, variant, crafter_id, crafter_name, custom_data_json,
  container_x, container_y, container_z, sector_x, sector_z, zone_x, zone_z
)

render_cell(
  snapshot_id, layer, cell_size, cx, cz,
  count_value, sum_value, log_value
)
```

## Generated Era16 baseline

Generated from:

```text
C:\work\comfy\erasave\ComfyEra16.db
```

Outputs:

```text
viewer/target/ComfyEra16.duckdb
viewer/target/rendered-era16/1/manifest.json
viewer/target/rendered-era16/1/*.png
viewer/target/generation-era16.out.log
viewer/target/generation-era16.err.log
```

Verified counts:

```text
world_snapshot = 1
zdo            = 9,155,594
container_item = 406,582
render_cell    = 31,924
zdo_field      = 0
```

`zdo_field` is zero because the generated baseline used fast mode without `--cache-fields`.

Rendered layers:

- build density: 64m, 320m, 500m, 1000m
- container coins: 64m, 320m, 500m, 1000m

## Runbook

Build a cache and rendered layers:

```powershell
java -Xmx6g -jar viewer\target\world-viewer-1.0.0.jar `
  C:\work\comfy\erasave\ComfyEra16.db `
  --rebuild-cache `
  --cache viewer\target\ComfyEra16.duckdb `
  --render-layers `
  --render-dir viewer\target\rendered-era16 `
  --batch-only `
  --no-browser
```

Run the viewer with that cache attached:

```powershell
java -Xmx6g -jar viewer\target\world-viewer-1.0.0.jar `
  C:\work\comfy\erasave\ComfyEra16.db `
  --cache viewer\target\ComfyEra16.duckdb `
  --render-dir viewer\target\rendered-era16 `
  --port 7080 `
  --no-browser
```

Inspect the cache with JShell:

```powershell
$jdk = "C:\Users\derek\.codex\jdks\jdk-17.0.19+10"
@'
import java.sql.*;
Class.forName("org.duckdb.DuckDBDriver");
try (Connection c = DriverManager.getConnection("jdbc:duckdb:C:/work/comfystewardview/viewer/target/ComfyEra16.duckdb")) {
  for (String table : new String[]{"world_snapshot","zdo","container_item","render_cell","zdo_field"}) {
    try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("select count(*) from " + table)) {
      r.next();
      System.out.println(table + "=" + r.getLong(1));
    }
  }
}
/exit
'@ | & "$jdk\bin\jshell.exe" --class-path "viewer\lib\duckdb_jdbc-1.5.4.0.jar" -q
```

## API surface

```text
GET /api/v1/rendered/manifest
GET /api/v1/rendered/{file}
GET /api/v1/db/zdo/query
GET /api/v1/db/containers/items
GET /api/v1/db/selection-summary
```

The DB query endpoints are intentionally bounded and paginated. The browser should never receive millions of points.

## Feature coverage

Now enabled:

- All ZDO position/category/prefab rows are available in DuckDB.
- 64m Valheim sectors and 320m Comfy zones are precomputed as columns.
- Container contents are decoded into per-item rows.
- Log-scaled rendered overlays are available for build density and coin concentration.
- Map selection can use DB-backed summaries when a cache is attached.

Partially enabled:

- Prefab/category exploration exists at the API level, not yet as a friendly whitelist UI.
- Location filtering exists as bounding boxes, not semantic masks.
- Build analysis has raw data and rendered density, but not leaderboards.
- CreatorId mapping has raw data, but not the inference tool.
- Custom field analysis requires a rerun with `--cache-fields`.

Not yet built:

- Player/admin roster config.
- Known-world and space-island semantic filters.
- Portal hub detector and outgoing destination map.
- Local 3D prefab viewer.
- Custom field watchlist UI.
- Build-piece leaderboards and base scoring.

## Recommended next milestones

1. **Explorer UI for cached ZDOs**
   Add filter controls for category, prefab, creatorId, and bounding box. Back it with `/api/v1/db/zdo/query`.

2. **Location masks**
   Add semantic filters:
   - `known_world`: radius <= 10800 around origin.
   - `space_islands`: configured northern rectangles or polygons.
   - `outside_player_area`: anything outside both.

3. **Build analytics**
   Query `zdo where category = 'BUILDING'` by creator, prefab, sector, and zone. Add top builders, top pieces, and high-density build locations.

4. **Container wealth analytics**
   Query `container_item` by item, area, crafter, and inferred base owner. Start with Coins and high-value materials.

5. **CreatorId inference**
   Join creatorId observations across beds, tombstones, portals, signs, wards, and local build clusters. Emit confidence and evidence rows.

6. **Portal hubs**
   Cluster nearby portals, group by tag, and draw outgoing matched destinations as map lines.

7. **Custom fields**
   Rerun with `--cache-fields` for a targeted save, then add a watchlist of known field hashes and summary endpoints.

8. **Local 3D view**
   Query a small bounded window, downsample if needed, and render prefab positions in a Three.js scene. Keep it local-window only.
