package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.DriverManager;
import java.util.HexFormat;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PublicCacheExporterTest {
    @TempDir Path temporary;
    private final ObjectMapper mapper = new ObjectMapper();

    @BeforeAll static void driver() throws Exception {
        Class.forName("org.duckdb.DuckDBDriver");
    }

    @Test void exportsExactSanitizedGeometryWithReceipts() throws Exception {
        Path source = sourceCache();
        Path parquet = buildingGeometry(false);
        Path catalog = pieceGeometry();
        Path contextManifest = contextManifest();
        Path output = temporary.resolve("public.duckdb");

        PublicCacheExporter.export(source, output, 107, contextManifest, parquet, catalog);

        assertTrue(Files.isRegularFile(output));
        ObjectNode metadata = (ObjectNode) mapper.readTree(output.resolveSibling("public.duckdb.json").toFile());
        assertEquals(3, metadata.path("schemaVersion").asInt());
        assertEquals(3, metadata.path("buildingCount").asInt());
        assertEquals(2, metadata.path("geometryCatalogRows").asInt());
        assertEquals(2, metadata.path("knownGeometryRows").asInt());
        assertEquals(1, metadata.path("realGeometryRows").asInt());
        assertEquals(1, metadata.path("estimatedGeometryRows").asInt());
        assertEquals(1, metadata.path("unknownGeometryRows").asInt());
        assertEquals(sha256(parquet), metadata.path("buildingGeometrySha256").asText());
        assertEquals(sha256(catalog), metadata.path("pieceGeometrySha256").asText());

        SnapshotRepository repository = new SnapshotRepository(output, new LensRegistry(), mapper, true);
        try (var connection = repository.open();
             var statement = connection.createStatement()) {
            try (var row = statement.executeQuery(
                    "SELECT y, has_rot, rot_x, rot_y, rot_z, biome FROM zdo WHERE zdo_index=10")) {
                assertTrue(row.next());
                assertEquals(12.5, row.getDouble("y"));
                assertTrue(row.getBoolean("has_rot"));
                assertEquals(10, row.getDouble("rot_x"));
                assertEquals(20, row.getDouble("rot_y"));
                assertEquals(30, row.getDouble("rot_z"));
                assertEquals("space", row.getString("biome"));
            }
            try (var row = statement.executeQuery("SELECT COUNT(*) FROM prefab_geometry")) {
                assertTrue(row.next());
                assertEquals(2, row.getInt(1));
            }
        }

        TerrainContext context = TerrainContext.load(contextManifest, mapper, 107, "a".repeat(64), "ComfyEra17");
        repository.validatePublicRelease(context);
    }

    @Test void rejectsNullableOrMismatchedGeometryInsteadOfPublishingIt() throws Exception {
        Path output = temporary.resolve("invalid-public.duckdb");
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
            () -> PublicCacheExporter.export(sourceCache(), output, 107, contextManifest(),
                buildingGeometry(true), pieceGeometry()));
        assertTrue(error.getMessage().contains("exact, valid snapshot join"));
        assertTrue(Files.notExists(output));
    }

    private Path sourceCache() throws Exception {
        Path source = temporary.resolve("source.duckdb");
        if (Files.exists(source)) return source;
        try (var connection = DriverManager.getConnection("jdbc:duckdb:" + source);
             var statement = connection.createStatement()) {
            statement.executeUpdate("CREATE TABLE world_snapshot (snapshot_id BIGINT, world_id VARCHAR, " +
                "world_name VARCHAR, source VARCHAR, backup_id VARCHAR, parsed_at TIMESTAMP, " +
                "file_hash VARCHAR, prefab_dictionary_version VARCHAR)");
            statement.executeUpdate("INSERT INTO world_snapshot VALUES " +
                "(107,'ComfyEra17','Comfy Era 17','release','test',CURRENT_TIMESTAMP,'" +
                "a".repeat(64) + "','test')");
            statement.executeUpdate("CREATE TABLE zdo (snapshot_id BIGINT, zdo_index BIGINT, x DOUBLE, " +
                "z DOUBLE, prefab_name VARCHAR, prefab_hash INTEGER, category VARCHAR)");
            statement.executeUpdate("INSERT INTO zdo VALUES " +
                "(107,10,1,2,'piece_wall',1,'BUILDING')," +
                "(107,11,3,4,'piece_roof',2,'BUILDING')," +
                "(107,12,5,6,'piece_unknown',3,'BUILDING')," +
                "(107,13,7,8,'Deer',4,'CREATURE')");
        }
        return source;
    }

    private Path buildingGeometry(boolean invalid) throws Exception {
        Path parquet = temporary.resolve(invalid ? "building-invalid.parquet" : "building.parquet");
        try (var connection = DriverManager.getConnection("jdbc:duckdb:");
             var statement = connection.createStatement()) {
            statement.executeUpdate("CREATE TABLE geometry (zdo_index BIGINT, prefab_hash INTEGER, " +
                "prefab_name VARCHAR, category VARCHAR, x DOUBLE, y DOUBLE, z DOUBLE, has_rot BOOLEAN, " +
                "rot_x DOUBLE, rot_y DOUBLE, rot_z DOUBLE)");
            statement.executeUpdate("INSERT INTO geometry VALUES " +
                "(10,1,'piece_wall','BUILDING',1," + (invalid ? "NULL" : "12.5") + ",2,true,10,20,30)," +
                "(11,2,'piece_roof','BUILDING',3,4.5,4,false,NULL,NULL,NULL)," +
                "(12,3,'piece_unknown','BUILDING',5,6.5,6,false,NULL,NULL,NULL)");
            statement.execute("COPY geometry TO '" + sqlPath(parquet) + "' (FORMAT PARQUET)");
        }
        return parquet;
    }

    private Path pieceGeometry() throws Exception {
        Path path = temporary.resolve("piece-geometry.json");
        ObjectNode root = mapper.createObjectNode();
        ObjectNode wall = root.withArray("pieces").addObject();
        wall.put("hash", 1).put("name", "piece_wall").put("family", "wall").put("source", "mesh");
        wall.putArray("extents").add(2).add(4).add(.2);
        wall.putArray("center_offset").add(0).add(2).add(0);
        ObjectNode roof = root.withArray("pieces").addObject();
        roof.put("hash", 2).put("name", "piece_roof").put("family", "roof")
            .put("source", "family_median");
        roof.putArray("extents").add(4).add(1).add(3);
        roof.putArray("center_offset").add(0).add(.5).add(0);
        mapper.writeValue(path.toFile(), root);
        return path;
    }

    private Path contextManifest() throws Exception {
        Path path = temporary.resolve("context.json");
        if (Files.exists(path)) return path;
        Path overview = image("overview.png", false);
        Path detail = image("detail.png", false);
        Path mask = image("biome-mask.png", true);
        Path displayMask = image("biome-display-mask.png", true);
        ObjectNode root = mapper.createObjectNode();
        root.put("schemaVersion", 2).put("kind", "steward-terrain-context")
            .put("style", "test").put("defaultOpacity", .62).put("detailZoom", -2.25)
            .put("closeDetailFactor", 1);
        root.putObject("world").put("id", "ComfyEra17").put("name", "Comfy Era 17");
        root.putObject("snapshot").put("id", 107).put("sha256", "a".repeat(64));
        root.putObject("bounds").put("minX", -10).put("maxX", 10).put("minZ", -10).put("maxZ", 10);
        addVariant(root, "overview", overview);
        addVariant(root, "detail", detail);
        addVariant(root, "biome-mask", mask);
        addVariant(root, "biome-display-mask", displayMask);
        ObjectNode biomes = root.putObject("biomes");
        biomes.put("classification", "test").put("maskVariant", "biome-mask")
            .put("displayMaskVariant", "biome-display-mask").put("spaceIncludesWater", true);
        String[][] catalog = {
            {"space","Ocean","#8f8bd8"}, {"deep-north","Deep North","#bfe8ff"},
            {"mistlands","Mistlands","#a28bd0"}, {"ashlands","Ashlands","#f06a4f"},
            {"swamps","Swamps","#78966b"}, {"plains","Plains","#e2bd72"},
            {"meadows","Meadows","#91ca70"}, {"other","Mountains + Forest","#b3bac5"}
        };
        for (int index = 0; index < catalog.length; index++) {
            biomes.withArray("catalog").addObject().put("index", index + 1)
                .put("id", catalog[index][0]).put("label", catalog[index][1])
                .put("color", catalog[index][2]).put("pixelCount", index == 0 ? 4 : 0);
        }
        mapper.writeValue(path.toFile(), root);
        return path;
    }

    private void addVariant(ObjectNode root, String id, Path image) throws Exception {
        root.withArray("variants").addObject().put("id", id).put("file", image.getFileName().toString())
            .put("width", 2).put("height", 2).put("displayPixelMeters", 10)
            .put("sha256", sha256(image)).put("bytes", Files.size(image));
    }

    private Path image(String name, boolean mask) throws Exception {
        Path path = temporary.resolve(name);
        BufferedImage image = new BufferedImage(2, 2,
            mask ? BufferedImage.TYPE_BYTE_GRAY : BufferedImage.TYPE_INT_ARGB);
        if (mask) {
            for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) image.getRaster().setSample(x, y, 0, 1);
        }
        ImageIO.write(image, "png", path.toFile());
        return path;
    }

    private static String sqlPath(Path path) {
        return path.toAbsolutePath().toString().replace('\\', '/').replace("'", "''");
    }

    private static String sha256(Path path) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(path)));
    }
}
