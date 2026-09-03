package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TerrainContextTest {
    @TempDir Path temp;
    private final ObjectMapper mapper = new ObjectMapper();

    @Test void validatesSnapshotImagesAndSafePublicContract() throws Exception {
        Path manifest = contextManifest("a".repeat(64));
        TerrainContext context = TerrainContext.load(manifest, mapper, 107, "a".repeat(64), "ComfyEra17");

        assertEquals(107, context.snapshotId());
        assertEquals(-12288, context.bounds().minX());
        assertEquals(2, context.requireVariant("detail").width());
        ObjectNode publicJson = context.publicJson(mapper);
        assertEquals("SNAPSHOT-MATCHED", publicJson.path("provenance").asText());
        assertEquals(0.62, publicJson.path("defaultOpacity").asDouble());
        assertEquals(1.0, publicJson.path("closeDetailFactor").asDouble());
        assertEquals(6, publicJson.withArray("variants").size());
        assertEquals("topographic-overview", publicJson.withArray("variants").get(2).path("id").asText());
        assertEquals("biome-mask", publicJson.path("biomes").path("maskVariant").asText());
        assertEquals("biome-display-mask", publicJson.path("biomes").path("displayMaskVariant").asText());
        assertEquals(8, publicJson.path("biomes").withArray("catalog").size());
        assertTrue(publicJson.findValue("sources") == null);
    }

    @Test void rejectsWrongSnapshotAndTamperedImage() throws Exception {
        Path manifest = contextManifest("a".repeat(64));
        assertThrows(IllegalArgumentException.class,
            () -> TerrainContext.load(manifest, mapper, 108, "a".repeat(64), "ComfyEra17"));

        Files.write(temp.resolve("detail.png"), new byte[]{1, 2, 3});
        assertThrows(IllegalArgumentException.class,
            () -> TerrainContext.load(manifest, mapper, 107, "a".repeat(64), "ComfyEra17"));
    }

    private Path contextManifest(String snapshotHash) throws Exception {
        Path overview = image("overview.png");
        Path detail = image("detail.png");
        Path topographicOverview = image("topographic-overview.png");
        Path topographicDetail = image("topographic-detail.png");
        Path biomeMask = image("biome-mask.png");
        Path biomeDisplayMask = image("biome-display-mask.png");
        ObjectNode root = mapper.createObjectNode();
        root.put("schemaVersion", 2);
        root.put("kind", "steward-terrain-context");
        root.put("style", "muted-topographic-v1");
        root.putObject("world").put("id", "ComfyEra17").put("name", "Comfy Era 17");
        root.putObject("snapshot").put("id", 107).put("sha256", snapshotHash);
        root.putObject("bounds").put("minX", -12288).put("maxX", 12288)
            .put("minZ", -12288).put("maxZ", 12288);
        root.put("defaultOpacity", 0.62);
        root.put("detailZoom", -2.25);
        root.put("closeDetailFactor", 1.0);
        addVariant(root, "overview", overview);
        addVariant(root, "detail", detail);
        addVariant(root, "topographic-overview", topographicOverview);
        addVariant(root, "topographic-detail", topographicDetail);
        addVariant(root, "biome-mask", biomeMask);
        addVariant(root, "biome-display-mask", biomeDisplayMask);
        ObjectNode biomes = root.putObject("biomes");
        biomes.put("classification", "test-territories-v1");
        biomes.put("maskVariant", "biome-mask");
        biomes.put("displayMaskVariant", "biome-display-mask");
        biomes.put("spaceIncludesWater", true);
        String[][] catalog = {
            {"space", "Ocean", "#8f8bd8"}, {"deep-north", "Deep North", "#bfe8ff"},
            {"mistlands", "Mistlands", "#a28bd0"}, {"ashlands", "Ashlands", "#f06a4f"},
            {"swamps", "Swamps", "#78966b"}, {"plains", "Plains", "#e2bd72"},
            {"meadows", "Meadows", "#91ca70"}, {"other", "Mountains + Forest", "#b3bac5"}
        };
        for (int index = 0; index < catalog.length; index++) {
            biomes.withArray("catalog").addObject()
                .put("index", index + 1).put("id", catalog[index][0])
                .put("label", catalog[index][1]).put("color", catalog[index][2]).put("pixelCount", 1);
        }
        Path manifest = temp.resolve("manifest.json");
        mapper.writeValue(manifest.toFile(), root);
        return manifest;
    }

    private void addVariant(ObjectNode root, String id, Path image) throws Exception {
        ObjectNode node = root.withArray("variants").addObject();
        node.put("id", id);
        node.put("file", image.getFileName().toString());
        node.put("width", 2);
        node.put("height", 2);
        node.put("displayPixelMeters", id.endsWith("detail") ? 6 : 12);
        node.put("sha256", sha256(image));
        node.put("bytes", Files.size(image));
    }

    private Path image(String name) throws Exception {
        Path path = temp.resolve(name);
        BufferedImage image = new BufferedImage(2, 2, BufferedImage.TYPE_INT_ARGB);
        ImageIO.write(image, "png", path.toFile());
        return path;
    }

    private static String sha256(Path path) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        return HexFormat.of().formatHex(digest.digest(Files.readAllBytes(path)));
    }
}
