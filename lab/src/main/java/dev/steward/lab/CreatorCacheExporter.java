package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.sql.DriverManager;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/** Private snapshot cache for Creator selection, including bindable signs.
 * Geometry must come from the same parser pass as the analytics cache. The
 * representation catalog is copied from a separately verified Steward release;
 * its world rows and coordinates are never imported into the Creator snapshot.
 */
public final class CreatorCacheExporter {
    public static void main(String[] args) throws Exception {
        if (args.length != 5) throw new IllegalArgumentException(
            "Usage: CreatorCacheExporter <analytics.duckdb> <geometry.parquet> " +
            "<catalog-release.duckdb> <creator.duckdb> <snapshot-id>");
        export(Path.of(args[0]), Path.of(args[1]), Path.of(args[2]), Path.of(args[3]),
            Long.parseLong(args[4]));
    }

    public static void export(Path source, Path geometry, Path catalog, Path output,
            long snapshot) throws Exception {
        source = source.toAbsolutePath().normalize();
        geometry = geometry.toAbsolutePath().normalize();
        catalog = catalog.toAbsolutePath().normalize();
        output = output.toAbsolutePath().normalize();
        if (snapshot <= 0 || !Files.isRegularFile(source) || !Files.isRegularFile(geometry)
                || !Files.isRegularFile(catalog) || Files.exists(output)
                || output.equals(source) || output.equals(catalog))
            throw new IllegalArgumentException("Creator cache inputs or output are invalid");
        Files.createDirectories(output.getParent());
        Path temporary = output.resolveSibling(output.getFileName() + ".tmp-" + UUID.randomUUID());
        String geometryHash = sha(geometry), catalogHash = sha(catalog), sourceHash = sha(source);
        Map<String, Object> receipt = new LinkedHashMap<>();
        Class.forName("org.duckdb.DuckDBDriver");
        try {
            try (var connection = DriverManager.getConnection("jdbc:duckdb:");
                 var sql = connection.createStatement()) {
                sql.execute("SET threads = 4");
                sql.execute("SET memory_limit = '2GB'");
                sql.execute("ATTACH " + quote(source) + " AS source_cache (READ_ONLY)");
                sql.execute("ATTACH " + quote(catalog) + " AS catalog_cache (READ_ONLY)");
                sql.execute("ATTACH " + quote(temporary) + " AS creator_cache");
                sql.execute("CREATE TEMP VIEW geometry_input AS SELECT * FROM read_parquet(" +
                    quote(geometry) + ") WHERE category IN ('BUILDING', 'SIGN')");
                String selected = " FROM source_cache.zdo s WHERE s.snapshot_id = " + snapshot +
                    " AND s.category IN ('BUILDING', 'SIGN')";
                long expected;
                try (var rows = sql.executeQuery("SELECT COUNT(*)" + selected)) {
                    rows.next(); expected = rows.getLong(1);
                }
                if (expected == 0) throw new IllegalArgumentException("Creator snapshot is empty");
                try (var rows = sql.executeQuery("SELECT COUNT(*), COUNT(DISTINCT zdo_index) FROM geometry_input")) {
                    rows.next();
                    if (rows.getLong(1) != expected || rows.getLong(2) != expected)
                        throw new IllegalArgumentException("Creator geometry membership mismatch");
                }
                try (var rows = sql.executeQuery("SELECT COUNT(*) FROM source_cache.zdo s " +
                        "LEFT JOIN geometry_input g USING (zdo_index) WHERE s.snapshot_id = " + snapshot +
                        " AND s.category IN ('BUILDING', 'SIGN') AND (g.zdo_index IS NULL " +
                        "OR s.prefab_hash IS DISTINCT FROM g.prefab_hash " +
                        "OR s.category IS DISTINCT FROM g.category " +
                        "OR abs(s.x-g.x)>0.0001 OR abs(s.z-g.z)>0.0001)")) {
                    rows.next();
                    if (rows.getLong(1) != 0)
                        throw new IllegalArgumentException("Creator geometry identity mismatch");
                }
                String snapshotHash;
                try (var rows = sql.executeQuery("SELECT file_hash FROM source_cache.world_snapshot " +
                        "WHERE snapshot_id = " + snapshot)) {
                    if (!rows.next()) throw new IllegalArgumentException("Creator snapshot is missing");
                    snapshotHash = rows.getString(1);
                    if (snapshotHash == null || !snapshotHash.matches("[0-9a-f]{64}") || rows.next())
                        throw new IllegalArgumentException("Creator snapshot provenance is invalid");
                }
                sql.execute("CREATE TABLE creator_cache.world_snapshot AS SELECT * FROM " +
                    "source_cache.world_snapshot WHERE snapshot_id = " + snapshot);
                for (String table : new String[]{"prefab_geometry", "prefab_representation",
                        "prefab_representation_primitive"})
                    sql.execute("CREATE TABLE creator_cache." + table + " AS SELECT * FROM catalog_cache." + table);
                sql.execute("CREATE TABLE creator_cache.zdo AS SELECT s.snapshot_id, s.zdo_index, " +
                    "s.x, g.y, s.z, s.prefab_name, s.prefab_hash, s.category, ''::VARCHAR AS biome, " +
                    "g.has_rot, g.rot_x, g.rot_y, g.rot_z FROM source_cache.zdo s " +
                    "JOIN geometry_input g USING (zdo_index) WHERE s.snapshot_id = " + snapshot +
                    " AND s.category IN ('BUILDING', 'SIGN') ORDER BY s.zdo_index");
                sql.execute("CREATE TABLE creator_cache.release_metadata AS SELECT " +
                    "'" + snapshotHash + "'::VARCHAR AS snapshot_hash, '" + geometryHash +
                    "'::VARCHAR AS building_geometry_sha256, piece_geometry_sha256, " +
                    "representation_catalog_sha256, promotion_receipt_sha256 FROM catalog_cache.release_metadata");
                sql.execute("CHECKPOINT creator_cache");
                receipt.put("schema", "steward-creator-cache/v1");
                receipt.put("snapshot_id", snapshot);
                receipt.put("snapshot_file_sha256", snapshotHash);
                receipt.put("source_cache_sha256", sourceHash);
                receipt.put("geometry_sha256", geometryHash);
                receipt.put("catalog_release_sha256", catalogHash);
                receipt.put("rows", expected);
                receipt.put("categories", new String[]{"BUILDING", "SIGN"});
                receipt.put("biome_authority", "unavailable; no biome filter applied");
            }
            Files.move(temporary, output, StandardCopyOption.ATOMIC_MOVE);
        } finally {
            Files.deleteIfExists(temporary);
        }
        receipt.put("cache_sha256", sha(output));
        new ObjectMapper().writerWithDefaultPrettyPrinter().writeValue(
            output.resolveSibling(output.getFileName() + ".json").toFile(), receipt);
        System.out.println("Creator cache ready: " + output + " (" + receipt.get("rows") + " rows)");
    }

    private static String quote(Path path) { return "'" + path.toString().replace("'", "''") + "'"; }
    private static String sha(Path path) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (var input = Files.newInputStream(path)) {
            byte[] buffer = new byte[1024 * 1024];
            int count;
            while ((count = input.read(buffer)) >= 0) digest.update(buffer, 0, count);
        }
        return HexFormat.of().formatHex(digest.digest());
    }
}
