package com.valheim.viewer.db;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeMap;

/**
 * Computes deltas between two snapshots of the same world.
 *
 * <h2>What identifies a world object</h2>
 *
 * A ZDO is identified here by <b>prefab hash plus quantised position</b>, not by
 * {@code zdo_index}. That distinction is the whole correctness of this class.
 *
 * <p>{@code zdo_index} is the parse loop counter — a ZDO's ordinal position in the save file.
 * The parser never reads a ZDOID, so the {@code zdo} table carries no persistent per-object
 * identity. Comparing {@code zdo_index} between two saves compares array slots, not objects:
 * if snapshot A has N rows (indices {@code 0..N-1}) and B has M rows, then "present in B but
 * not in A" is exactly the index range {@code N..M-1}. The result collapses to
 * {@code added = max(0, M-N)}, {@code removed = max(0, N-M)} — one of them always zero — with
 * the prefab breakdown taken from whichever objects happen to sit at the tail of the larger
 * file. It reports the row-count difference dressed up as a delta.
 *
 * <p>Position is a sound surrogate: two objects cannot occupy the same coordinates, and a
 * placed object keeps its position across saves. Coordinates are quantised to 1 cm so that
 * float→double widening cannot produce spurious inequality.
 *
 * <h2>Mobile categories churn by design</h2>
 *
 * Creatures, dropped items and ships move, so they legitimately appear as
 * removed-here/added-there between any two saves. Per-category breakdowns are returned so
 * that churn is visible rather than buried in the headline number; {@code CREATURE} and
 * {@code DROPPED_ITEM} movement is not a build change.
 *
 * <h2>Dictionary skew</h2>
 *
 * The prefab breakdowns group by {@code prefab_name}, which the prefab dictionary supplies.
 * If two snapshots were built with different dictionaries, a rename would read as a world
 * change. {@link DeltaResult#dictionaryMismatch()} flags that; callers should surface it
 * rather than present the numbers as world activity.
 */
public final class SnapshotDeltaEngine {

    /** Coordinate quantisation: 100 = 1 cm buckets. */
    private static final int POS_SCALE = 100;

    public record DeltaResult(
            long fromSnapshotId,
            long toSnapshotId,
            int zdosAdded,
            int zdosRemoved,
            int zdosModified,
            int containerItemsDelta,
            Map<String, Integer> addedPrefabs,
            Map<String, Integer> removedPrefabs,
            int newPortals,
            int newTombstones,
            Map<String, Integer> addedByCategory,
            Map<String, Integer> removedByCategory,
            boolean dictionaryMismatch,
            String fromDictionaryVersion,
            String toDictionaryVersion,
            long zdoCountFrom,
            long zdoCountTo,
            /**
             * Self-check: {@code added - removed} must equal {@code countTo - countFrom}.
             *
             * <p>It can fail in one known way. About 0.8% of position keys are shared by more
             * than one ZDO (objects at identical coordinates), and the anti-join treats a key as
             * present or absent, not as a multiplicity. If the number of objects at a duplicated
             * key changes, that change is invisible to added/removed while still moving the row
             * count. A false here means the headline numbers understate real churn.
             */
            boolean reconciles
    ) {}

    private SnapshotDeltaEngine() {}

    /**
     * SQL predicate implementing Steward's snapshot identity rule.
     *
     * <p>The aliases are supplied only by package-owned query builders, never by request data.
     * Keeping the predicate here ensures tabular deltas and spatial delta rasters cannot drift
     * into subtly different definitions of "the same object".
     */
    static String missingIdentityPredicate(String presentAlias, String absentAlias) {
        return "NOT EXISTS (" +
            "SELECT 1 FROM zdo " + absentAlias + " " +
            "WHERE " + absentAlias + ".snapshot_id = ? " +
            "AND " + absentAlias + ".prefab_hash = " + presentAlias + ".prefab_hash " +
            "AND CAST(ROUND(" + absentAlias + ".x * " + POS_SCALE + ") AS BIGINT) = " +
                "CAST(ROUND(" + presentAlias + ".x * " + POS_SCALE + ") AS BIGINT) " +
            "AND CAST(ROUND(" + absentAlias + ".y * " + POS_SCALE + ") AS BIGINT) = " +
                "CAST(ROUND(" + presentAlias + ".y * " + POS_SCALE + ") AS BIGINT) " +
            "AND CAST(ROUND(" + absentAlias + ".z * " + POS_SCALE + ") AS BIGINT) = " +
                "CAST(ROUND(" + presentAlias + ".z * " + POS_SCALE + ") AS BIGINT))";
    }

    public static DeltaResult computeDelta(Connection conn, long fromSnapshotId, long toSnapshotId)
            throws SQLException {

        Map<String, Integer> addedPrefabs    = new LinkedHashMap<>();
        Map<String, Integer> removedPrefabs  = new LinkedHashMap<>();
        Map<String, Integer> addedByCategory = new TreeMap<>();
        Map<String, Integer> removedByCategory = new TreeMap<>();

        Counts added   = collectMissing(conn, toSnapshotId, fromSnapshotId, addedPrefabs, addedByCategory);
        Counts removed = collectMissing(conn, fromSnapshotId, toSnapshotId, removedPrefabs, removedByCategory);

        int zdosModified      = countModified(conn, fromSnapshotId, toSnapshotId);
        int containerItemsDelta = countItems(conn, toSnapshotId) - countItems(conn, fromSnapshotId);

        String fromDict = dictionaryVersion(conn, fromSnapshotId);
        String toDict   = dictionaryVersion(conn, toSnapshotId);
        boolean mismatch = fromDict != null && toDict != null && !fromDict.equals(toDict);

        long countFrom = countZdos(conn, fromSnapshotId);
        long countTo   = countZdos(conn, toSnapshotId);
        boolean reconciles = (added.total - removed.total) == (countTo - countFrom);

        return new DeltaResult(
                fromSnapshotId, toSnapshotId,
                added.total, removed.total, zdosModified, containerItemsDelta,
                addedPrefabs, removedPrefabs,
                added.portals, added.tombstones,
                addedByCategory, removedByCategory,
                mismatch, fromDict, toDict,
                countFrom, countTo, reconciles);
    }

    private static long countZdos(Connection conn, long snapshotId) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT COUNT(*) FROM zdo WHERE snapshot_id = ?")) {
            ps.setLong(1, snapshotId);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? rs.getLong(1) : 0L;
            }
        }
    }

    private static final class Counts {
        int total, portals, tombstones;
    }

    /**
     * Rows present in {@code presentIn} whose (prefab, position) key is absent from {@code absentFrom}.
     */
    private static Counts collectMissing(Connection conn, long presentIn, long absentFrom,
                                         Map<String, Integer> byPrefab,
                                         Map<String, Integer> byCategory) throws SQLException {
        String sql =
            "SELECT b.prefab_name, b.category, COUNT(*) AS n " +
            "FROM zdo b " +
            "WHERE b.snapshot_id = ? " +
            "  AND " + missingIdentityPredicate("b", "a") + " " +
            "GROUP BY b.prefab_name, b.category " +
            "ORDER BY n DESC";

        Counts c = new Counts();
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setLong(1, presentIn);
            ps.setLong(2, absentFrom);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    String prefab = rs.getString(1);
                    String category = rs.getString(2);
                    int n = rs.getInt(3);
                    if (prefab == null) prefab = "unknown";
                    if (category == null) category = "UNKNOWN";

                    byPrefab.merge(prefab, n, Integer::sum);
                    byCategory.merge(category, n, Integer::sum);
                    c.total += n;
                    // Category, not a substring of the name — "portal_wood" and "Player_tombstone"
                    // are classified during parsing and the classification is what we mean here.
                    if ("PORTAL".equals(category))    c.portals    += n;
                    if ("TOMBSTONE".equals(category)) c.tombstones += n;
                }
            }
        }
        return c;
    }

    /**
     * Objects present in both snapshots at the same place whose ownership changed.
     *
     * <p>Only the columns the cache actually stores per ZDO can be compared. Per-field changes
     * would need {@code --cache-fields}, which is off by default.
     */
    private static int countModified(Connection conn, long fromSnapshotId, long toSnapshotId) throws SQLException {
        String sql =
            "SELECT COUNT(*) FROM zdo a JOIN zdo b " +
            "  ON a.prefab_hash = b.prefab_hash " +
            " AND CAST(ROUND(a.x * " + POS_SCALE + ") AS BIGINT) = CAST(ROUND(b.x * " + POS_SCALE + ") AS BIGINT) " +
            " AND CAST(ROUND(a.y * " + POS_SCALE + ") AS BIGINT) = CAST(ROUND(b.y * " + POS_SCALE + ") AS BIGINT) " +
            " AND CAST(ROUND(a.z * " + POS_SCALE + ") AS BIGINT) = CAST(ROUND(b.z * " + POS_SCALE + ") AS BIGINT) " +
            "WHERE a.snapshot_id = ? AND b.snapshot_id = ? " +
            "  AND (a.creator_id IS DISTINCT FROM b.creator_id OR a.owner_id IS DISTINCT FROM b.owner_id)";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setLong(1, fromSnapshotId);
            ps.setLong(2, toSnapshotId);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? rs.getInt(1) : 0;
            }
        }
    }

    private static int countItems(Connection conn, long snapshotId) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT COUNT(*) FROM container_item WHERE snapshot_id = ?")) {
            ps.setLong(1, snapshotId);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? rs.getInt(1) : 0;
            }
        }
    }

    /**
     * Dictionary version for a snapshot, or null when unknown.
     *
     * <p>Tolerates the column being absent: a cache written before this column existed is only
     * migrated by {@code AnalyticsCache.createSchema()}, and the read-only reader path never
     * opens one. An unknown version means "cannot tell", which reports as no mismatch — never a
     * failed comparison.
     */
    private static String dictionaryVersion(Connection conn, long snapshotId) {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT prefab_dictionary_version FROM world_snapshot WHERE snapshot_id = ?")) {
            ps.setLong(1, snapshotId);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? rs.getString(1) : null;
            }
        } catch (SQLException e) {
            return null;   // pre-migration cache
        }
    }
}
