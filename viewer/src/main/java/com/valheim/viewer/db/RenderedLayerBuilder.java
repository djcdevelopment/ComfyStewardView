package com.valheim.viewer.db;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;

/**
 * Batch renderer for static map overlays sourced from the analytics cache.
 */
public final class RenderedLayerBuilder {

    private static final int[] DEFAULT_CELL_SIZES = {64, 320, 500, 1000};

    /**
     * Bumped whenever a render changes what the pixels mean, so an existing manifest can be
     * recognised as stale rather than merely present.
     *
     * <p>Without this the caller's "skip if manifest.json exists" test made every future change to
     * this builder invisible on any deployment that had already rendered once — the AM4 container
     * gates its batch phase on a marker file, so a schema change there would simply never be
     * picked up.
     *
     * <p>1: off-map dungeon interiors excluded from all-zdos, all layers clamped to the world box.
     */
    public static final int SCHEMA_VERSION = 1;

    /**
     * The playable world box, matching {@link com.valheim.viewer.store.HeatmapGrid}.
     *
     * <p>Rasters are clamped to it rather than to the old {@code ABS(coord) < 100000} sanity
     * bound. A handful of outlier ZDOs sit past {@code x = +75000}, and because layer bounds are
     * derived from the cells that got written, those outliers stretched every raster's extent:
     * the actual world ended up occupying roughly 60% of the image, and anything framing itself
     * on those bounds framed mostly empty space.
     */
    static final double WORLD_MIN_X = -26500, WORLD_MAX_X = 26500;
    static final double WORLD_MIN_Z = -20500, WORLD_MAX_Z = 27500;

    /**
     * Valheim places dungeon interiors on a regular lattice far off the map — the parser tags
     * them {@code INTERIOR} by their {@code y > 3000} altitude. They are real objects, but they
     * are not anywhere, so drawing them on a world map produces the grid of disconnected blocks
     * to the north-west of the landmass and nothing else.
     *
     * <p>Excluding them is also what turns {@code all-zdos} into a usable land mask: vegetation
     * and rock only generate on land, so surface ZDO density is the coastline.
     */
    private static final String SURFACE_ONLY = "AND (category IS NULL OR category <> 'INTERIOR') ";

    private static final String[][] LAYERS = {
        {"build-density", "Build Density"},
        {"dropped-items", "Dropped Items"},
        {"all-zdos", "All ZDOs"},
        {"coins", "Container Coins"},
    };

    private final File cacheFile;
    private final File renderRoot;
    private final long snapshotId;

    public RenderedLayerBuilder(File cacheFile, File renderRoot, long snapshotId) {
        this.cacheFile = cacheFile;
        this.renderRoot = renderRoot;
        this.snapshotId = snapshotId;
    }

    public File renderDefaults() throws Exception {
        Class.forName("org.duckdb.DuckDBDriver");
        File outDir = new File(renderRoot, String.valueOf(snapshotId));
        if (!outDir.exists() && !outDir.mkdirs()) {
            throw new IllegalStateException("Could not create render directory: " + outDir.getAbsolutePath());
        }

        ObjectMapper mapper = new ObjectMapper();
        ObjectNode manifest = mapper.createObjectNode();
        manifest.put("schemaVersion", SCHEMA_VERSION);
        manifest.put("snapshotId", snapshotId);
        manifest.put("generatedAt", Instant.now().toString());
        ArrayNode layers = manifest.putArray("layers");

        try (Connection conn = DriverManager.getConnection("jdbc:duckdb:" + cacheFile.getAbsolutePath())) {
            for (int cellSize : DEFAULT_CELL_SIZES) {
                for (String[] layer : LAYERS) {
                    renderLayer(conn, outDir, layers, layer[0], layer[1], cellSize);
                }
            }
        }

        File manifestFile = new File(outDir, "manifest.json");
        mapper.writerWithDefaultPrettyPrinter().writeValue(manifestFile, manifest);
        return manifestFile;
    }

    /**
     * True when {@code manifestFile} was written by this version of the builder. A manifest from
     * an older schema describes different pixels and must be re-rendered, not served.
     */
    public static boolean isCurrentManifest(File manifestFile) {
        if (!manifestFile.isFile()) return false;
        try {
            return new ObjectMapper().readTree(manifestFile).path("schemaVersion").asInt(0)
                == SCHEMA_VERSION;
        } catch (Exception ignored) {
            return false;
        }
    }

    private void renderLayer(Connection conn, File outDir, ArrayNode manifestLayers,
            String layer, String label, int cellSize) throws Exception {
        populateCells(conn, layer, cellSize);

        Bounds bounds = loadBounds(conn, layer, cellSize);
        if (bounds == null) return;

        int width = bounds.maxCx - bounds.minCx + 1;
        int height = bounds.maxCz - bounds.minCz + 1;
        if (width <= 0 || height <= 0 || width > 20_000 || height > 20_000) {
            throw new IllegalStateException("Refusing to render oversized layer " + layer +
                " " + cellSize + "m: " + width + "x" + height);
        }

        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        double maxLog = Math.max(1.0, bounds.maxLog);

        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT cx, cz, log_value FROM render_cell " +
                "WHERE snapshot_id = ? AND layer = ? AND cell_size = ?")) {
            ps.setLong(1, snapshotId);
            ps.setString(2, layer);
            ps.setInt(3, cellSize);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    int cx = rs.getInt("cx");
                    int cz = rs.getInt("cz");
                    double t = rs.getDouble("log_value") / maxLog;
                    int px = cx - bounds.minCx;
                    int py = bounds.maxCz - cz;
                    if (px >= 0 && px < width && py >= 0 && py < height) {
                        // Intensity-only pixels: the viewer applies the color ramp client-side.
                        // Alpha is binary (255 occupied / 0 empty) — partial alpha would quantize
                        // the gray value through premultiplication when the canvas reads it back.
                        int v = Math.max(1, (int) Math.round(255 * Math.max(0.0, Math.min(1.0, t))));
                        image.setRGB(px, py, 0xFF000000 | (v << 16) | (v << 8) | v);
                    }
                }
            }
        }

        String fileName = layer + "-" + cellSize + ".png";
        ImageIO.write(image, "png", new File(outDir, fileName));

        ObjectNode n = manifestLayers.addObject();
        n.put("id", layer + "-" + cellSize);
        n.put("layer", layer);
        n.put("label", label + " " + cellSize + "m");
        n.put("cellSize", cellSize);
        n.put("file", fileName);
        ObjectNode b = n.putObject("bounds");
        b.put("minX", bounds.minCx * (double) cellSize);
        b.put("maxX", (bounds.maxCx + 1) * (double) cellSize);
        b.put("minZ", bounds.minCz * (double) cellSize);
        b.put("maxZ", (bounds.maxCz + 1) * (double) cellSize);
        n.put("maxLog", bounds.maxLog);
        n.put("maxRaw", bounds.maxRaw);
        n.put("cellCount", bounds.cellCount);
        n.put("encoding", "gray8");
    }

    private void populateCells(Connection conn, String layer, int cellSize) throws SQLException {
        try (PreparedStatement del = conn.prepareStatement(
                "DELETE FROM render_cell WHERE snapshot_id = ? AND layer = ? AND cell_size = ?")) {
            del.setLong(1, snapshotId);
            del.setString(2, layer);
            del.setInt(3, cellSize);
            del.executeUpdate();
        }

        String sql;
        if ("build-density".equals(layer) || "dropped-items".equals(layer) || "all-zdos".equals(layer)) {
            // build-density and dropped-items are already surface-only by category; all-zdos is
            // the layer that needs INTERIOR removed explicitly.
            String categoryFilter =
                "build-density".equals(layer) ? "AND category = 'BUILDING' " :
                "dropped-items".equals(layer) ? "AND category = 'DROPPED_ITEM' " : SURFACE_ONLY;
            sql =
                "INSERT INTO render_cell " +
                "SELECT ?, ?, ?, CAST(FLOOR(x / ?) AS INTEGER) AS cx, CAST(FLOOR(z / ?) AS INTEGER) AS cz, " +
                "COUNT(*) AS count_value, CAST(COUNT(*) AS DOUBLE) AS sum_value, LN(1 + COUNT(*)) AS log_value " +
                "FROM zdo WHERE snapshot_id = ? " + categoryFilter +
                "AND x BETWEEN " + WORLD_MIN_X + " AND " + WORLD_MAX_X + " " +
                "AND z BETWEEN " + WORLD_MIN_Z + " AND " + WORLD_MAX_Z + " " +
                "GROUP BY cx, cz";
        } else if ("coins".equals(layer)) {
            sql =
                "INSERT INTO render_cell " +
                "SELECT ?, ?, ?, CAST(FLOOR(container_x / ?) AS INTEGER) AS cx, CAST(FLOOR(container_z / ?) AS INTEGER) AS cz, " +
                "COUNT(*) AS count_value, SUM(stack) AS sum_value, LN(1 + SUM(stack)) AS log_value " +
                "FROM container_item WHERE snapshot_id = ? AND item_name = 'Coins' " +
                "AND container_x BETWEEN " + WORLD_MIN_X + " AND " + WORLD_MAX_X + " " +
                "AND container_z BETWEEN " + WORLD_MIN_Z + " AND " + WORLD_MAX_Z + " " +
                "GROUP BY cx, cz";
        } else {
            throw new IllegalArgumentException("Unknown render layer: " + layer);
        }

        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setLong(1, snapshotId);
            ps.setString(2, layer);
            ps.setInt(3, cellSize);
            ps.setInt(4, cellSize);
            ps.setInt(5, cellSize);
            ps.setLong(6, snapshotId);
            ps.executeUpdate();
        }
    }

    private Bounds loadBounds(Connection conn, String layer, int cellSize) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT MIN(cx) AS min_cx, MAX(cx) AS max_cx, MIN(cz) AS min_cz, MAX(cz) AS max_cz, " +
                "MAX(log_value) AS max_log, MAX(sum_value) AS max_raw, COUNT(*) AS cell_count " +
                "FROM render_cell WHERE snapshot_id = ? AND layer = ? AND cell_size = ?")) {
            ps.setLong(1, snapshotId);
            ps.setString(2, layer);
            ps.setInt(3, cellSize);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next() || rs.getLong("cell_count") == 0) return null;
                Bounds b = new Bounds();
                b.minCx = rs.getInt("min_cx");
                b.maxCx = rs.getInt("max_cx");
                b.minCz = rs.getInt("min_cz");
                b.maxCz = rs.getInt("max_cz");
                b.maxLog = rs.getDouble("max_log");
                b.maxRaw = rs.getDouble("max_raw");
                b.cellCount = rs.getLong("cell_count");
                return b;
            }
        }
    }

    private static final class Bounds {
        int minCx;
        int maxCx;
        int minCz;
        int maxCz;
        double maxLog;
        double maxRaw;
        long cellCount;
    }
}
