package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.LinkedHashMap;
import java.util.Properties;
import java.util.concurrent.ConcurrentHashMap;

public final class SnapshotRepository {
    private final Path cachePath;
    private final LensRegistry lenses;
    private final ObjectMapper mapper;
    private final boolean constrained;
    private final Map<String, Double> worldTotals = new ConcurrentHashMap<>();

    public SnapshotRepository(Path cachePath, LensRegistry lenses, ObjectMapper mapper) throws Exception {
        this(cachePath, lenses, mapper, false);
    }

    public SnapshotRepository(Path cachePath, LensRegistry lenses, ObjectMapper mapper,
            boolean constrained) throws Exception {
        this.cachePath = cachePath;
        this.lenses = lenses;
        this.mapper = mapper;
        this.constrained = constrained;
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
        Connection connection = DriverManager.getConnection("jdbc:duckdb:" + cachePath, properties);
        if (constrained) {
            try (var statement = connection.createStatement()) {
                statement.execute("SET threads = 2");
                statement.execute("SET memory_limit = '1GB'");
            } catch (SQLException error) {
                connection.close();
                throw error;
            }
        }
        return connection;
    }

    public List<Snapshot> snapshots() throws SQLException {
        List<Snapshot> result = new ArrayList<>();
        String zdoCountExpression = constrained ? "0" :
            "(SELECT COUNT(*) FROM zdo z WHERE z.snapshot_id = w.snapshot_id)";
        try (Connection connection = open();
             PreparedStatement statement = connection.prepareStatement(
                 "SELECT snapshot_id, world_id, world_name, source, backup_id, parsed_at, " +
                 "file_hash, prefab_dictionary_version, " +
                 zdoCountExpression + " AS zdo_count " +
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

    public void validatePublicRelease(TerrainContext context) throws SQLException {
        try (Connection connection = open();
             PreparedStatement statement = connection.prepareStatement(
                 "SELECT schema_version, snapshot_id, snapshot_hash, biome_mask_sha256, " +
                 "building_geometry_sha256, piece_geometry_sha256, building_geometry_rows, " +
                 "geometry_catalog_rows, known_geometry_rows, real_geometry_rows, estimated_geometry_rows " +
                 "FROM release_metadata");
             ResultSet row = statement.executeQuery()) {
            if (!row.next() || row.getInt("schema_version") != PublicCacheExporter.SCHEMA_VERSION ||
                    row.getLong("snapshot_id") != context.snapshotId() ||
                    !context.snapshotHash().equalsIgnoreCase(row.getString("snapshot_hash")) ||
                    !context.biomeMask().sha256().equalsIgnoreCase(row.getString("biome_mask_sha256")) ||
                    !isSha256(row.getString("building_geometry_sha256")) ||
                    !isSha256(row.getString("piece_geometry_sha256")) ||
                    row.getLong("building_geometry_rows") <= 0 ||
                    row.getLong("geometry_catalog_rows") <= 0 ||
                    row.getLong("known_geometry_rows") > row.getLong("building_geometry_rows") ||
                    row.getLong("known_geometry_rows") < row.getLong("real_geometry_rows") ||
                    row.getLong("known_geometry_rows") != row.getLong("real_geometry_rows") +
                        row.getLong("estimated_geometry_rows")) {
                throw new IllegalArgumentException("Public cache does not match the biome context package");
            }
            try (PreparedStatement counts = connection.prepareStatement(
                    "SELECT (SELECT COUNT(*) FROM zdo) AS zdo_rows, " +
                    "(SELECT COUNT(*) FROM prefab_geometry) AS catalog_rows");
                 ResultSet count = counts.executeQuery()) {
                if (!count.next() || count.getLong("zdo_rows") != row.getLong("building_geometry_rows") ||
                        count.getLong("catalog_rows") != row.getLong("geometry_catalog_rows")) {
                    throw new IllegalArgumentException("Public cache geometry receipts do not match its tables");
                }
            }
        } catch (SQLException error) {
            throw new IllegalArgumentException("Public cache is not terrain-and-scene enabled", error);
        }
    }

    private static boolean isSha256(String value) {
        return value != null && value.matches("(?i)[0-9a-f]{64}");
    }

    public Map<String, Long> biomeCounts(long snapshotId,
            double minX, double maxX, double minZ, double maxZ) throws SQLException {
        validateBounds(minX, maxX, minZ, maxZ);
        Map<String, Long> result = new LinkedHashMap<>();
        try (Connection connection = open();
             PreparedStatement statement = connection.prepareStatement(
                 "SELECT biome, COUNT(*) AS item_count FROM zdo WHERE snapshot_id = ? " +
                 "AND category = 'BUILDING' AND x >= ? AND x <= ? AND z >= ? AND z <= ? " +
                 "GROUP BY biome ORDER BY biome")) {
            statement.setLong(1, snapshotId);
            statement.setDouble(2, minX);
            statement.setDouble(3, maxX);
            statement.setDouble(4, minZ);
            statement.setDouble(5, maxZ);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) result.put(rows.getString("biome"), rows.getLong("item_count"));
            }
        }
        return result;
    }

    public ObjectNode selection(long snapshotId, String lensId,
            double minX, double maxX, double minZ, double maxZ, int topN) throws SQLException {
        return selection(snapshotId, lensId, minX, maxX, minZ, maxZ, topN, List.of());
    }

    public ObjectNode selection(long snapshotId, String lensId,
            double minX, double maxX, double minZ, double maxZ, int topN,
            List<String> biomes) throws SQLException {
        validateBounds(minX, maxX, minZ, maxZ);
        LensDefinition lens = lenses.require(lensId);
        validateBiomeScope(lens, biomes);
        topN = topN <= 0 ? 0 : Math.max(1, Math.min(50, topN));
        double selectedTotal;
        long positionCount;
        int categoryCount = 0;
        ArrayNode top = mapper.createArrayNode();

        try (Connection connection = open()) {
            selectedTotal = scalarValue(connection, snapshotId, lens, minX, maxX, minZ, maxZ, biomes);
            positionCount = lens.source() == LensDefinition.Source.ZDO
                ? Math.round(selectedTotal)
                : positionCount(connection, snapshotId, lens, minX, maxX, minZ, maxZ, biomes);
            String group = lens.groupExpression();
            String groupedSql = "SELECT " + group + " AS label, " + lens.valueExpression() + " AS value " +
                "FROM " + lens.table() + " WHERE snapshot_id = ? AND " + lens.predicate() +
                scopeClause(lens, biomes) + " GROUP BY 1";
            String sql = "SELECT label, value, COUNT(*) OVER () AS category_count FROM (" +
                groupedSql + ") AS lens_groups ORDER BY value DESC" + (topN > 0 ? " LIMIT ?" : "");
            try (PreparedStatement statement = connection.prepareStatement(sql)) {
                int index = bindScope(statement, 1, snapshotId, minX, maxX, minZ, maxZ, biomes);
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
                return scalarValue(connection, snapshotId, lens,
                    WorldBounds.VALHEIM.minX(), WorldBounds.VALHEIM.maxX(),
                    WorldBounds.VALHEIM.minZ(), WorldBounds.VALHEIM.maxZ(), List.of());
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
        ArrayNode selectedBiomes = result.putArray("biomes");
        biomes.forEach(selectedBiomes::add);
        result.set("top", top);
        return result;
    }

    public ObjectNode exactPoints(long snapshotId, String lensId,
            double minX, double maxX, double minZ, double maxZ, int requestedLimit) throws SQLException {
        return exactPoints(snapshotId, lensId, minX, maxX, minZ, maxZ, requestedLimit, List.of());
    }

    public ObjectNode exactPoints(long snapshotId, String lensId,
            double minX, double maxX, double minZ, double maxZ, int requestedLimit,
            List<String> biomes) throws SQLException {
        validateBounds(minX, maxX, minZ, maxZ);
        LensDefinition lens = lenses.require(lensId);
        validateBiomeScope(lens, biomes);
        int limit = Math.max(1, Math.min(5_000, requestedLimit));
        ArrayNode points = mapper.createArrayNode();
        boolean truncated = false;

        String sql;
        if (lens.source() == LensDefinition.Source.ZDO) {
            sql = "SELECT " + lens.xColumn() + " AS x, " + lens.zColumn() + " AS z, " +
                lens.groupExpression() + " AS label, 1 AS value FROM " + lens.table() +
                " WHERE snapshot_id = ? AND " + lens.predicate() + scopeClause(lens, biomes) + " LIMIT ?";
        } else {
            sql = "SELECT " + lens.xColumn() + " AS x, " + lens.zColumn() + " AS z, " +
                lens.groupExpression() + " AS label, " + lens.valueExpression() + " AS value FROM " +
                lens.table() + " WHERE snapshot_id = ? AND " + lens.predicate() + boundsClause(lens) +
                " GROUP BY 1,2,3 LIMIT ?";
        }

        try (Connection connection = open();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            int index = bindScope(statement, 1, snapshotId, minX, maxX, minZ, maxZ, biomes);
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
        result.put("sampled", false);
        ArrayNode selectedBiomes = result.putArray("biomes");
        biomes.forEach(selectedBiomes::add);
        result.set("points", points);
        return result;
    }

    public ObjectNode samplePoints(long snapshotId, String lensId,
            double minX, double maxX, double minZ, double maxZ, int requestedLimit,
            List<String> biomes) throws SQLException {
        validateBounds(minX, maxX, minZ, maxZ);
        LensDefinition lens = lenses.require(lensId);
        validateBiomeScope(lens, biomes);
        if (lens.source() != LensDefinition.Source.ZDO) {
            throw new IllegalArgumentException("Representative sampling is available for object lenses only");
        }
        int limit = Math.max(1, Math.min(5_000, requestedLimit));
        long total;
        ArrayNode points = mapper.createArrayNode();
        String sql = "SELECT " + lens.xColumn() + " AS x, " + lens.zColumn() + " AS z, " +
            lens.groupExpression() + " AS label, 1 AS value FROM " + lens.table() +
            " WHERE snapshot_id = ? AND " + lens.predicate() + scopeClause(lens, biomes) +
            " ORDER BY hash(zdo_index) LIMIT ?";
        try (Connection connection = open()) {
            total = positionCount(connection, snapshotId, lens, minX, maxX, minZ, maxZ, biomes);
            try (PreparedStatement statement = connection.prepareStatement(sql)) {
                int index = bindScope(statement, 1, snapshotId, minX, maxX, minZ, maxZ, biomes);
                statement.setInt(index, limit);
                try (ResultSet rows = statement.executeQuery()) {
                    while (rows.next()) {
                        ObjectNode point = points.addObject();
                        point.put("x", rows.getDouble("x"));
                        point.put("z", rows.getDouble("z"));
                        point.put("label", rows.getString("label"));
                        point.put("value", rows.getDouble("value"));
                    }
                }
            }
        }
        ObjectNode result = mapper.createObjectNode();
        result.put("snapshotId", snapshotId);
        result.put("lensId", lensId);
        result.put("limit", limit);
        result.put("total", total);
        result.put("minimumCount", total);
        result.put("truncated", total > limit);
        result.put("sampled", total > limit);
        ArrayNode selectedBiomes = result.putArray("biomes");
        biomes.forEach(selectedBiomes::add);
        result.set("points", points);
        return result;
    }

    public ObjectNode items(long snapshotId, String lensId,
            double minX, double maxX, double minZ, double maxZ, int requestedLimit,
            String cursor, List<String> biomes) throws SQLException {
        validateBounds(minX, maxX, minZ, maxZ);
        LensDefinition lens = lenses.require(lensId);
        validateBiomeScope(lens, biomes);
        if (lens.source() != LensDefinition.Source.ZDO) {
            throw new IllegalArgumentException("Individual rows are available for object lenses only");
        }
        int limit = Math.max(1, Math.min(250, requestedLimit));
        String scope = scopeKey(snapshotId, lensId, minX, maxX, minZ, maxZ, biomes);
        long after = decodeCursor(cursor, scope);
        ArrayNode items = mapper.createArrayNode();
        long total;
        Long lastReturnedIndex = null;
        boolean hasMore = false;
        String sql = "SELECT zdo_index, " + lens.xColumn() + " AS x, " + lens.zColumn() + " AS z, " +
            lens.groupExpression() + " AS label, biome FROM " + lens.table() +
            " WHERE snapshot_id = ? AND " + lens.predicate() + scopeClause(lens, biomes) +
            " AND zdo_index > ? ORDER BY zdo_index LIMIT ?";
        try (Connection connection = open()) {
            total = positionCount(connection, snapshotId, lens, minX, maxX, minZ, maxZ, biomes);
            try (PreparedStatement statement = connection.prepareStatement(sql)) {
                int index = bindScope(statement, 1, snapshotId, minX, maxX, minZ, maxZ, biomes);
                statement.setLong(index++, after);
                statement.setInt(index, limit + 1);
                try (ResultSet rows = statement.executeQuery()) {
                    while (rows.next()) {
                        long zdoIndex = rows.getLong("zdo_index");
                        if (items.size() == limit) { hasMore = true; break; }
                        ObjectNode item = items.addObject();
                        item.put("label", rows.getString("label"));
                        item.put("biome", rows.getString("biome"));
                        item.put("x", rows.getDouble("x"));
                        item.put("z", rows.getDouble("z"));
                        lastReturnedIndex = zdoIndex;
                    }
                }
            }
        }
        ObjectNode result = mapper.createObjectNode();
        result.put("snapshotId", snapshotId);
        result.put("lensId", lensId);
        result.put("total", total);
        result.put("limit", limit);
        result.put("after", after);
        result.put("hasMore", hasMore);
        if (hasMore && lastReturnedIndex != null) result.put("nextCursor", encodeCursor(lastReturnedIndex, scope));
        else result.putNull("nextCursor");
        result.set("items", items);
        return result;
    }

    private double scalarValue(Connection connection, long snapshotId, LensDefinition lens,
            Double minX, Double maxX, Double minZ, Double maxZ, List<String> biomes) throws SQLException {
        boolean bounded = minX != null;
        String sql = "SELECT COALESCE(" + lens.valueExpression() + ", 0) AS value FROM " +
            lens.table() + " WHERE snapshot_id = ? AND " + lens.predicate() +
            (bounded ? scopeClause(lens, biomes) : "");
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setLong(1, snapshotId);
            if (bounded) {
                bindScope(statement, 1, snapshotId, minX, maxX, minZ, maxZ, biomes);
            }
            try (ResultSet row = statement.executeQuery()) {
                return row.next() ? row.getDouble("value") : 0;
            }
        }
    }

    private long positionCount(Connection connection, long snapshotId, LensDefinition lens,
            double minX, double maxX, double minZ, double maxZ, List<String> biomes) throws SQLException {
        String boundedRows = "SELECT " + lens.xColumn() + " AS x, " + lens.zColumn() + " AS z, " +
            lens.groupExpression() + " AS label FROM " + lens.table() +
            " WHERE snapshot_id = ? AND " + lens.predicate() + scopeClause(lens, biomes);
        String sql = lens.source() == LensDefinition.Source.ZDO
            ? "SELECT COUNT(*) AS value FROM (" + boundedRows + ") AS positions"
            : "SELECT COUNT(*) AS value FROM (" + boundedRows + " GROUP BY 1,2,3) AS positions";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            bindScope(statement, 1, snapshotId, minX, maxX, minZ, maxZ, biomes);
            try (ResultSet row = statement.executeQuery()) {
                return row.next() ? row.getLong("value") : 0;
            }
        }
    }

    private static String boundsClause(LensDefinition lens) {
        return " AND " + lens.xColumn() + " >= ? AND " + lens.xColumn() + " <= ?" +
            " AND " + lens.zColumn() + " >= ? AND " + lens.zColumn() + " <= ?";
    }

    private static String scopeClause(LensDefinition lens, List<String> biomes) {
        StringBuilder result = new StringBuilder(boundsClause(lens));
        if (!biomes.isEmpty()) {
            result.append(" AND biome IN (");
            for (int index = 0; index < biomes.size(); index++) {
                if (index > 0) result.append(',');
                result.append('?');
            }
            result.append(')');
        }
        return result.toString();
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

    private static int bindScope(PreparedStatement statement, int index, long snapshotId,
            double minX, double maxX, double minZ, double maxZ, List<String> biomes) throws SQLException {
        index = bindBounds(statement, index, snapshotId, minX, maxX, minZ, maxZ);
        for (String biome : biomes) statement.setString(index++, biome);
        return index;
    }

    private static void validateBiomeScope(LensDefinition lens, List<String> biomes) {
        if (!biomes.isEmpty() && lens.source() != LensDefinition.Source.ZDO) {
            throw new IllegalArgumentException("Biome filters are available for object lenses only");
        }
    }

    private static String scopeKey(long snapshotId, String lensId,
            double minX, double maxX, double minZ, double maxZ, List<String> biomes) {
        return snapshotId + "|" + lensId + "|" + Double.toString(minX) + "|" + Double.toString(maxX) +
            "|" + Double.toString(minZ) + "|" + Double.toString(maxZ) + "|" + String.join(",", biomes);
    }

    private static String encodeCursor(long after, String scope) {
        String value = after + "\n" + scope;
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static long decodeCursor(String cursor, String scope) {
        if (cursor == null || cursor.isBlank()) return -1;
        try {
            String value = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
            int separator = value.indexOf('\n');
            if (separator <= 0 || !value.substring(separator + 1).equals(scope)) {
                throw new IllegalArgumentException("Cursor does not match the current selection");
            }
            long after = Long.parseLong(value.substring(0, separator));
            if (after < 0) throw new IllegalArgumentException("Cursor is invalid");
            return after;
        } catch (IllegalArgumentException error) {
            if ("Cursor does not match the current selection".equals(error.getMessage()) ||
                    "Cursor is invalid".equals(error.getMessage())) throw error;
            throw new IllegalArgumentException("Cursor is invalid");
        }
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
