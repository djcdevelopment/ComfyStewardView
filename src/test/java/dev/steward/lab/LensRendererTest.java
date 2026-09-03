package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class LensRendererTest {
    @TempDir Path temporary;

    @BeforeAll static void driver() throws Exception {
        Class.forName("org.duckdb.DuckDBDriver");
    }

    @Test void rendersCustomLensAndExplainsASelection() throws Exception {
        Path cache = temporary.resolve("fixture.duckdb");
        createFixture(cache);
        ObjectMapper mapper = new ObjectMapper();
        LensRegistry lenses = new LensRegistry();
        SnapshotRepository repository = new SnapshotRepository(cache, lenses, mapper);
        ArtifactStore artifacts = new ArtifactStore(temporary.resolve("artifacts"), mapper);
        LensRenderer renderer = new LensRenderer(repository, artifacts, lenses, mapper);

        try (JobManager jobs = new JobManager(renderer, mapper)) {
            LabJob job = jobs.runBlocking(new LabJob.RenderRequest(
                7, List.of("birch-trees"), List.of(320), true, 0, 0));
            assertEquals(LabJob.Status.COMPLETE, job.status());
            ObjectNode created = job.toJson(mapper);
            assertEquals(1, created.path("metrics").path("createdLayers").asInt());
            assertEquals(0, created.path("metrics").path("cacheHits").asInt());

            LabJob cachedJob = jobs.runBlocking(new LabJob.RenderRequest(
                7, List.of("birch-trees"), List.of(320), false, 0, 0));
            assertEquals(LabJob.Status.COMPLETE, cachedJob.status());
            ObjectNode cached = cachedJob.toJson(mapper);
            assertEquals(0, cached.path("metrics").path("createdLayers").asInt());
            assertEquals(1, cached.path("metrics").path("cacheHits").asInt());
        }

        ObjectNode manifest = artifacts.readManifest(7);
        assertNotNull(manifest);
        ObjectNode layer = artifacts.findLayer(manifest, "birch-trees", 320);
        assertNotNull(layer);
        assertEquals(3, layer.path("totalValue").asInt());
        assertEquals(2, layer.path("cellCount").asInt());
        assertEquals(166, layer.path("width").asInt());
        assertEquals(150, layer.path("height").asInt());

        BufferedImage image = ImageIO.read(artifacts.resolveArtifact(7, layer.path("file").asText()).toFile());
        assertEquals(166, image.getWidth());
        assertEquals(150, image.getHeight());

        ObjectNode selection = repository.selection(7, "birch-trees", -200, 500, -200, 500, 10);
        assertEquals(3, selection.path("total").asInt());
        assertEquals(3, selection.path("worldTotal").asInt());
        assertEquals(3, selection.path("positionCount").asInt());
        assertEquals(2, selection.path("categoryCount").asInt());
        assertEquals(2, selection.path("returnedCategories").asInt());
        assertTrue(selection.path("completeCategories").asBoolean());
        assertEquals("Birch1", selection.withArray("top").get(0).path("label").asText());

        ObjectNode preview = repository.selection(7, "birch-trees", -200, 500, -200, 500, 1);
        assertEquals(2, preview.path("categoryCount").asInt());
        assertEquals(1, preview.path("returnedCategories").asInt());
        assertFalse(preview.path("completeCategories").asBoolean());

        ObjectNode allCategories = repository.selection(7, "birch-trees", -200, 500, -200, 500, 0);
        assertEquals(2, allCategories.withArray("top").size());
        assertTrue(allCategories.path("completeCategories").asBoolean());

        ObjectNode coins = repository.selection(7, "coins", -200, 500, -200, 500, 10);
        assertEquals(25, coins.path("total").asInt());
        assertEquals(1, coins.path("positionCount").asInt(),
            "Value lenses use drawable positions, not summed units, for the point budget");

        ObjectNode points = repository.exactPoints(7, "birch-trees", -200, 500, -200, 500, 20);
        assertEquals(3, points.withArray("points").size());
        assertFalse(points.path("truncated").asBoolean());

        ObjectNode dense = repository.exactPoints(7, "birch-trees", -200, 500, -200, 500, 2);
        assertTrue(dense.path("truncated").asBoolean());
        assertEquals(3, dense.path("minimumCount").asInt());
        assertEquals(0, dense.withArray("points").size(),
            "A database-order prefix would imply false spatial coverage");

        ObjectNode meadows = repository.selection(
            7, "birch-trees", -200, 500, -200, 500, 10, List.of("meadows"));
        assertEquals(2, meadows.path("total").asInt());
        assertEquals("meadows", meadows.withArray("biomes").get(0).asText());

        ObjectNode sampled = repository.samplePoints(
            7, "birch-trees", -200, 500, -200, 500, 2, List.of());
        assertTrue(sampled.path("sampled").asBoolean());
        assertEquals(3, sampled.path("total").asInt());
        assertEquals(2, sampled.withArray("points").size());

        ObjectNode firstPage = repository.items(
            7, "birch-trees", -200, 500, -200, 500, 2, null, List.of());
        assertEquals(3, firstPage.path("total").asInt());
        assertEquals(2, firstPage.withArray("items").size());
        assertTrue(firstPage.path("hasMore").asBoolean());
        ObjectNode secondPage = repository.items(7, "birch-trees", -200, 500, -200, 500,
            2, firstPage.path("nextCursor").asText(), List.of());
        assertEquals(1, secondPage.withArray("items").size());
        assertFalse(secondPage.path("hasMore").asBoolean());
        assertNotEquals(firstPage.withArray("items").get(0).path("x").asDouble(),
            secondPage.withArray("items").get(0).path("x").asDouble());
    }

    @Test void failureInjectionLeavesAnObservableFailedJob() throws Exception {
        Path cache = temporary.resolve("failure.duckdb");
        createFixture(cache);
        ObjectMapper mapper = new ObjectMapper();
        LensRegistry lenses = new LensRegistry();
        SnapshotRepository repository = new SnapshotRepository(cache, lenses, mapper);
        ArtifactStore artifacts = new ArtifactStore(temporary.resolve("failed-artifacts"), mapper);
        LensRenderer renderer = new LensRenderer(repository, artifacts, lenses, mapper);

        try (JobManager jobs = new JobManager(renderer, mapper)) {
            LabJob job = jobs.runBlocking(new LabJob.RenderRequest(
                7, List.of("birch-trees"), List.of(320), true, 0, 1));
            assertEquals(LabJob.Status.FAILED, job.status());
            assertTrue(job.toJson(mapper).path("error").asText().contains("Injected lab failure"));
            assertEquals(1, job.toJson(mapper).path("completedUnits").asInt());
        }
    }

    @Test void artifactStoreRejectsTraversal() throws Exception {
        ArtifactStore artifacts = new ArtifactStore(temporary.resolve("safe"), new ObjectMapper());
        assertThrows(IllegalArgumentException.class,
            () -> artifacts.resolveArtifact(7, "../outside.png"));
    }

    private static void createFixture(Path cache) throws Exception {
        try (var connection = DriverManager.getConnection("jdbc:duckdb:" + cache);
             var statement = connection.createStatement()) {
            statement.executeUpdate("CREATE TABLE world_snapshot (" +
                "snapshot_id BIGINT, world_id VARCHAR, world_name VARCHAR, source VARCHAR, " +
                "backup_id VARCHAR, parsed_at VARCHAR, file_hash VARCHAR, prefab_dictionary_version VARCHAR)");
            statement.executeUpdate("CREATE TABLE zdo (snapshot_id BIGINT, zdo_index BIGINT, prefab_hash INTEGER, " +
                "prefab_name VARCHAR, category VARCHAR, x DOUBLE, z DOUBLE, biome VARCHAR)");
            statement.executeUpdate("CREATE TABLE container_item (snapshot_id BIGINT, item_name VARCHAR, " +
                "stack INTEGER, container_x DOUBLE, container_z DOUBLE)");
            statement.executeUpdate("INSERT INTO world_snapshot VALUES " +
                "(7,'fixture','Fixture world','test','fixture-7','2026-08-23T00:00:00Z','abc','test')");
            statement.executeUpdate("INSERT INTO zdo VALUES " +
                "(7,0,1,'Birch1',NULL,0,0,'meadows')," +
                "(7,1,1,'Birch1',NULL,10,10,'meadows')," +
                "(7,2,2,'Birch2_aut',NULL,400,400,'other')," +
                "(7,3,3,'Beech1',NULL,20,20,'meadows')," +
                "(7,4,4,'piece_wood','BUILDING',25,25,'meadows')");
            statement.executeUpdate("INSERT INTO container_item VALUES (7,'Coins',25,30,30)");
        }
    }
}
