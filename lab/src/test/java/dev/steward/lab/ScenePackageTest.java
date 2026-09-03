package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
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
        assertEquals(2, header.getInt());
        int manifestLength = header.getInt();
        int instanceOffset = header.getInt();
        assertEquals(0, instanceOffset % 4);
        assertEquals(5, first.renderInstances());
        assertEquals(5 * ScenePackage.INSTANCE_STRIDE, first.bytes().length - instanceOffset);
        assertTrue(manifestLength > 0);

        ObjectNode manifest = first.manifest();
        assertEquals("steward-zdo-scene/v2", manifest.path("schema").asText());
        assertTrue(manifest.path("exact").asBoolean());
        assertFalse(manifest.path("forced").asBoolean());
        assertEquals(5, manifest.path("renderInstances").asInt());
        assertEquals(1, manifest.path("representationQuality").path("runtimeCompoundProxy").asInt());
        assertEquals(1, manifest.path("representationQuality").path("contextMarkers").asInt());
        assertEquals(1, manifest.path("representationQuality").path("hiddenContextPieces").asInt());
        assertEquals(2, manifest.path("representationQuality").path("pivotMarker").asInt());
        assertEquals(1, manifest.path("representationQuality").path("outlierMarkers").asInt());
        assertEquals(4, manifest.withArray("drawGroups").size());
        int expectedStart = 0;
        boolean foundHiddenContext = false;
        for (var group : manifest.withArray("drawGroups")) {
            assertEquals(expectedStart, group.path("start").asInt());
            expectedStart += group.path("count").asInt();
            if ("context".equals(group.path("name").asText())) {
                foundHiddenContext = true;
                assertFalse(group.path("defaultVisible").asBoolean());
                assertEquals(1, group.path("pieces").asInt());
            }
        }
        assertTrue(foundHiddenContext);
        assertEquals(first.renderInstances(), expectedStart);
        assertEquals("d".repeat(64), manifest.path("representationCatalogSha256").asText());
        assertEquals("e".repeat(64), manifest.path("promotionReceiptSha256").asText());
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

    @Test void hiddenContextDoesNotChangeTheInitialHomeFrame() throws Exception {
        Path cache = temporary.resolve("hidden-context-frame.duckdb");
        createFixture(cache, 0);
        try (var connection = DriverManager.getConnection("jdbc:duckdb:" + cache);
             var statement = connection.createStatement()) {
            statement.executeUpdate("UPDATE zdo SET x=900 WHERE zdo_index=11");
        }
        ObjectMapper mapper = new ObjectMapper();
        ScenePackage scenes = new ScenePackage(
            new SnapshotRepository(cache, new LensRegistry(), mapper, true), mapper);

        ScenePackage.Result result = scenes.build(
            7, "build-density", -1000, 1000, -10, 10, List.of(), false, "test");

        var home = result.manifest().path("home");
        assertEquals("selection-all", home.path("strategy").asText());
        assertEquals(3, home.path("pieces").asInt());
        assertTrue(home.path("radiusM").asDouble() < 200,
            "the distant hidden marker must not zoom the starting camera out");
        assertTrue(result.manifest().path("radiusM").asDouble() > 800,
            "Frame all still covers the complete presentation when context is enabled");
    }

    @Test void localRndCandidateCanBeComparedWithoutChangingPublicRepresentation() throws Exception {
        Path cache = temporary.resolve("rnd-candidate.duckdb");
        createFixture(cache, 0);
        Path receipt = Files.writeString(temporary.resolve("renderer-candidate.json"), """
            {"schema":"steward-prefab-renderers/v1","prefabs":[{
              "name":"PineTree","hash":3,"status":"candidate","boxCount":1,
              "animationAxis":"z","animationPivot":[0,0,0],"boxes":[{
                "path":"high","animated":false,
                "matrix":[2,0,0,0,0,4,0,0,0,0,2,0,0,2,0,1]
              }]
            }]}
            """);
        ObjectMapper mapper = new ObjectMapper();
        SnapshotRepository repository = new SnapshotRepository(cache, new LensRegistry(), mapper, true);

        ScenePackage.Result publicResult = new ScenePackage(repository, mapper).build(
            7, "build-density", -10, 10, -10, 10, List.of(), false, "test");
        ScenePackage.Result rndResult = new ScenePackage(repository, mapper, receipt).build(
            7, "build-density", -10, 10, -10, 10, List.of(), false, "test", "candidate", true);

        assertEquals(1, publicResult.manifest().path("representationQuality").path("outlierMarkers").asInt());
        assertEquals(2, rndResult.manifest().path("representationQuality").path("runtimeCompoundProxy").asInt());
        assertTrue(rndResult.manifest().path("rndCandidate").asBoolean());
        assertEquals(64, rndResult.manifest().path("rndCandidateSha256").asText().length());
        assertTrue(rndResult.manifest().withArray("drawGroups").findValuesAsText("name").contains("PineTree"));
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

    @Test void collapsesCompoundPresentationAtInstanceBudgetWithoutDroppingMembership() throws Exception {
        Path cache = temporary.resolve("instance-budget.duckdb");
        int pieces = 20_000;
        createFixture(cache, pieces);
        try (var connection = DriverManager.getConnection("jdbc:duckdb:" + cache);
             var statement = connection.createStatement()) {
            statement.executeUpdate("UPDATE prefab_representation SET primitive_count=32 WHERE prefab_hash=1");
            statement.executeUpdate("INSERT INTO prefab_representation_primitive " +
                "SELECT 1, ordinal, false, .2,0,0,0, 0,.2,0,0, 0,0,.2,0, " +
                "ordinal*.25,1,0,1 FROM range(2,32) rows(ordinal)");
        }
        ObjectMapper mapper = new ObjectMapper();
        ScenePackage scenes = new ScenePackage(
            new SnapshotRepository(cache, new LensRegistry(), mapper, true), mapper);

        ScenePackage.Result result = scenes.build(
            7, "build-density", -1, 300, -1, 1, List.of(), true, "test");

        assertEquals(pieces, result.pieces(), "the exact ZDO membership remains intact");
        assertEquals(pieces, result.renderInstances(), "each over-budget compound becomes one marker");
        assertEquals(pieces,
            result.manifest().path("representationQuality").path("compoundBudgetMarkers").asInt());
        assertEquals(0,
            result.manifest().path("representationQuality").path("unresolvedCompoundMarkers").asInt());
        assertEquals(pieces,
            result.manifest().withArray("drawGroups").get(0).path("pieces").asInt());
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
            statement.executeUpdate("CREATE TABLE prefab_representation (prefab_hash INTEGER PRIMARY KEY, " +
                "prefab_name VARCHAR, semantic_class VARCHAR, strategy VARCHAR, authority VARCHAR, " +
                "default_visible BOOLEAN, marker_axis DOUBLE, primitive_count INTEGER, animation_axis VARCHAR, " +
                "animation_pivot_x DOUBLE, animation_pivot_y DOUBLE, animation_pivot_z DOUBLE)");
            statement.executeUpdate("CREATE TABLE prefab_representation_primitive (prefab_hash INTEGER, " +
                "ordinal INTEGER, animated BOOLEAN, m00 DOUBLE, m01 DOUBLE, m02 DOUBLE, m03 DOUBLE, " +
                "m10 DOUBLE, m11 DOUBLE, m12 DOUBLE, m13 DOUBLE, m20 DOUBLE, m21 DOUBLE, m22 DOUBLE, " +
                "m23 DOUBLE, m30 DOUBLE, m31 DOUBLE, m32 DOUBLE, m33 DOUBLE)");
            statement.executeUpdate("CREATE TABLE release_metadata (snapshot_hash VARCHAR, " +
                "building_geometry_sha256 VARCHAR, piece_geometry_sha256 VARCHAR, " +
                "representation_catalog_sha256 VARCHAR, promotion_receipt_sha256 VARCHAR)");
            statement.executeUpdate("INSERT INTO release_metadata VALUES ('" + "a".repeat(64) +
                "','" + "b".repeat(64) + "','" + "c".repeat(64) + "','" +
                "d".repeat(64) + "','" + "e".repeat(64) + "')");
            statement.executeUpdate("INSERT INTO prefab_geometry VALUES " +
                "(1,'piece_wall','wall','mesh',2,4,.2,.5,2,0)," +
                "(2,'piece_roof','roof','family_median',4,1,3,0,.5,0)," +
                "(3,'PineTree','misc','mesh',94.35,212.95,89.57,0,106.48,0)");
            statement.executeUpdate("INSERT INTO prefab_representation VALUES " +
                "(1,'piece_wall','structure','runtime-compound','test-runtime',true,.35,2,'z',0,1,0)," +
                "(2,'piece_roof','context','pivot-marker','test-exact-name',false,.22,0,NULL,0,0,0)");
            statement.executeUpdate("INSERT INTO prefab_representation_primitive VALUES " +
                "(1,0,false,2,0,0,0,0,4,0,0,0,0,.2,0,.5,2,0,1)," +
                "(1,1,true,.2,0,0,0,0,.2,0,0,0,0,3,0,0,4,0,1)");
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
