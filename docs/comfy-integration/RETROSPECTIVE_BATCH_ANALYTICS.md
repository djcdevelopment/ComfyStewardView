# Retrospective: DB-backed ZDO analytics, 2026-07-02

Audience: future maintainers extending the GM investigation feature set.

## What we set out to do

The GM feature request needed the viewer to answer questions that the original in-memory model could not answer cleanly:

- include additional ZDO types without hard-coding each one as "interesting"
- query arbitrary prefab categories after parse
- inspect build pieces and creatorIds
- decode container contents per container
- support 64m Valheim sectors and 320m Comfy zones
- pre-render high-density views instead of forcing the browser to draw millions of points

The key design change was to treat full-ZDO retention as a batch analytics problem, not a live UI rendering problem.

## What shipped

| Area | Output |
|---|---|
| Storage | DuckDB cache with `world_snapshot`, `zdo`, `zdo_field`, `container_item`, and `render_cell` tables |
| Parser | Optional analytics sink wired into `WorldParser` |
| Inventory | Existing container decoder now also emits per-item `container_item` rows |
| Rendering | Static PNG overlays for build density and container coins at 64m, 320m, 500m, 1000m |
| API | Render manifest/file routes plus DB-backed ZDO, container item, and selection-summary queries |
| UI | Optional rendered layer selector and DB-backed map-selection summaries |
| CLI | `--build-cache`, `--rebuild-cache`, `--cache`, `--render-layers`, `--render-dir`, `--batch-only`, `--cache-fields` |

## Generated baseline

Dataset:

```text
C:\work\comfy\erasave\ComfyEra16.db
```

Run mode:

```text
--rebuild-cache --render-layers --batch-only
```

Verified output:

```text
zdo            = 9,155,594
container_item = 406,582
render_cell    = 31,924
world_snapshot = 1
zdo_field      = 0
```

`zdo_field` is zero by design for this baseline. Full field capture is opt-in with `--cache-fields`.

## What worked

**Separating "store everything" from "render everything" was the right architecture.**

The viewer can now keep every ZDO row in DuckDB while the browser still receives only static overlays, summaries, or paginated bounded result sets.

**DuckDB appender API was necessary.**

The first implementation used JDBC prepared-statement batches for every ZDO row. It worked technically, but throughput was too slow for a 9.1M-ZDO world. Switching `zdo` and `container_item` writes to `DuckDBAppender` moved parse/write throughput into the hundreds of thousands of ZDOs per second.

**Defaulting field capture off was the right tradeoff.**

Storing every scalar/vector/string field is valuable for custom mod analysis, but it is far heavier than the core GM workflows need. The fast default now captures all ZDO identity/position/category rows plus decoded container items. `--cache-fields` exists for deeper forensic runs.

**Static rendered overlays were cheap once the DB existed.**

The first useful layers were straightforward SQL group-bys:

- build density from `zdo where category = 'BUILDING'`
- coin concentration from `container_item where item_name = 'Coins'`

The `render_cell` table makes layer generation inspectable and reproducible.

## What did not work

**The first run was too slow.**

At about 100k parsed after 90 seconds, it was clear that field-heavy prepared-statement inserts would take too long. We stopped the run, made field capture opt-in, and switched hot tables to appenders.

**Rebuilding the fat JAR by mutating the old archive broke `java -jar`.**

Merging DuckDB contents into the existing shaded JAR removed or damaged the executable manifest. The fix was to rebuild a clean fat JAR from a staging directory: unpack valid dependency jars, copy `target/classes`, and create the archive with `jar cfe ... com.valheim.viewer.Main`.

**The repo tracks build artifacts.**

Because `viewer/target/classes` and the JARs are tracked, compiling all Java sources creates a broad class-file diff. That is consistent with the repo's current packaging style, but future work should consider either committing source only or formalizing generated-artifact expectations.

## Design decisions to preserve

1. Keep the existing `ZdoFlatStore` path alive for the live dashboard.
2. Treat DuckDB as an additive analytics cache, not a replacement parser model yet.
3. Do not send unbounded query results to the browser.
4. Use pre-rendered layers for dense world-scale maps.
5. Keep full `zdo_field` capture opt-in until there is a targeted custom-field workflow.
6. Prefer 64m and 320m as first-class grid sizes because they match Valheim sectors and Comfy zones.

## Follow-up plan

Next useful slices, in order:

1. ZDO explorer UI over `/api/v1/db/zdo/query`.
2. Semantic location masks for known-world radius and space islands.
3. Build leaderboards by creatorId, prefab, 64m sector, and 320m zone.
4. Container wealth reports by area and item type.
5. CreatorId inference from beds, tombstones, portals, signs, wards, and build clusters.
6. Portal hub detector with outgoing tag matches.
7. Custom field watchlist using `--cache-fields`.
8. Local bounded 3D prefab view.

## Validation commands used

Compile:

```powershell
$jdk = "C:\Users\derek\.codex\jdks\jdk-17.0.19+10"
$classes = "viewer\target\classes"
$jars = Get-ChildItem viewer\lib -Filter *.jar |
  Where-Object { $_.Name -ne "jetty-servlet.jar" } |
  ForEach-Object { $_.FullName }
$cp = "$classes;" + ($jars -join ";")
$sources = Get-ChildItem viewer\src\main\java -Recurse -Filter *.java |
  ForEach-Object { $_.FullName }
& "$jdk\bin\javac.exe" -cp $cp -d $classes $sources
```

Batch generation:

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

DuckDB row-count check:

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
