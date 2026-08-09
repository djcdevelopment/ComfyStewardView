package com.valheim.viewer.db;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AnalyticsCacheArchiveTest {

    @TempDir
    Path tempDir;

    @Test
    void parquetRoundTripPreservesSnapshotsAndSkipsDuplicates() throws Exception {
        File source = tempDir.resolve("source.duckdb").toFile();
        File archive = tempDir.resolve("archive").toFile();
        Files.createDirectories(archive.toPath());

        // Build a source cache with three tiny snapshots directly via SQL.
        try (AnalyticsCache cache = new AnalyticsCache(source, true)) {
            try (Statement st = cache.connection().createStatement()) {
                for (int id = 1; id <= 3; id++) {
                    st.executeUpdate("INSERT INTO world_snapshot (snapshot_id, source_path, " +
                        "file_size, parsed_at, world_version, net_time_seconds, world_id, source, file_hash) " +
                        "VALUES (" + id + ", 'snap-" + id + ".db', 1, '2026-01-01T00:00:00Z', 1, 100.0, " +
                        "'world-a', 'test', 'hash-" + id + "')");
                    st.executeUpdate("INSERT INTO zdo (snapshot_id, zdo_index, prefab_hash, " +
                        "prefab_name, category, x, y, z) VALUES " +
                        "(" + id + ", 0, 100, 'piece', 'BUILDING', " + (id * 10) + ", 0, 0), " +
                        "(" + id + ", 1, 101, 'boar', 'CREATURE', 0, 0, " + (id * 10) + ")");
                    st.executeUpdate("INSERT INTO container_item (snapshot_id, container_zdo_index, " +
                        "item_name, stack, container_x, container_y, container_z) VALUES " +
                        "(" + id + ", 0, 'Coins', " + (id * 100) + ", 5, 0, 5)");
                }
            }
            cache.connection().commit();

            // Export each snapshot the way the publish archive lane does.
            try (Statement st = cache.connection().createStatement()) {
                for (int id = 1; id <= 3; id++) {
                    File dir = new File(archive, "snapshot-" + id + "-test");
                    Files.createDirectories(dir.toPath());
                    String p = dir.getAbsolutePath().replace('\\', '/');
                    for (String table : new String[] {"world_snapshot", "zdo", "container_item"}) {
                        st.execute("COPY (SELECT * FROM " + table + " WHERE snapshot_id = " + id +
                            ") TO '" + p + "/" + table + ".parquet' (FORMAT PARQUET, COMPRESSION ZSTD)");
                    }
                }
            }
        }

        // Import latest 2 into a fresh cache: snapshot 1 ages out, ids preserved.
        File target = tempDir.resolve("target.duckdb").toFile();
        try (AnalyticsCache cache = new AnalyticsCache(target, true)) {
            List<Long> imported = cache.importArchiveSnapshots(archive, 2);
            assertEquals(List.of(2L, 3L), imported);
            // Re-import is a no-op (dedupe by snapshot id).
            assertEquals(List.of(), cache.importArchiveSnapshots(archive, 2));
            cache.finish();
        }

        Class.forName("org.duckdb.DuckDBDriver");
        try (Connection conn = DriverManager.getConnection("jdbc:duckdb:" + target.getAbsolutePath());
             Statement st = conn.createStatement()) {
            try (ResultSet rs = st.executeQuery(
                    "SELECT snapshot_id, file_hash FROM world_snapshot ORDER BY snapshot_id")) {
                assertTrue(rs.next());
                assertEquals(2, rs.getLong(1));
                assertEquals("hash-2", rs.getString(2));
                assertTrue(rs.next());
                assertEquals(3, rs.getLong(1));
                assertTrue(!rs.next());
            }
            try (ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM zdo")) {
                rs.next();
                assertEquals(4, rs.getLong(1));
            }
            try (ResultSet rs = st.executeQuery(
                    "SELECT SUM(stack) FROM container_item WHERE snapshot_id = 3")) {
                rs.next();
                assertEquals(300, rs.getLong(1));
            }
            // A new snapshot appended after import continues the id sequence.
        }
        try (AnalyticsCache cache = new AnalyticsCache(target, false)) {
            cache.beginSnapshot(target, 1, 100.0, null);
            assertEquals(4, cache.snapshotId());
        }
    }
}
