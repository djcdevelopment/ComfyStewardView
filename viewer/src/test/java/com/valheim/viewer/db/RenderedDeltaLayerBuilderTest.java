package com.valheim.viewer.db;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RenderedDeltaLayerBuilderTest {

    private static final Pattern PAIR_DIR = Pattern.compile("[1-9][0-9]*-[1-9][0-9]*");

    @TempDir
    Path tempDir;

    @Test
    void rendersAlignedChannelsWithTheTabularIdentityRule() throws Exception {
        File cache = tempDir.resolve("fixture.duckdb").toFile();
        File rendered = tempDir.resolve("rendered").toFile();
        createSchema(cache);
        try (Connection conn = open(cache)) {
            insertSnapshot(conn, 1, "world-a", "dict-1");
            insertSnapshot(conn, 2, "world-a", "dict-1");

            // Same prefab and centimetre-quantised position: unchanged despite a different row index.
            insertZdo(conn, 1, 0, 100, "piece_common", "BUILDING", 10.001, 0, 10.001);
            insertZdo(conn, 2, 99, 100, "piece_common", "BUILDING", 10.002, 0, 10.002);
            insertZdo(conn, 1, 1, 101, "piece_removed", "BUILDING", -65, 0, 0);
            insertZdo(conn, 2, 1, 102, "piece_added", "BUILDING", 130, 0, 0);
            insertZdo(conn, 2, 2, 103, "boar_added", "CREATURE", 0, 0, 70);
            insertZdo(conn, 2, 3, 104, "outside_map", "CREATURE", 150_000, 0, 0);
            insertZdo(conn, 1, 4, 105, "drop_removed", "DROPPED_ITEM", -320, 0, -320);
            insertZdo(conn, 2, 4, 106, "drop_added", "DROPPED_ITEM", 320, 0, 320);
            // Coins: same-cell shrink (100 -> 40) plus a new hoard in a different 64m cell.
            // At 1000m both containers share one cell, so the layer must show the net +440.
            insertContainerItem(conn, 1, 100, 10, 10);
            insertContainerItem(conn, 2, 40, 10, 10);
            insertContainerItem(conn, 2, 500, 200, 200);
            try (Statement st = conn.createStatement()) {
                st.executeUpdate("INSERT INTO render_cell VALUES " +
                    "(1, 'all-zdos', 1000, 0, 0, 3), (2, 'all-zdos', 1000, 0, 0, 5)");
            }

            SnapshotDeltaEngine.DeltaResult tableDelta = SnapshotDeltaEngine.computeDelta(conn, 1, 2);
            assertEquals(4, tableDelta.zdosAdded());
            assertEquals(2, tableDelta.zdosRemoved());
            assertTrue(tableDelta.reconciles());
        }

        File manifestFile = new RenderedDeltaLayerBuilder(cache, rendered).renderPair(1, 2);
        JsonNode manifest = new ObjectMapper().readTree(manifestFile);
        assertEquals(1, manifest.path("fromSnapshotId").asLong());
        assertEquals(2, manifest.path("toSnapshotId").asLong());
        assertEquals("world-a", manifest.path("worldId").asText());
        assertEquals("prefab-hash+position-cm", manifest.path("identity").asText());
        assertEquals(4, manifest.path("zdosAdded").asLong());
        assertEquals(2, manifest.path("zdosRemoved").asLong());
        assertEquals(3, manifest.path("spatialZdosAdded").asLong());
        assertEquals(1, manifest.path("unrenderableZdosAdded").asLong());
        assertFalse(manifest.path("dictionaryMismatch").asBoolean());
        assertEquals(2, manifest.path("schemaVersion").asInt());
        assertEquals(16, manifest.path("layers").size());

        JsonNode build64 = layer(manifest, "build-activity", 64);
        JsonNode all64 = layer(manifest, "all-zdos", 64);
        assertEquals(1, build64.path("addedRawTotal").asLong());
        assertEquals(1, build64.path("removedRawTotal").asLong());
        assertEquals("objects", build64.path("units").asText());
        assertEquals("prefab-hash+position-cm", build64.path("identity").asText());
        assertEquals(3, all64.path("addedRawTotal").asLong());
        assertEquals(2, all64.path("removedRawTotal").asLong());

        JsonNode dropped64 = layer(manifest, "dropped-items", 64);
        assertEquals(1, dropped64.path("addedRawTotal").asLong());
        assertEquals(1, dropped64.path("removedRawTotal").asLong());

        JsonNode coins64 = layer(manifest, "coins", 64);
        assertEquals("coins", coins64.path("units").asText());
        assertEquals("cell-coin-stack-sum", coins64.path("identity").asText());
        assertEquals(500, coins64.path("addedMaxRaw").asLong());
        assertEquals(60, coins64.path("removedMaxRaw").asLong());
        JsonNode coins1000 = layer(manifest, "coins", 1000);
        assertEquals(440, coins1000.path("addedMaxRaw").asLong());
        assertEquals(0, coins1000.path("removedMaxRaw").asLong());

        for (JsonNode layer : manifest.path("layers")) {
            BufferedImage added = ImageIO.read(new File(manifestFile.getParentFile(), layer.path("addedFile").asText()));
            BufferedImage removed = ImageIO.read(new File(manifestFile.getParentFile(), layer.path("removedFile").asText()));
            assertNotNull(added);
            assertNotNull(removed);
            assertEquals(added.getWidth(), removed.getWidth());
            assertEquals(added.getHeight(), removed.getHeight());
            assertEquals(layer.path("width").asInt(), added.getWidth());
            assertEquals(layer.path("height").asInt(), added.getHeight());
        }

        try (AnalyticsCacheReader reader = new AnalyticsCacheReader(cache, rendered)) {
            assertEquals(2, reader.snapshotId());
            assertNotNull(reader.snapshotInfo(1));
            assertNull(reader.snapshotInfo(99));
            assertEquals(3, reader.queryZdos(new ObjectMapper(), 1,
                -1000, 1000, -1000, 1000, null, null, null, 100, 0).path("total").asInt());
            assertEquals(4, reader.queryZdos(new ObjectMapper(), 2,
                -1000, 1000, -1000, 1000, null, null, null, 100, 0).path("total").asInt());
            JsonNode snapshots = reader.listSnapshots(new ObjectMapper(), "world-a");
            assertEquals(5, snapshots.path("snapshots").get(0).path("zdoCount").asLong());
            assertFalse(snapshots.path("snapshots").get(0).path("absoluteRasterAvailable").asBoolean());
            assertEquals(1, snapshots.path("deltaPairs").size());
            assertTrue(snapshots.path("deltaPairs").get(0).path("available").asBoolean());
            assertTrue(reader.deltaRenderedFileAdvertised(1, 2, build64.path("addedFile").asText()));
            assertFalse(reader.deltaRenderedFileAdvertised(1, 2, "orphan.png"));
        }

        ObjectMapper mapper = new ObjectMapper();
        ObjectNode incomplete = (ObjectNode) mapper.readTree(manifestFile);
        ((ObjectNode) incomplete.path("layers").get(0)).remove("addedMaxRaw");
        mapper.writeValue(manifestFile, incomplete);
        assertFalse(RenderedDeltaLayerBuilder.isCompleteManifest(manifestFile, 1, 2));
        assertEquals(1, new RenderedDeltaLayerBuilder(cache, rendered).renderRecentPairs());
        assertTrue(RenderedDeltaLayerBuilder.isCompleteManifest(manifestFile, 1, 2));

        // A pre-upgrade schemaVersion 1 manifest must fail the completeness check and re-render.
        ObjectNode oldSchema = (ObjectNode) mapper.readTree(manifestFile);
        oldSchema.put("schemaVersion", 1);
        mapper.writeValue(manifestFile, oldSchema);
        assertFalse(RenderedDeltaLayerBuilder.isCompleteManifest(manifestFile, 1, 2));
        assertEquals(1, new RenderedDeltaLayerBuilder(cache, rendered).renderRecentPairs());
        assertTrue(RenderedDeltaLayerBuilder.isCompleteManifest(manifestFile, 1, 2));

        File misalignedChannel = new File(manifestFile.getParentFile(), build64.path("addedFile").asText());
        assertTrue(ImageIO.write(new BufferedImage(1, 1, BufferedImage.TYPE_INT_ARGB),
            "png", misalignedChannel));
        try (AnalyticsCacheReader reader = new AnalyticsCacheReader(cache, rendered)) {
            assertFalse(reader.listSnapshots(new ObjectMapper(), "world-a")
                .path("deltaPairs").get(0).path("available").asBoolean());
        }
        assertEquals(1, new RenderedDeltaLayerBuilder(cache, rendered).renderRecentPairs());
        assertTrue(RenderedDeltaLayerBuilder.isCompleteManifest(manifestFile, 1, 2));
    }

    @Test
    void keepsOnlyFifteenCanonicalPairsForTheLatestSixSnapshots() throws Exception {
        File cache = tempDir.resolve("matrix.duckdb").toFile();
        File rendered = tempDir.resolve("matrix-rendered").toFile();
        createSchema(cache);
        try (Connection conn = open(cache)) {
            for (int id = 1; id <= 7; id++) insertSnapshot(conn, id, "world-a", "dict-1");
        }

        Path stale = rendered.toPath().resolve("delta/1-2");
        Files.createDirectories(stale);
        Files.writeString(stale.resolve("manifest.json"), "stale");
        Path unrelated = rendered.toPath().resolve("delta/notes");
        Files.createDirectories(unrelated);
        Files.writeString(unrelated.resolve("keep.txt"), "operator note");

        RenderedDeltaLayerBuilder builder = new RenderedDeltaLayerBuilder(cache, rendered);
        assertEquals(15, RenderedDeltaLayerBuilder.canonicalPairCount(7));
        assertEquals(15, builder.renderRecentPairs());
        assertFalse(Files.exists(stale));
        assertTrue(Files.exists(unrelated.resolve("keep.txt")));

        Set<String> actual = new HashSet<>();
        try (Stream<Path> paths = Files.list(rendered.toPath().resolve("delta"))) {
            paths.filter(Files::isDirectory)
                .map(path -> path.getFileName().toString())
                .filter(name -> PAIR_DIR.matcher(name).matches())
                .forEach(actual::add);
        }
        assertEquals(15, actual.size());
        assertTrue(actual.contains("2-7"));
        assertTrue(actual.contains("6-7"));
        assertTrue(actual.stream().noneMatch(name -> name.startsWith("1-") || name.endsWith("-1")));
        try (AnalyticsCacheReader reader = new AnalyticsCacheReader(cache, rendered)) {
            assertTrue(reader.isDeltaPairInRecentMatrix(2, 7));
            assertFalse(reader.isDeltaPairInRecentMatrix(1, 7));
            assertFalse(reader.isDeltaPairInRecentMatrix(7, 2));
        }
    }

    @Test
    void rejectsReverseAndCrossWorldPairs() throws Exception {
        File cache = tempDir.resolve("validation.duckdb").toFile();
        File rendered = tempDir.resolve("validation-rendered").toFile();
        createSchema(cache);
        try (Connection conn = open(cache)) {
            insertSnapshot(conn, 1, "world-a", "dict-1");
            insertSnapshot(conn, 2, "world-a", "dict-1");
            insertSnapshot(conn, 3, "world-b", "dict-2");
        }
        RenderedDeltaLayerBuilder builder = new RenderedDeltaLayerBuilder(cache, rendered);
        assertThrows(IllegalArgumentException.class, () -> builder.renderPair(2, 1));
        assertThrows(IllegalArgumentException.class, () -> builder.renderPair(2, 3));
    }

    private static JsonNode layer(JsonNode manifest, String id, int cellSize) {
        for (JsonNode layer : manifest.path("layers")) {
            if (id.equals(layer.path("layer").asText()) && cellSize == layer.path("cellSize").asInt()) {
                return layer;
            }
        }
        throw new AssertionError("missing layer " + id + " at " + cellSize + "m");
    }

    private static Connection open(File cache) throws Exception {
        Class.forName("org.duckdb.DuckDBDriver");
        return DriverManager.getConnection("jdbc:duckdb:" + cache.getAbsolutePath());
    }

    private static void createSchema(File cache) throws Exception {
        try (Connection conn = open(cache); Statement st = conn.createStatement()) {
            st.executeUpdate("""
                CREATE TABLE world_snapshot (
                    snapshot_id BIGINT PRIMARY KEY, source_path VARCHAR, file_size BIGINT,
                    parsed_at VARCHAR, world_version INTEGER, world_id VARCHAR, world_name VARCHAR,
                    source VARCHAR, backup_id VARCHAR, save_timestamp VARCHAR, file_hash VARCHAR,
                    parser_version VARCHAR, prefab_dictionary_version VARCHAR,
                    prefab_dictionary_entries INTEGER)
                """);
            st.executeUpdate("""
                CREATE TABLE zdo (
                    snapshot_id BIGINT, zdo_index INTEGER, prefab_hash INTEGER,
                    prefab_name VARCHAR, category VARCHAR, x DOUBLE, y DOUBLE, z DOUBLE,
                    creator_id BIGINT, owner_id BIGINT, spawn_time_micros BIGINT, flags INTEGER)
                """);
            st.executeUpdate("""
                CREATE TABLE container_item (
                    snapshot_id BIGINT, container_zdo_index INTEGER, item_name VARCHAR,
                    stack INTEGER, quality INTEGER, variant INTEGER, crafter_id BIGINT,
                    crafter_name VARCHAR, custom_data_json VARCHAR,
                    container_x DOUBLE, container_y DOUBLE, container_z DOUBLE)
                """);
            st.executeUpdate("""
                CREATE TABLE render_cell (
                    snapshot_id BIGINT, layer VARCHAR, cell_size INTEGER,
                    cx INTEGER, cz INTEGER, count_value BIGINT)
                """);
        }
    }

    private static void insertSnapshot(Connection conn, long id, String worldId, String dictionary)
            throws Exception {
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO world_snapshot VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
            ps.setLong(1, id);
            ps.setString(2, "snapshot-" + id + ".db");
            ps.setLong(3, 1);
            ps.setString(4, "2026-01-01T00:00:00Z");
            ps.setInt(5, 1);
            ps.setString(6, worldId);
            ps.setString(7, worldId);
            ps.setString(8, "test");
            ps.setString(9, "test-" + id);
            ps.setString(10, "2026-01-01T00:00:00Z");
            ps.setString(11, "hash-" + id);
            ps.setString(12, "test");
            ps.setString(13, dictionary);
            ps.setInt(14, 1);
            ps.executeUpdate();
        }
    }

    private static void insertContainerItem(Connection conn, long snapshotId, int stack,
            double x, double z) throws Exception {
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO container_item VALUES (?, 0, 'Coins', ?, 1, 0, NULL, NULL, NULL, ?, 0, ?)")) {
            ps.setLong(1, snapshotId);
            ps.setInt(2, stack);
            ps.setDouble(3, x);
            ps.setDouble(4, z);
            ps.executeUpdate();
        }
    }

    private static void insertZdo(Connection conn, long snapshotId, int index, int prefabHash,
            String prefab, String category, double x, double y, double z) throws Exception {
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO zdo VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0)")) {
            ps.setLong(1, snapshotId);
            ps.setInt(2, index);
            ps.setInt(3, prefabHash);
            ps.setString(4, prefab);
            ps.setString(5, category);
            ps.setDouble(6, x);
            ps.setDouble(7, y);
            ps.setDouble(8, z);
            ps.executeUpdate();
        }
    }
}
