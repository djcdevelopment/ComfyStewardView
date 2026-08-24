package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.javalin.Javalin;
import io.javalin.http.Context;
import io.javalin.http.Header;
import io.javalin.http.HttpStatus;

import java.io.FileInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

public final class LabServer {
    private final LabConfig config;
    private final SnapshotRepository snapshots;
    private final ArtifactStore artifacts;
    private final LensRegistry lenses;
    private final JobManager jobs;
    private final ObjectMapper mapper;
    private final Javalin app;

    public LabServer(LabConfig config, SnapshotRepository snapshots, ArtifactStore artifacts,
            LensRegistry lenses, JobManager jobs, ObjectMapper mapper) {
        this.config = config;
        this.snapshots = snapshots;
        this.artifacts = artifacts;
        this.lenses = lenses;
        this.jobs = jobs;
        this.mapper = mapper;
        this.app = Javalin.create(javalin -> {
            javalin.staticFiles.add("/static");
            javalin.http.defaultContentType = "application/json";
            javalin.bundledPlugins.enableCors(cors -> cors.addRule(rule -> rule.anyHost()));
        });
        routes();
    }

    public void start() {
        app.start("127.0.0.1", config.port());
    }

    public void stop() {
        app.stop();
    }

    private void routes() {
        app.before(ctx -> ctx.header(Header.CACHE_CONTROL, "no-store"));
        app.get("/api/health", ctx -> ctx.json(Map.of("status", "ready")));
        app.get("/api/bootstrap", this::bootstrap);
        app.get("/api/manifest", this::manifest);
        app.get("/api/artifacts/{snapshot}/{file}", this::artifact);
        app.get("/api/context", this::contextImage);
        app.get("/api/selection", this::selection);
        app.get("/api/points", this::points);
        app.get("/api/jobs", ctx -> ctx.json(jobs.jobsJson()));
        app.get("/api/jobs/{id}", ctx -> ctx.json(jobs.require(ctx.pathParam("id")).toJson(mapper)));
        app.post("/api/jobs/render", this::submitRender);
        app.post("/api/jobs/{id}/cancel", ctx -> {
            LabJob job = jobs.require(ctx.pathParam("id"));
            job.cancel();
            ctx.json(job.toJson(mapper));
        });

        app.exception(IllegalArgumentException.class, (error, ctx) ->
            apiError(ctx, HttpStatus.BAD_REQUEST, error.getMessage()));
        app.exception(Exception.class, (error, ctx) ->
            apiError(ctx, HttpStatus.INTERNAL_SERVER_ERROR,
                error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage()));
    }

    private void bootstrap(Context ctx) throws Exception {
        ObjectNode result = mapper.createObjectNode();
        result.put("cacheAvailable", snapshots.available());
        result.put("cachePath", snapshots.cachePath().toString());
        result.put("cacheBytes", snapshots.available() ? Files.size(snapshots.cachePath()) : 0);
        result.put("artifactPath", artifacts.root().toString());
        result.put("contextAvailable", config.contextImage() != null);
        result.put("contextLabel", config.contextImage() == null
            ? "Inferred land mask" : config.contextImage().getFileName().toString());
        result.put("contextAuthoritative", config.contextImage() != null);
        ObjectNode bounds = result.putObject("worldBounds");
        bounds.put("minX", WorldBounds.VALHEIM.minX());
        bounds.put("maxX", WorldBounds.VALHEIM.maxX());
        bounds.put("minZ", WorldBounds.VALHEIM.minZ());
        bounds.put("maxZ", WorldBounds.VALHEIM.maxZ());
        ArrayNode sizes = result.putArray("allowedResolutions");
        LabConfig.ALLOWED_RESOLUTIONS.forEach(sizes::add);
        result.set("lenses", lenses.publicJson(mapper));
        ArrayNode snapshotNodes = result.putArray("snapshots");
        if (snapshots.available()) {
            for (SnapshotRepository.Snapshot snapshot : snapshots.snapshots()) {
                snapshotNodes.add(snapshot.toJson(mapper));
            }
        }
        result.set("jobs", jobs.jobsJson());
        ctx.json(result);
    }

    private void manifest(Context ctx) throws Exception {
        long snapshotId = longQuery(ctx, "snapshot", true);
        ObjectNode manifest = artifacts.readManifest(snapshotId);
        if (manifest == null) {
            apiError(ctx, HttpStatus.NOT_FOUND,
                "No lab rasters exist for snapshot #" + snapshotId + ". Render a lens ladder.");
            return;
        }
        ctx.json(manifest);
    }

    private void artifact(Context ctx) throws Exception {
        long snapshotId = Long.parseLong(ctx.pathParam("snapshot"));
        Path file = artifacts.resolveArtifact(snapshotId, ctx.pathParam("file"));
        if (!Files.isRegularFile(file)) {
            apiError(ctx, HttpStatus.NOT_FOUND, "Artifact not found");
            return;
        }
        ctx.contentType("image/png");
        ctx.result(new FileInputStream(file.toFile()));
    }

    private void contextImage(Context ctx) throws Exception {
        if (config.contextImage() == null) {
            apiError(ctx, HttpStatus.NOT_FOUND, "No authoritative context image configured");
            return;
        }
        String name = config.contextImage().getFileName().toString().toLowerCase();
        ctx.contentType(name.endsWith(".jpg") || name.endsWith(".jpeg") ? "image/jpeg" : "image/png");
        ctx.result(new FileInputStream(config.contextImage().toFile()));
    }

    private void selection(Context ctx) throws Exception {
        long snapshot = longQuery(ctx, "snapshot", true);
        String lens = requiredQuery(ctx, "lens");
        ctx.json(snapshots.selection(snapshot, lens,
            doubleQuery(ctx, "minX"), doubleQuery(ctx, "maxX"),
            doubleQuery(ctx, "minZ"), doubleQuery(ctx, "maxZ"),
            (int) longQuery(ctx, "topN", false, 12)));
    }

    private void points(Context ctx) throws Exception {
        long snapshot = longQuery(ctx, "snapshot", true);
        String lens = requiredQuery(ctx, "lens");
        ctx.json(snapshots.exactPoints(snapshot, lens,
            doubleQuery(ctx, "minX"), doubleQuery(ctx, "maxX"),
            doubleQuery(ctx, "minZ"), doubleQuery(ctx, "maxZ"),
            (int) longQuery(ctx, "limit", false, 5000)));
    }

    private void submitRender(Context ctx) throws Exception {
        LabJob.RenderRequest request = ctx.bodyAsClass(LabJob.RenderRequest.class).normalized();
        if (request.snapshotId() <= 0) throw new IllegalArgumentException("snapshotId is required");
        for (String id : request.lensIds()) lenses.require(id);
        for (int size : request.resolutions()) {
            if (!LabConfig.ALLOWED_RESOLUTIONS.contains(size)) {
                throw new IllegalArgumentException("Unsupported resolution: " + size);
            }
        }
        LabJob job = jobs.submit(request);
        ctx.status(HttpStatus.ACCEPTED).json(job.toJson(mapper));
    }

    private static String requiredQuery(Context ctx, String name) {
        String value = ctx.queryParam(name);
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
        return value;
    }

    private static double doubleQuery(Context ctx, String name) {
        try { return Double.parseDouble(requiredQuery(ctx, name)); }
        catch (NumberFormatException error) { throw new IllegalArgumentException(name + " must be numeric"); }
    }

    private static long longQuery(Context ctx, String name, boolean required) {
        return longQuery(ctx, name, required, 0);
    }

    private static long longQuery(Context ctx, String name, boolean required, long fallback) {
        String raw = ctx.queryParam(name);
        if (raw == null || raw.isBlank()) {
            if (required) throw new IllegalArgumentException(name + " is required");
            return fallback;
        }
        try { return Long.parseLong(raw); }
        catch (NumberFormatException error) { throw new IllegalArgumentException(name + " must be an integer"); }
    }

    private static void apiError(Context ctx, HttpStatus status, String message) {
        ctx.status(status).json(Map.of("error", message == null ? "Unknown error" : message));
    }
}
