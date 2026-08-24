package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.awt.Desktop;
import java.net.URI;
import java.nio.file.Files;
import java.util.List;

public final class LabMain {
    private static final Logger log = LoggerFactory.getLogger(LabMain.class);

    public static void main(String[] args) throws Exception {
        LabConfig config = LabConfig.parse(args);
        ObjectMapper mapper = new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT);
        LensRegistry lenses = new LensRegistry();
        SnapshotRepository snapshots = new SnapshotRepository(config.cachePath(), lenses, mapper);
        ArtifactStore artifacts = new ArtifactStore(config.artifactsPath(), mapper);
        LensRenderer renderer = new LensRenderer(snapshots, artifacts, lenses, mapper);

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

        JobManager jobs = new JobManager(renderer, mapper);
        LabServer server = new LabServer(config, snapshots, artifacts, lenses, jobs, mapper);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            server.stop();
            jobs.close();
        }, "spatial-lab-shutdown"));
        server.start();
        String url = "http://127.0.0.1:" + config.port();
        log.info("Steward Spatial Lab ready at {}", url);
        log.info("Cache: {} ({})", config.cachePath(),
            Files.isRegularFile(config.cachePath()) ? "available" : "missing");
        log.info("Artifacts: {}", config.artifactsPath());
        if (!config.noBrowser() && Desktop.isDesktopSupported()) {
            try { Desktop.getDesktop().browse(URI.create(url)); }
            catch (Exception error) { log.warn("Could not open browser: {}", error.getMessage()); }
        }
    }
}
