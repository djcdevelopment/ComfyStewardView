package dev.steward.lab;

import com.fasterxml.jackson.databind.JsonNode;
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
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Instant;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Builds the smallest self-contained DuckDB needed by the public Build density experience. */
public final class PublicCacheExporter {
    static final int SCHEMA_VERSION = 3;

    private PublicCacheExporter() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 6) {
            throw new IllegalArgumentException(
                "Usage: PublicCacheExporter <source.duckdb> <public.duckdb> <snapshot-id> " +
                "<context-manifest> <building-geometry.parquet> <piece-geometry.json>");
        }
        export(Path.of(args[0]), Path.of(args[1]), Long.parseLong(args[2]), Path.of(args[3]),
            Path.of(args[4]), Path.of(args[5]));
    }

    static void export(Path sourcePath, Path outputPath, long snapshotId, Path contextManifest,
            Path buildingGeometry, Path pieceGeometry) throws Exception {
        sourcePath = requireFile(sourcePath, "Source cache");
        contextManifest = requireFile(contextManifest, "Context manifest");
        buildingGeometry = requireFile(buildingGeometry, "Building geometry");
        pieceGeometry = requireFile(pieceGeometry, "Piece geometry");
        outputPath = outputPath.toAbsolutePath().normalize();
        if (snapshotId <= 0) throw new IllegalArgumentException("Snapshot ID must be positive");
        if (sourcePath.equals(outputPath)) throw new IllegalArgumentException("Public cache must be a separate file");
        Files.createDirectories(outputPath.getParent());

        ObjectMapper mapper = new ObjectMapper();
        GeometryCatalog catalog = readCatalog(pieceGeometry, mapper);
        String geometrySha256 = sha256(buildingGeometry);
        String catalogSha256 = sha256(pieceGeometry);
        Path temporary = outputPath.resolveSibling(outputPath.getFileName() + ".tmp-" + UUID.randomUUID());
        Path metadata = outputPath.resolveSibling(outputPath.getFileName() + ".json");
        Path temporaryMetadata = metadata.resolveSibling(metadata.getFileName() + ".tmp-" + UUID.randomUUID());
        Files.deleteIfExists(temporary);
        Files.deleteIfExists(temporaryMetadata);

        Class.forName("org.duckdb.DuckDBDriver");
        long fullZdoCount;
        long buildingCount;
        long knownGeometryCount;
        long realGeometryCount;
        long estimatedGeometryCount;
        String snapshotHash;
        String worldId;
        Map<String, Long> biomeCounts = new LinkedHashMap<>();
        String sourceSql = quote(sourcePath);
        String targetSql = quote(temporary);
        String geometrySql = quote(buildingGeometry);
        try (Connection connection = DriverManager.getConnection("jdbc:duckdb:");
             Statement statement = connection.createStatement()) {
            statement.execute("SET threads = 4");
            statement.execute("SET memory_limit = '4GB'");
            statement.execute("SET preserve_insertion_order = false");
            statement.execute("ATTACH '" + sourceSql + "' AS source_cache (READ_ONLY)");
            statement.execute("ATTACH '" + targetSql + "' AS public_cache");
            statement.execute("CREATE TEMP VIEW geometry_input AS SELECT zdo_index, prefab_hash, " +
                "prefab_name, category, x, y, z, has_rot, rot_x, rot_y, rot_z " +
                "FROM read_parquet('" + geometrySql + "') WHERE category = 'BUILDING'");

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
            validateGeometryJoin(statement, snapshotId, buildingCount);

            TerrainContext context = TerrainContext.load(
                contextManifest, mapper, snapshotId, snapshotHash, worldId);
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
            statement.execute("CREATE TABLE public_cache.prefab_geometry (" +
                "prefab_hash INTEGER PRIMARY KEY, prefab_name VARCHAR NOT NULL, family VARCHAR NOT NULL, " +
                "geometry_source VARCHAR NOT NULL, extent_x DOUBLE NOT NULL, extent_y DOUBLE NOT NULL, " +
                "extent_z DOUBLE NOT NULL, center_x DOUBLE NOT NULL, center_y DOUBLE NOT NULL, " +
                "center_z DOUBLE NOT NULL)");
            insertCatalog(connection, catalog);
            statement.execute("CREATE TABLE public_cache.zdo AS SELECT " +
                "s.snapshot_id, s.zdo_index, s.x, g.y, s.z, s.prefab_name, s.prefab_hash, s.category, " +
                "steward_biome(s.x, s.z) AS biome, g.has_rot, " +
                "CASE WHEN g.has_rot THEN g.rot_x ELSE 0 END AS rot_x, " +
                "CASE WHEN g.has_rot THEN g.rot_y ELSE 0 END AS rot_y, " +
                "CASE WHEN g.has_rot THEN g.rot_z ELSE 0 END AS rot_z " +
                "FROM source_cache.zdo s JOIN geometry_input g USING (zdo_index) " +
                "WHERE s.snapshot_id = " + snapshotId + " AND s.category = 'BUILDING' " +
                "ORDER BY s.x, s.z, s.zdo_index");

            try (ResultSet row = statement.executeQuery(
                    "SELECT COUNT(pg.prefab_hash) AS known_count, " +
                    "count_if(pg.geometry_source <> 'family_median') AS real_count, " +
                    "count_if(pg.geometry_source = 'family_median') AS estimated_count " +
                    "FROM public_cache.zdo z LEFT JOIN public_cache.prefab_geometry pg USING (prefab_hash)")) {
                if (!row.next()) throw new IllegalStateException("Geometry coverage verification failed");
                knownGeometryCount = row.getLong("known_count");
                realGeometryCount = row.getLong("real_count");
                estimatedGeometryCount = row.getLong("estimated_count");
            }
            statement.execute("CREATE TABLE public_cache.release_metadata AS SELECT " +
                SCHEMA_VERSION + "::INTEGER AS schema_version, " + snapshotId + "::BIGINT AS snapshot_id, '" +
                sqlText(snapshotHash) + "'::VARCHAR AS snapshot_hash, '" +
                sqlText(context.biomeMask().sha256()) + "'::VARCHAR AS biome_mask_sha256, '" +
                geometrySha256 + "'::VARCHAR AS building_geometry_sha256, '" +
                catalogSha256 + "'::VARCHAR AS piece_geometry_sha256, " +
                buildingCount + "::BIGINT AS building_geometry_rows, " + catalog.size() +
                "::BIGINT AS geometry_catalog_rows, " + knownGeometryCount +
                "::BIGINT AS known_geometry_rows, " + realGeometryCount +
                "::BIGINT AS real_geometry_rows, " + estimatedGeometryCount +
                "::BIGINT AS estimated_geometry_rows");
            statement.execute("ANALYZE public_cache.zdo");
            statement.execute("ANALYZE public_cache.prefab_geometry");
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
        mapper.enable(SerializationFeature.INDENT_OUTPUT);
        ObjectNode manifest = mapper.createObjectNode();
        TerrainContext context = TerrainContext.load(contextManifest, mapper, snapshotId, snapshotHash, worldId);
        manifest.put("schemaVersion", SCHEMA_VERSION);
        manifest.put("snapshotId", snapshotId);
        manifest.put("snapshotHash", snapshotHash);
        manifest.put("zdoCount", fullZdoCount);
        manifest.put("buildingCount", buildingCount);
        manifest.put("biomeMaskSha256", context.biomeMask().sha256());
        manifest.put("buildingGeometrySha256", geometrySha256);
        manifest.put("pieceGeometrySha256", catalogSha256);
        manifest.put("geometryCatalogRows", catalog.size());
        manifest.put("knownGeometryRows", knownGeometryCount);
        manifest.put("realGeometryRows", realGeometryCount);
        manifest.put("estimatedGeometryRows", estimatedGeometryCount);
        manifest.put("unknownGeometryRows", buildingCount - knownGeometryCount);
        ObjectNode counts = manifest.putObject("biomeCounts");
        biomeCounts.forEach(counts::put);
        manifest.put("bytes", Files.size(outputPath));
        manifest.put("sha256", sha256(outputPath));
        manifest.put("generatedAt", Instant.now().toString());
        mapper.writeValue(temporaryMetadata.toFile(), manifest);
        moveReplace(temporaryMetadata, metadata);

        System.out.printf("Public cache ready: %s (%,d building rows, %,d catalog rows, %.1f MB)%n",
            outputPath, buildingCount, catalog.size(), Files.size(outputPath) / 1_048_576.0);
    }

    private static void validateGeometryJoin(Statement statement, long snapshotId,
            long buildingCount) throws Exception {
        try (ResultSet row = statement.executeQuery(
                "SELECT COUNT(*) AS rows, COUNT(DISTINCT zdo_index) AS unique_rows, " +
                "count_if(category <> 'BUILDING') AS wrong_category, " +
                "count_if(x IS NULL OR y IS NULL OR z IS NULL OR has_rot IS NULL OR " +
                "NOT isfinite(x) OR NOT isfinite(y) OR NOT isfinite(z) OR " +
                "(has_rot AND (rot_x IS NULL OR rot_y IS NULL OR rot_z IS NULL OR " +
                "NOT isfinite(rot_x) OR NOT isfinite(rot_y) OR NOT isfinite(rot_z)))) AS invalid_rows " +
                "FROM geometry_input")) {
            if (!row.next() || row.getLong("rows") != buildingCount ||
                    row.getLong("unique_rows") != buildingCount || row.getLong("wrong_category") != 0 ||
                    row.getLong("invalid_rows") != 0) {
                throw new IllegalArgumentException("Building geometry is not an exact, valid snapshot join");
            }
        }
        try (ResultSet row = statement.executeQuery(
                "SELECT COUNT(*) AS joined_rows, " +
                "count_if(g.zdo_index IS NULL) AS missing_rows, " +
                "count_if(g.zdo_index IS NOT NULL AND (s.prefab_hash IS DISTINCT FROM g.prefab_hash OR " +
                "s.prefab_name IS DISTINCT FROM g.prefab_name OR abs(s.x-g.x) > 0.0001 OR abs(s.z-g.z) > 0.0001)) " +
                "AS mismatch_rows FROM source_cache.zdo s LEFT JOIN geometry_input g USING (zdo_index) " +
                "WHERE s.snapshot_id = " + snapshotId + " AND s.category = 'BUILDING'")) {
            if (!row.next() || row.getLong("joined_rows") != buildingCount ||
                    row.getLong("missing_rows") != 0 || row.getLong("mismatch_rows") != 0) {
                throw new IllegalArgumentException("Building geometry does not match the selected source snapshot");
            }
        }
    }

    private static GeometryCatalog readCatalog(Path path, ObjectMapper mapper) throws Exception {
        JsonNode root = mapper.readTree(path.toFile());
        JsonNode pieces = root.path("pieces");
        if (!pieces.isArray() || pieces.isEmpty()) {
            throw new IllegalArgumentException("Piece geometry catalog has no pieces");
        }
        GeometryCatalog result = new GeometryCatalog();
        Set<Integer> hashes = new HashSet<>();
        for (JsonNode piece : pieces) {
            String name = requiredText(piece, "name");
            String family = requiredText(piece, "family");
            String source = requiredText(piece, "source");
            if (!Set.of("mesh", "snap", "snap+mesh", "family_median").contains(source)) {
                throw new IllegalArgumentException("Unknown geometry source for " + name + ": " + source);
            }
            if (!piece.has("hash") || !piece.path("hash").canConvertToInt()) {
                throw new IllegalArgumentException("Invalid prefab hash for " + name);
            }
            int hash = piece.path("hash").intValue();
            if (!hashes.add(hash)) throw new IllegalArgumentException("Duplicate prefab hash: " + hash);
            double[] extents = vector(piece, "extents");
            double[] center = vector(piece, "center_offset");
            if (extents[0] < 0 || extents[1] < 0 || extents[2] < 0 ||
                    extents[0] + extents[1] + extents[2] <= 0) {
                throw new IllegalArgumentException("Invalid extents for " + name);
            }
            result.add(new Geometry(hash, name, family, source, extents, center));
        }
        if (result.size() == 0) throw new IllegalArgumentException("Piece geometry catalog has no pieces");
        return result;
    }

    private static void insertCatalog(Connection connection, GeometryCatalog catalog) throws Exception {
        try (PreparedStatement insert = connection.prepareStatement(
                "INSERT INTO public_cache.prefab_geometry VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
            for (Geometry geometry : catalog.rows) {
                insert.setInt(1, geometry.hash);
                insert.setString(2, geometry.name);
                insert.setString(3, geometry.family);
                insert.setString(4, geometry.source);
                insert.setDouble(5, geometry.extents[0]);
                insert.setDouble(6, geometry.extents[1]);
                insert.setDouble(7, geometry.extents[2]);
                insert.setDouble(8, geometry.center[0]);
                insert.setDouble(9, geometry.center[1]);
                insert.setDouble(10, geometry.center[2]);
                insert.addBatch();
            }
            insert.executeBatch();
        }
    }

    private static String requiredText(JsonNode node, String field) {
        String value = node.path(field).asText("").trim();
        if (value.isEmpty()) throw new IllegalArgumentException("Missing geometry field: " + field);
        return value;
    }

    private static double[] vector(JsonNode node, String field) {
        JsonNode values = node.path(field);
        if (!values.isArray() || values.size() != 3) {
            throw new IllegalArgumentException("Geometry field must be a 3-vector: " + field);
        }
        double[] result = new double[3];
        for (int i = 0; i < 3; i++) {
            result[i] = values.path(i).asDouble(Double.NaN);
            if (!Double.isFinite(result[i])) {
                throw new IllegalArgumentException("Geometry field must be finite: " + field);
            }
        }
        return result;
    }

    private static Path requireFile(Path path, String label) {
        Path result = path.toAbsolutePath().normalize();
        if (!Files.isRegularFile(result)) throw new IllegalArgumentException(label + " not found: " + result);
        return result;
    }

    private static String quote(Path path) {
        return path.toString().replace('\\', '/').replace("'", "''");
    }

    private static String sqlText(String value) {
        return value.replace("'", "''");
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

    private record Geometry(int hash, String name, String family, String source,
            double[] extents, double[] center) {}

    private static final class GeometryCatalog {
        private final java.util.List<Geometry> rows = new java.util.ArrayList<>();
        void add(Geometry geometry) { rows.add(geometry); }
        int size() { return rows.size(); }
    }
}
