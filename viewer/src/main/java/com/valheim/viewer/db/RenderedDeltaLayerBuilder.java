package com.valheim.viewer.db;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Batch-only renderer for spatial changes between recent snapshots.
 *
 * <p>AM4 only serves the resulting manifests and PNGs. It never computes a delta raster in
 * response to an HTTP request. For each world, the builder keeps the canonical older-to-newer
 * pairs among the six most recently ingested snapshots: at most {@code C(6,2) = 15} pairs.
 */
public final class RenderedDeltaLayerBuilder {

    public static final int RECENT_SNAPSHOT_LIMIT = 6;
    public static final int[] CELL_SIZES = {64, 320, 500, 1000};

    private static final Pattern PAIR_DIR = Pattern.compile("[1-9][0-9]*-[1-9][0-9]*");
    private static final String BUILD_ACTIVITY = "build-activity";
    private static final String ALL_ZDOS = "all-zdos";
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final File cacheFile;
    private final File renderRoot;

    public RenderedDeltaLayerBuilder(File cacheFile, File renderRoot) {
        this.cacheFile = cacheFile;
        this.renderRoot = renderRoot;
    }

    /**
     * Render missing canonical pairs in the latest-six matrix, then prune stale pair directories.
     * Returns the number of manifests created during this pass.
     */
    public int renderRecentPairs() throws Exception {
        Class.forName("org.duckdb.DuckDBDriver");
        File deltaRoot = new File(renderRoot, "delta");
        if (!deltaRoot.exists() && !deltaRoot.mkdirs()) {
            throw new IllegalStateException("Could not create delta render directory: " + deltaRoot);
        }

        int rendered = 0;
        Set<String> validPairDirectories = new HashSet<>();
        try (Connection conn = DriverManager.getConnection("jdbc:duckdb:" + cacheFile.getAbsolutePath())) {
            Map<String, List<SnapshotMetadata>> worlds = loadRecentSnapshots(conn);
            for (List<SnapshotMetadata> snapshots : worlds.values()) {
                // loadRecentSnapshots returns newest first. Generate one canonical direction:
                // the older/lower id is `from`, the newer/higher id is `to`.
                for (int newer = 0; newer < snapshots.size() - 1; newer++) {
                    for (int older = newer + 1; older < snapshots.size(); older++) {
                        SnapshotMetadata from = snapshots.get(older);
                        SnapshotMetadata to = snapshots.get(newer);
                        String pairName = pairDirectoryName(from.snapshotId, to.snapshotId);
                        validPairDirectories.add(pairName);
                        File manifest = new File(new File(deltaRoot, pairName), "manifest.json");
                        if (isCompleteManifest(manifest, from.snapshotId, to.snapshotId)) continue;
                        renderPair(conn, from, to, new File(deltaRoot, pairName));
                        rendered++;
                    }
                }
            }
        }

        // Only prune after every required pair rendered successfully. A failed render leaves the
        // previous complete matrix untouched, which is safer for persistent ingest deployments.
        pruneStalePairDirectories(deltaRoot, validPairDirectories);
        return rendered;
    }

    /** Render one canonical pair. Primarily exposed for focused integration tests. */
    public File renderPair(long fromSnapshotId, long toSnapshotId) throws Exception {
        if (fromSnapshotId <= 0 || toSnapshotId <= 0 || fromSnapshotId >= toSnapshotId) {
            throw new IllegalArgumentException("delta raster pair must use older/lower 'from' and newer/higher 'to'");
        }
        Class.forName("org.duckdb.DuckDBDriver");
        try (Connection conn = DriverManager.getConnection("jdbc:duckdb:" + cacheFile.getAbsolutePath())) {
            SnapshotMetadata from = loadSnapshot(conn, fromSnapshotId);
            SnapshotMetadata to = loadSnapshot(conn, toSnapshotId);
            if (from == null || to == null) {
                throw new IllegalArgumentException("snapshot pair does not exist: " + fromSnapshotId + " -> " + toSnapshotId);
            }
            if (!sameWorld(from.worldId, to.worldId)) {
                throw new IllegalArgumentException("snapshots belong to different worlds");
            }
            File outDir = new File(new File(renderRoot, "delta"), pairDirectoryName(fromSnapshotId, toSnapshotId));
            return renderPair(conn, from, to, outDir);
        }
    }

    /** Canonical pair names are deliberately simple so serving and pruning stay path-safe. */
    public static String pairDirectoryName(long fromSnapshotId, long toSnapshotId) {
        return fromSnapshotId + "-" + toSnapshotId;
    }

    /** Latest-six canonical pair count; used by tests and operational verification. */
    public static int canonicalPairCount(int snapshotCount) {
        int retained = Math.max(0, Math.min(RECENT_SNAPSHOT_LIMIT, snapshotCount));
        return retained * (retained - 1) / 2;
    }

    private File renderPair(Connection conn, SnapshotMetadata from, SnapshotMetadata to, File outDir)
            throws Exception {
        if (!outDir.exists() && !outDir.mkdirs()) {
            throw new IllegalStateException("Could not create delta pair directory: " + outDir);
        }

        // A manifest is the serving-side completeness marker. Remove an older/incomplete marker
        // before touching either channel so a failed rebuild becomes a clean 404, never a stale
        // manifest pointing at a partially rewritten pair.
        File manifestFile = new File(outDir, "manifest.json");
        Files.deleteIfExists(manifestFile.toPath());

        ChangeSet added = collectChanges(conn, to.snapshotId, from.snapshotId);
        ChangeSet removed = collectChanges(conn, from.snapshotId, to.snapshotId);

        ObjectNode manifest = MAPPER.createObjectNode();
        manifest.put("schemaVersion", 1);
        manifest.put("fromSnapshotId", from.snapshotId);
        manifest.put("toSnapshotId", to.snapshotId);
        putNullable(manifest, "worldId", from.worldId);
        manifest.put("generatedAt", Instant.now().toString());
        manifest.put("identity", "prefab-hash+position-cm");
        putNullable(manifest, "fromDictionaryVersion", from.dictionaryVersion);
        putNullable(manifest, "toDictionaryVersion", to.dictionaryVersion);
        boolean dictionaryMismatch = dictionaryMismatch(from.dictionaryVersion, to.dictionaryVersion);
        manifest.put("dictionaryMismatch", dictionaryMismatch);
        manifest.put("dictionaryCompatibility", dictionaryMismatch ? "mismatch" :
            knownDictionary(from.dictionaryVersion) && knownDictionary(to.dictionaryVersion)
                ? "compatible" : "unknown");
        if (dictionaryMismatch) {
            manifest.put("warning", "Snapshots use different prefab dictionaries; category-level " +
                "spatial changes may include classification drift.");
        }
        manifest.put("zdosAdded", added.total);
        manifest.put("zdosRemoved", removed.total);
        manifest.put("spatialZdosAdded", added.spatialTotal);
        manifest.put("spatialZdosRemoved", removed.spatialTotal);
        manifest.put("unrenderableZdosAdded", added.total - added.spatialTotal);
        manifest.put("unrenderableZdosRemoved", removed.total - removed.spatialTotal);
        ArrayNode layers = manifest.putArray("layers");

        for (int cellSize : CELL_SIZES) {
            writeLayer(outDir, layers, BUILD_ACTIVITY, "Build Activity", cellSize,
                added.buildCells.get(cellSize), removed.buildCells.get(cellSize));
            writeLayer(outDir, layers, ALL_ZDOS, "All ZDO Change", cellSize,
                added.allCells.get(cellSize), removed.allCells.get(cellSize));
        }

        // The manifest is the completeness marker and is deliberately written last.
        MAPPER.writerWithDefaultPrettyPrinter().writeValue(manifestFile, manifest);
        return manifestFile;
    }

    private ChangeSet collectChanges(Connection conn, long presentIn, long absentFrom) throws SQLException {
        ChangeSet changes = new ChangeSet();
        String sql =
            "SELECT b.category, b.x, b.z FROM zdo b " +
            "WHERE b.snapshot_id = ? " +
            "AND " + SnapshotDeltaEngine.missingIdentityPredicate("b", "a");
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setLong(1, presentIn);
            ps.setLong(2, absentFrom);
            ps.setFetchSize(10_000);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    String category = rs.getString("category");
                    double x = rs.getDouble("x");
                    double z = rs.getDouble("z");
                    changes.total++;
                    if (!Double.isFinite(x) || !Double.isFinite(z) ||
                            Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000) continue;
                    changes.spatialTotal++;
                    for (int cellSize : CELL_SIZES) {
                        Cell cell = new Cell(gridCoord(x, cellSize), gridCoord(z, cellSize));
                        changes.allCells.get(cellSize).merge(cell, 1L, Long::sum);
                        if ("BUILDING".equals(category)) {
                            changes.buildCells.get(cellSize).merge(cell, 1L, Long::sum);
                        }
                    }
                }
            }
        }
        return changes;
    }

    private void writeLayer(File outDir, ArrayNode layers, String layer, String label, int cellSize,
            Map<Cell, Long> added, Map<Cell, Long> removed) throws IOException {
        Bounds bounds = unionBounds(added, removed);
        boolean empty = bounds == null;
        if (empty) bounds = new Bounds(0, 0, 0, 0);

        int width = bounds.maxCx - bounds.minCx + 1;
        int height = bounds.maxCz - bounds.minCz + 1;
        if (width <= 0 || height <= 0 || width > 20_000 || height > 20_000) {
            throw new IllegalStateException("Refusing to render oversized delta layer " + layer +
                " " + cellSize + "m: " + width + "x" + height);
        }

        BufferedImage addedImage = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        BufferedImage removedImage = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        ChannelStats addedStats = paintChannel(addedImage, bounds, added);
        ChannelStats removedStats = paintChannel(removedImage, bounds, removed);

        String addedFile = layer + "-" + cellSize + "-added.png";
        String removedFile = layer + "-" + cellSize + "-removed.png";
        if (!ImageIO.write(addedImage, "png", new File(outDir, addedFile)) ||
                !ImageIO.write(removedImage, "png", new File(outDir, removedFile))) {
            throw new IOException("No PNG writer available for delta layer output");
        }

        ObjectNode n = layers.addObject();
        n.put("id", layer + "-" + cellSize);
        n.put("layer", layer);
        n.put("label", label + " " + cellSize + "m");
        n.put("cellSize", cellSize);
        n.put("addedFile", addedFile);
        n.put("removedFile", removedFile);
        ObjectNode b = n.putObject("bounds");
        b.put("minX", bounds.minCx * (double) cellSize);
        b.put("maxX", (bounds.maxCx + 1) * (double) cellSize);
        b.put("minZ", bounds.minCz * (double) cellSize);
        b.put("maxZ", (bounds.maxCz + 1) * (double) cellSize);
        n.put("width", width);
        n.put("height", height);
        n.put("addedMaxLog", addedStats.maxLog);
        n.put("removedMaxLog", removedStats.maxLog);
        n.put("addedMaxRaw", addedStats.maxRaw);
        n.put("removedMaxRaw", removedStats.maxRaw);
        n.put("addedCellCount", addedStats.cellCount);
        n.put("removedCellCount", removedStats.cellCount);
        n.put("addedRawTotal", addedStats.rawTotal);
        n.put("removedRawTotal", removedStats.rawTotal);
        n.put("encoding", "gray8");
        n.put("empty", empty);
    }

    private static ChannelStats paintChannel(BufferedImage image, Bounds bounds, Map<Cell, Long> cells) {
        long maxRaw = 0;
        long rawTotal = 0;
        for (long value : cells.values()) {
            maxRaw = Math.max(maxRaw, value);
            rawTotal += value;
        }
        double maxLog = maxRaw == 0 ? 0.0 : Math.log1p(maxRaw);
        if (maxLog > 0.0) {
            for (Map.Entry<Cell, Long> entry : cells.entrySet()) {
                Cell cell = entry.getKey();
                double t = Math.log1p(entry.getValue()) / maxLog;
                int value = Math.max(1, (int) Math.round(255 * Math.max(0.0, Math.min(1.0, t))));
                int px = cell.cx - bounds.minCx;
                int py = bounds.maxCz - cell.cz;
                image.setRGB(px, py, 0xFF000000 | (value << 16) | (value << 8) | value);
            }
        }
        return new ChannelStats(maxLog, maxRaw, cells.size(), rawTotal);
    }

    private static Bounds unionBounds(Map<Cell, Long> first, Map<Cell, Long> second) {
        if (first.isEmpty() && second.isEmpty()) return null;
        int minCx = Integer.MAX_VALUE, maxCx = Integer.MIN_VALUE;
        int minCz = Integer.MAX_VALUE, maxCz = Integer.MIN_VALUE;
        for (Map<Cell, Long> cells : List.of(first, second)) {
            for (Cell cell : cells.keySet()) {
                minCx = Math.min(minCx, cell.cx);
                maxCx = Math.max(maxCx, cell.cx);
                minCz = Math.min(minCz, cell.cz);
                maxCz = Math.max(maxCz, cell.cz);
            }
        }
        return new Bounds(minCx, maxCx, minCz, maxCz);
    }

    private static Map<String, List<SnapshotMetadata>> loadRecentSnapshots(Connection conn) throws SQLException {
        Map<String, List<SnapshotMetadata>> worlds = new LinkedHashMap<>();
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT snapshot_id, world_id, prefab_dictionary_version " +
                "FROM world_snapshot ORDER BY world_id, snapshot_id DESC");
             ResultSet rs = ps.executeQuery()) {
            while (rs.next()) {
                String worldId = rs.getString("world_id");
                // A missing world id cannot safely participate in a world-scoped pair matrix.
                if (worldId == null || worldId.isBlank()) continue;
                List<SnapshotMetadata> snapshots = worlds.computeIfAbsent(worldId, ignored -> new ArrayList<>());
                if (snapshots.size() < RECENT_SNAPSHOT_LIMIT) {
                    snapshots.add(new SnapshotMetadata(
                        rs.getLong("snapshot_id"), worldId, rs.getString("prefab_dictionary_version")));
                }
            }
        }
        return worlds;
    }

    private static SnapshotMetadata loadSnapshot(Connection conn, long snapshotId) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT snapshot_id, world_id, prefab_dictionary_version FROM world_snapshot WHERE snapshot_id = ?")) {
            ps.setLong(1, snapshotId);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) return null;
                return new SnapshotMetadata(rs.getLong(1), rs.getString(2), rs.getString(3));
            }
        }
    }

    public static boolean isCompleteManifest(File manifestFile, long fromSnapshotId, long toSnapshotId) {
        if (!manifestFile.isFile()) return false;
        try {
            var root = MAPPER.readTree(manifestFile);
            if (root.path("schemaVersion").asInt() != 1 ||
                    root.path("fromSnapshotId").asLong() != fromSnapshotId ||
                    root.path("toSnapshotId").asLong() != toSnapshotId ||
                    root.path("worldId").asText("").isBlank() ||
                    !"prefab-hash+position-cm".equals(root.path("identity").asText()) ||
                    !root.has("fromDictionaryVersion") || !root.has("toDictionaryVersion") ||
                    !root.path("dictionaryMismatch").isBoolean() ||
                    !validDictionaryCompatibility(root) ||
                    !nonNegativeNumber(root.get("zdosAdded")) ||
                    !nonNegativeNumber(root.get("zdosRemoved")) ||
                    root.path("layers").size() != CELL_SIZES.length * 2) return false;
            Set<String> expected = new HashSet<>();
            for (int cellSize : CELL_SIZES) {
                expected.add(BUILD_ACTIVITY + "-" + cellSize);
                expected.add(ALL_ZDOS + "-" + cellSize);
            }
            for (var layer : root.path("layers")) {
                JsonNode bounds = layer.path("bounds");
                int cellSize = layer.path("cellSize").asInt();
                String layerName = layer.path("layer").asText();
                if (!"gray8".equals(layer.path("encoding").asText()) ||
                        !bounds.isObject() || !finiteNumber(bounds.get("minX")) ||
                        !finiteNumber(bounds.get("maxX")) || !finiteNumber(bounds.get("minZ")) ||
                        !finiteNumber(bounds.get("maxZ")) ||
                        bounds.path("maxX").asDouble() <= bounds.path("minX").asDouble() ||
                        bounds.path("maxZ").asDouble() <= bounds.path("minZ").asDouble() ||
                        layer.path("width").asInt() <= 0 || layer.path("height").asInt() <= 0 ||
                        !layer.path("empty").isBoolean() ||
                        !nonNegativeNumber(layer.get("addedMaxRaw")) ||
                        !nonNegativeNumber(layer.get("removedMaxRaw")) ||
                        !nonNegativeNumber(layer.get("addedMaxLog")) ||
                        !nonNegativeNumber(layer.get("removedMaxLog")) ||
                        !expected.remove(layer.path("id").asText()) ||
                        !layer.path("id").asText().equals(layerName + "-" + cellSize)) return false;
                for (String field : List.of("addedFile", "removedFile")) {
                    String name = layer.path(field).asText("");
                    if (name.isBlank() || !new File(name).getName().equals(name) ||
                            !new File(manifestFile.getParentFile(), name).isFile()) return false;
                }
                ImageDimensions addedDimensions = imageDimensions(
                    new File(manifestFile.getParentFile(), layer.path("addedFile").asText()));
                ImageDimensions removedDimensions = imageDimensions(
                    new File(manifestFile.getParentFile(), layer.path("removedFile").asText()));
                if (addedDimensions == null || removedDimensions == null ||
                        !addedDimensions.equals(removedDimensions) ||
                        addedDimensions.width != layer.path("width").asInt() ||
                        addedDimensions.height != layer.path("height").asInt()) return false;
            }
            return expected.isEmpty();
        } catch (Exception ignored) {
            return false;
        }
    }

    /** True only when {@code fileName} is one of the complete manifest's channel files. */
    public static boolean isAdvertisedChannel(File manifestFile, long fromSnapshotId,
            long toSnapshotId, String fileName) {
        if (!isCompleteManifest(manifestFile, fromSnapshotId, toSnapshotId)) return false;
        try {
            for (JsonNode layer : MAPPER.readTree(manifestFile).path("layers")) {
                if (fileName.equals(layer.path("addedFile").asText()) ||
                        fileName.equals(layer.path("removedFile").asText())) return true;
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    private static boolean validDictionaryCompatibility(JsonNode root) {
        String value = root.path("dictionaryCompatibility").asText("");
        boolean mismatch = root.path("dictionaryMismatch").asBoolean();
        return ("mismatch".equals(value) || "compatible".equals(value) || "unknown".equals(value)) &&
            mismatch == "mismatch".equals(value);
    }

    private static boolean finiteNumber(JsonNode value) {
        return value != null && value.isNumber() && Double.isFinite(value.asDouble());
    }

    private static boolean nonNegativeNumber(JsonNode value) {
        return finiteNumber(value) && value.asDouble() >= 0;
    }

    private static ImageDimensions imageDimensions(File file) {
        try (ImageInputStream input = ImageIO.createImageInputStream(file)) {
            if (input == null) return null;
            Iterator<ImageReader> readers = ImageIO.getImageReaders(input);
            if (!readers.hasNext()) return null;
            ImageReader reader = readers.next();
            try {
                if (!"png".equalsIgnoreCase(reader.getFormatName())) return null;
                reader.setInput(input, true, true);
                return new ImageDimensions(reader.getWidth(0), reader.getHeight(0));
            } finally {
                reader.dispose();
            }
        } catch (Exception ignored) {
            return null;
        }
    }

    private static void pruneStalePairDirectories(File deltaRoot, Set<String> validPairs) throws IOException {
        File[] children = deltaRoot.listFiles(File::isDirectory);
        if (children == null) return;
        Path rootPath = deltaRoot.toPath().toRealPath();
        for (File child : children) {
            String name = child.getName();
            if (!PAIR_DIR.matcher(name).matches() || validPairs.contains(name)) continue;
            Path childPath = child.toPath().toRealPath();
            if (!childPath.getParent().equals(rootPath)) {
                throw new IOException("Refusing to prune delta directory outside render root: " + childPath);
            }
            try (Stream<Path> paths = Files.walk(childPath)) {
                for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) {
                    Files.delete(path);
                }
            }
        }
    }

    private static int gridCoord(double value, int cellSize) {
        return (int) Math.floor(value / cellSize);
    }

    private static boolean sameWorld(String first, String second) {
        return first != null && first.equals(second);
    }

    private static boolean dictionaryMismatch(String first, String second) {
        return knownDictionary(first) && knownDictionary(second) && !first.equals(second);
    }

    private static boolean knownDictionary(String version) {
        return version != null && !version.isBlank();
    }

    private static void putNullable(ObjectNode node, String field, String value) {
        if (value == null) node.putNull(field);
        else node.put(field, value);
    }

    private static final class ChangeSet {
        long total;
        long spatialTotal;
        final Map<Integer, Map<Cell, Long>> buildCells = cellMaps();
        final Map<Integer, Map<Cell, Long>> allCells = cellMaps();

        private static Map<Integer, Map<Cell, Long>> cellMaps() {
            Map<Integer, Map<Cell, Long>> result = new HashMap<>();
            for (int cellSize : CELL_SIZES) result.put(cellSize, new HashMap<>());
            return result;
        }
    }

    private record SnapshotMetadata(long snapshotId, String worldId, String dictionaryVersion) {}
    private record Cell(int cx, int cz) {}
    private record Bounds(int minCx, int maxCx, int minCz, int maxCz) {}
    private record ChannelStats(double maxLog, long maxRaw, long cellCount, long rawTotal) {}
    private record ImageDimensions(int width, int height) {}
}
