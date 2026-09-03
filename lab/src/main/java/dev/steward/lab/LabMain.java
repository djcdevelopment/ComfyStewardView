package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.awt.Desktop;
import java.net.URI;
import java.nio.file.Files;

public final class LabMain {
    private static final Logger log = LoggerFactory.getLogger(LabMain.class);

    public static void main(String[] args) throws Exception {
        LabConfig config = LabConfig.parse(args);
        ObjectMapper mapper = new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT);
        LensRegistry lenses = new LensRegistry();
        SnapshotRepository snapshots = new SnapshotRepository(
            config.cachePath(), lenses, mapper, config.publicMode());
        ArtifactStore artifacts = new ArtifactStore(config.artifactsPath(), mapper);
        LensRenderer renderer = new LensRenderer(snapshots, artifacts, lenses, mapper);
        TerrainContext terrainContext = null;

        if (config.contextManifest() != null) {
            ObjectNode artifactManifest = config.snapshotId() > 0
                ? artifacts.readManifest(config.snapshotId()) : null;
            String expectedHash = artifactManifest == null ? "" :
                artifactManifest.path("snapshot").path("fileHash").asText("");
            String expectedWorld = artifactManifest == null ? "" :
                artifactManifest.path("snapshot").path("worldId").asText("");
            terrainContext = TerrainContext.load(config.contextManifest(), mapper,
                config.snapshotId(), expectedHash, expectedWorld);
        }

        if ("render".equals(config.mode())) {
            if (!snapshots.available()) {
                throw new IllegalArgumentException("Analytics cache not found: " + config.cachePath());
            }
            long snapshotId = config.snapshotId() > 0
                ? config.snapshotId() : snapshots.latestSnapshotId();
            try (JobManager jobs = new JobManager(renderer, mapper)) {
                LabJob job = jobs.runBlocking(new LabJob.RenderRequest(snapshotId,
                    config.lensIds(), config.resolutions(), config.force(), 0, 0));
                System.out.println(mapper.writeValueAsString(job.toJson(mapper)));
                if (job.status() != LabJob.Status.COMPLETE) System.exit(1);
            }
            return;
        }

        if (config.publicMode()) {
            config.feedback().validateForPublic();
            if (!snapshots.available()) {
                throw new IllegalArgumentException("Public cache not found: " + config.cachePath());
            }
            snapshots.requireSnapshot(config.snapshotId());
            if (artifacts.readManifest(config.snapshotId()) == null) {
                throw new IllegalArgumentException("Public artifacts are missing for snapshot #" + config.snapshotId());
            }
            if (terrainContext == null) {
                throw new IllegalArgumentException("Public mode requires --context-manifest");
            }
            snapshots.validatePublicRelease(terrainContext);
            lenses.require("build-density");
        }

        JobManager jobs = new JobManager(renderer, mapper);
        LabServer server = new LabServer(config, snapshots, artifacts, lenses, jobs, mapper, terrainContext);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            server.stop();
            jobs.close();
        }, "spatial-lab-shutdown"));
        server.start();
        String url = config.publicMode() ? config.publicUrl() : "http://127.0.0.1:" + config.port();
        log.info("Steward Spatial Lab ready at {}", url);
        log.info("Experience: {}", config.publicMode() ? "public Era 17 view" : "local lab");
        log.info("Cache: {} ({})", config.cachePath(),
            Files.isRegularFile(config.cachePath()) ? "available" : "missing");
        log.info("Artifacts: {}", config.artifactsPath());
        if (!config.noBrowser() && Desktop.isDesktopSupported()) {
            try { Desktop.getDesktop().browse(URI.create(url)); }
            catch (Exception error) { log.warn("Could not open browser: {}", error.getMessage()); }
        }
    }
}
