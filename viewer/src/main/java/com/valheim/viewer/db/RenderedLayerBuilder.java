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
        manifest.put("snapshotId", snapshotId);
        manifest.put("generatedAt", Instant.now().toString());
        ArrayNode layers = manifest.putArray("layers");

        try (Connection conn = DriverManager.getConnection("jdbc:duckdb:" + cacheFile.getAbsolutePath())) {
            for (int cellSize : DEFAULT_CELL_SIZES) {
                renderLayer(conn, outDir, layers, "build-density", "Build Density", cellSize);
                renderLayer(conn, outDir, layers, "coins", "Container Coins", cellSize);
            }
        }

        File manifestFile = new File(outDir, "manifest.json");
        mapper.writerWithDefaultPrettyPrinter().writeValue(manifestFile, manifest);
        return manifestFile;
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
                        image.setRGB(px, py, heatColor(t));
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
        n.put("cellCount", bounds.cellCount);
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
        if ("build-density".equals(layer)) {
            sql =
                "INSERT INTO render_cell " +
                "SELECT ?, ?, ?, CAST(FLOOR(x / ?) AS INTEGER) AS cx, CAST(FLOOR(z / ?) AS INTEGER) AS cz, " +
                "COUNT(*) AS count_value, CAST(COUNT(*) AS DOUBLE) AS sum_value, LN(1 + COUNT(*)) AS log_value " +
                "FROM zdo WHERE snapshot_id = ? AND category = 'BUILDING' " +
                "AND ABS(x) < 100000 AND ABS(z) < 100000 " +
                "GROUP BY cx, cz";
        } else if ("coins".equals(layer)) {
            sql =
                "INSERT INTO render_cell " +
                "SELECT ?, ?, ?, CAST(FLOOR(container_x / ?) AS INTEGER) AS cx, CAST(FLOOR(container_z / ?) AS INTEGER) AS cz, " +
                "COUNT(*) AS count_value, SUM(stack) AS sum_value, LN(1 + SUM(stack)) AS log_value " +
                "FROM container_item WHERE snapshot_id = ? AND item_name = 'Coins' " +
                "AND ABS(container_x) < 100000 AND ABS(container_z) < 100000 " +
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
                "MAX(log_value) AS max_log, COUNT(*) AS cell_count " +
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
                b.cellCount = rs.getLong("cell_count");
                return b;
            }
        }
    }

    private static int heatColor(double tRaw) {
        double t = Math.max(0.0, Math.min(1.0, tRaw));
        int alpha = (int) Math.round(50 + 205 * t);
        int r;
        int g;
        int b;
        if (t < 0.25) {
            r = 0;
            g = 0;
            b = (int) Math.round(255 * t * 4);
        } else if (t < 0.5) {
            r = 0;
            g = (int) Math.round(255 * (t - 0.25) * 4);
            b = 255;
        } else if (t < 0.75) {
            r = (int) Math.round(255 * (t - 0.5) * 4);
            g = 255;
            b = (int) Math.round(255 * (1 - (t - 0.5) * 4));
        } else {
            r = 255;
            g = (int) Math.round(255 * (1 - (t - 0.75) * 4));
            b = 0;
        }
        return ((alpha & 0xFF) << 24) | ((r & 0xFF) << 16) | ((g & 0xFF) << 8) | (b & 0xFF);
    }

    private static final class Bounds {
        int minCx;
        int maxCx;
        int minCz;
        int maxCz;
        double maxLog;
        long cellCount;
    }
}
