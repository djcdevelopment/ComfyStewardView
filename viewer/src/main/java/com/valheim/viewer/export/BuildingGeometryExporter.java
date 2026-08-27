package com.valheim.viewer.export;

import com.valheim.viewer.store.ZdoFlatStore.Categories;
import org.duckdb.DuckDBAppender;
import org.duckdb.DuckDBConnection;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * One-shot batch sink: every architectural ZDO the parser sees, with its rotation, written
 * to a single Parquet file. This is the research lane for reconstruction work — it does NOT
 * touch the analytics cache schema or the publish pipeline. If rotation ever earns a place
 * in the real `zdo` table, that promotion is a separate, parser_version-bumped change.
 *
 * Rows are staged through a throwaway DuckDB (created beside the output, deleted on close)
 * because the DuckDB JDBC driver we already ship can append fast and COPY TO PARQUET, and
 * that beats adding a Parquet writer dependency to the jar.
 */
public class BuildingGeometryExporter implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(BuildingGeometryExporter.class);

    private static final int BATCH_LIMIT = 50_000;

    private final File outParquet;
    private final File tmpDb;
    private final Connection conn;
    private final DuckDBAppender appender;
    private final boolean allCategories;
    private int batch = 0;
    private long rows = 0;
    private long rotRows = 0;

    public BuildingGeometryExporter(File outParquet) throws SQLException {
        this(outParquet, false);
    }

    /**
     * @param allCategories export every ZDO, not just the architectural ones. Needed by the
     *     sight-line probe, whose occluders are vegetation and rock — category UNKNOWN, which
     *     the architectural filter deliberately drops.
     */
    public BuildingGeometryExporter(File outParquet, boolean allCategories) throws SQLException {
        this.allCategories = allCategories;
        this.outParquet = outParquet;
        File parent = outParquet.getAbsoluteFile().getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new SQLException("Cannot create output directory: " + parent);
        }
        this.tmpDb = new File(parent, outParquet.getName() + ".tmp.duckdb");
        if (tmpDb.exists() && !tmpDb.delete()) {
            throw new SQLException("Stale temp staging db in the way: " + tmpDb);
        }
        this.conn = DriverManager.getConnection("jdbc:duckdb:" + tmpDb.getAbsolutePath());
        try (Statement st = conn.createStatement()) {
            st.executeUpdate(
                "CREATE TABLE bg (" +
                "zdo_index INTEGER, prefab_hash INTEGER, prefab_name VARCHAR, category VARCHAR, " +
                "x DOUBLE, y DOUBLE, z DOUBLE, " +
                "has_rot INTEGER, rot_x DOUBLE, rot_y DOUBLE, rot_z DOUBLE, " +
                "creator_id BIGINT, flags INTEGER)");
        }
        conn.setAutoCommit(false);
        this.appender = conn.unwrap(DuckDBConnection.class).createAppender("bg");
        log.info("Building-geometry export staging at {}", tmpDb.getAbsolutePath());
    }

    /**
     * Architectural categories only. Chests, beds, signs, portals and item stands are
     * construction pieces that classified into their own categories before the BUILDING
     * branch, and interior planning wants all of them — so this is a category filter,
     * not a prefab allowlist.
     */
    public boolean wants(byte category) {
        if (allCategories) return true;
        switch (category) {
            case Categories.BUILDING:
            case Categories.ITEM_STAND:
            case Categories.CONTAINER:
            case Categories.PORTAL:
            case Categories.BED:
            case Categories.SIGN:
            case Categories.BALLISTA:
                return true;
            default:
                return false;
        }
    }

    public void accept(int zdoIndex, int prefabHash, String prefabName, byte category,
            float x, float y, float z, boolean hasRot, float rotX, float rotY, float rotZ,
            long creatorId, int flags) throws SQLException {
        appender.beginRow();
        appender.append(zdoIndex);
        appender.append(prefabHash);
        if (prefabName == null) appender.appendNull(); else appender.append(prefabName);
        appender.append(Categories.name(category));
        appender.append((double) x);
        appender.append((double) y);
        appender.append((double) z);
        appender.append(hasRot ? 1 : 0);
        appender.append((double) rotX);
        appender.append((double) rotY);
        appender.append((double) rotZ);
        if (creatorId == 0L) appender.appendNull(); else appender.append(creatorId);
        appender.append(flags);
        appender.endRow();
        rows++;
        if (hasRot) rotRows++;
        if (++batch >= BATCH_LIMIT) {
            appender.flush();
            conn.commit();
            batch = 0;
        }
    }

    /** Flush, report, COPY to Parquet, and remove the staging db. */
    @Override
    public void close() throws SQLException {
        appender.flush();
        conn.commit();
        appender.close();

        try (Statement st = conn.createStatement()) {
            try (ResultSet rs = st.executeQuery(
                    "SELECT category, count(*) FROM bg GROUP BY category ORDER BY 2 DESC")) {
                StringBuilder sb = new StringBuilder();
                while (rs.next()) {
                    if (sb.length() > 0) sb.append(", ");
                    sb.append(rs.getString(1)).append('=').append(String.format("%,d", rs.getLong(2)));
                }
                log.info("Geometry export census: {}", sb);
            }
            // Raw rotation value ranges are the first decode signal: |values| beyond 2*pi
            // rule out radians and reconstructed-quaternion readings before any geometry runs.
            try (ResultSet rs = st.executeQuery(
                    "SELECT min(rot_x), max(rot_x), min(rot_y), max(rot_y), min(rot_z), max(rot_z) " +
                    "FROM bg WHERE has_rot = 1")) {
                if (rs.next()) {
                    log.info("Rotation ranges (has_rot rows): x [{}, {}], y [{}, {}], z [{}, {}]",
                        rs.getDouble(1), rs.getDouble(2), rs.getDouble(3),
                        rs.getDouble(4), rs.getDouble(5), rs.getDouble(6));
                }
            }
            String target = outParquet.getAbsolutePath().replace("'", "''");
            st.executeUpdate("COPY bg TO '" + target + "' (FORMAT PARQUET, COMPRESSION ZSTD)");
        }
        conn.commit();
        conn.close();
        if (!tmpDb.delete()) {
            log.warn("Could not delete staging db {} — remove it by hand", tmpDb.getAbsolutePath());
        }
        log.info("Building geometry exported: {} rows ({} with rotation, {}%) -> {}",
            String.format("%,d", rows), String.format("%,d", rotRows),
            rows > 0 ? String.format("%.1f", 100.0 * rotRows / rows) : "0",
            outParquet.getAbsolutePath());
    }

    public long rowCount() { return rows; }
}
