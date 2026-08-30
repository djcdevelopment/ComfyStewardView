package com.valheim.viewer.db;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.valheim.viewer.contract.SpatialEvidenceContract;

import java.io.File;
import java.nio.file.Files;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.time.Instant;
import java.util.Locale;

/**
 * Dedicated append-only Quest evidence database.
 *
 * <p>This connection never points at the analytics cache. Cache rebuilds may replace
 * {@code world-cache.duckdb}; imported runtime evidence survives in its own file and joins back
 * to map snapshots through immutable snapshot id/file hash provenance carried in every record.
 */
public final class QuestEvidenceStore implements AutoCloseable {

    public static final int MAX_OVERLAYS = 2_000;

    private final File dbFile;
    private final Connection conn;

    public record ImportReceipt(
            String contentSha256,
            int recordCount,
            boolean alreadyPresent) {}

    public QuestEvidenceStore(File dbFile) throws Exception {
        this.dbFile = dbFile.getCanonicalFile();
        File parent = this.dbFile.getParentFile();
        if (parent != null) Files.createDirectories(parent.toPath());
        Class.forName("org.duckdb.DuckDBDriver");
        this.conn = DriverManager.getConnection("jdbc:duckdb:" + this.dbFile.getAbsolutePath());
        createSchema();
    }

    public File dbFile() {
        return dbFile;
    }

    public synchronized ImportReceipt importJson(String json) throws Exception {
        SpatialEvidenceContract.Bundle bundle = SpatialEvidenceContract.parse(json);
        String hash = bundle.contentSha256.toLowerCase(Locale.ROOT);
        int existing = existingRecordCount(hash);
        if (existing >= 0) return new ImportReceipt(hash, existing, true);

        boolean priorAutoCommit = conn.getAutoCommit();
        conn.setAutoCommit(false);
        try {
            insertBundle(bundle, json, hash);
            insertRecords(bundle, hash);
            conn.commit();
            return new ImportReceipt(hash, bundle.records.size(), false);
        } catch (Exception e) {
            conn.rollback();
            throw e;
        } finally {
            conn.setAutoCommit(priorAutoCommit);
        }
    }

    public synchronized ObjectNode overlays(
            ObjectMapper mapper, AnalyticsCacheReader.SnapshotInfo snapshot) throws SQLException {
        if (snapshot == null || snapshot.snapshotId() <= 0 || snapshot.worldId() == null ||
                snapshot.worldId().isBlank() || snapshot.fileHash() == null ||
                !snapshot.fileHash().matches("(?i)^[0-9a-f]{64}$")) {
            throw new IllegalArgumentException("snapshot_provenance_invalid");
        }
        long snapshotId = snapshot.snapshotId();
        String snapshotHash = snapshot.fileHash().toLowerCase(Locale.ROOT);
        ObjectNode root = mapper.createObjectNode();
        root.put("schema", "comfy-steward-quest-overlays/v1");
        root.put("snapshotId", snapshotId);
        root.put("snapshotWorldId", snapshot.worldId());
        root.put("snapshotFileSha256", snapshotHash);
        int total = countForSnapshot(snapshotId, snapshot.worldId(), snapshotHash);
        root.put("total", total);
        root.put("limit", MAX_OVERLAYS);
        root.put("truncated", total > MAX_OVERLAYS);
        ArrayNode data = root.putArray("data");

        String sql =
            "SELECT r.bundle_sha256, r.receipt_id, r.at_utc, r.correlation_id, " +
            "r.transition_id, r.event_name, r.area_id, r.predicate, " +
            "r.current_count, r.required_count, r.anchor_sha256, " +
            "r.snapshot_world_id, r.snapshot_file_sha256, r.zdo_index, r.prefab, " +
            "r.piece_x, r.piece_y, r.piece_z, r.center_x, r.center_y, r.center_z, " +
            "r.radius_meters, r.observed_x, r.observed_y, r.observed_z, " +
            "r.distance_meters, r.satisfied, b.project_id, b.experience_id, b.pack_id, " +
            "b.content_hash, b.activation_id, b.run_id, b.world_uid, b.imported_utc " +
            "FROM quest_spatial_evidence r JOIN quest_evidence_bundle b " +
            "ON b.bundle_sha256 = r.bundle_sha256 " +
            "WHERE r.snapshot_id = ? AND r.snapshot_world_id = ? " +
            "AND r.snapshot_file_sha256 = ? " +
            "ORDER BY r.at_utc DESC, r.bundle_sha256, r.record_index " +
            "LIMIT ?";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setLong(1, snapshotId);
            ps.setString(2, snapshot.worldId());
            ps.setString(3, snapshotHash);
            ps.setInt(4, MAX_OVERLAYS);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode item = data.addObject();
                    item.put("bundleSha256", rs.getString("bundle_sha256"));
                    item.put("receiptId", rs.getString("receipt_id"));
                    item.put("atUtc", rs.getString("at_utc"));
                    putNullable(item, "correlationId", rs.getString("correlation_id"));
                    putNullable(item, "transitionId", rs.getString("transition_id"));
                    putNullable(item, "eventName", rs.getString("event_name"));
                    item.put("areaId", rs.getString("area_id"));
                    item.put("predicate", rs.getString("predicate"));
                    item.put("currentCount", rs.getInt("current_count"));
                    item.put("requiredCount", rs.getInt("required_count"));
                    item.put("anchorSha256", rs.getString("anchor_sha256"));
                    ObjectNode snapshotNode = item.putObject("snapshot");
                    snapshotNode.put("snapshotId", snapshotId);
                    snapshotNode.put("worldId", rs.getString("snapshot_world_id"));
                    snapshotNode.put("fileSha256", rs.getString("snapshot_file_sha256"));
                    ObjectNode piece = item.putObject("piece");
                    piece.put("zdoIndex", rs.getInt("zdo_index"));
                    piece.put("prefab", rs.getString("prefab"));
                    point(piece.putObject("position"), rs, "piece");
                    point(item.putObject("resolvedCenter"), rs, "center");
                    item.put("radiusMeters", rs.getDouble("radius_meters"));
                    nullablePoint(item, "observedPosition", rs, "observed");
                    double distance = rs.getDouble("distance_meters");
                    if (rs.wasNull()) item.putNull("distanceMeters");
                    else item.put("distanceMeters", distance);
                    item.put("satisfied", rs.getBoolean("satisfied"));
                    ObjectNode run = item.putObject("run");
                    run.put("projectId", rs.getString("project_id"));
                    run.put("experienceId", rs.getString("experience_id"));
                    run.put("packId", rs.getString("pack_id"));
                    run.put("contentHash", rs.getString("content_hash"));
                    run.put("activationId", rs.getString("activation_id"));
                    run.put("runId", rs.getString("run_id"));
                    run.put("worldUid", rs.getString("world_uid"));
                    run.put("importedUtc", rs.getString("imported_utc"));
                }
            }
        }
        return root;
    }

    private void createSchema() throws SQLException {
        try (Statement st = conn.createStatement()) {
            st.executeUpdate(
                "CREATE TABLE IF NOT EXISTS quest_evidence_bundle (" +
                "bundle_sha256 VARCHAR PRIMARY KEY, " +
                "contract_schema VARCHAR NOT NULL, " +
                "exported_utc VARCHAR NOT NULL, " +
                "project_id VARCHAR NOT NULL, " +
                "experience_id VARCHAR NOT NULL, " +
                "pack_id VARCHAR NOT NULL, " +
                "content_hash VARCHAR NOT NULL, " +
                "activation_id VARCHAR NOT NULL, " +
                "run_id VARCHAR NOT NULL, " +
                "world_uid VARCHAR NOT NULL, " +
                "record_count INTEGER NOT NULL, " +
                "raw_json VARCHAR NOT NULL, " +
                "imported_utc VARCHAR NOT NULL)");
            st.executeUpdate(
                "CREATE TABLE IF NOT EXISTS quest_spatial_evidence (" +
                "bundle_sha256 VARCHAR NOT NULL, " +
                "record_index INTEGER NOT NULL, " +
                "receipt_id VARCHAR NOT NULL, " +
                "at_utc VARCHAR NOT NULL, " +
                "correlation_id VARCHAR, transition_id VARCHAR, event_name VARCHAR, " +
                "area_id VARCHAR NOT NULL, predicate VARCHAR NOT NULL, " +
                "current_count INTEGER NOT NULL, required_count INTEGER NOT NULL, " +
                "anchor_sha256 VARCHAR NOT NULL, " +
                "snapshot_id BIGINT NOT NULL, snapshot_world_id VARCHAR NOT NULL, " +
                "snapshot_file_sha256 VARCHAR NOT NULL, " +
                "zdo_index INTEGER NOT NULL, prefab VARCHAR NOT NULL, " +
                "piece_x DOUBLE NOT NULL, piece_y DOUBLE NOT NULL, piece_z DOUBLE NOT NULL, " +
                "center_x DOUBLE NOT NULL, center_y DOUBLE NOT NULL, center_z DOUBLE NOT NULL, " +
                "radius_meters DOUBLE NOT NULL, " +
                "observed_x DOUBLE, observed_y DOUBLE, observed_z DOUBLE, " +
                "distance_meters DOUBLE, satisfied BOOLEAN NOT NULL, " +
                "PRIMARY KEY (bundle_sha256, record_index))");
            // Migrate the unpublished local v1 rehearsal schema in place. Count observations do
            // not have one honest point, so their observed coordinates must remain nullable.
            st.executeUpdate("ALTER TABLE quest_spatial_evidence " +
                "ADD COLUMN IF NOT EXISTS current_count INTEGER DEFAULT 0");
            st.executeUpdate("ALTER TABLE quest_spatial_evidence " +
                "ADD COLUMN IF NOT EXISTS required_count INTEGER DEFAULT 1");
            st.executeUpdate("UPDATE quest_spatial_evidence SET current_count = required_count " +
                "WHERE satisfied AND current_count = 0");
            st.executeUpdate("ALTER TABLE quest_spatial_evidence ALTER observed_x DROP NOT NULL");
            st.executeUpdate("ALTER TABLE quest_spatial_evidence ALTER observed_y DROP NOT NULL");
            st.executeUpdate("ALTER TABLE quest_spatial_evidence ALTER observed_z DROP NOT NULL");
            st.executeUpdate(
                "CREATE INDEX IF NOT EXISTS quest_spatial_evidence_snapshot " +
                "ON quest_spatial_evidence(snapshot_id)");
        }
    }

    private int existingRecordCount(String hash) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT record_count FROM quest_evidence_bundle WHERE bundle_sha256 = ?")) {
            ps.setString(1, hash);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? rs.getInt(1) : -1;
            }
        }
    }

    private int countForSnapshot(long snapshotId, String worldId, String fileHash) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT COUNT(*) FROM quest_spatial_evidence WHERE snapshot_id = ? " +
                "AND snapshot_world_id = ? AND snapshot_file_sha256 = ?")) {
            ps.setLong(1, snapshotId);
            ps.setString(2, worldId);
            ps.setString(3, fileHash);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? rs.getInt(1) : 0;
            }
        }
    }

    private void insertBundle(
            SpatialEvidenceContract.Bundle bundle, String json, String hash) throws SQLException {
        String sql = "INSERT INTO quest_evidence_bundle VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            int i = 1;
            ps.setString(i++, hash);
            ps.setString(i++, bundle.schema);
            ps.setString(i++, bundle.exportedUtc);
            ps.setString(i++, bundle.projectId);
            ps.setString(i++, bundle.experienceId);
            ps.setString(i++, bundle.packId);
            ps.setString(i++, bundle.contentHash.toLowerCase(Locale.ROOT));
            ps.setString(i++, bundle.activationId);
            ps.setString(i++, bundle.runId);
            ps.setString(i++, bundle.worldUid);
            ps.setInt(i++, bundle.records.size());
            ps.setString(i++, json);
            ps.setString(i, Instant.now().toString());
            ps.executeUpdate();
        }
    }

    private void insertRecords(SpatialEvidenceContract.Bundle bundle, String hash) throws SQLException {
        String sql =
            "INSERT INTO quest_spatial_evidence (" +
            "bundle_sha256, record_index, receipt_id, at_utc, correlation_id, " +
            "transition_id, event_name, area_id, predicate, current_count, required_count, " +
            "anchor_sha256, snapshot_id, snapshot_world_id, snapshot_file_sha256, " +
            "zdo_index, prefab, piece_x, piece_y, piece_z, center_x, center_y, center_z, " +
            "radius_meters, observed_x, observed_y, observed_z, distance_meters, satisfied" +
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, " +
            "?, ?, ?, ?, ?, ?, ?, ?)";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            for (int recordIndex = 0; recordIndex < bundle.records.size(); recordIndex++) {
                SpatialEvidenceContract.Record item = bundle.records.get(recordIndex);
                int i = 1;
                ps.setString(i++, hash);
                ps.setInt(i++, recordIndex);
                ps.setString(i++, item.receiptId);
                ps.setString(i++, item.atUtc);
                setNullableString(ps, i++, item.correlationId);
                setNullableString(ps, i++, item.transitionId);
                setNullableString(ps, i++, item.eventName);
                ps.setString(i++, item.areaId);
                ps.setString(i++, item.predicate);
                ps.setInt(i++, item.currentCount);
                ps.setInt(i++, item.requiredCount);
                ps.setString(i++, item.anchorSha256.toLowerCase(Locale.ROOT));
                ps.setLong(i++, item.snapshot.snapshotId);
                ps.setString(i++, item.snapshot.worldId);
                ps.setString(i++, item.snapshot.fileSha256.toLowerCase(Locale.ROOT));
                ps.setInt(i++, item.piece.zdoIndex);
                ps.setString(i++, item.piece.prefab);
                ps.setDouble(i++, item.piece.position.x);
                ps.setDouble(i++, item.piece.position.y);
                ps.setDouble(i++, item.piece.position.z);
                ps.setDouble(i++, item.resolvedCenter.x);
                ps.setDouble(i++, item.resolvedCenter.y);
                ps.setDouble(i++, item.resolvedCenter.z);
                ps.setDouble(i++, item.radiusMeters);
                setNullableDouble(ps, i++, item.observedPosition == null ? null : item.observedPosition.x);
                setNullableDouble(ps, i++, item.observedPosition == null ? null : item.observedPosition.y);
                setNullableDouble(ps, i++, item.observedPosition == null ? null : item.observedPosition.z);
                if (item.distanceMeters == null) ps.setNull(i++, Types.DOUBLE);
                else ps.setDouble(i++, item.distanceMeters);
                ps.setBoolean(i, item.satisfied);
                ps.addBatch();
            }
            ps.executeBatch();
        }
    }

    private static void setNullableString(PreparedStatement ps, int index, String value)
            throws SQLException {
        if (value == null) ps.setNull(index, Types.VARCHAR);
        else ps.setString(index, value);
    }

    private static void setNullableDouble(PreparedStatement ps, int index, Double value)
            throws SQLException {
        if (value == null) ps.setNull(index, Types.DOUBLE);
        else ps.setDouble(index, value);
    }

    private static void point(ObjectNode target, ResultSet rs, String prefix) throws SQLException {
        target.put("x", rs.getDouble(prefix + "_x"));
        target.put("y", rs.getDouble(prefix + "_y"));
        target.put("z", rs.getDouble(prefix + "_z"));
    }

    private static void nullablePoint(
            ObjectNode target, String name, ResultSet rs, String prefix) throws SQLException {
        double x = rs.getDouble(prefix + "_x");
        boolean missing = rs.wasNull();
        double y = rs.getDouble(prefix + "_y");
        missing |= rs.wasNull();
        double z = rs.getDouble(prefix + "_z");
        missing |= rs.wasNull();
        if (missing) target.putNull(name);
        else {
            ObjectNode value = target.putObject(name);
            value.put("x", x);
            value.put("y", y);
            value.put("z", z);
        }
    }

    private static void putNullable(ObjectNode target, String name, String value) {
        if (value == null) target.putNull(name);
        else target.put(name, value);
    }

    @Override
    public synchronized void close() throws SQLException {
        conn.close();
    }
}
