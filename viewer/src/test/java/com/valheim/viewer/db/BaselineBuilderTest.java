package com.valheim.viewer.db;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class BaselineBuilderTest {

    @TempDir
    Path tempDir;

    /**
     * The check that matters: the baseline must count what the map counts.
     *
     * <p>A baseline that disagrees with the delta about object identity would produce anomaly
     * scores for objects the map never showed, and nothing downstream would reveal it. This is
     * true by construction today because {@link BaselineBuilder} calls
     * {@link SnapshotDeltaEngine#computeDelta}; the test exists so that stays true if someone
     * later replaces that call with a bespoke query "for speed".
     */
    @Test
    void seriesAgreesWithTheDeltaEngineIntervalByInterval() throws Exception {
        File cache = tempDir.resolve("agree.duckdb").toFile();
        File rendered = tempDir.resolve("rendered").toFile();
        createSchema(cache);
        try (Connection conn = open(cache)) {
            for (long id = 1; id <= 4; id++) insertSnapshot(conn, id, "world-a");
            // A tree felled between 2 and 3, and a different one between 3 and 4.
            insertZdo(conn, 1, 10, "Birch1", 100, 100);
            insertZdo(conn, 2, 11, "Birch1", 100, 100);
            insertZdo(conn, 3, 12, "Beech1", 200, 200);
            insertZdo(conn, 4, 13, "wood_floor", 300, 300);
        }

        List<File> written = new BaselineBuilder(cache, rendered).buildAll();
        assertEquals(1, written.size());
        JsonNode root = new ObjectMapper().readTree(written.get(0));

        assertEquals(3, root.path("intervalCount").asInt(), "4 snapshots -> 3 consecutive pairs");

        try (Connection conn = open(cache)) {
            for (JsonNode interval : root.path("intervals")) {
                long from = interval.path("from").asLong(), to = interval.path("to").asLong();
                var delta = SnapshotDeltaEngine.computeDelta(conn, from, to);
                assertEquals(delta.zdosAdded(), interval.path("zdosAdded").asInt(),
                    "added must match computeDelta for " + from + "->" + to);
                assertEquals(delta.zdosRemoved(), interval.path("zdosRemoved").asInt(),
                    "removed must match computeDelta for " + from + "->" + to);
            }
        }

        // And per prefab, summed across intervals.
        assertEquals(1, root.path("prefabs").path("Birch1").path("removed").get(1).asInt(),
            "Birch1 removed in the 2->3 interval");
        assertEquals("tree", root.path("prefabs").path("Birch1").path("group").asText());
        assertTrue(root.path("prefabs").path("wood_floor").path("group").isMissingNode(),
            "a building piece is not a harvestable resource");
    }

    /**
     * Percentiles are withheld below the sample threshold rather than computed from noise.
     *
     * <p>On the corpus this was built against, three of five intervals had zero removals. A p99
     * over that is the maximum wearing a percentile's name, and a steward acting on "3x your p99"
     * would be acting on nothing.
     */
    @Test
    void withholdsPercentilesWhenThereAreTooFewIntervals() throws Exception {
        File cache = tempDir.resolve("thin.duckdb").toFile();
        File rendered = tempDir.resolve("thin-rendered").toFile();
        createSchema(cache);
        try (Connection conn = open(cache)) {
            for (long id = 1; id <= 3; id++) insertSnapshot(conn, id, "world-a");
            insertZdo(conn, 1, 20, "Birch1", 10, 10);
        }

        JsonNode root = new ObjectMapper().readTree(
            new BaselineBuilder(cache, rendered).buildAll().get(0));

        JsonNode sufficiency = root.path("sufficiency");
        assertEquals(2, sufficiency.path("sampleCount").asInt());
        assertFalse(sufficiency.path("percentilesEmitted").asBoolean());
        assertTrue(sufficiency.path("note").asText().contains("Too few"));

        JsonNode stats = root.path("prefabs").path("Birch1").path("removedStats");
        assertTrue(stats.has("median"), "median degrades honestly and is always emitted");
        assertTrue(stats.has("max"));
        assertFalse(stats.has("p99"), "p99 must not appear at 2 samples");
        assertFalse(stats.has("p90"));
    }

    /** A world with one snapshot has no intervals and must not produce a file. */
    @Test
    void skipsWorldsWithNothingToCompare() throws Exception {
        File cache = tempDir.resolve("single.duckdb").toFile();
        File rendered = tempDir.resolve("single-rendered").toFile();
        createSchema(cache);
        try (Connection conn = open(cache)) {
            insertSnapshot(conn, 1, "world-a");
            insertZdo(conn, 1, 30, "Birch1", 5, 5);
        }
        assertTrue(new BaselineBuilder(cache, rendered).buildAll().isEmpty());
    }

    // ----- fixture helpers -----

    private static Connection open(File cache) throws Exception {
        Class.forName("org.duckdb.DuckDBDriver");
        return DriverManager.getConnection("jdbc:duckdb:" + cache.getAbsolutePath());
    }

    private static void createSchema(File cache) throws Exception {
        try (Connection conn = open(cache); Statement st = conn.createStatement()) {
            st.executeUpdate("CREATE TABLE world_snapshot (snapshot_id BIGINT, world_id VARCHAR, " +
                "prefab_dictionary_version VARCHAR)");
            st.executeUpdate("CREATE TABLE zdo (snapshot_id BIGINT, zdo_index BIGINT, " +
                "prefab_hash BIGINT, prefab_name VARCHAR, category VARCHAR, " +
                "x DOUBLE, y DOUBLE, z DOUBLE, creator_id BIGINT, owner_id BIGINT)");
            st.executeUpdate("CREATE TABLE container_item (snapshot_id BIGINT, item_name VARCHAR, " +
                "stack INTEGER, container_x DOUBLE, container_z DOUBLE)");
        }
    }

    private static void insertSnapshot(Connection conn, long id, String worldId) throws Exception {
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO world_snapshot VALUES (?, ?, 'dict-1')")) {
            ps.setLong(1, id);
            ps.setString(2, worldId);
            ps.executeUpdate();
        }
    }

    private static void insertZdo(Connection conn, long snapshotId, long index, String prefab,
            double x, double z) throws Exception {
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO zdo VALUES (?, ?, ?, ?, 'UNKNOWN', ?, 0, ?, NULL, NULL)")) {
            ps.setLong(1, snapshotId);
            ps.setLong(2, index);
            ps.setLong(3, prefab.hashCode());
            ps.setString(4, prefab);
            ps.setDouble(5, x);
            ps.setDouble(6, z);
            ps.executeUpdate();
        }
    }
}
