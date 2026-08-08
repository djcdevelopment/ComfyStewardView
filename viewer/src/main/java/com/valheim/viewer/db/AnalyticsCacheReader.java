package com.valheim.viewer.db;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.File;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.HashSet;
import java.util.Set;

/**
 * Read-only query facade for the DuckDB analytics cache.
 */
public final class AnalyticsCacheReader implements AutoCloseable {

    private final File dbFile;
    private final File renderDir;
    private final Connection conn;
    private volatile long snapshotId;

    public record SnapshotInfo(long snapshotId, String worldId, String dictionaryVersion) {}

    private record SnapshotListEntry(
            long snapshotId,
            String worldId,
            String dictionaryVersion) {}

    public AnalyticsCacheReader(File dbFile, File renderDir) throws Exception {
        this.dbFile = dbFile;
        this.renderDir = renderDir;
        Class.forName("org.duckdb.DuckDBDriver");
        this.conn = DriverManager.getConnection("jdbc:duckdb:" + dbFile.getAbsolutePath());
        this.snapshotId = latestSnapshotId(conn);
    }

    public Connection connection() {
        return conn;
    }

    public File dbFile() {
        return dbFile;
    }

    public long snapshotId() {
        return snapshotId;
    }

    /** Refresh the default snapshot after an in-process ingest appends to the cache. */
    public long refreshLatestSnapshotId() throws SQLException {
        snapshotId = latestSnapshotId(conn);
        return snapshotId;
    }

    public ObjectNode listSnapshots(ObjectMapper mapper, String worldIdFilter) throws SQLException {
        ObjectNode root = mapper.createObjectNode();
        ArrayNode arr = root.putArray("snapshots");
        Map<Long, Long> zdoCounts = loadZdoCounts(worldIdFilter);
        Map<String, List<SnapshotListEntry>> byWorld = new LinkedHashMap<>();

        StringBuilder sql = new StringBuilder(
                "SELECT snapshot_id, source_path, file_size, parsed_at, world_version, " +
                "world_id, world_name, source, backup_id, save_timestamp, file_hash, parser_version, " +
                // COLUMNS(...) would be cleaner but these must degrade on a pre-migration cache,
                // so they are read defensively below rather than assumed present.
                "COALESCE(prefab_dictionary_version, '') AS prefab_dictionary_version, " +
                "COALESCE(prefab_dictionary_entries, 0) AS prefab_dictionary_entries " +
                "FROM world_snapshot ");
        if (worldIdFilter != null && !worldIdFilter.isBlank()) {
            sql.append("WHERE world_id = ? ");
        }
        sql.append("ORDER BY snapshot_id DESC");

        try (PreparedStatement ps = conn.prepareStatement(sql.toString())) {
            if (worldIdFilter != null && !worldIdFilter.isBlank()) {
                ps.setString(1, worldIdFilter);
            }
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    long id = rs.getLong("snapshot_id");
                    String worldId = rs.getString("world_id");
                    String dictionaryVersion = emptyToNull(rs.getString("prefab_dictionary_version"));
                    ObjectNode n = arr.addObject();
                    n.put("snapshotId", id);
                    putNullable(n, "sourcePath", rs.getString("source_path"));
                    n.put("fileSize", rs.getLong("file_size"));
                    putNullable(n, "parsedAt", rs.getString("parsed_at"));
                    n.put("worldVersion", rs.getInt("world_version"));
                    putNullable(n, "worldId", worldId);
                    putNullable(n, "worldName", rs.getString("world_name"));
                    putNullable(n, "source", rs.getString("source"));
                    putNullable(n, "backupId", rs.getString("backup_id"));
                    putNullable(n, "saveTimestamp", rs.getString("save_timestamp"));
                    putNullable(n, "fileHash", rs.getString("file_hash"));
                    putNullable(n, "parserVersion", rs.getString("parser_version"));
                    putNullable(n, "prefabDictionaryVersion", dictionaryVersion);
                    n.put("prefabDictionaryEntries", rs.getInt("prefab_dictionary_entries"));
                    n.put("zdoCount", zdoCounts.getOrDefault(id, 0L));
                    n.put("absoluteRasterAvailable", manifestFile(id).isFile());
                    if (worldId != null && !worldId.isBlank()) {
                        byWorld.computeIfAbsent(worldId, ignored -> new ArrayList<>())
                            .add(new SnapshotListEntry(id, worldId, dictionaryVersion));
                    }
                }
            }
        }

        // Advertise only canonical pairs in the current latest-six window. Old pair directories
        // are intentionally invisible even before the next renderer pass prunes them.
        ArrayNode pairs = root.putArray("deltaPairs");
        for (List<SnapshotListEntry> snapshots : byWorld.values()) {
            int retained = Math.min(RenderedDeltaLayerBuilder.RECENT_SNAPSHOT_LIMIT, snapshots.size());
            for (int newer = 0; newer < retained - 1; newer++) {
                for (int older = newer + 1; older < retained; older++) {
                    SnapshotListEntry from = snapshots.get(older);
                    SnapshotListEntry to = snapshots.get(newer);
                    ObjectNode pair = pairs.addObject();
                    pair.put("fromSnapshotId", from.snapshotId);
                    pair.put("toSnapshotId", to.snapshotId);
                    pair.put("worldId", from.worldId);
                    pair.put("available", deltaRasterAvailable(from.snapshotId, to.snapshotId));
                    pair.put("dictionaryMismatch", dictionaryMismatch(
                        from.dictionaryVersion, to.dictionaryVersion));
                    putNullable(pair, "fromDictionaryVersion", from.dictionaryVersion);
                    putNullable(pair, "toDictionaryVersion", to.dictionaryVersion);
                }
            }
        }
        return root;
    }

    public ObjectNode getSnapshotDelta(ObjectMapper mapper, long targetSnapshotId) throws SQLException {
        ObjectNode root = mapper.createObjectNode();
        root.put("snapshotId", targetSnapshotId);

        String sql = "SELECT prev_snapshot_id, zdos_added, zdos_removed, zdos_modified, " +
                     "container_items_delta, computed_at FROM snapshot_delta WHERE snapshot_id = ?";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setLong(1, targetSnapshotId);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    root.put("prevSnapshotId", rs.getLong("prev_snapshot_id"));
                    root.put("zdosAdded", rs.getInt("zdos_added"));
                    root.put("zdosRemoved", rs.getInt("zdos_removed"));
                    root.put("zdosModified", rs.getInt("zdos_modified"));
                    root.put("containerItemsDelta", rs.getInt("container_items_delta"));
                    putNullable(root, "computedAt", rs.getString("computed_at"));
                }
            }
        }
        return root;
    }

    public File renderDir() {
        return renderDir;
    }

    public File manifestFile() {
        return manifestFile(snapshotId);
    }

    public File manifestFile(long targetSnapshotId) {
        return new File(new File(renderDir, String.valueOf(targetSnapshotId)), "manifest.json");
    }

    public File renderedFile(String fileName) {
        return renderedFile(snapshotId, fileName);
    }

    public File renderedFile(long targetSnapshotId, String fileName) {
        String clean = fileName.replace('\\', '/');
        if (clean.contains("/") || clean.contains("..")) {
            return null;
        }
        return new File(new File(renderDir, String.valueOf(targetSnapshotId)), clean);
    }

    public File deltaManifestFile(long fromSnapshotId, long toSnapshotId) {
        return new File(new File(new File(renderDir, "delta"),
            RenderedDeltaLayerBuilder.pairDirectoryName(fromSnapshotId, toSnapshotId)), "manifest.json");
    }

    public File deltaRenderedFile(long fromSnapshotId, long toSnapshotId, String fileName) {
        String clean = fileName.replace('\\', '/');
        if (clean.contains("/") || clean.contains("..")) return null;
        return new File(new File(new File(renderDir, "delta"),
            RenderedDeltaLayerBuilder.pairDirectoryName(fromSnapshotId, toSnapshotId)), clean);
    }

    /** A pair is available only when its manifest and every advertised channel are complete. */
    public boolean deltaRasterAvailable(long fromSnapshotId, long toSnapshotId) {
        return RenderedDeltaLayerBuilder.isCompleteManifest(
            deltaManifestFile(fromSnapshotId, toSnapshotId), fromSnapshotId, toSnapshotId);
    }

    public boolean deltaRenderedFileAdvertised(long fromSnapshotId, long toSnapshotId, String fileName) {
        return RenderedDeltaLayerBuilder.isAdvertisedChannel(
            deltaManifestFile(fromSnapshotId, toSnapshotId), fromSnapshotId, toSnapshotId, fileName);
    }

    public SnapshotInfo snapshotInfo(long targetSnapshotId) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT snapshot_id, world_id, prefab_dictionary_version " +
                "FROM world_snapshot WHERE snapshot_id = ?")) {
            ps.setLong(1, targetSnapshotId);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) return null;
                return new SnapshotInfo(rs.getLong(1), rs.getString(2), rs.getString(3));
            }
        }
    }

    public boolean worldExists(String worldId) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT EXISTS(SELECT 1 FROM world_snapshot WHERE world_id = ?)")) {
            ps.setString(1, worldId);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() && rs.getBoolean(1);
            }
        }
    }

    /** True only for a canonical pair whose two snapshots are both in their world's latest six. */
    public boolean isDeltaPairInRecentMatrix(long fromSnapshotId, long toSnapshotId) throws SQLException {
        if (fromSnapshotId <= 0 || fromSnapshotId >= toSnapshotId) return false;
        SnapshotInfo from = snapshotInfo(fromSnapshotId);
        SnapshotInfo to = snapshotInfo(toSnapshotId);
        if (from == null || to == null || from.worldId() == null || from.worldId().isBlank() ||
                !from.worldId().equals(to.worldId())) return false;

        boolean foundFrom = false;
        boolean foundTo = false;
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT snapshot_id FROM world_snapshot WHERE world_id = ? " +
                "ORDER BY snapshot_id DESC LIMIT " + RenderedDeltaLayerBuilder.RECENT_SNAPSHOT_LIMIT)) {
            ps.setString(1, from.worldId());
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    long id = rs.getLong(1);
                    foundFrom |= id == fromSnapshotId;
                    foundTo |= id == toSnapshotId;
                }
            }
        }
        return foundFrom && foundTo;
    }

    public ObjectNode queryZdos(
            ObjectMapper mapper,
            long targetSnapshotId,
            float minX,
            float maxX,
            float minZ,
            float maxZ,
            String category,
            String prefab,
            Long creatorId,
            int limit,
            int offset) throws SQLException {

        StringBuilder sql = new StringBuilder(
            "SELECT zdo_index, prefab_hash, prefab_name, category, x, y, z, " +
            "creator_id, owner_id, spawn_time_micros, flags " +
            "FROM zdo WHERE snapshot_id = ? AND x BETWEEN ? AND ? AND z BETWEEN ? AND ?");
        List<Object> params = new ArrayList<>();
        params.add(targetSnapshotId);
        params.add(minX);
        params.add(maxX);
        params.add(minZ);
        params.add(maxZ);

        if (category != null && !category.isEmpty()) {
            sql.append(" AND category = ?");
            params.add(category.toUpperCase());
        }
        if (prefab != null && !prefab.isEmpty()) {
            sql.append(" AND prefab_name = ?");
            params.add(prefab);
        }
        if (creatorId != null) {
            sql.append(" AND creator_id = ?");
            params.add(creatorId);
        }

        String countSql = "SELECT COUNT(*) FROM (" + sql + ") t";
        int total = count(countSql, params);

        sql.append(" ORDER BY zdo_index LIMIT ? OFFSET ?");
        params.add(limit);
        params.add(offset);

        ObjectNode root = mapper.createObjectNode();
        root.put("snapshotId", targetSnapshotId);
        root.put("total", total);
        root.put("offset", offset);
        root.put("limit", limit);
        ArrayNode arr = root.putArray("data");

        try (PreparedStatement ps = conn.prepareStatement(sql.toString())) {
            bind(ps, params);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode n = arr.addObject();
                    n.put("zdoIndex", rs.getInt("zdo_index"));
                    n.put("prefabHash", rs.getInt("prefab_hash"));
                    putNullable(n, "prefab", rs.getString("prefab_name"));
                    putNullable(n, "category", rs.getString("category"));
                    n.put("x", rs.getDouble("x"));
                    n.put("y", rs.getDouble("y"));
                    n.put("z", rs.getDouble("z"));
                    putNullableLong(n, "creatorId", rs, "creator_id");
                    putNullableLong(n, "ownerId", rs, "owner_id");
                    putNullableLong(n, "spawnTimeMicros", rs, "spawn_time_micros");
                    n.put("flags", rs.getInt("flags"));
                }
            }
        }
        return root;
    }

    public ObjectNode queryContainerItems(
            ObjectMapper mapper,
            long targetSnapshotId,
            float minX,
            float maxX,
            float minZ,
            float maxZ,
            String item,
            int limit,
            int offset) throws SQLException {

        StringBuilder sql = new StringBuilder(
            "SELECT container_zdo_index, item_name, stack, quality, variant, crafter_id, " +
            "crafter_name, custom_data_json, container_x, container_y, container_z " +
            "FROM container_item WHERE snapshot_id = ? " +
            "AND container_x BETWEEN ? AND ? AND container_z BETWEEN ? AND ?");
        List<Object> params = new ArrayList<>();
        params.add(targetSnapshotId);
        params.add(minX);
        params.add(maxX);
        params.add(minZ);
        params.add(maxZ);

        if (item != null && !item.isEmpty()) {
            sql.append(" AND item_name = ?");
            params.add(item);
        }

        String countSql = "SELECT COUNT(*) FROM (" + sql + ") t";
        int total = count(countSql, params);

        sql.append(" ORDER BY stack DESC, container_zdo_index LIMIT ? OFFSET ?");
        params.add(limit);
        params.add(offset);

        ObjectNode root = mapper.createObjectNode();
        root.put("snapshotId", targetSnapshotId);
        root.put("total", total);
        root.put("offset", offset);
        root.put("limit", limit);
        ArrayNode arr = root.putArray("data");

        try (PreparedStatement ps = conn.prepareStatement(sql.toString())) {
            bind(ps, params);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode n = arr.addObject();
                    n.put("containerZdoIndex", rs.getInt("container_zdo_index"));
                    n.put("itemName", rs.getString("item_name"));
                    n.put("stack", rs.getInt("stack"));
                    n.put("quality", rs.getInt("quality"));
                    n.put("variant", rs.getInt("variant"));
                    putNullableLong(n, "crafterId", rs, "crafter_id");
                    putNullable(n, "crafterName", rs.getString("crafter_name"));
                    putNullable(n, "customData", rs.getString("custom_data_json"));
                    n.put("x", rs.getDouble("container_x"));
                    n.put("y", rs.getDouble("container_y"));
                    n.put("z", rs.getDouble("container_z"));
                }
            }
        }
        return root;
    }

    public ObjectNode selectedAreaSummary(
            ObjectMapper mapper,
            long targetSnapshotId,
            float minX,
            float maxX,
            float minZ,
            float maxZ,
            int topN) throws SQLException {

        ObjectNode root = mapper.createObjectNode();
        root.put("snapshotId", targetSnapshotId);
        root.set("topPrefabs", grouped(mapper,
            "SELECT prefab_name AS key, COUNT(*) AS value FROM zdo " +
            "WHERE snapshot_id = ? AND x BETWEEN ? AND ? AND z BETWEEN ? AND ? " +
            "GROUP BY prefab_name ORDER BY value DESC LIMIT ?",
            targetSnapshotId, minX, maxX, minZ, maxZ, topN));
        root.set("topCreators", grouped(mapper,
            "SELECT CAST(creator_id AS VARCHAR) AS key, COUNT(*) AS value FROM zdo " +
            "WHERE snapshot_id = ? AND creator_id IS NOT NULL " +
            "AND x BETWEEN ? AND ? AND z BETWEEN ? AND ? " +
            "GROUP BY creator_id ORDER BY value DESC LIMIT ?",
            targetSnapshotId, minX, maxX, minZ, maxZ, topN));
        root.set("topItems", grouped(mapper,
            "SELECT item_name AS key, SUM(stack) AS value FROM container_item " +
            "WHERE snapshot_id = ? AND container_x BETWEEN ? AND ? AND container_z BETWEEN ? AND ? " +
            "GROUP BY item_name ORDER BY value DESC LIMIT ?",
            targetSnapshotId, minX, maxX, minZ, maxZ, topN));
        return root;
    }

    /**
     * Bounded spawn-time distribution: counts of zdo spawn fractions
     * ({@code spawn_time_micros/1e6/net_time_seconds}) grouped into at most 80 buckets over the
     * 0..2 domain the map filter uses. One snapshot-filtered scan; out-of-domain fractions clamp
     * into the edge buckets. A cache without a usable net_time_seconds reports available:false.
     */
    public ObjectNode spawnFractionHistogram(ObjectMapper mapper, long snapshotId, int buckets,
            String category) throws SQLException {
        ObjectNode root = mapper.createObjectNode();
        root.put("snapshotId", snapshotId);
        root.put("domainMin", 0);
        root.put("domainMax", 2);
        root.put("buckets", buckets);
        root.put("bucketWidth", 2.0 / buckets);

        double netTimeSeconds = 0;
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT net_time_seconds FROM world_snapshot WHERE snapshot_id = ?")) {
            ps.setLong(1, snapshotId);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) netTimeSeconds = rs.getDouble(1);
            }
        } catch (SQLException preMigrationCache) {
            netTimeSeconds = 0;
        }
        root.put("netTimeSeconds", netTimeSeconds);

        ArrayNode counts = root.putArray("counts");
        if (!(netTimeSeconds > 0) || !Double.isFinite(netTimeSeconds)) {
            root.put("total", 0);
            root.put("unknownSpawnCount", 0);
            root.put("maxCount", 0);
            root.put("available", false);
            return root;
        }

        long[] bucketCounts = new long[buckets];
        String categoryFilter = category != null && !category.isBlank() ? " AND category = ?" : "";
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT GREATEST(0, LEAST(? - 1, " +
                "CAST(FLOOR(((spawn_time_micros / 1000000.0) / ?) / (2.0 / ?)) AS INTEGER))) AS bucket, " +
                "COUNT(*) AS n FROM zdo " +
                "WHERE snapshot_id = ? AND spawn_time_micros IS NOT NULL AND spawn_time_micros > 0" +
                categoryFilter + " GROUP BY bucket")) {
            ps.setInt(1, buckets);
            ps.setDouble(2, netTimeSeconds);
            ps.setInt(3, buckets);
            ps.setLong(4, snapshotId);
            if (!categoryFilter.isEmpty()) ps.setString(5, category);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    int bucket = rs.getInt("bucket");
                    if (bucket >= 0 && bucket < buckets) bucketCounts[bucket] = rs.getLong("n");
                }
            }
        }

        long total = 0;
        long maxCount = 0;
        for (long n : bucketCounts) {
            counts.add(n);
            total += n;
            maxCount = Math.max(maxCount, n);
        }

        long unknown;
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT COUNT(*) FROM zdo WHERE snapshot_id = ? " +
                "AND (spawn_time_micros IS NULL OR spawn_time_micros <= 0)" + categoryFilter)) {
            ps.setLong(1, snapshotId);
            if (!categoryFilter.isEmpty()) ps.setString(2, category);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                unknown = rs.getLong(1);
            }
        }

        root.put("total", total);
        root.put("unknownSpawnCount", unknown);
        root.put("maxCount", maxCount);
        root.put("available", true);
        return root;
    }

    @Override
    public void close() throws SQLException {
        conn.close();
    }

    private ArrayNode grouped(ObjectMapper mapper, String sql,
            long targetSnapshotId,
            float minX, float maxX, float minZ, float maxZ, int topN) throws SQLException {
        ArrayNode arr = mapper.createArrayNode();
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setLong(1, targetSnapshotId);
            ps.setFloat(2, minX);
            ps.setFloat(3, maxX);
            ps.setFloat(4, minZ);
            ps.setFloat(5, maxZ);
            ps.setInt(6, topN);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode n = arr.addObject();
                    putNullable(n, "key", rs.getString("key"));
                    n.put("value", rs.getLong("value"));
                }
            }
        }
        return arr;
    }

    private int count(String sql, List<Object> params) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            bind(ps, params);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getInt(1);
            }
        }
    }

    private Map<Long, Long> loadZdoCounts(String worldIdFilter) throws SQLException {
        Map<Long, Long> counts = new HashMap<>();
        Set<Long> missing = new HashSet<>();
        String snapshotSql = "SELECT snapshot_id FROM world_snapshot" +
            (worldIdFilter != null && !worldIdFilter.isBlank() ? " WHERE world_id = ?" : "");
        try (PreparedStatement ps = conn.prepareStatement(snapshotSql)) {
            if (worldIdFilter != null && !worldIdFilter.isBlank()) ps.setString(1, worldIdFilter);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) missing.add(rs.getLong(1));
            }
        }

        // The 1000m all-zdos raster cells are tiny compared with the source ZDO table, and their
        // count_value sum is the exact snapshot row count. This keeps History loads O(render cells)
        // instead of repeatedly grouping millions of ZDO rows.
        if (!missing.isEmpty()) {
            String placeholders = String.join(",", java.util.Collections.nCopies(missing.size(), "?"));
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT snapshot_id, CAST(SUM(count_value) AS BIGINT) " +
                    "FROM render_cell WHERE layer = 'all-zdos' AND cell_size = 1000 " +
                    "AND snapshot_id IN (" + placeholders + ") GROUP BY snapshot_id")) {
                int index = 1;
                for (long id : missing) ps.setLong(index++, id);
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        long id = rs.getLong(1);
                        counts.put(id, rs.getLong(2));
                    }
                }
                missing.removeAll(counts.keySet());
            } catch (SQLException ignored) {
                // Pre-render/pre-migration caches fall through to the targeted source-table query.
            }
        }

        if (!missing.isEmpty()) {
            String placeholders = String.join(",", java.util.Collections.nCopies(missing.size(), "?"));
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT snapshot_id, COUNT(*) FROM zdo WHERE snapshot_id IN (" + placeholders +
                    ") GROUP BY snapshot_id")) {
                int index = 1;
                for (long id : missing) ps.setLong(index++, id);
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) counts.put(rs.getLong(1), rs.getLong(2));
                }
            }
        }
        return counts;
    }

    private static boolean dictionaryMismatch(String first, String second) {
        return first != null && !first.isBlank() && second != null && !second.isBlank() &&
            !first.equals(second);
    }

    private static String emptyToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private static long latestSnapshotId(Connection conn) throws SQLException {
        try (Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery("SELECT COALESCE(MAX(snapshot_id), 0) FROM world_snapshot")) {
            rs.next();
            long id = rs.getLong(1);
            if (id <= 0) throw new SQLException("analytics cache has no snapshots");
            return id;
        }
    }

    private static void bind(PreparedStatement ps, List<Object> params) throws SQLException {
        for (int i = 0; i < params.size(); i++) {
            Object p = params.get(i);
            if (p instanceof String) ps.setString(i + 1, (String) p);
            else if (p instanceof Integer) ps.setInt(i + 1, (Integer) p);
            else if (p instanceof Long) ps.setLong(i + 1, (Long) p);
            else if (p instanceof Float) ps.setFloat(i + 1, (Float) p);
            else if (p instanceof Double) ps.setDouble(i + 1, (Double) p);
            else ps.setObject(i + 1, p);
        }
    }

    private static void putNullable(ObjectNode n, String field, String value) {
        if (value == null) n.putNull(field);
        else n.put(field, value);
    }

    private static void putNullableLong(ObjectNode n, String field, ResultSet rs, String column) throws SQLException {
        long value = rs.getLong(column);
        if (rs.wasNull()) n.putNull(field);
        else n.put(field, value);
    }
}
