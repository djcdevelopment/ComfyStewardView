package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ScenePackageTest {
    @TempDir Path temporary;

    @BeforeAll static void driver() throws Exception {
        Class.forName("org.duckdb.DuckDBDriver");
    }

    @Test void packagesExactDeterministicSelectionWithoutAbsoluteOriginOrPrivateFields() throws Exception {
        Path cache = temporary.resolve("scene.duckdb");
        createFixture(cache, 0);
        ObjectMapper mapper = new ObjectMapper();
        ScenePackage scenes = new ScenePackage(
            new SnapshotRepository(cache, new LensRegistry(), mapper, true), mapper);

        ScenePackage.Result first = scenes.build(7, "build-density", -10, 10, -10, 10,
            List.of(), false, "test-release");
        ScenePackage.Result second = scenes.build(7, "build-density", -10, 10, -10, 10,
            List.of(), false, "test-release");

        assertEquals(4, first.pieces());
        assertArrayEquals(first.bytes(), second.bytes(), "identical scope must produce identical bytes");
        ByteBuffer header = ByteBuffer.wrap(first.bytes()).order(ByteOrder.LITTLE_ENDIAN);
        byte[] magic = new byte[4]; header.get(magic);
        assertEquals("SV3D", new String(magic, StandardCharsets.US_ASCII));
        assertEquals(1, header.getInt());
        int manifestLength = header.getInt();
        int instanceOffset = header.getInt();
        assertEquals(0, instanceOffset % 4);
        assertEquals(4 * ScenePackage.INSTANCE_STRIDE, first.bytes().length - instanceOffset);
        assertTrue(manifestLength > 0);

        int roofRecord = instanceOffset + ScenePackage.INSTANCE_STRIDE;
        int wallRecord = instanceOffset + 3 * ScenePackage.INSTANCE_STRIDE;
        assertEquals(.35f, header.getFloat(instanceOffset), 1e-5);
        assertEquals(.35f, header.getFloat(instanceOffset + 20), 1e-5);
        assertEquals(.35f, header.getFloat(instanceOffset + 40), 1e-5);
        assertEquals(4f, header.getFloat(wallRecord + 48) - header.getFloat(roofRecord + 48), 1e-5);
        assertEquals(.5f, header.getFloat(wallRecord + 52) - header.getFloat(roofRecord + 52), 1e-5);
        assertEquals(-1.5f, header.getFloat(wallRecord + 56) - header.getFloat(roofRecord + 56), 1e-5);
        assertEquals(2f, header.getFloat(wallRecord + 8), 1e-5);
        assertEquals(4f, header.getFloat(wallRecord + 20), 1e-5);
        assertEquals(-.2f, header.getFloat(wallRecord + 32), 1e-5);

        ObjectNode manifest = first.manifest();
        assertEquals("steward-zdo-scene/v1", manifest.path("schema").asText());
        assertTrue(manifest.path("exact").asBoolean());
        assertFalse(manifest.path("forced").asBoolean());
        assertEquals(1, manifest.path("geometryCoverage").path("real").asInt());
        assertEquals(1, manifest.path("geometryCoverage").path("estimated").asInt());
        assertEquals(2, manifest.path("geometryCoverage").path("unknown").asInt());
        assertEquals(1, manifest.path("geometryCoverage").path("proxyOutliers").asInt());
        assertEquals(4, manifest.withArray("families").size());
        assertEquals("misc", manifest.withArray("families").get(0).path("name").asText());
        assertEquals("roof", manifest.withArray("families").get(1).path("name").asText());
        assertEquals("unknown", manifest.withArray("families").get(2).path("name").asText());
        assertEquals("wall", manifest.withArray("families").get(3).path("name").asText());
        assertNull(manifest.findValue("origin"));
        assertNull(manifest.findValue("creator"));
        assertNull(manifest.findValue("owner"));
        assertNull(manifest.findValue("flags"));
        assertEquals("selection-local right-handed; absolute origin withheld",
            manifest.path("coordinateContract").asText());

        ScenePackage.Result meadows = scenes.build(7, "build-density", -10, 10, -10, 10,
            List.of("meadows"), false, "test-release");
        assertEquals(3, meadows.pieces());
        assertEquals("meadows", meadows.manifest().path("scope").withArray("biomes").get(0).asText());
    }

    @Test void appliesVerifiedUnityEulerOrder() {
        double[][] rotation = ScenePackage.rotation(0, 90, 0);
        assertEquals(0, rotation[0][0], 1e-9);
        assertEquals(1, rotation[0][2], 1e-9);
        assertEquals(1, rotation[1][1], 1e-9);
        assertEquals(-1, rotation[2][0], 1e-9);
        assertEquals(0, rotation[2][2], 1e-9);

        double[][] combined = ScenePackage.rotation(90, 90, 0);
        assertArrayEquals(new double[] {0, 1, 0}, combined[0], 1e-9);
        assertArrayEquals(new double[] {0, 0, -1}, combined[1], 1e-9);
        assertArrayEquals(new double[] {-1, 0, 0}, combined[2], 1e-9);
    }

    @Test void suppliesAUsefulDenseHomeFrameForWidelySeparatedElevation() throws Exception {
        Path cache = temporary.resolve("home-frame.duckdb");
        createFixture(cache, 0);
        try (var connection = DriverManager.getConnection("jdbc:duckdb:" + cache);
             var statement = connection.createStatement()) {
            statement.executeUpdate("INSERT INTO zdo SELECT 7, 1000 + i::BIGINT, " +
                "(i % 10)::DOUBLE, 0, floor(i / 10)::DOUBLE, 'piece_wall', 1, " +
                "'BUILDING', 'meadows', false, 0, 0, 0 FROM range(100) rows(i)");
            statement.executeUpdate("INSERT INTO zdo VALUES " +
                "(7,9999,1000,5000,1000,'piece_wall',1,'BUILDING','meadows',false,0,0,0)");
        }
        ObjectMapper mapper = new ObjectMapper();
        ScenePackage scenes = new ScenePackage(
            new SnapshotRepository(cache, new LensRegistry(), mapper, true), mapper);

        ScenePackage.Result result = scenes.build(
            7, "build-density", -10, 1100, -10, 1100, List.of(), false, "test");
        var home = result.manifest().path("home");
        assertEquals("densest-cluster", home.path("strategy").asText());
        assertTrue(home.path("pieces").asInt() >= 100);
        assertTrue(home.path("pieces").asInt() < result.pieces());
        assertTrue(home.path("radiusM").asDouble() < 100);
        assertEquals(3, home.withArray("target").size());
    }

    @Test void enforcesDirectAndForcedExactCapsBeforeEncoding() throws Exception {
        Path cache = temporary.resolve("confirmable.duckdb");
        createFixture(cache, ScenePackage.DIRECT_LIMIT + 1);
        ObjectMapper mapper = new ObjectMapper();
        ScenePackage scenes = new ScenePackage(
            new SnapshotRepository(cache, new LensRegistry(), mapper, true), mapper);

        ScenePackage.CapacityException direct = assertThrows(ScenePackage.CapacityException.class,
            () -> scenes.build(7, "build-density", -1, 300, -1, 1, List.of(), false, "test"));
        assertTrue(direct.overrideAvailable());
        ScenePackage.Result confirmed = scenes.build(
            7, "build-density", -1, 300, -1, 1, List.of(), true, "test");
        assertEquals(ScenePackage.DIRECT_LIMIT + 1, confirmed.pieces());
        assertTrue(confirmed.manifest().path("forced").asBoolean());

        Path overLimitCache = temporary.resolve("over-limit.duckdb");
        createFixture(overLimitCache, ScenePackage.OVERRIDE_LIMIT + 1);
        ScenePackage overLimitScenes = new ScenePackage(
            new SnapshotRepository(overLimitCache, new LensRegistry(), mapper, true), mapper);
        ScenePackage.CapacityException forced = assertThrows(ScenePackage.CapacityException.class,
            () -> overLimitScenes.build(7, "build-density", -1, 300, -1, 1, List.of(), true, "test"));
        assertFalse(forced.overrideAvailable());
    }

    private static void createFixture(Path cache, int generatedRows) throws Exception {
        try (var connection = DriverManager.getConnection("jdbc:duckdb:" + cache);
             var statement = connection.createStatement()) {
            statement.executeUpdate("CREATE TABLE zdo (snapshot_id BIGINT, zdo_index BIGINT, " +
                "x DOUBLE, y DOUBLE, z DOUBLE, prefab_name VARCHAR, prefab_hash INTEGER, " +
                "category VARCHAR, biome VARCHAR, has_rot BOOLEAN, rot_x DOUBLE, rot_y DOUBLE, rot_z DOUBLE)");
            statement.executeUpdate("CREATE TABLE prefab_geometry (prefab_hash INTEGER PRIMARY KEY, " +
                "prefab_name VARCHAR, family VARCHAR, geometry_source VARCHAR, extent_x DOUBLE, " +
                "extent_y DOUBLE, extent_z DOUBLE, center_x DOUBLE, center_y DOUBLE, center_z DOUBLE)");
            statement.executeUpdate("CREATE TABLE release_metadata (snapshot_hash VARCHAR, " +
                "building_geometry_sha256 VARCHAR, piece_geometry_sha256 VARCHAR)");
            statement.executeUpdate("INSERT INTO release_metadata VALUES ('" + "a".repeat(64) +
                "','" + "b".repeat(64) + "','" + "c".repeat(64) + "')");
            statement.executeUpdate("INSERT INTO prefab_geometry VALUES " +
                "(1,'piece_wall','wall','mesh',2,4,.2,.5,2,0)," +
                "(2,'piece_roof','roof','family_median',4,1,3,0,.5,0)," +
                "(3,'PineTree','misc','mesh',94.35,212.95,89.57,0,106.48,0)");
            if (generatedRows > 0) {
                statement.executeUpdate("INSERT INTO zdo SELECT 7, i::BIGINT, i*.001, 0, 0, " +
                    "'piece_wall', 1, 'BUILDING', 'meadows', false, 0, 0, 0 " +
                    "FROM range(" + generatedRows + ") rows(i)");
            } else {
                statement.executeUpdate("INSERT INTO zdo VALUES " +
                    "(7,10,0,2,0,'piece_wall',1,'BUILDING','meadows',true,0,90,0)," +
                    "(7,11,4,3,1,'piece_roof',2,'BUILDING','other',false,0,0,0)," +
                    "(7,12,-3,1,-2,'mystery',99,'BUILDING','meadows',true,15,20,25)," +
                    "(7,13,2,0,-4,'PineTree',3,'BUILDING','meadows',false,0,0,0)");
            }
        }
    }
}
