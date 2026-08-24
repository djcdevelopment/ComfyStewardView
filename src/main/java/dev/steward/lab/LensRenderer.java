package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Instant;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class LensRenderer {
    private static final int MAX_DIMENSION = 20_000;

    private final SnapshotRepository repository;
    private final ArtifactStore artifacts;
    private final LensRegistry lenses;
    private final ObjectMapper mapper;
    private final WorldBounds world = WorldBounds.VALHEIM;

    public LensRenderer(SnapshotRepository repository, ArtifactStore artifacts,
            LensRegistry lenses, ObjectMapper mapper) {
        this.repository = repository;
        this.artifacts = artifacts;
        this.lenses = lenses;
        this.mapper = mapper;
    }

    public void render(LabJob job) throws Exception {
        LabJob.RenderRequest request = validate(job.request().normalized());
        int layerCount = request.lensIds().size() * request.resolutions().size();
        job.start(layerCount);

        SnapshotRepository.Snapshot snapshot = phase(job, "Open snapshot metadata", () ->
            repository.requireSnapshot(request.snapshotId()), Map.of());

        ObjectNode manifest = artifacts.readManifest(snapshot.snapshotId());
        if (manifest == null || manifest.path("schemaVersion").asInt() != ArtifactStore.SCHEMA_VERSION ||
                manifest.path("snapshotId").asLong() != snapshot.snapshotId()) {
            manifest = artifacts.newManifest(snapshot, lenses);
        }

        int renderedLayers = 0;
        long totalOutputBytes = 0;
        try (Connection connection = phase(job, "Open read-only DuckDB", repository::open,
                Map.of("cache", repository.cachePath().toString()))) {
            for (String lensId : request.lensIds()) {
                LensDefinition lens = lenses.require(lensId);
                for (int cellSize : request.resolutions()) {
                    job.checkCancelled();
                    String layerName = lens.label() + " · " + cellSize + " m";
                    String fileName = lens.id() + "-" + cellSize + ".png";
                    Path target = artifacts.resolveArtifact(snapshot.snapshotId(), fileName);
                    ObjectNode existing = artifacts.findLayer(manifest, lens.id(), cellSize);

                    if (!request.force() && existing != null && Files.isRegularFile(target)) {
                        LabJob.Phase cachePhase = job.beginPhase(layerName + " · artifact hit");
                        long bytes = Files.size(target);
                        job.completePhase(cachePhase, Map.of(
                            "cacheHit", true, "fileBytes", bytes,
                            "cellCount", existing.path("cellCount").asLong(),
                            "totalValue", existing.path("totalValue").asDouble()));
                        totalOutputBytes += bytes;
                        job.unitComplete();
                        renderedLayers++;
                        delay(job, request.simulatedDelayMs());
                        maybeInjectFailure(request, renderedLayers);
                        continue;
                    }

                    CellData cells = phase(job, layerName + " · aggregate", () ->
                        aggregate(connection, snapshot.snapshotId(), lens, cellSize, job), Map.of());
                    delay(job, request.simulatedDelayMs());

                    EncodedLayer encoded = phase(job, layerName + " · encode gray8", () ->
                        encode(snapshot.snapshotId(), lens, cellSize, cells), Map.of(
                            "pixels", (long) cells.width * cells.height,
                            "cellCount", cells.size,
                            "totalValue", cells.total,
                            "maxRaw", cells.max));
                    totalOutputBytes += encoded.fileBytes;
                    delay(job, request.simulatedDelayMs());

                    ObjectNode layerNode = layerJson(lens, cellSize, cells, encoded);
                    artifacts.replaceLayer(manifest, layerNode);
                    ObjectNode manifestToWrite = manifest;
                    phase(job, layerName + " · publish manifest", () -> {
                        artifacts.writeManifest(snapshot.snapshotId(), manifestToWrite);
                        return null;
                    }, Map.of("manifest", artifacts.manifestPath(snapshot.snapshotId()).toString()));
                    delay(job, request.simulatedDelayMs());

                    job.unitComplete();
                    renderedLayers++;
                    maybeInjectFailure(request, renderedLayers);
                }
            }
        }

        LabJob.Phase summary = job.beginPhase("Summarize outputs");
        job.completePhase(summary, Map.of(
            "renderedLayers", renderedLayers,
            "outputBytes", totalOutputBytes,
            "artifactDirectory", artifacts.snapshotDirectory(snapshot.snapshotId()).toString()));
        job.complete();
    }

    private LabJob.RenderRequest validate(LabJob.RenderRequest request) throws Exception {
        if (request.snapshotId() <= 0) throw new IllegalArgumentException("snapshotId is required");
        if (request.lensIds().isEmpty()) throw new IllegalArgumentException("Choose at least one lens");
        if (request.resolutions().isEmpty()) throw new IllegalArgumentException("Choose at least one resolution");
        request.lensIds().forEach(lenses::require);
        for (int size : request.resolutions()) {
            if (!LabConfig.ALLOWED_RESOLUTIONS.contains(size)) {
                throw new IllegalArgumentException("Unsupported resolution: " + size);
            }
        }
        repository.requireSnapshot(request.snapshotId());
        return request;
    }

    private CellData aggregate(Connection connection, long snapshotId, LensDefinition lens,
            int cellSize, LabJob job) throws Exception {
        int width = world.width(cellSize);
        int height = world.height(cellSize);
        if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
            throw new IllegalArgumentException("Refusing oversized raster " + width + "x" + height);
        }

        String sql = "SELECT CAST(FLOOR((" + lens.xColumn() + " - ?) / ?) AS INTEGER) AS cx, " +
            "CAST(FLOOR((" + lens.zColumn() + " - ?) / ?) AS INTEGER) AS cz, " +
            lens.valueExpression() + " AS cell_value FROM " + lens.table() +
            " WHERE snapshot_id = ? AND " + lens.predicate() +
            " AND " + lens.xColumn() + " >= ? AND " + lens.xColumn() + " < ?" +
            " AND " + lens.zColumn() + " >= ? AND " + lens.zColumn() + " < ?" +
            " GROUP BY 1,2";

        CellData cells = new CellData(width, height);
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            int index = 1;
            statement.setDouble(index++, world.minX());
            statement.setInt(index++, cellSize);
            statement.setDouble(index++, world.minZ());
            statement.setInt(index++, cellSize);
            statement.setLong(index++, snapshotId);
            statement.setDouble(index++, world.minX());
            statement.setDouble(index++, world.maxX());
            statement.setDouble(index++, world.minZ());
            statement.setDouble(index, world.maxZ());
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    if ((cells.size & 1023) == 0) job.checkCancelled();
                    int cx = rows.getInt("cx");
                    int cz = rows.getInt("cz");
                    double value = rows.getDouble("cell_value");
                    if (cx >= 0 && cx < width && cz >= 0 && cz < height && value > 0) {
                        cells.add(cx, cz, value);
                    }
                }
            }
        }
        job.log("Aggregated " + cells.size + " occupied cells; max " +
            Math.round(cells.max) + "; total " + Math.round(cells.total));
        return cells;
    }

    private EncodedLayer encode(long snapshotId, LensDefinition lens, int cellSize,
            CellData cells) throws IOException {
        BufferedImage image = new BufferedImage(cells.width, cells.height, BufferedImage.TYPE_INT_ARGB);
        double maxLog = Math.max(1.0, Math.log1p(cells.max));
        for (int i = 0; i < cells.size; i++) {
            double intensity = Math.log1p(cells.values[i]) / maxLog;
            int gray = Math.max(1, Math.min(255, (int) Math.round(intensity * 255)));
            int y = cells.height - 1 - cells.zs[i];
            image.setRGB(cells.xs[i], y, 0xFF000000 | (gray << 16) | (gray << 8) | gray);
        }

        String fileName = lens.id() + "-" + cellSize + ".png";
        Path target = artifacts.resolveArtifact(snapshotId, fileName);
        Files.createDirectories(target.getParent());
        Path temporary = target.resolveSibling(fileName + ".tmp");
        long started = System.nanoTime();
        if (!ImageIO.write(image, "png", temporary.toFile())) {
            throw new IOException("No PNG encoder available");
        }
        image.flush();
        ArtifactStore.atomicReplace(temporary, target);
        long imageMs = (System.nanoTime() - started) / 1_000_000;
        return new EncodedLayer(fileName, Files.size(target), imageMs);
    }

    private ObjectNode layerJson(LensDefinition lens, int cellSize, CellData cells,
            EncodedLayer encoded) {
        ObjectNode node = mapper.createObjectNode();
        node.put("id", lens.id() + "-" + cellSize);
        node.put("lensId", lens.id());
        node.put("label", lens.label() + " " + cellSize + " m");
        node.put("cellSize", cellSize);
        node.put("file", encoded.fileName);
        node.put("width", cells.width);
        node.put("height", cells.height);
        node.put("maxRaw", cells.max);
        node.put("maxLog", Math.max(1.0, Math.log1p(cells.max)));
        node.put("cellCount", cells.size);
        node.put("totalValue", cells.total);
        node.put("empty", cells.size == 0);
        node.put("encoding", "gray8");
        node.put("fileBytes", encoded.fileBytes);
        node.put("imageWriteMs", encoded.imageWriteMs);
        node.put("generatedAt", Instant.now().toString());
        ObjectNode bounds = node.putObject("bounds");
        bounds.put("minX", world.minX()); bounds.put("maxX", world.maxX());
        bounds.put("minZ", world.minZ()); bounds.put("maxZ", world.maxZ());
        return node;
    }

    private static void maybeInjectFailure(LabJob.RenderRequest request, int renderedLayers) {
        if (request.failAfterLayers() > 0 && renderedLayers >= request.failAfterLayers()) {
            throw new IllegalStateException("Injected lab failure after " + renderedLayers + " layer(s)");
        }
    }

    private static void delay(LabJob job, long delayMs) {
        if (delayMs <= 0) return;
        job.checkCancelled();
        try {
            Thread.sleep(delayMs);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new LabJob.JobCancelledException();
        }
        job.checkCancelled();
    }

    private static <T> T phase(LabJob job, String name, ThrowingSupplier<T> operation,
            Map<String, Object> declaredMetrics) throws Exception {
        LabJob.Phase phase = job.beginPhase(name);
        long started = System.nanoTime();
        try {
            T result = operation.get();
            Map<String, Object> metrics = new LinkedHashMap<>(declaredMetrics);
            metrics.put("durationMs", (System.nanoTime() - started) / 1_000_000);
            job.completePhase(phase, metrics);
            return result;
        } catch (Exception | Error failure) {
            job.failPhase(phase, failure);
            throw failure;
        }
    }

    @FunctionalInterface
    private interface ThrowingSupplier<T> { T get() throws Exception; }

    private static final class CellData {
        final int width;
        final int height;
        int[] xs = new int[1024];
        int[] zs = new int[1024];
        double[] values = new double[1024];
        int size;
        double max;
        double total;

        CellData(int width, int height) {
            this.width = width;
            this.height = height;
        }

        void add(int x, int z, double value) {
            if (size == xs.length) {
                int next = xs.length * 2;
                xs = Arrays.copyOf(xs, next);
                zs = Arrays.copyOf(zs, next);
                values = Arrays.copyOf(values, next);
            }
            xs[size] = x;
            zs[size] = z;
            values[size] = value;
            size++;
            max = Math.max(max, value);
            total += value;
        }
    }

    private record EncodedLayer(String fileName, long fileBytes, long imageWriteMs) {}
}
