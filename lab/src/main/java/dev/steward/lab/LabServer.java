package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.javalin.Javalin;
import io.javalin.http.Context;
import io.javalin.http.Header;
import io.javalin.http.HttpStatus;
import io.javalin.http.staticfiles.Location;

import java.io.FileInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Semaphore;

public final class LabServer {
    private final LabConfig config;
    private final SnapshotRepository snapshots;
    private final ArtifactStore artifacts;
    private final LensRegistry lenses;
    private final JobManager jobs;
    private final ObjectMapper mapper;
    private final TerrainContext terrainContext;
    private final DiscordFeedbackService feedback;
    private final ScenePackage scenes;
    private final SlidingWindowRateLimiter queryRate = new SlidingWindowRateLimiter(30, Duration.ofMinutes(1));
    private final SlidingWindowRateLimiter sceneRate = new SlidingWindowRateLimiter(6, Duration.ofMinutes(1));
    private final SlidingWindowRateLimiter feedbackRate = new SlidingWindowRateLimiter(3, Duration.ofMinutes(10));
    private final Semaphore querySlots = new Semaphore(2);
    private final Semaphore sceneSlots = new Semaphore(1);
    private final Javalin app;

    public LabServer(LabConfig config, SnapshotRepository snapshots, ArtifactStore artifacts,
            LensRegistry lenses, JobManager jobs, ObjectMapper mapper, TerrainContext terrainContext) {
        this.config = config;
        this.snapshots = snapshots;
        this.artifacts = artifacts;
        this.lenses = lenses;
        this.jobs = jobs;
        this.mapper = mapper;
        this.terrainContext = terrainContext;
        this.feedback = new DiscordFeedbackService(config.feedback(), mapper);
        this.scenes = new ScenePackage(snapshots, mapper);
        this.app = Javalin.create(javalin -> {
            javalin.staticFiles.add("/static");
            javalin.staticFiles.add(files -> {
                files.hostedPath = "/vendor/leaflet";
                files.directory = "/META-INF/resources/webjars/leaflet/1.9.4";
                files.location = Location.CLASSPATH;
            });
            javalin.http.defaultContentType = "application/json";
            if (!config.publicMode()) {
                javalin.bundledPlugins.enableCors(cors -> cors.addRule(rule -> rule.anyHost()));
            }
        });
        routes();
    }

    public void start() {
        app.start(config.bindAddress(), config.port());
    }

    public void stop() {
        app.stop();
    }

    private void routes() {
        app.before(this::securityHeaders);
        app.get("/api/health", ctx -> ctx.json(Map.of(
            "status", "ready",
            "publicMode", config.publicMode(),
            "release", config.releaseVersion(),
            "context", terrainContext == null ? "fallback" : "ready",
            "contextSnapshot", terrainContext == null ? 0 : terrainContext.snapshotId())));
        app.get("/api/bootstrap", this::bootstrap);
        app.get("/api/manifest", this::manifest);
        app.get("/api/artifacts/{snapshot}/{file}", this::artifact);
        app.get("/api/context", this::contextImage);
        app.get("/api/context/{variant}", this::contextVariant);
        app.get("/api/selection", ctx -> boundedQuery(ctx, this::selection));
        app.get("/api/points", ctx -> boundedQuery(ctx, this::points));
        app.get("/api/items", ctx -> boundedQuery(ctx, this::items));
        app.get("/api/scene", ctx -> sceneQuery(ctx, this::scene));
        if (config.publicMode()) {
            app.get("/api/auth/discord/start", this::startDiscordAuthorization);
            app.get("/api/auth/discord/callback", this::finishDiscordAuthorization);
            app.get("/api/auth/session", this::authSession);
            app.post("/api/auth/logout", this::logout);
            app.post("/api/feedback", this::submitFeedback);
        } else {
            app.get("/api/jobs", ctx -> ctx.json(jobs.jobsJson()));
            app.get("/api/jobs/{id}", ctx -> ctx.json(jobs.require(ctx.pathParam("id")).toJson(mapper)));
            app.post("/api/jobs/render", this::submitRender);
            app.post("/api/jobs/{id}/cancel", ctx -> {
                LabJob job = jobs.require(ctx.pathParam("id"));
                job.cancel();
                ctx.json(job.toJson(mapper));
            });
        }

        app.exception(DiscordFeedbackService.IdentityRequiredException.class, (error, ctx) ->
            apiError(ctx, HttpStatus.UNAUTHORIZED, error.getMessage()));
        app.exception(ScenePackage.CapacityException.class, (error, ctx) -> {
            ObjectNode body = mapper.createObjectNode();
            body.put("error", error.getMessage());
            body.put("overrideAvailable", error.overrideAvailable());
            ctx.status(error.overrideAvailable() ? HttpStatus.CONFLICT : HttpStatus.CONTENT_TOO_LARGE).json(body);
        });
        app.exception(IllegalArgumentException.class, (error, ctx) ->
            apiError(ctx, HttpStatus.BAD_REQUEST, error.getMessage()));
        app.exception(IllegalStateException.class, (error, ctx) ->
            apiError(ctx, HttpStatus.SERVICE_UNAVAILABLE, error.getMessage()));
        app.exception(Exception.class, (error, ctx) ->
            apiError(ctx, HttpStatus.INTERNAL_SERVER_ERROR,
                config.publicMode() ? "The request could not be completed" :
                    (error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage())));
    }

    private void bootstrap(Context ctx) throws Exception {
        ObjectNode result = mapper.createObjectNode();
        result.put("cacheAvailable", snapshots.available());
        result.put("cachePath", config.publicMode() ? "read-only Era 17 cache" : snapshots.cachePath().toString());
        result.put("cacheBytes", config.publicMode() ? 0 :
            (snapshots.available() ? Files.size(snapshots.cachePath()) : 0));
        result.put("cacheModifiedAt", snapshots.available()
            ? Files.getLastModifiedTime(snapshots.cachePath()).toInstant().toString() : "");
        result.put("artifactPath", config.publicMode() ? "prebuilt spatial artifacts" : artifacts.root().toString());
        result.put("publicMode", config.publicMode());
        result.put("releaseVersion", config.releaseVersion());
        result.put("feedbackEnabled", config.publicMode() && config.feedback().feedbackEnabled());
        result.put("discordIdentityEnabled", config.publicMode() && config.feedback().identityEnabled());
        result.put("sceneAvailable", config.publicMode());
        boolean suppliedContext = terrainContext != null || config.contextImage() != null;
        result.put("contextAvailable", suppliedContext);
        result.put("contextLabel", terrainContext != null
            ? "Terrain + water · snapshot #" + terrainContext.snapshotId()
            : config.contextImage() == null ? "Inferred land mask" : config.contextImage().getFileName().toString());
        result.put("contextAuthoritative", suppliedContext);
        if (terrainContext != null) {
            ObjectNode context = terrainContext.publicJson(mapper);
            if (snapshots.available()) {
                Map<String, Long> biomeCounts = snapshots.biomeCounts(config.publicMode()
                        ? config.snapshotId() : snapshots.latestSnapshotId(),
                    WorldBounds.VALHEIM.minX(), WorldBounds.VALHEIM.maxX(),
                    WorldBounds.VALHEIM.minZ(), WorldBounds.VALHEIM.maxZ());
                long publishedItemCount = 0;
                for (var biomeNode : context.path("biomes").path("catalog")) {
                    long itemCount = biomeCounts.getOrDefault(biomeNode.path("id").asText(), 0L);
                    ((ObjectNode) biomeNode).put("itemCount", itemCount);
                    publishedItemCount += itemCount;
                }
                context.put("publishedItemCount", publishedItemCount);
            }
            result.set("context", context);
        }
        ObjectNode bounds = result.putObject("worldBounds");
        bounds.put("minX", WorldBounds.VALHEIM.minX());
        bounds.put("maxX", WorldBounds.VALHEIM.maxX());
        bounds.put("minZ", WorldBounds.VALHEIM.minZ());
        bounds.put("maxZ", WorldBounds.VALHEIM.maxZ());
        ArrayNode sizes = result.putArray("allowedResolutions");
        LabConfig.ALLOWED_RESOLUTIONS.forEach(sizes::add);
        if (config.publicMode()) {
            ArrayNode publicLenses = result.putArray("lenses");
            publicLenses.add(lenses.require("build-density").publicJson(mapper));
        } else {
            result.set("lenses", lenses.publicJson(mapper));
        }
        ArrayNode snapshotNodes = result.putArray("snapshots");
        if (snapshots.available()) {
            ObjectNode publicManifest = config.publicMode()
                ? artifacts.readManifest(config.snapshotId()) : null;
            for (SnapshotRepository.Snapshot snapshot : snapshots.snapshots()) {
                if (!config.publicMode() || snapshot.snapshotId() == config.snapshotId()) {
                    ObjectNode node = snapshot.toJson(mapper);
                    if (publicManifest != null) {
                        long publishedCount = publicManifest.path("snapshot").path("zdoCount")
                            .asLong(snapshot.zdoCount());
                        node.put("zdoCount", publishedCount);
                    }
                    snapshotNodes.add(node);
                }
            }
        }
        result.set("jobs", config.publicMode() ? mapper.createArrayNode() : jobs.jobsJson());
        ctx.json(result);
    }

    private void manifest(Context ctx) throws Exception {
        long snapshotId = longQuery(ctx, "snapshot", true);
        enforcePublicScope(snapshotId, "build-density");
        ObjectNode manifest = artifacts.readManifest(snapshotId);
        if (manifest == null) {
            apiError(ctx, HttpStatus.NOT_FOUND,
                "No lab rasters exist for snapshot #" + snapshotId + ". Render a lens ladder.");
            return;
        }
        ctx.json(config.publicMode() ? publicManifest(manifest) : manifest);
    }

    private void artifact(Context ctx) throws Exception {
        long snapshotId = Long.parseLong(ctx.pathParam("snapshot"));
        if (config.publicMode() && snapshotId != config.snapshotId()) {
            apiError(ctx, HttpStatus.NOT_FOUND, "Artifact not found");
            return;
        }
        if (config.publicMode() && !isPublicArtifact(ctx.pathParam("file"))) {
            apiError(ctx, HttpStatus.NOT_FOUND, "Artifact not found");
            return;
        }
        Path file = artifacts.resolveArtifact(snapshotId, ctx.pathParam("file"));
        if (!Files.isRegularFile(file)) {
            apiError(ctx, HttpStatus.NOT_FOUND, "Artifact not found");
            return;
        }
        ctx.contentType("image/png");
        ctx.result(new FileInputStream(file.toFile()));
    }

    private ObjectNode publicManifest(ObjectNode source) {
        ObjectNode result = source.deepCopy();
        ArrayNode publicLenses = mapper.createArrayNode();
        source.withArray("lenses").forEach(node -> {
            if ("build-density".equals(node.path("id").asText())) publicLenses.add(node.deepCopy());
        });
        ArrayNode publicLayers = mapper.createArrayNode();
        source.withArray("layers").forEach(node -> {
            String id = node.path("id").asText();
            if (id.startsWith("build-density-") || "all-zdos-320".equals(id)) {
                publicLayers.add(node.deepCopy());
            }
        });
        result.set("lenses", publicLenses);
        result.set("layers", publicLayers);
        return result;
    }

    private static boolean isPublicArtifact(String file) {
        return file.matches("build-density-(1000|320|160|80|64|16)\\.png") ||
            "all-zdos-320.png".equals(file);
    }

    private void contextImage(Context ctx) throws Exception {
        if (terrainContext != null) {
            serveContext(ctx, terrainContext.overview());
            return;
        }
        if (config.contextImage() == null) {
            apiError(ctx, HttpStatus.NOT_FOUND, "No authoritative context image configured");
            return;
        }
        String name = config.contextImage().getFileName().toString().toLowerCase();
        ctx.contentType(name.endsWith(".jpg") || name.endsWith(".jpeg") ? "image/jpeg" : "image/png");
        ctx.result(new FileInputStream(config.contextImage().toFile()));
    }

    private void contextVariant(Context ctx) throws Exception {
        if (terrainContext == null) {
            apiError(ctx, HttpStatus.NOT_FOUND, "No snapshot-matched terrain context configured");
            return;
        }
        serveContext(ctx, terrainContext.requireVariant(ctx.pathParam("variant")));
    }

    private static void serveContext(Context ctx, TerrainContext.Variant variant) throws Exception {
        String etag = "\"" + variant.sha256() + "\"";
        ctx.header("ETag", etag);
        ctx.header(Header.CACHE_CONTROL, "public, max-age=31536000, immutable");
        if (etag.equals(ctx.header("If-None-Match"))) {
            ctx.status(HttpStatus.NOT_MODIFIED);
            return;
        }
        ctx.contentType("image/png");
        ctx.header("Content-Length", Long.toString(variant.bytes()));
        ctx.result(new FileInputStream(variant.path().toFile()));
    }

    private void selection(Context ctx) throws Exception {
        long snapshot = longQuery(ctx, "snapshot", true);
        String lens = requiredQuery(ctx, "lens");
        enforcePublicScope(snapshot, lens);
        double minX = doubleQuery(ctx, "minX"), maxX = doubleQuery(ctx, "maxX");
        double minZ = doubleQuery(ctx, "minZ"), maxZ = doubleQuery(ctx, "maxZ");
        requirePublishedBounds(minX, maxX, minZ, maxZ);
        ctx.json(snapshots.selection(snapshot, lens,
            minX, maxX, minZ, maxZ,
            (int) longQuery(ctx, "topN", false, 12), biomeQuery(ctx)));
    }

    private void points(Context ctx) throws Exception {
        long snapshot = longQuery(ctx, "snapshot", true);
        String lens = requiredQuery(ctx, "lens");
        enforcePublicScope(snapshot, lens);
        double minX = doubleQuery(ctx, "minX"), maxX = doubleQuery(ctx, "maxX");
        double minZ = doubleQuery(ctx, "minZ"), maxZ = doubleQuery(ctx, "maxZ");
        requirePublishedBounds(minX, maxX, minZ, maxZ);
        int limit = (int) longQuery(ctx, "limit", false, 5000);
        List<String> biomes = biomeQuery(ctx);
        ctx.json(booleanQuery(ctx, "sample")
            ? snapshots.samplePoints(snapshot, lens, minX, maxX, minZ, maxZ, limit, biomes)
            : snapshots.exactPoints(snapshot, lens, minX, maxX, minZ, maxZ, limit, biomes));
    }

    private void items(Context ctx) throws Exception {
        long snapshot = longQuery(ctx, "snapshot", true);
        String lens = requiredQuery(ctx, "lens");
        enforcePublicScope(snapshot, lens);
        double minX = doubleQuery(ctx, "minX"), maxX = doubleQuery(ctx, "maxX");
        double minZ = doubleQuery(ctx, "minZ"), maxZ = doubleQuery(ctx, "maxZ");
        requirePublishedBounds(minX, maxX, minZ, maxZ);
        ctx.json(snapshots.items(snapshot, lens, minX, maxX, minZ, maxZ,
            (int) longQuery(ctx, "limit", false, 100), ctx.queryParam("cursor"), biomeQuery(ctx)));
    }

    private void scene(Context ctx) throws Exception {
        long snapshot = longQuery(ctx, "snapshot", true);
        String lens = requiredQuery(ctx, "lens");
        enforcePublicScope(snapshot, lens);
        double minX = doubleQuery(ctx, "minX"), maxX = doubleQuery(ctx, "maxX");
        double minZ = doubleQuery(ctx, "minZ"), maxZ = doubleQuery(ctx, "maxZ");
        requirePublishedBounds(minX, maxX, minZ, maxZ);
        ScenePackage.Result scene = scenes.build(snapshot, lens, minX, maxX, minZ, maxZ,
            biomeQuery(ctx), booleanQuery(ctx, "override"), config.releaseVersion());
        ctx.contentType(ScenePackage.CONTENT_TYPE);
        ctx.header("Content-Length", Integer.toString(scene.bytes().length));
        ctx.header("X-Steward-Scene-Pieces", Integer.toString(scene.pieces()));
        ctx.result(scene.bytes());
    }

    private void startDiscordAuthorization(Context ctx) {
        DiscordFeedbackService.Authorization authorization = feedback.beginAuthorization();
        addCookie(ctx, "steward_oauth_nonce", authorization.browserNonce(), 600, true);
        ctx.redirect(authorization.redirectUri().toString());
    }

    private void finishDiscordAuthorization(Context ctx) {
        try {
            DiscordFeedbackService.IdentitySession session = feedback.completeAuthorization(
                ctx.queryParam("code"), ctx.queryParam("state"), ctx.cookie("steward_oauth_nonce"));
            addCookie(ctx, "steward_identity", session.sessionId(), 3600, true);
            clearCookie(ctx, "steward_oauth_nonce");
            ctx.redirect(config.publicUrl() + "?discord=connected");
        } catch (Exception error) {
            clearCookie(ctx, "steward_oauth_nonce");
            ctx.redirect(config.publicUrl() + "?discord=error");
        }
    }

    private void authSession(Context ctx) {
        DiscordFeedbackService.DiscordIdentity identity = feedback.identity(ctx.cookie("steward_identity"));
        ObjectNode result = mapper.createObjectNode();
        result.put("connected", identity != null);
        if (identity != null) {
            result.put("displayName", identity.displayName());
            result.put("username", identity.username());
        }
        ctx.json(result);
    }

    private void logout(Context ctx) {
        requireSameOrigin(ctx);
        feedback.logout(ctx.cookie("steward_identity"));
        clearCookie(ctx, "steward_identity");
        ctx.json(Map.of("ok", true));
    }

    private void submitFeedback(Context ctx) throws Exception {
        requireSameOrigin(ctx);
        SlidingWindowRateLimiter.Result allowance = feedbackRate.acquire(clientKey(ctx));
        if (!allowance.allowed()) {
            rateLimited(ctx, allowance.retryAfterSeconds(), "Please wait a little before sending more feedback");
            return;
        }
        DiscordFeedbackService.FeedbackRequest request =
            ctx.bodyAsClass(DiscordFeedbackService.FeedbackRequest.class);
        DiscordFeedbackService.DiscordIdentity identity = feedback.identity(ctx.cookie("steward_identity"));
        String id = feedback.submit(request, identity);
        ctx.json(Map.of("ok", true, "feedbackId", id));
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

    private void securityHeaders(Context ctx) {
        ctx.header(Header.CACHE_CONTROL, "no-store");
        if (!config.publicMode()) return;
        ctx.header("X-Content-Type-Options", "nosniff");
        ctx.header("X-Frame-Options", "DENY");
        ctx.header("Referrer-Policy", "no-referrer");
        ctx.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
        ctx.header("Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; " +
            "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    }

    private void enforcePublicScope(long snapshot, String lens) {
        if (!config.publicMode()) return;
        if (snapshot != config.snapshotId() || !"build-density".equals(lens)) {
            throw new IllegalArgumentException("This shared view is focused on Comfy Era 17 build density");
        }
    }

    private void boundedQuery(Context ctx, QueryHandler handler) throws Exception {
        if (config.publicMode()) {
            SlidingWindowRateLimiter.Result allowance = queryRate.acquire(clientKey(ctx));
            if (!allowance.allowed()) {
                rateLimited(ctx, allowance.retryAfterSeconds(), "The map is receiving a lot of requests; try again shortly");
                return;
            }
            if (!querySlots.tryAcquire()) {
                rateLimited(ctx, 2, "The map is answering another detailed query; try again in a moment");
                return;
            }
        }
        try {
            handler.handle(ctx);
        } finally {
            if (config.publicMode()) querySlots.release();
        }
    }

    private void sceneQuery(Context ctx, QueryHandler handler) throws Exception {
        if (config.publicMode()) {
            SlidingWindowRateLimiter.Result allowance = sceneRate.acquire(clientKey(ctx));
            if (!allowance.allowed()) {
                rateLimited(ctx, allowance.retryAfterSeconds(),
                    "The 3D explorer has reached its request limit; try again shortly");
                return;
            }
            if (!sceneSlots.tryAcquire()) {
                rateLimited(ctx, 2, "Another 3D scene is being assembled; try again in a moment");
                return;
            }
        }
        try {
            handler.handle(ctx);
        } finally {
            if (config.publicMode()) sceneSlots.release();
        }
    }

    private void requireSameOrigin(Context ctx) {
        if (!config.publicMode()) return;
        String origin = ctx.header("Origin");
        if (origin == null || origin.isBlank()) {
            String fetchSite = ctx.header("Sec-Fetch-Site");
            if (!"same-origin".equalsIgnoreCase(fetchSite)) {
                throw new IllegalArgumentException("Same-origin browser request required");
            }
            return;
        }
        java.net.URI expected = java.net.URI.create(config.publicUrl());
        String expectedOrigin = expected.getScheme() + "://" + expected.getAuthority();
        if (!expectedOrigin.equalsIgnoreCase(origin)) {
            throw new IllegalArgumentException("Cross-origin submissions are not accepted");
        }
    }

    private static String clientKey(Context ctx) {
        String forwarded = ctx.header("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) return forwarded.split(",", 2)[0].trim();
        String remote = ctx.ip();
        return remote == null || remote.isBlank() ? "unknown" : remote;
    }

    private static void rateLimited(Context ctx, long retryAfter, String message) {
        ctx.header("Retry-After", Long.toString(retryAfter));
        apiError(ctx, HttpStatus.TOO_MANY_REQUESTS, message);
    }

    private void addCookie(Context ctx, String name, String value, int maxAgeSeconds, boolean httpOnly) {
        String cookie = name + "=" + value + "; Path=" + config.feedback().cookiePath() +
            "; Max-Age=" + maxAgeSeconds + "; SameSite=Lax" +
            (httpOnly ? "; HttpOnly" : "") + (config.feedback().secureCookies() ? "; Secure" : "");
        ctx.res().addHeader("Set-Cookie", cookie);
    }

    private void clearCookie(Context ctx, String name) {
        String cookie = name + "=; Path=" + config.feedback().cookiePath() +
            "; Max-Age=0; SameSite=Lax; HttpOnly" +
            (config.feedback().secureCookies() ? "; Secure" : "");
        ctx.res().addHeader("Set-Cookie", cookie);
    }

    @FunctionalInterface
    private interface QueryHandler {
        void handle(Context ctx) throws Exception;
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

    private List<String> biomeQuery(Context ctx) {
        String raw = ctx.queryParam("biomes");
        if (raw == null || raw.isBlank() || "all".equalsIgnoreCase(raw.trim())) return List.of();
        if (terrainContext == null) throw new IllegalArgumentException("Biome filters are not available");
        Set<String> requested = new HashSet<>();
        for (String item : raw.split(",")) {
            String id = item.trim().toLowerCase();
            if (id.isEmpty()) continue;
            terrainContext.biomes().require(id);
            requested.add(id);
        }
        if (requested.isEmpty()) return List.of();
        List<String> result = new ArrayList<>();
        for (TerrainContext.Biome biome : terrainContext.biomes().catalog()) {
            if (requested.contains(biome.id())) result.add(biome.id());
        }
        return List.copyOf(result);
    }

    private static boolean booleanQuery(Context ctx, String name) {
        String raw = ctx.queryParam(name);
        if (raw == null || raw.isBlank()) return false;
        if ("true".equalsIgnoreCase(raw) || "1".equals(raw)) return true;
        if ("false".equalsIgnoreCase(raw) || "0".equals(raw)) return false;
        throw new IllegalArgumentException(name + " must be true or false");
    }

    private static void requirePublishedBounds(double minX, double maxX, double minZ, double maxZ) {
        WorldBounds bounds = WorldBounds.VALHEIM;
        if (minX < bounds.minX() || maxX > bounds.maxX() ||
                minZ < bounds.minZ() || maxZ > bounds.maxZ()) {
            throw new IllegalArgumentException("Selection extends beyond the published world bounds");
        }
    }

    private static void apiError(Context ctx, HttpStatus status, String message) {
        ctx.status(status).json(Map.of("error", message == null ? "Unknown error" : message));
    }
}
