package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Deterministic, exact, selection-local WebGPU scene package. */
public final class ScenePackage {
    public static final int DIRECT_LIMIT = 5_000;
    public static final int OVERRIDE_LIMIT = 250_000;
    public static final int INSTANCE_STRIDE = 80;
    public static final String CONTENT_TYPE = "application/vnd.comfysteward.scene";
    private static final double MIN_VISIBLE_AXIS = 0.01;
    private static final double UNKNOWN_MARKER_AXIS = 0.35;
    private static final double MAX_PROXY_AXIS = 20.0;
    private static final double MAX_PROXY_VOLUME = 2_000.0;
    private static final double HOME_ALL_MAX_SPAN = 600.0;
    private static final double HOME_CELL_METERS = 64.0;
    private static final Map<String, String> FAMILY_COLORS = familyColors();

    private final SnapshotRepository snapshots;
    private final ObjectMapper mapper;

    public ScenePackage(SnapshotRepository snapshots, ObjectMapper mapper) {
        this.snapshots = snapshots;
        this.mapper = mapper;
    }

    public Result build(long snapshotId, String lensId,
            double minX, double maxX, double minZ, double maxZ,
            List<String> biomes, boolean forced, String release) throws Exception {
        if (!"build-density".equals(lensId)) {
            throw new IllegalArgumentException("3D exploration is available for Build density only");
        }
        validateBounds(minX, maxX, minZ, maxZ);
        long pieceCount = count(snapshotId, minX, maxX, minZ, maxZ, biomes);
        if (pieceCount > OVERRIDE_LIMIT) {
            throw new CapacityException(false,
                "This selection exceeds the 250,000-piece 3D safety limit. Tighten the green area.");
        }
        if (!forced && pieceCount > DIRECT_LIMIT) {
            throw new CapacityException(true,
                "This selection exceeds 5,000 pieces. Confirm the exact 3D override from the map.");
        }
        if (pieceCount == 0) {
            throw new IllegalArgumentException("This selection contains no building pieces to explore in 3D");
        }
        List<Piece> pieces = query(snapshotId, minX, maxX, minZ, maxZ, biomes, (int) pieceCount);
        if (pieces.size() != pieceCount) {
            throw new IllegalStateException("The exact scene changed while it was being assembled");
        }

        Bounds bounds = orientedBounds(pieces);
        double[] origin = bounds.center();
        int real = 0;
        int estimated = 0;
        int unknown = 0;
        int proxyOutliers = 0;
        ByteBuffer instances = ByteBuffer.allocate(pieces.size() * INSTANCE_STRIDE)
            .order(ByteOrder.LITTLE_ENDIAN);
        LinkedHashMap<String, FamilyRange> families = new LinkedHashMap<>();
        double radius = 0;
        for (int index = 0; index < pieces.size(); index++) {
            Piece piece = pieces.get(index);
            FamilyRange family = families.get(piece.family);
            if (family == null) {
                family = new FamilyRange(piece.family, color(piece.family), index);
                families.put(piece.family, family);
            }
            family.count++;
            if (piece.quality == Quality.REAL) real++;
            else if (piece.quality == Quality.ESTIMATED) estimated++;
            else unknown++;
            if (piece.proxyOutlier) proxyOutliers++;

            double[] localCenter = {
                -(piece.center[0] - origin[0]),
                piece.center[1] - origin[1],
                piece.center[2] - origin[2]
            };
            double[][] mirrored = mirrorX(piece.rotation);
            double[][] linear = new double[3][3];
            for (int row = 0; row < 3; row++) {
                for (int column = 0; column < 3; column++) {
                    linear[row][column] = mirrored[row][column] * piece.extents[column];
                }
            }
            putModel(instances, linear, localCenter);
            float[] rgba = hexColor(piece.quality == Quality.UNKNOWN
                ? FAMILY_COLORS.get("unknown") : family.color);
            for (float channel : rgba) instances.putFloat(channel);
            radius = Math.max(radius, length(localCenter) + length(piece.extents) / 2.0);
        }
        byte[] instanceBytes = instances.array();
        String instanceSha = sha256(instanceBytes);
        ReleaseReceipt receipt = releaseReceipt();
        HomeFrame home = homeFrame(pieces, bounds, origin, radius);

        ObjectNode manifest = mapper.createObjectNode();
        manifest.put("schema", "steward-zdo-scene/v1");
        manifest.put("snapshotId", snapshotId);
        manifest.put("snapshotHash", receipt.snapshotHash);
        manifest.put("release", release == null ? "" : release);
        manifest.put("lens", lensId);
        manifest.put("exact", true);
        manifest.put("forced", forced);
        manifest.put("pieces", pieces.size());
        manifest.put("triangles", pieces.size() * 12L);
        manifest.put("instanceStride", INSTANCE_STRIDE);
        manifest.put("instanceBytes", instanceBytes.length);
        manifest.put("instanceSha256", instanceSha);
        manifest.put("buildingGeometrySha256", receipt.buildingGeometrySha256);
        manifest.put("pieceGeometrySha256", receipt.pieceGeometrySha256);
        manifest.put("coordinateContract", "selection-local right-handed; absolute origin withheld");
        manifest.put("floorY", round(bounds.low[1] - origin[1], 3));
        manifest.put("radiusM", round(Math.max(radius, 1.0), 3));
        ArrayNode dimensions = manifest.putArray("dimensionsM");
        dimensions.add(round(bounds.high[0] - bounds.low[0], 2));
        dimensions.add(round(bounds.high[1] - bounds.low[1], 2));
        dimensions.add(round(bounds.high[2] - bounds.low[2], 2));
        ObjectNode homeNode = manifest.putObject("home");
        homeNode.put("strategy", home.strategy);
        homeNode.put("pieces", home.pieces);
        homeNode.put("radiusM", round(home.radius, 3));
        homeNode.put("floorY", round(home.floorY, 3));
        ArrayNode homeTarget = homeNode.putArray("target");
        for (double value : home.target) homeTarget.add(round(value, 3));
        ObjectNode scope = manifest.putObject("scope");
        scope.put("minX", minX); scope.put("maxX", maxX);
        scope.put("minZ", minZ); scope.put("maxZ", maxZ);
        ArrayNode selectedBiomes = scope.putArray("biomes");
        biomes.forEach(selectedBiomes::add);
        ObjectNode coverage = manifest.putObject("geometryCoverage");
        coverage.put("real", real);
        coverage.put("estimated", estimated);
        coverage.put("unknown", unknown);
        coverage.put("proxyOutliers", proxyOutliers);
        coverage.put("unknownMarkerM", UNKNOWN_MARKER_AXIS);
        ArrayNode familyNodes = manifest.putArray("families");
        for (FamilyRange family : families.values()) {
            ObjectNode node = familyNodes.addObject();
            node.put("name", family.name);
            node.put("color", family.color);
            node.put("start", family.start);
            node.put("count", family.count);
        }
        manifest.put("warmupFrames", 30);
        manifest.put("benchmarkFrames", 300);

        byte[] manifestBytes = mapper.writeValueAsBytes(manifest);
        int instanceOffset = align4(16 + manifestBytes.length);
        ByteBuffer result = ByteBuffer.allocate(instanceOffset + instanceBytes.length)
            .order(ByteOrder.LITTLE_ENDIAN);
        result.put("SV3D".getBytes(StandardCharsets.US_ASCII));
        result.putInt(1);
        result.putInt(manifestBytes.length);
        result.putInt(instanceOffset);
        result.put(manifestBytes);
        while (result.position() < instanceOffset) result.put((byte) 0);
        result.put(instanceBytes);
        return new Result(result.array(), manifest, pieces.size());
    }

    private List<Piece> query(long snapshotId, double minX, double maxX,
            double minZ, double maxZ, List<String> biomes, int limit) throws SQLException {
        StringBuilder biomeSql = new StringBuilder();
        if (!biomes.isEmpty()) {
            biomeSql.append(" AND z.biome IN (");
            for (int i = 0; i < biomes.size(); i++) {
                if (i > 0) biomeSql.append(',');
                biomeSql.append('?');
            }
            biomeSql.append(')');
        }
        String sql = "SELECT z.zdo_index, z.x, z.y, z.z, z.has_rot, z.rot_x, z.rot_y, z.rot_z, " +
            "pg.family, pg.geometry_source, pg.extent_x, pg.extent_y, pg.extent_z, " +
            "pg.center_x, pg.center_y, pg.center_z FROM zdo z " +
            "LEFT JOIN prefab_geometry pg USING (prefab_hash) WHERE z.snapshot_id = ? " +
            "AND z.category = 'BUILDING' AND z.x >= ? AND z.x <= ? AND z.z >= ? AND z.z <= ?" +
            biomeSql + " ORDER BY COALESCE(pg.family, 'unknown'), z.zdo_index LIMIT ?";
        List<Piece> result = new ArrayList<>(Math.min(limit + 1, 8_192));
        try (Connection connection = snapshots.open();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            int parameter = 1;
            statement.setLong(parameter++, snapshotId);
            statement.setDouble(parameter++, minX);
            statement.setDouble(parameter++, maxX);
            statement.setDouble(parameter++, minZ);
            statement.setDouble(parameter++, maxZ);
            for (String biome : biomes) statement.setString(parameter++, biome);
            statement.setInt(parameter, limit + 1);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) result.add(readPiece(rows));
            }
        }
        return result;
    }

    private long count(long snapshotId, double minX, double maxX,
            double minZ, double maxZ, List<String> biomes) throws SQLException {
        StringBuilder biomeSql = new StringBuilder();
        if (!biomes.isEmpty()) {
            biomeSql.append(" AND biome IN (");
            for (int i = 0; i < biomes.size(); i++) {
                if (i > 0) biomeSql.append(',');
                biomeSql.append('?');
            }
            biomeSql.append(')');
        }
        String sql = "SELECT COUNT(*) FROM zdo WHERE snapshot_id = ? AND category = 'BUILDING' " +
            "AND x >= ? AND x <= ? AND z >= ? AND z <= ?" + biomeSql;
        try (Connection connection = snapshots.open();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            int parameter = 1;
            statement.setLong(parameter++, snapshotId);
            statement.setDouble(parameter++, minX);
            statement.setDouble(parameter++, maxX);
            statement.setDouble(parameter++, minZ);
            statement.setDouble(parameter++, maxZ);
            for (String biome : biomes) statement.setString(parameter++, biome);
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next()) throw new IllegalStateException("The exact scene count is unavailable");
                return row.getLong(1);
            }
        }
    }

    private static Piece readPiece(ResultSet row) throws SQLException {
        boolean known = row.getString("family") != null;
        double[] measuredExtents = known
            ? new double[] { row.getDouble("extent_x"), row.getDouble("extent_y"), row.getDouble("extent_z") }
            : new double[] { UNKNOWN_MARKER_AXIS, UNKNOWN_MARKER_AXIS, UNKNOWN_MARKER_AXIS };
        boolean proxyOutlier = known && !safeProxyEnvelope(measuredExtents);
        String family = known ? row.getString("family") : "unknown";
        String source = !known ? "unknown" : proxyOutlier ? "proxy-outlier" : row.getString("geometry_source");
        Quality quality = !known || proxyOutlier ? Quality.UNKNOWN :
            ("family_median".equals(source) ? Quality.ESTIMATED : Quality.REAL);
        double[] extents = proxyOutlier
            ? new double[] { UNKNOWN_MARKER_AXIS, UNKNOWN_MARKER_AXIS, UNKNOWN_MARKER_AXIS }
            : measuredExtents;
        for (int i = 0; i < 3; i++) extents[i] = Math.max(MIN_VISIBLE_AXIS, extents[i]);
        double[][] rotation = row.getBoolean("has_rot")
            ? rotation(row.getDouble("rot_x"), row.getDouble("rot_y"), row.getDouble("rot_z"))
            : identity();
        double[] pivot = { row.getDouble("x"), row.getDouble("y"), row.getDouble("z") };
        double[] offset = known && !proxyOutlier
            ? new double[] { row.getDouble("center_x"), row.getDouble("center_y"), row.getDouble("center_z") }
            : new double[3];
        double[] rotatedOffset = multiply(rotation, offset);
        double[] center = {
            pivot[0] + rotatedOffset[0], pivot[1] + rotatedOffset[1], pivot[2] + rotatedOffset[2]
        };
        for (double value : center) {
            if (!Double.isFinite(value)) throw new IllegalStateException("Scene contains a non-finite transform");
        }
        return new Piece(row.getLong("zdo_index"), family, source, quality, extents, rotation, center, proxyOutlier);
    }

    private static boolean safeProxyEnvelope(double[] extents) {
        double volume = 1;
        for (double extent : extents) {
            if (!Double.isFinite(extent) || extent > MAX_PROXY_AXIS) return false;
            volume *= Math.max(MIN_VISIBLE_AXIS, extent);
        }
        return Double.isFinite(volume) && volume <= MAX_PROXY_VOLUME;
    }

    private static HomeFrame homeFrame(List<Piece> pieces, Bounds bounds, double[] origin, double radius) {
        double maxSpan = Math.max(bounds.high[0] - bounds.low[0],
            Math.max(bounds.high[1] - bounds.low[1], bounds.high[2] - bounds.low[2]));
        if (maxSpan <= HOME_ALL_MAX_SPAN) {
            return new HomeFrame("selection-all", pieces.size(), new double[3],
                Math.max(radius, 1.0), bounds.low[1] - origin[1]);
        }

        LinkedHashMap<Cell, Integer> cellCounts = new LinkedHashMap<>();
        for (Piece piece : pieces) {
            Cell cell = cell(localCenter(piece, origin));
            cellCounts.merge(cell, 1, Integer::sum);
        }
        Cell best = null;
        int bestCount = -1;
        double bestDistance = Double.POSITIVE_INFINITY;
        for (Cell candidate : cellCounts.keySet()) {
            int neighborhood = 0;
            for (int dx = -1; dx <= 1; dx++) {
                for (int dy = -1; dy <= 1; dy++) {
                    for (int dz = -1; dz <= 1; dz++) {
                        neighborhood += cellCounts.getOrDefault(
                            new Cell(candidate.x + dx, candidate.y + dy, candidate.z + dz), 0);
                    }
                }
            }
            double distance = candidate.x * candidate.x + candidate.y * candidate.y + candidate.z * candidate.z;
            if (neighborhood > bestCount || neighborhood == bestCount && distance < bestDistance) {
                best = candidate;
                bestCount = neighborhood;
                bestDistance = distance;
            }
        }

        double[] low = { Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY };
        double[] high = { Double.NEGATIVE_INFINITY, Double.NEGATIVE_INFINITY, Double.NEGATIVE_INFINITY };
        int homePieces = 0;
        for (Piece piece : pieces) {
            double[] center = localCenter(piece, origin);
            Cell cell = cell(center);
            if (Math.abs(cell.x - best.x) > 1 || Math.abs(cell.y - best.y) > 1 ||
                    Math.abs(cell.z - best.z) > 1) continue;
            homePieces++;
            double[] half = { piece.extents[0] / 2, piece.extents[1] / 2, piece.extents[2] / 2 };
            for (int axis = 0; axis < 3; axis++) {
                double reach = Math.abs(piece.rotation[axis][0]) * half[0] +
                    Math.abs(piece.rotation[axis][1]) * half[1] +
                    Math.abs(piece.rotation[axis][2]) * half[2];
                low[axis] = Math.min(low[axis], center[axis] - reach);
                high[axis] = Math.max(high[axis], center[axis] + reach);
            }
        }
        double[] target = {
            (low[0] + high[0]) / 2, (low[1] + high[1]) / 2, (low[2] + high[2]) / 2
        };
        double homeRadius = 0;
        for (int mask = 0; mask < 8; mask++) {
            double[] corner = {
                (mask & 1) == 0 ? low[0] : high[0],
                (mask & 2) == 0 ? low[1] : high[1],
                (mask & 4) == 0 ? low[2] : high[2]
            };
            homeRadius = Math.max(homeRadius, length(new double[] {
                corner[0] - target[0], corner[1] - target[1], corner[2] - target[2]
            }));
        }
        return new HomeFrame("densest-cluster", homePieces, target,
            Math.max(homeRadius, 1.0), low[1]);
    }

    private static double[] localCenter(Piece piece, double[] origin) {
        return new double[] {
            -(piece.center[0] - origin[0]), piece.center[1] - origin[1], piece.center[2] - origin[2]
        };
    }

    private static Cell cell(double[] center) {
        return new Cell((long) Math.floor(center[0] / HOME_CELL_METERS),
            (long) Math.floor(center[1] / HOME_CELL_METERS),
            (long) Math.floor(center[2] / HOME_CELL_METERS));
    }

    private ReleaseReceipt releaseReceipt() throws SQLException {
        try (Connection connection = snapshots.open();
             PreparedStatement statement = connection.prepareStatement(
                 "SELECT snapshot_hash, building_geometry_sha256, piece_geometry_sha256 FROM release_metadata");
             ResultSet row = statement.executeQuery()) {
            if (!row.next()) throw new IllegalStateException("Public scene metadata is missing");
            return new ReleaseReceipt(row.getString(1), row.getString(2), row.getString(3));
        }
    }

    private static Bounds orientedBounds(List<Piece> pieces) {
        double[] low = { Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY };
        double[] high = { Double.NEGATIVE_INFINITY, Double.NEGATIVE_INFINITY, Double.NEGATIVE_INFINITY };
        for (Piece piece : pieces) {
            double[] half = { piece.extents[0] / 2, piece.extents[1] / 2, piece.extents[2] / 2 };
            for (int axis = 0; axis < 3; axis++) {
                double reach = Math.abs(piece.rotation[axis][0]) * half[0] +
                    Math.abs(piece.rotation[axis][1]) * half[1] +
                    Math.abs(piece.rotation[axis][2]) * half[2];
                low[axis] = Math.min(low[axis], piece.center[axis] - reach);
                high[axis] = Math.max(high[axis], piece.center[axis] + reach);
            }
        }
        return new Bounds(low, high);
    }

    /** Unity Euler: apply Z, then X, then Y; column-vector product Ry * Rx * Rz. */
    static double[][] rotation(double xDegrees, double yDegrees, double zDegrees) {
        double x = Math.toRadians(xDegrees), y = Math.toRadians(yDegrees), z = Math.toRadians(zDegrees);
        double cx = Math.cos(x), sx = Math.sin(x);
        double cy = Math.cos(y), sy = Math.sin(y);
        double cz = Math.cos(z), sz = Math.sin(z);
        double[][] rx = {{1,0,0},{0,cx,-sx},{0,sx,cx}};
        double[][] ry = {{cy,0,sy},{0,1,0},{-sy,0,cy}};
        double[][] rz = {{cz,-sz,0},{sz,cz,0},{0,0,1}};
        return multiply(multiply(ry, rx), rz);
    }

    private static double[][] identity() {
        return new double[][] {{1,0,0},{0,1,0},{0,0,1}};
    }

    private static double[][] multiply(double[][] a, double[][] b) {
        double[][] result = new double[3][3];
        for (int row = 0; row < 3; row++) {
            for (int column = 0; column < 3; column++) {
                for (int k = 0; k < 3; k++) result[row][column] += a[row][k] * b[k][column];
            }
        }
        return result;
    }

    private static double[] multiply(double[][] matrix, double[] vector) {
        return new double[] {
            matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2],
            matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2],
            matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2]
        };
    }

    private static double[][] mirrorX(double[][] rotation) {
        double[] mirror = {-1, 1, 1};
        double[][] result = new double[3][3];
        for (int row = 0; row < 3; row++) {
            for (int column = 0; column < 3; column++) {
                result[row][column] = mirror[row] * rotation[row][column] * mirror[column];
            }
        }
        return result;
    }

    private static void putModel(ByteBuffer buffer, double[][] linear, double[] center) {
        // Column-major mat4, matching WGSL mat4x4f construction and the proven R&D renderer.
        for (int column = 0; column < 4; column++) {
            for (int row = 0; row < 4; row++) {
                double value;
                if (column < 3 && row < 3) value = linear[row][column];
                else if (column == 3 && row < 3) value = center[row];
                else value = column == 3 && row == 3 ? 1 : 0;
                buffer.putFloat((float) value);
            }
        }
    }

    private static int align4(int value) { return (value + 3) & ~3; }
    private static double length(double[] value) {
        return Math.sqrt(value[0] * value[0] + value[1] * value[1] + value[2] * value[2]);
    }
    private static double round(double value, int places) {
        double scale = Math.pow(10, places);
        return Math.round(value * scale) / scale;
    }
    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static String color(String family) {
        return FAMILY_COLORS.getOrDefault(family, FAMILY_COLORS.get("misc"));
    }

    private static float[] hexColor(String value) {
        return new float[] {
            Integer.parseInt(value.substring(1, 3), 16) / 255f,
            Integer.parseInt(value.substring(3, 5), 16) / 255f,
            Integer.parseInt(value.substring(5, 7), 16) / 255f,
            1f
        };
    }

    private static Map<String, String> familyColors() {
        LinkedHashMap<String, String> result = new LinkedHashMap<>();
        result.put("wall", "#9e9e9e"); result.put("roof", "#c0392b");
        result.put("floor", "#79553d"); result.put("door", "#27ae60");
        result.put("gate", "#16a085"); result.put("window", "#29b6f6");
        result.put("stair", "#e67e22"); result.put("beam", "#6d4c41");
        result.put("pole", "#8d6e63"); result.put("fence", "#a1887f");
        result.put("light", "#f1c40f"); result.put("seat", "#9b59b6");
        result.put("table", "#8e44ad"); result.put("bed", "#ba68c8");
        result.put("container", "#af7ac5"); result.put("portal", "#00e5ff");
        result.put("sign", "#fff176"); result.put("item_stand", "#ce93d8");
        result.put("ballista", "#ff8a65"); result.put("unknown", "#ff5b62");
        result.put("misc", "#cfd8dc");
        return Map.copyOf(result);
    }

    private static void validateBounds(double minX, double maxX, double minZ, double maxZ) {
        if (!Double.isFinite(minX) || !Double.isFinite(maxX) || !Double.isFinite(minZ) ||
                !Double.isFinite(maxZ) || minX >= maxX || minZ >= maxZ) {
            throw new IllegalArgumentException("Invalid selection bounds");
        }
    }

    public record Result(byte[] bytes, ObjectNode manifest, int pieces) {}

    public static final class CapacityException extends IllegalArgumentException {
        private final boolean overrideAvailable;
        CapacityException(boolean overrideAvailable, String message) {
            super(message);
            this.overrideAvailable = overrideAvailable;
        }
        public boolean overrideAvailable() { return overrideAvailable; }
    }

    private enum Quality { REAL, ESTIMATED, UNKNOWN }
    private record Piece(long zdoIndex, String family, String source, Quality quality,
                         double[] extents, double[][] rotation, double[] center, boolean proxyOutlier) {}
    private record Cell(long x, long y, long z) {}
    private record HomeFrame(String strategy, int pieces, double[] target, double radius, double floorY) {}
    private record ReleaseReceipt(String snapshotHash, String buildingGeometrySha256,
                                  String pieceGeometrySha256) {}
    private record Bounds(double[] low, double[] high) {
        double[] center() {
            return new double[] {
                (low[0] + high[0]) / 2, (low[1] + high[1]) / 2, (low[2] + high[2]) / 2
            };
        }
    }
    private static final class FamilyRange {
        private final String name;
        private final String color;
        private final int start;
        private int count;
        private FamilyRange(String name, String color, int start) {
            this.name = name; this.color = color; this.start = start;
        }
    }
}
