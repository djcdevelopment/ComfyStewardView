package com.valheim.viewer.db;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.valheim.viewer.parser.WorldParser;
import com.valheim.viewer.store.ZdoFlatStore;

import java.io.File;
import java.io.FileInputStream;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Instant;

/**
 * Headless ingestion service that parses a local world save, appends it to DuckDB with provenance,
 * pre-calculates snapshot deltas, and returns an Islet operational receipt.
 */
public final class SnapshotIngestService {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    public static ObjectNode processIngest(File dbFile, SnapshotProvenance provenance, AnalyticsCache cache) throws Exception {
        return processIngest(dbFile, provenance, cache, false);
    }

    /**
     * {@code deferDelta=true} skips the inline delta computation — the caller runs it in a
     * post-response pass (the delta of a 9M-ZDO world can take minutes and blocking the HTTP
     * response on it caused client timeouts). The receipt then carries {@code deltaPending}.
     */
    public static ObjectNode processIngest(File dbFile, SnapshotProvenance provenance, AnalyticsCache cache,
            boolean deferDelta) throws Exception {
        long startTime = System.currentTimeMillis();

        if (!dbFile.exists() || !dbFile.isFile()) {
            throw new IllegalArgumentException("World save file not found: " + dbFile.getAbsolutePath());
        }

        // Verify SHA256 file hash if provided, or compute if empty
        String computedHash = sha256(dbFile);
        if (provenance.fileHash() != null && !provenance.fileHash().isBlank()
                && !provenance.fileHash().equalsIgnoreCase(computedHash)) {
            throw new IllegalArgumentException("File hash mismatch for " + dbFile.getName() +
                    ". Expected: " + provenance.fileHash() + ", Computed: " + computedHash);
        }

        SnapshotProvenance finalProvenance = new SnapshotProvenance(
                provenance.worldId(),
                provenance.worldName(),
                provenance.source(),
                provenance.backupId(),
                provenance.saveTimestamp() != null ? provenance.saveTimestamp() : Instant.ofEpochMilli(dbFile.lastModified()).toString(),
                computedHash,
                provenance.parserVersion(),
                provenance.schemaVersion()
        );

        // Find the previous snapshot for this world. This must run BEFORE the parse, which is
        // what creates the current snapshot row — afterwards MAX(snapshot_id) would return the
        // ingest's own snapshot and the delta would compare it against itself.
        long prevSnapshotId = -1;
        Connection conn = cache.connection();
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT MAX(snapshot_id) FROM world_snapshot WHERE world_id = ? AND snapshot_id < ?")) {
            ps.setString(1, finalProvenance.worldId());
            ps.setLong(2, cache.snapshotId() > 0 ? cache.snapshotId() : Long.MAX_VALUE);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    prevSnapshotId = rs.getLong(1);
                    if (rs.wasNull()) prevSnapshotId = -1;
                }
            }
        }

        // Run parser.
        //
        // WorldParser.parse() opens the snapshot itself, part-way through parsing, and every
        // insertZdo lands under that snapshot_id. Provenance therefore has to be staged BEFORE
        // the parse — calling beginSnapshot afterwards would open a second, empty snapshot and
        // leave the 9M parsed rows attached to the first one with blank provenance.
        WorldParser parser = new WorldParser();
        parser.setAnalyticsCache(cache);
        cache.setPendingProvenance(finalProvenance);
        // Appending through existing indexes is ~20x slower and degrades linearly with rows
        // already in the table (O(n^2) across a series of ingests). Drop them for the bulk
        // append; finish() rebuilds them once.
        cache.dropIndexes();
        ZdoFlatStore store = parser.parse(dbFile);
        cache.finish();

        long currentSnapshotId = cache.snapshotId();

        // Pre-calculate Delta if previous snapshot exists (unless deferred to a post-pass)
        SnapshotDeltaEngine.DeltaResult delta = null;
        if (prevSnapshotId > 0 && !deferDelta) {
            delta = SnapshotDeltaEngine.computeDelta(conn, prevSnapshotId, currentSnapshotId);
            cache.recordDelta(prevSnapshotId, delta.zdosAdded(), delta.zdosRemoved(), delta.zdosModified(), delta.containerItemsDelta());
        }

        long durationMs = System.currentTimeMillis() - startTime;

        // Build Islet operational receipt
        ObjectNode receipt = MAPPER.createObjectNode();
        receipt.put("status", "success");
        receipt.put("snapshotId", currentSnapshotId);
        receipt.put("worldId", finalProvenance.worldId());
        receipt.put("worldName", finalProvenance.worldName());
        receipt.put("source", finalProvenance.source());
        receipt.put("backupId", finalProvenance.backupId());
        receipt.put("fileHash", computedHash);
        receipt.put("fileSize", dbFile.length());
        // Total ZDOs in the save, not store.size() — that is only the "interesting" subset kept
        // in memory (roughly a tenth), which reads as a parse failure in an operational receipt.
        receipt.put("parsedZdos", store.zdosSeen());
        receipt.put("storedZdos", store.size());
        receipt.put("worldVersion", store.worldVersion);
        receipt.put("prefabDictionaryVersion", store.dictionaryGameVersion);
        receipt.put("prefabCoveragePct", Math.round(store.resolvedPct() * 100.0) / 100.0);
        receipt.put("durationMs", durationMs);
        receipt.put("ingestedAt", Instant.now().toString());

        receipt.put("deltaPending", deferDelta && prevSnapshotId > 0);
        ObjectNode deltaNode = receipt.putObject("delta");
        deltaNode.put("prevSnapshotId", prevSnapshotId);
        deltaNode.put("zdosAdded", delta != null ? delta.zdosAdded() : 0);
        deltaNode.put("zdosRemoved", delta != null ? delta.zdosRemoved() : 0);
        deltaNode.put("zdosModified", delta != null ? delta.zdosModified() : 0);
        deltaNode.put("containerItemsDelta", delta != null ? delta.containerItemsDelta() : 0);
        deltaNode.put("newPortals", delta != null ? delta.newPortals() : 0);
        deltaNode.put("newTombstones", delta != null ? delta.newTombstones() : 0);
        deltaNode.put("dictionaryMismatch", delta != null && delta.dictionaryMismatch());
        if (delta != null && delta.dictionaryMismatch()) {
            deltaNode.put("warning", "Snapshots named by different prefab dictionaries ("
                + delta.fromDictionaryVersion() + " vs " + delta.toDictionaryVersion()
                + "); prefab-level deltas are not comparable.");
        }

        return receipt;
    }

    /** SHA-256 of a file, lowercase hex. Shared with the batch path so both stamp the same value. */
    public static String sha256(File file) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (FileInputStream fis = new FileInputStream(file);
             DigestInputStream dis = new DigestInputStream(fis, md)) {
            byte[] buffer = new byte[65536];
            while (dis.read(buffer) != -1) {
                // Digest update happens automatically
            }
        }
        byte[] digest = md.digest();
        StringBuilder sb = new StringBuilder();
        for (byte b : digest) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }
}
