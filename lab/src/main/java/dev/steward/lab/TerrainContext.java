package dev.steward.lab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** A validated, snapshot-bound set of static terrain context images. */
public final class TerrainContext {
    public static final int SCHEMA_VERSION = 2;
    public static final String KIND = "steward-terrain-context";

    private final Path manifestPath;
    private final long snapshotId;
    private final String snapshotHash;
    private final String worldId;
    private final String worldName;
    private final String style;
    private final Bounds bounds;
    private final double defaultOpacity;
    private final double detailZoom;
    private final double closeDetailFactor;
    private final Map<String, Variant> variants;
    private final BiomeConfiguration biomes;

    private TerrainContext(Path manifestPath, long snapshotId, String snapshotHash,
            String worldId, String worldName, String style, Bounds bounds,
            double defaultOpacity, double detailZoom, double closeDetailFactor,
            Map<String, Variant> variants, BiomeConfiguration biomes) {
        this.manifestPath = manifestPath;
        this.snapshotId = snapshotId;
        this.snapshotHash = snapshotHash;
        this.worldId = worldId;
        this.worldName = worldName;
        this.style = style;
        this.bounds = bounds;
        this.defaultOpacity = defaultOpacity;
        this.detailZoom = detailZoom;
        this.closeDetailFactor = closeDetailFactor;
        this.variants = Map.copyOf(variants);
        this.biomes = biomes;
    }

    public static TerrainContext load(Path manifestPath, ObjectMapper mapper,
            long expectedSnapshotId, String expectedSnapshotHash, String expectedWorldId) throws IOException {
        Path normalizedManifest = manifestPath.toAbsolutePath().normalize();
        if (!Files.isRegularFile(normalizedManifest)) {
            throw new IllegalArgumentException("Terrain context manifest not found: " + normalizedManifest);
        }
        JsonNode root = mapper.readTree(normalizedManifest.toFile());
        if (root.path("schemaVersion").asInt(-1) != SCHEMA_VERSION ||
                !KIND.equals(root.path("kind").asText())) {
            throw new IllegalArgumentException("Unsupported terrain context manifest: " + normalizedManifest);
        }
        long snapshotId = root.path("snapshot").path("id").asLong(0);
        String snapshotHash = hash(root.path("snapshot").path("sha256").asText(), "snapshot.sha256");
        String worldId = requiredText(root.path("world"), "id");
        String worldName = requiredText(root.path("world"), "name");
        if (expectedSnapshotId > 0 && snapshotId != expectedSnapshotId) {
            throw new IllegalArgumentException("Terrain context snapshot #" + snapshotId +
                " does not match configured snapshot #" + expectedSnapshotId);
        }
        if (expectedSnapshotHash != null && !expectedSnapshotHash.isBlank() &&
                !snapshotHash.equalsIgnoreCase(expectedSnapshotHash)) {
            throw new IllegalArgumentException("Terrain context save hash does not match the artifact snapshot");
        }
        if (expectedWorldId != null && !expectedWorldId.isBlank() && !worldId.equals(expectedWorldId)) {
            throw new IllegalArgumentException("Terrain context world " + worldId +
                " does not match artifact world " + expectedWorldId);
        }

        String style = requiredText(root, "style");
        Bounds bounds = Bounds.parse(root.path("bounds"));
        double defaultOpacity = bounded(root.path("defaultOpacity").asDouble(0.62), 0, 1, "defaultOpacity");
        double detailZoom = bounded(root.path("detailZoom").asDouble(-2.25), -10, 10, "detailZoom");
        double closeDetailFactor = bounded(root.path("closeDetailFactor").asDouble(0.55), 0, 1,
            "closeDetailFactor");
        Path rootPath = normalizedManifest.getParent().toRealPath();
        Map<String, Variant> variants = new LinkedHashMap<>();
        JsonNode variantNodes = root.path("variants");
        if (!variantNodes.isArray()) throw new IllegalArgumentException("Terrain context variants must be an array");
        for (JsonNode node : variantNodes) {
            Variant variant = Variant.parse(rootPath, node);
            if (variants.putIfAbsent(variant.id(), variant) != null) {
                throw new IllegalArgumentException("Duplicate terrain context variant: " + variant.id());
            }
        }
        if (!variants.containsKey("overview") || !variants.containsKey("detail")) {
            throw new IllegalArgumentException("Terrain context requires overview and detail variants");
        }
        BiomeConfiguration biomes = BiomeConfiguration.parse(root.path("biomes"), variants);
        return new TerrainContext(normalizedManifest, snapshotId, snapshotHash, worldId,
            worldName, style, bounds, defaultOpacity, detailZoom, closeDetailFactor, variants, biomes);
    }

    public ObjectNode publicJson(ObjectMapper mapper) {
        ObjectNode result = mapper.createObjectNode();
        result.put("available", true);
        result.put("kind", KIND);
        result.put("label", "Terrain + water · snapshot #" + snapshotId);
        result.put("provenance", "SNAPSHOT-MATCHED");
        result.put("authoritative", true);
        result.put("snapshotId", snapshotId);
        result.put("worldId", worldId);
        result.put("worldName", worldName);
        result.put("style", style);
        result.put("defaultOpacity", defaultOpacity);
        result.put("detailZoom", detailZoom);
        result.put("closeDetailFactor", closeDetailFactor);
        result.set("bounds", bounds.toJson(mapper));
        ArrayNode variantNodes = result.putArray("variants");
        for (Variant variant : orderedVariants()) {
            ObjectNode node = variantNodes.addObject();
            node.put("id", variant.id());
            node.put("width", variant.width());
            node.put("height", variant.height());
            node.put("displayPixelMeters", variant.displayPixelMeters());
            node.put("version", variant.sha256().substring(0, 16));
        }
        result.set("biomes", biomes.toJson(mapper));
        return result;
    }

    public Variant requireVariant(String id) {
        Variant variant = variants.get(id);
        if (variant == null) throw new IllegalArgumentException("Unknown terrain context variant: " + id);
        return variant;
    }

    public Variant overview() { return requireVariant("overview"); }
    public Variant biomeMask() { return requireVariant(biomes.maskVariant()); }
    public Variant biomeDisplayMask() { return requireVariant(biomes.displayMaskVariant()); }
    public BiomeConfiguration biomes() { return biomes; }
    public long snapshotId() { return snapshotId; }
    public String snapshotHash() { return snapshotHash; }
    public String worldId() { return worldId; }
    public String worldName() { return worldName; }
    public Bounds bounds() { return bounds; }
    public double defaultOpacity() { return defaultOpacity; }
    public double detailZoom() { return detailZoom; }
    public double closeDetailFactor() { return closeDetailFactor; }
    public Path manifestPath() { return manifestPath; }

    private List<Variant> orderedVariants() {
        List<Variant> result = new ArrayList<>();
        result.add(overview());
        result.add(requireVariant("detail"));
        if (variants.containsKey("topographic-overview") && variants.containsKey("topographic-detail")) {
            result.add(requireVariant("topographic-overview"));
            result.add(requireVariant("topographic-detail"));
        }
        result.add(biomeMask());
        if (!biomes.displayMaskVariant().equals(biomes.maskVariant())) result.add(biomeDisplayMask());
        return result;
    }

    private static String requiredText(JsonNode node, String field) {
        String value = node.path(field).asText("").trim();
        if (value.isEmpty()) throw new IllegalArgumentException("Terrain context is missing " + field);
        return value;
    }

    private static String hash(String value, String label) {
        String normalized = value == null ? "" : value.trim().toLowerCase();
        if (!normalized.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("Terrain context " + label + " is not SHA-256");
        }
        return normalized;
    }

    private static double bounded(double value, double minimum, double maximum, String label) {
        if (!Double.isFinite(value) || value < minimum || value > maximum) {
            throw new IllegalArgumentException("Terrain context " + label + " is out of range");
        }
        return value;
    }

    private static String sha256(Path path) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream input = Files.newInputStream(path)) {
                byte[] buffer = new byte[1024 * 1024];
                int read;
                while ((read = input.read(buffer)) >= 0) digest.update(buffer, 0, read);
            }
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    public record Bounds(double minX, double maxX, double minZ, double maxZ) {
        private static Bounds parse(JsonNode node) {
            Bounds bounds = new Bounds(
                finite(node.path("minX").asDouble(Double.NaN), "bounds.minX"),
                finite(node.path("maxX").asDouble(Double.NaN), "bounds.maxX"),
                finite(node.path("minZ").asDouble(Double.NaN), "bounds.minZ"),
                finite(node.path("maxZ").asDouble(Double.NaN), "bounds.maxZ"));
            if (bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ) {
                throw new IllegalArgumentException("Terrain context bounds are empty or reversed");
            }
            return bounds;
        }

        private ObjectNode toJson(ObjectMapper mapper) {
            ObjectNode result = mapper.createObjectNode();
            result.put("minX", minX);
            result.put("maxX", maxX);
            result.put("minZ", minZ);
            result.put("maxZ", maxZ);
            return result;
        }

        private static double finite(double value, String label) {
            if (!Double.isFinite(value)) throw new IllegalArgumentException("Terrain context " + label + " is invalid");
            return value;
        }
    }

    public record Variant(String id, Path path, int width, int height,
                          double displayPixelMeters, String sha256, long bytes) {
        private static Variant parse(Path root, JsonNode node) throws IOException {
            String id = requiredText(node, "id");
            if (!id.matches("[a-z][a-z0-9-]*")) {
                throw new IllegalArgumentException("Unsafe terrain context variant id: " + id);
            }
            String file = requiredText(node, "file");
            if (!file.matches("[A-Za-z0-9._-]+")) {
                throw new IllegalArgumentException("Unsafe terrain context filename: " + file);
            }
            Path path = root.resolve(file).normalize();
            if (!path.getParent().equals(root) || !Files.isRegularFile(path)) {
                throw new IllegalArgumentException("Terrain context image not found: " + path);
            }
            int width = node.path("width").asInt(0);
            int height = node.path("height").asInt(0);
            if (width < 1 || height < 1 || width > 8192 || height > 8192) {
                throw new IllegalArgumentException("Terrain context dimensions are invalid for " + id);
            }
            int[] actual = imageDimensions(path);
            if (actual[0] != width || actual[1] != height) {
                throw new IllegalArgumentException("Terrain context dimensions do not match " + file);
            }
            String expectedHash = hash(node.path("sha256").asText(), "variant sha256");
            String actualHash = TerrainContext.sha256(path);
            if (!expectedHash.equals(actualHash)) {
                throw new IllegalArgumentException("Terrain context checksum does not match " + file);
            }
            long bytes = Files.size(path);
            if (node.path("bytes").asLong(-1) != bytes) {
                throw new IllegalArgumentException("Terrain context byte count does not match " + file);
            }
            double pixelMeters = bounded(node.path("displayPixelMeters").asDouble(Double.NaN),
                0.1, 1000, "displayPixelMeters");
            return new Variant(id, path, width, height, pixelMeters, expectedHash, bytes);
        }

        private static int[] imageDimensions(Path path) throws IOException {
            try (ImageInputStream input = ImageIO.createImageInputStream(path.toFile())) {
                if (input == null) throw new IllegalArgumentException("Could not inspect context image " + path);
                Iterator<ImageReader> readers = ImageIO.getImageReaders(input);
                if (!readers.hasNext()) throw new IllegalArgumentException("Unsupported context image " + path);
                ImageReader reader = readers.next();
                try {
                    reader.setInput(input, true, true);
                    return new int[]{reader.getWidth(0), reader.getHeight(0)};
                } finally {
                    reader.dispose();
                }
            }
        }
    }

    public record BiomeConfiguration(String classification, String maskVariant, String displayMaskVariant,
            boolean spaceIncludesWater, List<Biome> catalog) {
        private static final Set<String> REQUIRED = Set.of(
            "space", "deep-north", "mistlands", "ashlands", "swamps", "plains", "meadows", "other");

        private static BiomeConfiguration parse(JsonNode node, Map<String, Variant> variants) {
            if (!node.isObject()) throw new IllegalArgumentException("Terrain context biomes are missing");
            String classification = requiredText(node, "classification");
            String maskVariant = requiredText(node, "maskVariant");
            Variant mask = variants.get(maskVariant);
            if (mask == null) throw new IllegalArgumentException("Terrain context biome mask variant is missing");
            String displayMaskVariant = node.path("displayMaskVariant").asText(maskVariant).trim();
            Variant displayMask = variants.get(displayMaskVariant);
            if (displayMask == null) throw new IllegalArgumentException("Terrain context biome display mask variant is missing");
            if (displayMask.width() != mask.width() || displayMask.height() != mask.height()) {
                throw new IllegalArgumentException("Terrain context biome masks must have matching dimensions");
            }
            if (!node.path("spaceIncludesWater").asBoolean(false)) {
                throw new IllegalArgumentException("Terrain context Ocean must include water");
            }
            JsonNode catalogNode = node.path("catalog");
            if (!catalogNode.isArray()) throw new IllegalArgumentException("Terrain context biome catalog is missing");
            List<Biome> catalog = new ArrayList<>();
            Set<String> ids = new HashSet<>();
            Set<Integer> indices = new HashSet<>();
            for (JsonNode item : catalogNode) {
                Biome biome = Biome.parse(item);
                if (!ids.add(biome.id())) throw new IllegalArgumentException("Duplicate biome id: " + biome.id());
                if (!indices.add(biome.index())) throw new IllegalArgumentException("Duplicate biome index: " + biome.index());
                catalog.add(biome);
            }
            if (!ids.equals(REQUIRED)) {
                throw new IllegalArgumentException("Terrain context biome catalog is incomplete");
            }
            return new BiomeConfiguration(classification, maskVariant, displayMaskVariant, true, List.copyOf(catalog));
        }

        ObjectNode toJson(ObjectMapper mapper) {
            ObjectNode result = mapper.createObjectNode();
            result.put("classification", classification);
            result.put("maskVariant", maskVariant);
            result.put("displayMaskVariant", displayMaskVariant);
            result.put("spaceIncludesWater", spaceIncludesWater);
            ArrayNode items = result.putArray("catalog");
            catalog.forEach(biome -> items.add(biome.toJson(mapper)));
            return result;
        }

        public Biome require(String id) {
            return catalog.stream().filter(biome -> biome.id().equals(id)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unknown biome: " + id));
        }
    }

    public record Biome(int index, String id, String label, String color, long pixelCount) {
        private static Biome parse(JsonNode node) {
            int index = node.path("index").asInt(-1);
            String id = requiredText(node, "id");
            String label = requiredText(node, "label");
            String color = requiredText(node, "color").toLowerCase();
            long pixelCount = node.path("pixelCount").asLong(-1);
            if (index < 1 || index > 255) throw new IllegalArgumentException("Biome index is invalid: " + index);
            if (!id.matches("[a-z][a-z0-9-]*")) throw new IllegalArgumentException("Biome id is invalid: " + id);
            if (!color.matches("#[0-9a-f]{6}")) throw new IllegalArgumentException("Biome color is invalid: " + color);
            if (pixelCount < 0) throw new IllegalArgumentException("Biome pixel count is invalid: " + id);
            return new Biome(index, id, label, color, pixelCount);
        }

        ObjectNode toJson(ObjectMapper mapper) {
            ObjectNode result = mapper.createObjectNode();
            result.put("index", index);
            result.put("id", id);
            result.put("label", label);
            result.put("color", color);
            result.put("pixelCount", pixelCount);
            return result;
        }
    }
}
