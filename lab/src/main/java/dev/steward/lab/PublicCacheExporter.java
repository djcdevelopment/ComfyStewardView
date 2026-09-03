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
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.ArrayList;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Builds the smallest self-contained DuckDB needed by the public Build density experience. */
public final class PublicCacheExporter {
    static final int SCHEMA_VERSION = 4;

    private PublicCacheExporter() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 8) {
            throw new IllegalArgumentException(
                "Usage: PublicCacheExporter <source.duckdb> <public.duckdb> <snapshot-id> " +
                "<context-manifest> <building-geometry.parquet> <piece-geometry.json> " +
                "<prefab-representations.json> <prefab-promotion-receipt.json>");
        }
        export(Path.of(args[0]), Path.of(args[1]), Long.parseLong(args[2]), Path.of(args[3]),
            Path.of(args[4]), Path.of(args[5]), Path.of(args[6]), Path.of(args[7]));
    }

    static void export(Path sourcePath, Path outputPath, long snapshotId, Path contextManifest,
            Path buildingGeometry, Path pieceGeometry, Path prefabRepresentations,
            Path promotionReceipt) throws Exception {
        sourcePath = requireFile(sourcePath, "Source cache");
        contextManifest = requireFile(contextManifest, "Context manifest");
        buildingGeometry = requireFile(buildingGeometry, "Building geometry");
        pieceGeometry = requireFile(pieceGeometry, "Piece geometry");
        prefabRepresentations = requireFile(prefabRepresentations, "Prefab representations");
        promotionReceipt = requireFile(promotionReceipt, "Prefab promotion receipt");
        outputPath = outputPath.toAbsolutePath().normalize();
        if (snapshotId <= 0) throw new IllegalArgumentException("Snapshot ID must be positive");
        if (sourcePath.equals(outputPath)) throw new IllegalArgumentException("Public cache must be a separate file");
        Files.createDirectories(outputPath.getParent());

        ObjectMapper mapper = new ObjectMapper();
        GeometryCatalog catalog = readCatalog(pieceGeometry, mapper);
        RepresentationCatalog representations = readRepresentations(prefabRepresentations, mapper);
        validateRepresentationCatalog(catalog, representations);
        validatePromotionReceipt(promotionReceipt, mapper, representations);
        String geometrySha256 = sha256(buildingGeometry);
        String catalogSha256 = sha256(pieceGeometry);
        String representationSha256 = sha256(prefabRepresentations);
        String promotionSha256 = sha256(promotionReceipt);
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
            statement.execute("CREATE TABLE public_cache.prefab_representation (" +
                "prefab_hash INTEGER PRIMARY KEY, prefab_name VARCHAR NOT NULL, semantic_class VARCHAR NOT NULL, " +
                "strategy VARCHAR NOT NULL, authority VARCHAR NOT NULL, default_visible BOOLEAN NOT NULL, " +
                "marker_axis DOUBLE NOT NULL, primitive_count INTEGER NOT NULL, animation_axis VARCHAR, " +
                "animation_pivot_x DOUBLE NOT NULL, animation_pivot_y DOUBLE NOT NULL, " +
                "animation_pivot_z DOUBLE NOT NULL)");
            statement.execute("CREATE TABLE public_cache.prefab_representation_primitive (" +
                "prefab_hash INTEGER NOT NULL, ordinal INTEGER NOT NULL, animated BOOLEAN NOT NULL, " +
                "m00 DOUBLE NOT NULL, m01 DOUBLE NOT NULL, m02 DOUBLE NOT NULL, m03 DOUBLE NOT NULL, " +
                "m10 DOUBLE NOT NULL, m11 DOUBLE NOT NULL, m12 DOUBLE NOT NULL, m13 DOUBLE NOT NULL, " +
                "m20 DOUBLE NOT NULL, m21 DOUBLE NOT NULL, m22 DOUBLE NOT NULL, m23 DOUBLE NOT NULL, " +
                "m30 DOUBLE NOT NULL, m31 DOUBLE NOT NULL, m32 DOUBLE NOT NULL, m33 DOUBLE NOT NULL, " +
                "PRIMARY KEY (prefab_hash, ordinal))");
            insertRepresentations(connection, representations);
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
                "'" + representationSha256 + "'::VARCHAR AS representation_catalog_sha256, " +
                "'" + promotionSha256 + "'::VARCHAR AS promotion_receipt_sha256, " +
                buildingCount + "::BIGINT AS building_geometry_rows, " + catalog.size() +
                "::BIGINT AS geometry_catalog_rows, " + knownGeometryCount +
                "::BIGINT AS known_geometry_rows, " + realGeometryCount +
                "::BIGINT AS real_geometry_rows, " + estimatedGeometryCount +
                "::BIGINT AS estimated_geometry_rows, " + representations.size() +
                "::BIGINT AS representation_rows, " + representations.primitiveCount() +
                "::BIGINT AS representation_primitive_rows");
            statement.execute("ANALYZE public_cache.zdo");
            statement.execute("ANALYZE public_cache.prefab_geometry");
            statement.execute("ANALYZE public_cache.prefab_representation");
            statement.execute("ANALYZE public_cache.prefab_representation_primitive");
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
        manifest.put("representationCatalogSha256", representationSha256);
        manifest.put("promotionReceiptSha256", promotionSha256);
        manifest.put("geometryCatalogRows", catalog.size());
        manifest.put("representationRows", representations.size());
        manifest.put("representationPrimitiveRows", representations.primitiveCount());
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

    private static RepresentationCatalog readRepresentations(Path path, ObjectMapper mapper) throws Exception {
        JsonNode root = mapper.readTree(path.toFile());
        if (!"steward-prefab-representations/v1".equals(root.path("schema").asText())) {
            throw new IllegalArgumentException("Unsupported prefab representation schema");
        }
        JsonNode rows = root.path("representations");
        if (!rows.isArray() || rows.isEmpty()) {
            throw new IllegalArgumentException("Prefab representation catalog has no rows");
        }
        RepresentationCatalog result = new RepresentationCatalog();
        Set<Integer> hashes = new HashSet<>();
        Set<String> names = new HashSet<>();
        for (JsonNode row : rows) {
            String name = requiredText(row, "name");
            if (!row.has("hash") || !row.path("hash").canConvertToInt()) {
                throw new IllegalArgumentException("Invalid representation hash for " + name);
            }
            int hash = row.path("hash").intValue();
            if (!hashes.add(hash) || !names.add(name)) {
                throw new IllegalArgumentException("Duplicate prefab representation: " + name);
            }
            String semanticClass = requiredText(row, "semanticClass");
            String strategy = requiredText(row, "strategy");
            String authority = requiredText(row, "authority");
            if (!Set.of("structure", "context").contains(semanticClass)) {
                throw new IllegalArgumentException("Invalid semantic class for " + name);
            }
            if (!Set.of("runtime-compound", "pivot-marker", "unresolved-compound").contains(strategy)) {
                throw new IllegalArgumentException("Invalid representation strategy for " + name);
            }
            if ("context".equals(semanticClass) && !"pivot-marker".equals(strategy) ||
                    "structure".equals(semanticClass) && "pivot-marker".equals(strategy)) {
                throw new IllegalArgumentException("Representation class and strategy disagree for " + name);
            }
            boolean defaultVisible = row.path("defaultVisible").asBoolean(true);
            if ("context".equals(semanticClass) && defaultVisible) {
                throw new IllegalArgumentException("Context must be hidden by default: " + name);
            }
            double markerAxis = row.path("markerAxis").asDouble(0.35);
            if (!Double.isFinite(markerAxis) || markerAxis < 0.02 || markerAxis > 2) {
                throw new IllegalArgumentException("Invalid marker axis for " + name);
            }
            List<Primitive> primitives = new ArrayList<>();
            JsonNode primitiveNodes = row.path("primitives");
            if (!primitiveNodes.isArray()) {
                throw new IllegalArgumentException("Representation primitives must be an array: " + name);
            }
            int ordinal = 0;
            for (JsonNode primitive : primitiveNodes) {
                JsonNode values = primitive.path("matrix");
                if (!values.isArray() || values.size() != 16) {
                    throw new IllegalArgumentException("Primitive matrix must contain 16 values: " + name);
                }
                double[] matrix = new double[16];
                for (int i = 0; i < matrix.length; i++) {
                    matrix[i] = values.path(i).asDouble(Double.NaN);
                    if (!Double.isFinite(matrix[i])) {
                        throw new IllegalArgumentException("Primitive matrix must be finite: " + name);
                    }
                }
                if (Math.abs(matrix[3]) > 0.0001 || Math.abs(matrix[7]) > 0.0001 ||
                        Math.abs(matrix[11]) > 0.0001 || Math.abs(matrix[15] - 1) > 0.0001) {
                    throw new IllegalArgumentException("Primitive matrix is not affine: " + name);
                }
                primitives.add(new Primitive(ordinal++, primitive.path("animated").asBoolean(false), matrix));
            }
            if (primitives.size() > 32) {
                throw new IllegalArgumentException("Representation exceeds the 32-box cap: " + name);
            }
            if ("runtime-compound".equals(strategy) && primitives.isEmpty()) {
                throw new IllegalArgumentException("Runtime compound has no boxes: " + name);
            }
            if (!"runtime-compound".equals(strategy) && !primitives.isEmpty()) {
                throw new IllegalArgumentException("Only runtime compounds may contain boxes: " + name);
            }
            String animationAxis = row.path("animationAxis").asText("").trim().toLowerCase();
            if (!animationAxis.isEmpty() && !Set.of("x", "y", "z").contains(animationAxis)) {
                throw new IllegalArgumentException("Invalid animation axis for " + name);
            }
            double[] animationPivot = row.has("animationPivot")
                ? vector(row, "animationPivot") : new double[3];
            result.add(new Representation(hash, name, semanticClass, strategy, authority,
                defaultVisible, markerAxis, animationAxis, animationPivot, List.copyOf(primitives)));
        }
        return result;
    }

    private static void validatePromotionReceipt(Path path, ObjectMapper mapper,
            RepresentationCatalog representations) throws Exception {
        JsonNode root = mapper.readTree(path.toFile());
        if (!"steward-prefab-promotion/v1".equals(root.path("schema").asText())) {
            throw new IllegalArgumentException("Unsupported prefab promotion receipt schema");
        }
        if (!root.path("results").isArray()) {
            throw new IllegalArgumentException("Prefab promotion receipt has no results array");
        }
        Map<Integer, Representation> byHash = new HashMap<>();
        for (Representation representation : representations.rows) {
            byHash.put(representation.hash, representation);
        }
        Map<Integer, String> statuses = new LinkedHashMap<>();
        for (JsonNode row : root.path("results")) {
            if (!row.path("hash").canConvertToInt()) {
                throw new IllegalArgumentException("Promotion receipt contains an invalid prefab hash");
            }
            int hash = row.path("hash").intValue();
            String status = requiredText(row, "status");
            if (!Set.of("promoted", "pending", "rejected").contains(status)) {
                throw new IllegalArgumentException("Invalid promotion status: " + status);
            }
            Representation representation = byHash.get(hash);
            if (representation == null || !representation.name.equals(requiredText(row, "prefab"))) {
                throw new IllegalArgumentException("Promotion receipt is not an exact prefab name/hash match");
            }
            if (statuses.put(hash, status) != null) {
                throw new IllegalArgumentException("Duplicate prefab promotion result: " + representation.name);
            }
            if ("promoted".equals(status) && !"runtime-compound".equals(representation.strategy)) {
                throw new IllegalArgumentException(
                    "Promoted receipt does not have runtime compound geometry: " + representation.name);
            }
        }
        for (Representation representation : representations.rows) {
            if ("runtime-compound".equals(representation.strategy) &&
                    !"promoted".equals(statuses.get(representation.hash))) {
                throw new IllegalArgumentException(
                    "Runtime compound lacks a promoted metrics receipt: " + representation.name);
            }
        }
    }

    private static void validateRepresentationCatalog(GeometryCatalog geometry,
            RepresentationCatalog representations) {
        Map<Integer, Geometry> byHash = new HashMap<>();
        for (Geometry row : geometry.rows) byHash.put(row.hash, row);
        for (Representation row : representations.rows) {
            Geometry match = byHash.get(row.hash);
            if (match == null || !match.name.equals(row.name)) {
                throw new IllegalArgumentException(
                    "Representation is not an exact prefab name/hash match: " + row.name);
            }
        }
    }

    private static void insertRepresentations(Connection connection,
            RepresentationCatalog catalog) throws Exception {
        try (PreparedStatement insert = connection.prepareStatement(
                "INSERT INTO public_cache.prefab_representation VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
             PreparedStatement primitiveInsert = connection.prepareStatement(
                "INSERT INTO public_cache.prefab_representation_primitive VALUES " +
                "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
            for (Representation row : catalog.rows) {
                insert.setInt(1, row.hash);
                insert.setString(2, row.name);
                insert.setString(3, row.semanticClass);
                insert.setString(4, row.strategy);
                insert.setString(5, row.authority);
                insert.setBoolean(6, row.defaultVisible);
                insert.setDouble(7, row.markerAxis);
                insert.setInt(8, row.primitives.size());
                insert.setString(9, row.animationAxis.isEmpty() ? null : row.animationAxis);
                insert.setDouble(10, row.animationPivot[0]);
                insert.setDouble(11, row.animationPivot[1]);
                insert.setDouble(12, row.animationPivot[2]);
                insert.addBatch();
                for (Primitive primitive : row.primitives) {
                    primitiveInsert.setInt(1, row.hash);
                    primitiveInsert.setInt(2, primitive.ordinal);
                    primitiveInsert.setBoolean(3, primitive.animated);
                    for (int i = 0; i < 16; i++) primitiveInsert.setDouble(4 + i, primitive.matrix[i]);
                    primitiveInsert.addBatch();
                }
            }
            insert.executeBatch();
            primitiveInsert.executeBatch();
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

    private record Primitive(int ordinal, boolean animated, double[] matrix) {}
    private record Representation(int hash, String name, String semanticClass, String strategy,
            String authority, boolean defaultVisible, double markerAxis, String animationAxis,
            double[] animationPivot, List<Primitive> primitives) {}

    private static final class GeometryCatalog {
        private final java.util.List<Geometry> rows = new java.util.ArrayList<>();
        void add(Geometry geometry) { rows.add(geometry); }
        int size() { return rows.size(); }
    }

    private static final class RepresentationCatalog {
        private final List<Representation> rows = new ArrayList<>();
        void add(Representation value) { rows.add(value); }
        int size() { return rows.size(); }
        int primitiveCount() {
            int result = 0;
            for (Representation row : rows) result += row.primitives.size();
            return result;
        }
    }
}
