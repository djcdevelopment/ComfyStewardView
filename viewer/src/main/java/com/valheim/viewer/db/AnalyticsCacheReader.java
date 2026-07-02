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
import java.util.List;

/**
 * Read-only query facade for the DuckDB analytics cache.
 */
public final class AnalyticsCacheReader implements AutoCloseable {

    private final File dbFile;
    private final File renderDir;
    private final Connection conn;
    private final long snapshotId;

    public AnalyticsCacheReader(File dbFile, File renderDir) throws Exception {
        this.dbFile = dbFile;
        this.renderDir = renderDir;
        Class.forName("org.duckdb.DuckDBDriver");
        this.conn = DriverManager.getConnection("jdbc:duckdb:" + dbFile.getAbsolutePath());
        this.snapshotId = latestSnapshotId(conn);
    }

    public File dbFile() {
        return dbFile;
    }

    public long snapshotId() {
        return snapshotId;
    }

    public File manifestFile() {
        return new File(new File(renderDir, String.valueOf(snapshotId)), "manifest.json");
    }

    public File renderedFile(String fileName) {
        String clean = fileName.replace('\\', '/');
        if (clean.contains("/") || clean.contains("..")) {
            return null;
        }
        return new File(new File(renderDir, String.valueOf(snapshotId)), clean);
    }

    public ObjectNode queryZdos(
            ObjectMapper mapper,
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
        params.add(snapshotId);
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
        root.put("snapshotId", snapshotId);
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
        params.add(snapshotId);
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
        root.put("snapshotId", snapshotId);
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
            float minX,
            float maxX,
            float minZ,
            float maxZ,
            int topN) throws SQLException {

        ObjectNode root = mapper.createObjectNode();
        root.put("snapshotId", snapshotId);
        root.set("topPrefabs", grouped(mapper,
            "SELECT prefab_name AS key, COUNT(*) AS value FROM zdo " +
            "WHERE snapshot_id = ? AND x BETWEEN ? AND ? AND z BETWEEN ? AND ? " +
            "GROUP BY prefab_name ORDER BY value DESC LIMIT ?",
            minX, maxX, minZ, maxZ, topN));
        root.set("topCreators", grouped(mapper,
            "SELECT CAST(creator_id AS VARCHAR) AS key, COUNT(*) AS value FROM zdo " +
            "WHERE snapshot_id = ? AND creator_id IS NOT NULL " +
            "AND x BETWEEN ? AND ? AND z BETWEEN ? AND ? " +
            "GROUP BY creator_id ORDER BY value DESC LIMIT ?",
            minX, maxX, minZ, maxZ, topN));
        root.set("topItems", grouped(mapper,
            "SELECT item_name AS key, SUM(stack) AS value FROM container_item " +
            "WHERE snapshot_id = ? AND container_x BETWEEN ? AND ? AND container_z BETWEEN ? AND ? " +
            "GROUP BY item_name ORDER BY value DESC LIMIT ?",
            minX, maxX, minZ, maxZ, topN));
        return root;
    }

    @Override
    public void close() throws SQLException {
        conn.close();
    }

    private ArrayNode grouped(ObjectMapper mapper, String sql,
            float minX, float maxX, float minZ, float maxZ, int topN) throws SQLException {
        ArrayNode arr = mapper.createArrayNode();
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setLong(1, snapshotId);
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
