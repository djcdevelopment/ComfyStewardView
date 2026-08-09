package com.valheim.viewer.db;

import com.valheim.viewer.store.ZdoFlatStore.Categories;
import org.duckdb.DuckDBAppender;
import org.duckdb.DuckDBConnection;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.time.Instant;

/**
 * DuckDB-backed batch cache for full-fidelity ZDO exploration.
 *
 * The existing viewer keeps a compact in-memory subset. This cache is the
 * opposite: a durable analytical store fed during parsing, optimized for
 * offline queries and pre-rendered map layers.
 */
public final class AnalyticsCache implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(AnalyticsCache.class);

    private static final int BATCH_LIMIT = 100_000;

    private final File dbFile;
    private final Connection conn;
    private final boolean captureFields;

    private long snapshotId = -1;

    private boolean finished = false;
    private boolean closed   = false;

    /**
     * Provenance to attach to the next {@link #beginSnapshot} call, consumed once.
     *
     * <p>{@code WorldParser.parse()} opens the snapshot itself, part-way through parsing, so an
     * ingest caller cannot supply provenance by calling {@code beginSnapshot} afterwards — that
     * would open a <em>second</em>, empty snapshot. The caller stages provenance here instead.
     */
    private SnapshotProvenance pendingProvenance;

    /** Prefab dictionary identity, recorded per snapshot so cross-dictionary deltas are detectable. */
    private String prefabDictionaryVersion = null;
    private int    prefabDictionaryEntries = 0;

    private PreparedStatement zdoStmt;
    private PreparedStatement fieldStmt;
    private PreparedStatement itemStmt;
    private DuckDBAppender zdoAppender;
    private DuckDBAppender itemAppender;

    private int zdoBatch;
    private int fieldBatch;
    private int itemBatch;

    public AnalyticsCache(File dbFile, boolean rebuild) throws Exception {
        this(dbFile, rebuild, false);
    }

    public AnalyticsCache(File dbFile, boolean rebuild, boolean captureFields) throws Exception {
        this.dbFile = dbFile;
        this.captureFields = captureFields;
        if (rebuild) {
            deleteIfExists(dbFile);
            deleteIfExists(new File(dbFile.getAbsolutePath() + ".wal"));
        }

        Class.forName("org.duckdb.DuckDBDriver");
        this.conn = DriverManager.getConnection("jdbc:duckdb:" + dbFile.getAbsolutePath());
        this.conn.setAutoCommit(false);
        createSchema();
    }

    public boolean capturesFields() {
        return captureFields;
    }

    public File dbFile() {
        return dbFile;
    }

    public Connection connection() {
        return conn;
    }

    public long snapshotId() {
        return snapshotId;
    }

    /** Stage provenance for the snapshot the parser is about to open. Consumed once. */
    public void setPendingProvenance(SnapshotProvenance provenance) {
        this.pendingProvenance = provenance;
    }

    /** Record which prefab dictionary named this snapshot's ZDOs. Call before the parse opens it. */
    public void setPrefabDictionaryInfo(String version, int entries) {
        this.prefabDictionaryVersion = version;
        this.prefabDictionaryEntries = entries;
    }

    public void beginSnapshot(File sourceFile, int worldVersion, double netTimeSeconds) throws SQLException {
        SnapshotProvenance staged = pendingProvenance;
        pendingProvenance = null;
        beginSnapshot(sourceFile, worldVersion, netTimeSeconds, staged);
    }

    public void beginSnapshot(File sourceFile, int worldVersion, double netTimeSeconds, SnapshotProvenance provenance) throws SQLException {
        if (provenance == null) {
            String defaultWorld = sourceFile.getName().replace(".db", "");
            provenance = new SnapshotProvenance(
                defaultWorld, defaultWorld, "local", "bak_manual",
                Instant.ofEpochMilli(sourceFile.lastModified()).toString(), "",
                SnapshotProvenance.DEFAULT_PARSER_VERSION, SnapshotProvenance.CURRENT_SCHEMA_VERSION);
        }

        try (Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery("SELECT COALESCE(MAX(snapshot_id), 0) + 1 FROM world_snapshot")) {
            rs.next();
            snapshotId = rs.getLong(1);
        }

        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO world_snapshot " +
                "(snapshot_id, source_path, file_size, file_mtime, parsed_at, world_version, net_time_seconds, " +
                "world_id, world_name, source, backup_id, save_timestamp, file_hash, parser_version, steward_schema_version, " +
                "prefab_dictionary_version, prefab_dictionary_entries) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
            ps.setLong(1, snapshotId);
            ps.setString(2, sourceFile.getAbsolutePath());
            ps.setLong(3, sourceFile.length());
            ps.setLong(4, sourceFile.lastModified());
            ps.setString(5, Instant.now().toString());
            ps.setInt(6, worldVersion);
            ps.setDouble(7, netTimeSeconds);
            ps.setString(8, provenance.worldId());
            ps.setString(9, provenance.worldName());
            ps.setString(10, provenance.source());
            ps.setString(11, provenance.backupId());
            ps.setString(12, provenance.saveTimestamp() != null ? provenance.saveTimestamp() : Instant.ofEpochMilli(sourceFile.lastModified()).toString());
            ps.setString(13, provenance.fileHash() != null ? provenance.fileHash() : "");
            ps.setString(14, provenance.parserVersion());
            ps.setInt(15, provenance.schemaVersion());
            ps.setString(16, prefabDictionaryVersion);
            ps.setInt(17, prefabDictionaryEntries);
            ps.executeUpdate();
        }
        conn.commit();
        prepareStatements();
    }

    public void recordDelta(long prevSnapshotId, int zdosAdded, int zdosRemoved, int zdosModified, int itemsDelta) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO snapshot_delta " +
                "(snapshot_id, prev_snapshot_id, zdos_added, zdos_removed, zdos_modified, container_items_delta, computed_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?)")) {
            ps.setLong(1, snapshotId);
            ps.setLong(2, prevSnapshotId);
            ps.setInt(3, zdosAdded);
            ps.setInt(4, zdosRemoved);
            ps.setInt(5, zdosModified);
            ps.setInt(6, itemsDelta);
            ps.setString(7, Instant.now().toString());
            ps.executeUpdate();
        }
        conn.commit();
    }

    public void insertZdo(
            int zdoIndex,
            int prefabHash,
            String prefabName,
            byte category,
            float x,
            float y,
            float z,
            long creatorId,
            long ownerId,
            long spawnTimeMicros,
            int flags) throws SQLException {

        if (snapshotId < 0) return;

        zdoAppender.beginRow();
        zdoAppender.append(snapshotId);
        zdoAppender.append(zdoIndex);
        zdoAppender.append(prefabHash);
        appendNullableString(zdoAppender, prefabName);
        zdoAppender.append(Categories.name(category));
        zdoAppender.append((double) x);
        zdoAppender.append((double) y);
        zdoAppender.append((double) z);
        zdoAppender.append(gridCoord(x, 64));
        zdoAppender.append(gridCoord(z, 64));
        zdoAppender.append(gridCoord(x, 320));
        zdoAppender.append(gridCoord(z, 320));
        appendNullableLong(zdoAppender, creatorId);
        appendNullableLong(zdoAppender, ownerId);
        appendNullableLong(zdoAppender, spawnTimeMicros);
        zdoAppender.append(flags);
        zdoAppender.endRow();
        zdoBatch++;
        flushIfNeeded();
    }

    public void insertIntField(int zdoIndex, String type, int hash, String name, int value) throws SQLException {
        insertField(zdoIndex, type, hash, name, Integer.valueOf(value), null, null, null, null);
    }

    public void insertLongField(int zdoIndex, String type, int hash, String name, long value) throws SQLException {
        insertField(zdoIndex, type, hash, name, null, Long.valueOf(value), null, null, null);
    }

    public void insertFloatField(int zdoIndex, String type, int hash, String name, float value) throws SQLException {
        insertField(zdoIndex, type, hash, name, null, null, Double.valueOf(value), null, null);
    }

    public void insertStringField(int zdoIndex, String type, int hash, String name, String value) throws SQLException {
        insertField(zdoIndex, type, hash, name, null, null, null, value, null);
    }

    public void insertVectorField(int zdoIndex, String type, int hash, String name, String value) throws SQLException {
        insertField(zdoIndex, type, hash, name, null, null, null, value, null);
    }

    public void insertBlobField(int zdoIndex, String type, int hash, String name, int blobSize) throws SQLException {
        insertField(zdoIndex, type, hash, name, null, null, null, null, Integer.valueOf(blobSize));
    }

    public void insertContainerItem(
            int containerZdoIndex,
            String itemName,
            int stack,
            float durability,
            int quality,
            int variant,
            long crafterId,
            String crafterName,
            String customDataJson,
            float containerX,
            float containerY,
            float containerZ) throws SQLException {

        if (snapshotId < 0) return;

        itemAppender.beginRow();
        itemAppender.append(snapshotId);
        itemAppender.append(containerZdoIndex);
        appendNullableString(itemAppender, itemName);
        itemAppender.append(stack);
        itemAppender.append((double) durability);
        itemAppender.append(quality);
        itemAppender.append(variant);
        appendNullableLong(itemAppender, crafterId);
        appendNullableString(itemAppender, crafterName);
        appendNullableString(itemAppender, customDataJson);
        itemAppender.append((double) containerX);
        itemAppender.append((double) containerY);
        itemAppender.append((double) containerZ);
        itemAppender.append(gridCoord(containerX, 64));
        itemAppender.append(gridCoord(containerZ, 64));
        itemAppender.append(gridCoord(containerX, 320));
        itemAppender.append(gridCoord(containerZ, 320));
        itemAppender.endRow();
        itemBatch++;
        flushIfNeeded();
    }

    @Override
    public void close() throws SQLException {
        if (closed) return;
        try {
            finish();
        } finally {
            closed = true;
            conn.close();
        }
    }

    /**
     * Flush, index and commit everything written so far, leaving the connection usable.
     *
     * <p>This deliberately does not close the connection. The ingest path has to query what it
     * just wrote — to compute a delta against the previous snapshot — and closing here made that
     * fail with "Connection was closed" after a ten-minute parse. Releasing the connection is
     * {@link #close()}'s job. Idempotent.
     */
    /** When true, {@link #finish()} skips index creation; a later run pays it once. */
    private boolean deferIndexes = false;

    public void setDeferIndexes(boolean defer) {
        this.deferIndexes = defer;
    }

    public void finish() throws SQLException {
        finish(!deferIndexes);
    }

    /**
     * Variant for bulk lanes: {@code buildIndexes=false} flushes and commits without creating
     * indexes, so a caller loading many snapshots back-to-back can pay the index build once at
     * the end (indexed appends run ~20x slower and degrade linearly with table size).
     */
    public void finish(boolean buildIndexes) throws SQLException {
        if (finished) return;
        flushBatches();
        if (buildIndexes) createIndexes();
        conn.commit();
        closeQuietly(zdoStmt);
        closeQuietly(fieldStmt);
        closeQuietly(itemStmt);
        closeQuietly(zdoAppender);
        closeQuietly(itemAppender);
        zdoStmt = null;
        fieldStmt = null;
        itemStmt = null;
        zdoAppender = null;
        itemAppender = null;
        finished = true;
    }

    private void insertField(
            int zdoIndex,
            String type,
            int hash,
            String name,
            Integer intValue,
            Long longValue,
            Double floatValue,
            String stringValue,
            Integer blobSize) throws SQLException {

        if (snapshotId < 0 || !captureFields) return;

        fieldStmt.setLong(1, snapshotId);
        fieldStmt.setInt(2, zdoIndex);
        fieldStmt.setString(3, type);
        fieldStmt.setInt(4, hash);
        fieldStmt.setString(5, name);
        if (intValue == null) fieldStmt.setNull(6, Types.INTEGER); else fieldStmt.setInt(6, intValue);
        if (longValue == null) fieldStmt.setNull(7, Types.BIGINT); else fieldStmt.setLong(7, longValue);
        if (floatValue == null) fieldStmt.setNull(8, Types.DOUBLE); else fieldStmt.setDouble(8, floatValue);
        fieldStmt.setString(9, stringValue);
        if (blobSize == null) fieldStmt.setNull(10, Types.INTEGER); else fieldStmt.setInt(10, blobSize);
        fieldStmt.addBatch();
        fieldBatch++;
        flushIfNeeded();
    }

    /**
     * Bulk-import archived snapshots (Parquet dirs written by the publish archive lane:
     * {@code snapshot-<id>-<source>/{world_snapshot,zdo,container_item}.parquet}) into this
     * cache, preserving original snapshot ids. Only the {@code latestN} highest snapshot ids are
     * imported; snapshots already present (by id) are skipped. Call before any parse and before
     * indexes exist — imports are plain inserts and stay fast on an unindexed table.
     * Returns the imported snapshot ids in ascending order.
     */
    public List<Long> importArchiveSnapshots(File archiveDir, int latestN) throws SQLException {
        File[] dirs = archiveDir.listFiles(f -> f.isDirectory() &&
            f.getName().startsWith("snapshot-") && new File(f, "world_snapshot.parquet").isFile());
        if (dirs == null || dirs.length == 0) return List.of();

        // Read each dir's snapshot id from its world_snapshot.parquet rather than trusting names.
        Map<Long, File> byId = new TreeMap<>();
        try (Statement st = conn.createStatement()) {
            for (File dir : dirs) {
                String p = dir.getAbsolutePath().replace('\\', '/').replace("'", "''");
                try (ResultSet rs = st.executeQuery(
                        "SELECT snapshot_id FROM read_parquet('" + p + "/world_snapshot.parquet')")) {
                    if (rs.next()) byId.put(rs.getLong(1), dir);
                }
            }
        }

        List<Long> selected = new ArrayList<>(byId.keySet());
        while (selected.size() > latestN) selected.remove(0);

        List<Long> imported = new ArrayList<>();
        try (Statement st = conn.createStatement()) {
            for (long id : selected) {
                try (ResultSet rs = st.executeQuery(
                        "SELECT COUNT(*) FROM world_snapshot WHERE snapshot_id = " + id)) {
                    rs.next();
                    if (rs.getLong(1) > 0) continue;
                }
                String p = byId.get(id).getAbsolutePath().replace('\\', '/').replace("'", "''");
                for (String table : new String[] {"world_snapshot", "zdo", "container_item"}) {
                    st.executeUpdate("INSERT INTO " + table + " BY NAME " +
                        "SELECT * FROM read_parquet('" + p + "/" + table + ".parquet')");
                }
                imported.add(id);
            }
        }
        conn.commit();
        return imported;
    }

    private void createSchema() throws SQLException {
        try (Statement st = conn.createStatement()) {
            st.executeUpdate(
                "CREATE TABLE IF NOT EXISTS world_snapshot (" +
                "snapshot_id BIGINT PRIMARY KEY, " +
                "source_path VARCHAR, " +
                "file_size BIGINT, " +
                "file_mtime BIGINT, " +
                "parsed_at VARCHAR, " +
                "world_version INTEGER, " +
                "net_time_seconds DOUBLE, " +
                "world_id VARCHAR, " +
                "world_name VARCHAR, " +
                "source VARCHAR, " +
                "backup_id VARCHAR, " +
                "save_timestamp VARCHAR, " +
                "file_hash VARCHAR, " +
                "parser_version VARCHAR, " +
                "steward_schema_version INTEGER, " +
                // Which prefab dictionary named this snapshot's ZDOs. Deltas group by
                // prefab_name, so comparing snapshots built with different dictionaries would
                // otherwise report a naming change as a world change.
                "prefab_dictionary_version VARCHAR, " +
                "prefab_dictionary_entries INTEGER)");

            st.executeUpdate(
                "CREATE TABLE IF NOT EXISTS snapshot_delta (" +
                "snapshot_id BIGINT PRIMARY KEY, " +
                "prev_snapshot_id BIGINT, " +
                "zdos_added INTEGER, " +
                "zdos_removed INTEGER, " +
                "zdos_modified INTEGER, " +
                "container_items_delta INTEGER, " +
                "computed_at VARCHAR)");

            st.executeUpdate(
                "CREATE TABLE IF NOT EXISTS zdo (" +
                "snapshot_id BIGINT, " +
                "zdo_index INTEGER, " +
                "prefab_hash INTEGER, " +
                "prefab_name VARCHAR, " +
                "category VARCHAR, " +
                "x DOUBLE, y DOUBLE, z DOUBLE, " +
                "sector_x INTEGER, sector_z INTEGER, " +
                "zone_x INTEGER, zone_z INTEGER, " +
                "creator_id BIGINT, owner_id BIGINT, " +
                "spawn_time_micros BIGINT, " +
                "flags INTEGER)");

            st.executeUpdate(
                "CREATE TABLE IF NOT EXISTS zdo_field (" +
                "snapshot_id BIGINT, " +
                "zdo_index INTEGER, " +
                "field_type VARCHAR, " +
                "field_hash INTEGER, " +
                "field_name VARCHAR, " +
                "int_value INTEGER, " +
                "long_value BIGINT, " +
                "float_value DOUBLE, " +
                "string_value VARCHAR, " +
                "blob_size INTEGER)");

            st.executeUpdate(
                "CREATE TABLE IF NOT EXISTS container_item (" +
                "snapshot_id BIGINT, " +
                "container_zdo_index INTEGER, " +
                "item_name VARCHAR, " +
                "stack INTEGER, " +
                "durability DOUBLE, " +
                "quality INTEGER, " +
                "variant INTEGER, " +
                "crafter_id BIGINT, " +
                "crafter_name VARCHAR, " +
                "custom_data_json VARCHAR, " +
                "container_x DOUBLE, container_y DOUBLE, container_z DOUBLE, " +
                "sector_x INTEGER, sector_z INTEGER, " +
                "zone_x INTEGER, zone_z INTEGER)");

            st.executeUpdate(
                "CREATE TABLE IF NOT EXISTS render_cell (" +
                "snapshot_id BIGINT, " +
                "layer VARCHAR, " +
                "cell_size INTEGER, " +
                "cx INTEGER, cz INTEGER, " +
                "count_value BIGINT, " +
                "sum_value DOUBLE, " +
                "log_value DOUBLE)");

            // Migrations. CREATE TABLE IF NOT EXISTS is a no-op on a cache built by an earlier
            // build, so columns added later have to be applied separately or every INSERT against
            // an existing cache fails on the missing column.
            for (String ddl : new String[] {
                "ALTER TABLE world_snapshot ADD COLUMN IF NOT EXISTS prefab_dictionary_version VARCHAR",
                "ALTER TABLE world_snapshot ADD COLUMN IF NOT EXISTS prefab_dictionary_entries INTEGER",
            }) {
                try { st.executeUpdate(ddl); }
                catch (SQLException e) { log.warn("Schema migration skipped ({}): {}", ddl, e.getMessage()); }
            }
        }
        conn.commit();
    }

    private void prepareStatements() throws SQLException {
        DuckDBConnection duck = conn.unwrap(DuckDBConnection.class);
        zdoAppender = duck.createAppender("zdo");
        itemAppender = duck.createAppender("container_item");

        if (captureFields) {
            fieldStmt = conn.prepareStatement(
                "INSERT INTO zdo_field " +
                "(snapshot_id, zdo_index, field_type, field_hash, field_name, int_value, long_value, " +
                "float_value, string_value, blob_size) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        }
    }

    /** Public so bulk lanes can drop indexes before a large append and rebuild them after. */
    public void dropIndexes() throws SQLException {
        try (Statement st = conn.createStatement()) {
            for (String name : new String[] {
                "zdo_snapshot_idx", "zdo_prefab_idx", "zdo_category_idx", "zdo_creator_idx",
                "zdo_sector_idx", "zdo_zone_idx", "zdo_xz_idx", "zdo_field_hash_idx",
                "container_item_name_idx", "container_item_crafter_idx",
                "container_item_sector_idx", "render_cell_layer_idx",
            }) {
                st.executeUpdate("DROP INDEX IF EXISTS " + name);
            }
        }
        conn.commit();
    }

    public void createIndexes() throws SQLException {
        try (Statement st = conn.createStatement()) {
            // Every SnapshotDeltaEngine query filters on snapshot_id; without this the delta
            // path full-scans the multi-snapshot table.
            st.executeUpdate("CREATE INDEX IF NOT EXISTS zdo_snapshot_idx ON zdo(snapshot_id, prefab_hash)");
            st.executeUpdate("CREATE INDEX IF NOT EXISTS zdo_prefab_idx ON zdo(prefab_hash)");
            st.executeUpdate("CREATE INDEX IF NOT EXISTS zdo_category_idx ON zdo(category)");
            st.executeUpdate("CREATE INDEX IF NOT EXISTS zdo_creator_idx ON zdo(creator_id)");
            st.executeUpdate("CREATE INDEX IF NOT EXISTS zdo_sector_idx ON zdo(sector_x, sector_z)");
            st.executeUpdate("CREATE INDEX IF NOT EXISTS zdo_zone_idx ON zdo(zone_x, zone_z)");
            st.executeUpdate("CREATE INDEX IF NOT EXISTS zdo_xz_idx ON zdo(x, z)");
            st.executeUpdate("CREATE INDEX IF NOT EXISTS zdo_field_hash_idx ON zdo_field(field_hash)");
            st.executeUpdate("CREATE INDEX IF NOT EXISTS container_item_name_idx ON container_item(item_name)");
            st.executeUpdate("CREATE INDEX IF NOT EXISTS container_item_crafter_idx ON container_item(crafter_id)");
            st.executeUpdate("CREATE INDEX IF NOT EXISTS container_item_sector_idx ON container_item(sector_x, sector_z)");
            st.executeUpdate("CREATE INDEX IF NOT EXISTS render_cell_layer_idx ON render_cell(layer, cell_size)");
        }
    }

    private void flushIfNeeded() throws SQLException {
        if (zdoBatch + fieldBatch + itemBatch >= BATCH_LIMIT) {
            flushBatches();
        }
    }

    public void flushBatches() throws SQLException {
        if (zdoBatch > 0) {
            zdoAppender.flush();
            zdoBatch = 0;
        }
        if (fieldBatch > 0) {
            fieldStmt.executeBatch();
            fieldBatch = 0;
        }
        if (itemBatch > 0) {
            itemAppender.flush();
            itemBatch = 0;
        }
        conn.commit();
    }

    private static int gridCoord(float value, int cellSize) {
        return (int) Math.floor(value / (double) cellSize);
    }

    private static void setNullableLong(PreparedStatement ps, int index, long value) throws SQLException {
        if (value == 0L) ps.setNull(index, Types.BIGINT);
        else ps.setLong(index, value);
    }

    private static void appendNullableLong(DuckDBAppender appender, long value) throws SQLException {
        if (value == 0L) appender.appendNull();
        else appender.append(value);
    }

    private static void appendNullableString(DuckDBAppender appender, String value) throws SQLException {
        if (value == null) appender.appendNull();
        else appender.append(value);
    }

    private static void closeQuietly(AutoCloseable closeable) {
        if (closeable == null) return;
        try {
            closeable.close();
        } catch (Exception ignored) {
        }
    }

    private static void deleteIfExists(File file) {
        if (file.exists() && !file.delete()) {
            throw new IllegalStateException("Could not delete existing cache file: " + file.getAbsolutePath());
        }
    }
}
