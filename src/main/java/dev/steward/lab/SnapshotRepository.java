package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.ConcurrentHashMap;

public final class SnapshotRepository {
    private final Path cachePath;
    private final LensRegistry lenses;
    private final ObjectMapper mapper;
    private final Map<String, Double> worldTotals = new ConcurrentHashMap<>();

    public SnapshotRepository(Path cachePath, LensRegistry lenses, ObjectMapper mapper) throws Exception {
        this.cachePath = cachePath;
        this.lenses = lenses;
        this.mapper = mapper;
        Class.forName("org.duckdb.DuckDBDriver");
    }

    public Path cachePath() {
        return cachePath;
    }

    public boolean available() {
        return Files.isRegularFile(cachePath);
    }

    public Connection open() throws SQLException {
        if (!available()) throw new SQLException("Analytics cache not found: " + cachePath);
        Properties properties = new Properties();
        properties.setProperty("duckdb.read_only", "true");
        return DriverManager.getConnection("jdbc:duckdb:" + cachePath, properties);
    }

    public List<Snapshot> snapshots() throws SQLException {
        List<Snapshot> result = new ArrayList<>();
        try (Connection connection = open();
             PreparedStatement statement = connection.prepareStatement(
                 "SELECT snapshot_id, world_id, world_name, source, backup_id, parsed_at, " +
                 "file_hash, prefab_dictionary_version, " +
                 "(SELECT COUNT(*) FROM zdo z WHERE z.snapshot_id = w.snapshot_id) AS zdo_count " +
                 "FROM world_snapshot w ORDER BY snapshot_id DESC");
             ResultSet rows = statement.executeQuery()) {
            while (rows.next()) {
                result.add(new Snapshot(
                    rows.getLong("snapshot_id"), rows.getString("world_id"),
                    rows.getString("world_name"), rows.getString("source"),
                    rows.getString("backup_id"), rows.getString("parsed_at"),
                    rows.getString("file_hash"), rows.getString("prefab_dictionary_version"),
                    rows.getLong("zdo_count")));
            }
        }
        return result;
    }

    public Snapshot requireSnapshot(long snapshotId) throws SQLException {
        return snapshots().stream().filter(s -> s.snapshotId() == snapshotId).findFirst()
            .orElseThrow(() -> new IllegalArgumentException("Snapshot not found: " + snapshotId));
    }

    public long latestSnapshotId() throws SQLException {
        try (Connection connection = open();
             PreparedStatement statement = connection.prepareStatement(
                 "SELECT MAX(snapshot_id) FROM world_snapshot");
             ResultSet row = statement.executeQuery()) {
            if (!row.next() || row.getLong(1) <= 0) throw new SQLException("Cache has no snapshots");
            return row.getLong(1);
        }
    }

    public ObjectNode selection(long snapshotId, String lensId,
            double minX, double maxX, double minZ, double maxZ, int topN) throws SQLException {
        validateBounds(minX, maxX, minZ, maxZ);
        LensDefinition lens = lenses.require(lensId);
        topN = topN <= 0 ? 0 : Math.max(1, Math.min(50, topN));
        double selectedTotal;
        long positionCount;
        int categoryCount = 0;
        ArrayNode top = mapper.createArrayNode();

        try (Connection connection = open()) {
            selectedTotal = scalarValue(connection, snapshotId, lens, minX, maxX, minZ, maxZ);
            positionCount = lens.source() == LensDefinition.Source.ZDO
                ? Math.round(selectedTotal)
                : positionCount(connection, snapshotId, lens, minX, maxX, minZ, maxZ);
            String group = lens.groupExpression();
            String groupedSql = "SELECT " + group + " AS label, " + lens.valueExpression() + " AS value " +
                "FROM " + lens.table() + " WHERE snapshot_id = ? AND " + lens.predicate() +
                boundsClause(lens) + " GROUP BY 1";
            String sql = "SELECT label, value, COUNT(*) OVER () AS category_count FROM (" +
                groupedSql + ") AS lens_groups ORDER BY value DESC" + (topN > 0 ? " LIMIT ?" : "");
            try (PreparedStatement statement = connection.prepareStatement(sql)) {
                int index = bindBounds(statement, 1, snapshotId, minX, maxX, minZ, maxZ);
                if (topN > 0) statement.setInt(index, topN);
                try (ResultSet rows = statement.executeQuery()) {
                    while (rows.next()) {
                        categoryCount = rows.getInt("category_count");
                        ObjectNode item = top.addObject();
                        item.put("label", rows.getString("label"));
                        item.put("value", rows.getDouble("value"));
                    }
                }
            }
        }

        double worldTotal = worldTotals.computeIfAbsent(snapshotId + ":" + lensId, ignored -> {
            try (Connection connection = open()) {
                return scalarValue(connection, snapshotId, lens, null, null, null, null);
            } catch (SQLException e) {
                throw new WorldTotalException(e);
            }
        });

        double areaKm2 = ((maxX - minX) * (maxZ - minZ)) / 1_000_000.0;
        ObjectNode result = mapper.createObjectNode();
        result.put("snapshotId", snapshotId);
        result.put("lensId", lensId);
        result.put("lensLabel", lens.label());
        ObjectNode bounds = result.putObject("bounds");
        bounds.put("minX", minX); bounds.put("maxX", maxX);
        bounds.put("minZ", minZ); bounds.put("maxZ", maxZ);
        result.put("total", selectedTotal);
        result.put("worldTotal", worldTotal);
        result.put("worldSharePct", worldTotal == 0 ? 0 : selectedTotal / worldTotal * 100.0);
        result.put("areaSquareKm", areaKm2);
        result.put("densityPerSquareKm", areaKm2 == 0 ? 0 : selectedTotal / areaKm2);
        result.put("positionCount", positionCount);
        result.put("categoryCount", categoryCount);
        result.put("returnedCategories", top.size());
        result.put("completeCategories", topN == 0 || top.size() >= categoryCount);
        result.put("units", lens.units());
        result.set("top", top);
        return result;
    }

    public ObjectNode exactPoints(long snapshotId, String lensId,
            double minX, double maxX, double minZ, double maxZ, int requestedLimit) throws SQLException {
        validateBounds(minX, maxX, minZ, maxZ);
        LensDefinition lens = lenses.require(lensId);
        int limit = Math.max(1, Math.min(5_000, requestedLimit));
        ArrayNode points = mapper.createArrayNode();
        boolean truncated = false;

        String sql;
        if (lens.source() == LensDefinition.Source.ZDO) {
            sql = "SELECT " + lens.xColumn() + " AS x, " + lens.zColumn() + " AS z, " +
                lens.groupExpression() + " AS label, 1 AS value FROM " + lens.table() +
                " WHERE snapshot_id = ? AND " + lens.predicate() + boundsClause(lens) + " LIMIT ?";
        } else {
            sql = "SELECT " + lens.xColumn() + " AS x, " + lens.zColumn() + " AS z, " +
                lens.groupExpression() + " AS label, " + lens.valueExpression() + " AS value FROM " +
                lens.table() + " WHERE snapshot_id = ? AND " + lens.predicate() + boundsClause(lens) +
                " GROUP BY 1,2,3 LIMIT ?";
        }

        try (Connection connection = open();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            int index = bindBounds(statement, 1, snapshotId, minX, maxX, minZ, maxZ);
            statement.setInt(index, limit + 1);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    if (points.size() == limit) { truncated = true; break; }
                    ObjectNode point = points.addObject();
                    point.put("x", rows.getDouble("x"));
                    point.put("z", rows.getDouble("z"));
                    point.put("label", rows.getString("label"));
                    point.put("value", rows.getDouble("value"));
                }
            }
        }

        // A database-order prefix is spatially biased and must never masquerade as an
        // exact viewport. Keep the complete raster authoritative until every point in
        // the viewport fits within the client budget.
        if (truncated) points.removeAll();

        ObjectNode result = mapper.createObjectNode();
        result.put("snapshotId", snapshotId);
        result.put("lensId", lensId);
        result.put("limit", limit);
        result.put("minimumCount", truncated ? limit + 1 : points.size());
        result.put("truncated", truncated);
        result.set("points", points);
        return result;
    }

    private double scalarValue(Connection connection, long snapshotId, LensDefinition lens,
            Double minX, Double maxX, Double minZ, Double maxZ) throws SQLException {
        boolean bounded = minX != null;
        String sql = "SELECT COALESCE(" + lens.valueExpression() + ", 0) AS value FROM " +
            lens.table() + " WHERE snapshot_id = ? AND " + lens.predicate() +
            (bounded ? boundsClause(lens) : "");
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setLong(1, snapshotId);
            if (bounded) {
                statement.setDouble(2, minX);
                statement.setDouble(3, maxX);
                statement.setDouble(4, minZ);
                statement.setDouble(5, maxZ);
            }
            try (ResultSet row = statement.executeQuery()) {
                return row.next() ? row.getDouble("value") : 0;
            }
        }
    }

    private long positionCount(Connection connection, long snapshotId, LensDefinition lens,
            double minX, double maxX, double minZ, double maxZ) throws SQLException {
        String boundedRows = "SELECT " + lens.xColumn() + " AS x, " + lens.zColumn() + " AS z, " +
            lens.groupExpression() + " AS label FROM " + lens.table() +
            " WHERE snapshot_id = ? AND " + lens.predicate() + boundsClause(lens);
        String sql = lens.source() == LensDefinition.Source.ZDO
            ? "SELECT COUNT(*) AS value FROM (" + boundedRows + ") AS positions"
            : "SELECT COUNT(*) AS value FROM (" + boundedRows + " GROUP BY 1,2,3) AS positions";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            bindBounds(statement, 1, snapshotId, minX, maxX, minZ, maxZ);
            try (ResultSet row = statement.executeQuery()) {
                return row.next() ? row.getLong("value") : 0;
            }
        }
    }

    private static String boundsClause(LensDefinition lens) {
        return " AND " + lens.xColumn() + " >= ? AND " + lens.xColumn() + " <= ?" +
            " AND " + lens.zColumn() + " >= ? AND " + lens.zColumn() + " <= ?";
    }

    private static int bindBounds(PreparedStatement statement, int index, long snapshotId,
            double minX, double maxX, double minZ, double maxZ) throws SQLException {
        statement.setLong(index++, snapshotId);
        statement.setDouble(index++, minX);
        statement.setDouble(index++, maxX);
        statement.setDouble(index++, minZ);
        statement.setDouble(index++, maxZ);
        return index;
    }

    private static void validateBounds(double minX, double maxX, double minZ, double maxZ) {
        if (!Double.isFinite(minX) || !Double.isFinite(maxX) ||
                !Double.isFinite(minZ) || !Double.isFinite(maxZ) ||
                minX >= maxX || minZ >= maxZ) {
            throw new IllegalArgumentException("Invalid selection bounds");
        }
    }

    public record Snapshot(long snapshotId, String worldId, String worldName, String source,
            String backupId, String parsedAt, String fileHash, String dictionaryVersion,
            long zdoCount) {
        public ObjectNode toJson(ObjectMapper mapper) {
            ObjectNode node = mapper.createObjectNode();
            node.put("snapshotId", snapshotId);
            node.put("worldId", worldId);
            node.put("worldName", worldName);
            node.put("source", source);
            node.put("backupId", backupId);
            node.put("parsedAt", parsedAt);
            node.put("fileHash", fileHash);
            node.put("dictionaryVersion", dictionaryVersion);
            node.put("zdoCount", zdoCount);
            return node;
        }
    }

    private static final class WorldTotalException extends RuntimeException {
        WorldTotalException(Throwable cause) { super(cause); }
    }
}
