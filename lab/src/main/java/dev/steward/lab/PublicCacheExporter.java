package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.duckdb.DuckDBFunctions;

import java.io.InputStream;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/** Builds the smallest self-contained DuckDB needed by the public Build density experience. */
public final class PublicCacheExporter {
    private PublicCacheExporter() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 4) {
            throw new IllegalArgumentException(
                "Usage: PublicCacheExporter <source.duckdb> <public.duckdb> <snapshot-id> <context-manifest>");
        }
        export(Path.of(args[0]), Path.of(args[1]), Long.parseLong(args[2]), Path.of(args[3]));
    }

    static void export(Path sourcePath, Path outputPath, long snapshotId, Path contextManifest) throws Exception {
        sourcePath = sourcePath.toAbsolutePath().normalize();
        outputPath = outputPath.toAbsolutePath().normalize();
        if (!Files.isRegularFile(sourcePath)) throw new IllegalArgumentException("Source cache not found: " + sourcePath);
        if (snapshotId <= 0) throw new IllegalArgumentException("Snapshot ID must be positive");
        if (sourcePath.equals(outputPath)) throw new IllegalArgumentException("Public cache must be a separate file");
        Files.createDirectories(outputPath.getParent());

        Path temporary = outputPath.resolveSibling(outputPath.getFileName() + ".tmp-" + UUID.randomUUID());
        Path metadata = outputPath.resolveSibling(outputPath.getFileName() + ".json");
        Path temporaryMetadata = metadata.resolveSibling(metadata.getFileName() + ".tmp-" + UUID.randomUUID());
        Files.deleteIfExists(temporary);
        Files.deleteIfExists(temporaryMetadata);

        Class.forName("org.duckdb.DuckDBDriver");
        long fullZdoCount;
        long buildingCount;
        String snapshotHash;
        String worldId;
        Map<String, Long> biomeCounts = new LinkedHashMap<>();
        String sourceSql = quote(sourcePath);
        String targetSql = quote(temporary);
        try (Connection connection = DriverManager.getConnection("jdbc:duckdb:");
             Statement statement = connection.createStatement()) {
            statement.execute("SET threads = 4");
            statement.execute("SET memory_limit = '4GB'");
            statement.execute("SET preserve_insertion_order = false");
            statement.execute("ATTACH '" + sourceSql + "' AS source_cache (READ_ONLY)");
            statement.execute("ATTACH '" + targetSql + "' AS public_cache");

            try (ResultSet row = statement.executeQuery(
                    "SELECT file_hash, world_id, (SELECT COUNT(*) FROM source_cache.zdo " +
                    "WHERE snapshot_id = " + snapshotId + ") AS zdo_count, " +
                    "(SELECT COUNT(*) FROM source_cache.zdo WHERE snapshot_id = " + snapshotId +
                    " AND category = 'BUILDING') AS building_count " +
                    "FROM source_cache.world_snapshot WHERE snapshot_id = " + snapshotId)) {
                if (!row.next()) throw new IllegalArgumentException("Snapshot not found: " + snapshotId);
                snapshotHash = row.getString("file_hash");
                worldId = row.getString("world_id");
                fullZdoCount = row.getLong("zdo_count");
                buildingCount = row.getLong("building_count");
            }
            if (snapshotHash == null || snapshotHash.isBlank()) {
                throw new IllegalArgumentException("Snapshot has no file hash: " + snapshotId);
            }
            TerrainContext context = TerrainContext.load(
                contextManifest, new ObjectMapper(), snapshotId, snapshotHash, worldId);
            BiomeClassifier classifier = new BiomeClassifier(context);
            try (var function = DuckDBFunctions.scalarFunction()
                    .withName("steward_biome")
                    .withParameters(Double.class, Double.class)
                    .withReturnType(String.class)
                    .withNullInNullOut()) {
                function.withFunction((Double x, Double z) -> classifier.classify(x, z)).register(connection);
            }

            statement.execute("CREATE TABLE public_cache.world_snapshot AS SELECT " +
                "snapshot_id, world_id, world_name, source, backup_id, parsed_at, file_hash, " +
                "prefab_dictionary_version FROM source_cache.world_snapshot WHERE snapshot_id = " + snapshotId);
            statement.execute("CREATE TABLE public_cache.zdo AS SELECT " +
                "snapshot_id, zdo_index, x, z, prefab_name, prefab_hash, category, " +
                "steward_biome(x, z) AS biome " +
                "FROM source_cache.zdo WHERE snapshot_id = " + snapshotId +
                " AND category = 'BUILDING' ORDER BY x, z");
            statement.execute("CREATE TABLE public_cache.release_metadata AS SELECT " +
                "2::INTEGER AS schema_version, " + snapshotId + "::BIGINT AS snapshot_id, '" +
                snapshotHash + "'::VARCHAR AS snapshot_hash, '" + context.biomeMask().sha256() +
                "'::VARCHAR AS biome_mask_sha256");
            statement.execute("ANALYZE public_cache.zdo");
            statement.execute("CHECKPOINT public_cache");

            try (ResultSet row = statement.executeQuery("SELECT COUNT(*) FROM public_cache.zdo")) {
                if (!row.next() || row.getLong(1) != buildingCount) {
                    throw new IllegalStateException("Public cache row verification failed");
                }
            }
            try (ResultSet rows = statement.executeQuery(
                    "SELECT biome, COUNT(*) AS item_count FROM public_cache.zdo GROUP BY biome ORDER BY biome")) {
                while (rows.next()) biomeCounts.put(rows.getString("biome"), rows.getLong("item_count"));
            }
            for (TerrainContext.Biome biome : context.biomes().catalog()) {
                biomeCounts.putIfAbsent(biome.id(), 0L);
            }
            statement.execute("DETACH public_cache");
            statement.execute("DETACH source_cache");
        } catch (Exception error) {
            Files.deleteIfExists(temporary);
            throw error;
        }

        moveReplace(temporary, outputPath);
        ObjectMapper mapper = new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT);
        ObjectNode manifest = mapper.createObjectNode();
        TerrainContext context = TerrainContext.load(contextManifest, mapper, snapshotId, snapshotHash, worldId);
        manifest.put("schemaVersion", 2);
        manifest.put("snapshotId", snapshotId);
        manifest.put("snapshotHash", snapshotHash);
        manifest.put("zdoCount", fullZdoCount);
        manifest.put("buildingCount", buildingCount);
        manifest.put("biomeMaskSha256", context.biomeMask().sha256());
        ObjectNode counts = manifest.putObject("biomeCounts");
        biomeCounts.forEach(counts::put);
        manifest.put("bytes", Files.size(outputPath));
        manifest.put("sha256", sha256(outputPath));
        manifest.put("generatedAt", Instant.now().toString());
        mapper.writeValue(temporaryMetadata.toFile(), manifest);
        moveReplace(temporaryMetadata, metadata);

        System.out.printf("Public cache ready: %s (%,d building rows, %.1f MB)%n",
            outputPath, buildingCount, Files.size(outputPath) / 1_048_576.0);
    }

    private static String quote(Path path) {
        return path.toString().replace('\\', '/').replace("'", "''");
    }

    private static String sha256(Path path) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = Files.newInputStream(path)) {
            byte[] buffer = new byte[1024 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                if (read > 0) digest.update(buffer, 0, read);
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    private static void moveReplace(Path source, Path target) throws Exception {
        try {
            Files.move(source, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException ignored) {
            Files.move(source, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }
}
