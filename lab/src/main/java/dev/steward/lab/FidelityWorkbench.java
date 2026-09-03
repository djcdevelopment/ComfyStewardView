package dev.steward.lab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.BufferedReader;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

/** Local-only join over the external gallery corpus; no image is copied into this repository. */
final class FidelityWorkbench {
    private static final int[] FIXTURES = {611, 713, 1364};

    private final Path gallery;
    private final Path receiptsPath;
    private final Path clustersPath;
    private final ObjectMapper mapper;
    private final JsonNode galleryIndex;
    private final JsonNode clusters;
    private final Map<String, JsonNode> receipts;
    private final JsonNode promotion;

    FidelityWorkbench(LabConfig config, ObjectMapper mapper) throws Exception {
        this.gallery = config.fidelityGallery();
        this.receiptsPath = config.fidelityReceipts();
        this.clustersPath = config.fidelityClusters();
        this.mapper = mapper;
        if (!available()) {
            galleryIndex = mapper.createObjectNode();
            clusters = mapper.createArrayNode();
            receipts = Map.of();
            promotion = mapper.createObjectNode();
            return;
        }
        galleryIndex = mapper.readTree(gallery.resolve("index.json").toFile());
        JsonNode clusterRoot = mapper.readTree(clustersPath.toFile());
        clusters = clusterRoot.path("clusters").isArray() ? clusterRoot.path("clusters") : clusterRoot;
        Map<String, JsonNode> joined = new HashMap<>();
        try (BufferedReader reader = Files.newBufferedReader(receiptsPath)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) continue;
                JsonNode receipt = mapper.readTree(line);
                String id = receipt.path("run").asText() + "_" +
                    String.format("%04d", receipt.path("cluster_id").asInt()) + "_" +
                    receipt.path("shot").asText();
                joined.put(id, receipt);
            }
        }
        receipts = Map.copyOf(joined);
        try (InputStream input = FidelityWorkbench.class.getResourceAsStream("/prefab-promotion-receipt.json")) {
            promotion = input == null ? mapper.createObjectNode() : mapper.readTree(input);
        }
    }

    boolean available() {
        return gallery != null && receiptsPath != null && clustersPath != null &&
            Files.isRegularFile(gallery.resolve("index.json"));
    }

    ObjectNode view(int clusterId) {
        if (!available()) throw new IllegalStateException("The private fidelity corpus is not configured");
        JsonNode cluster = null;
        for (JsonNode candidate : clusters) {
            if (candidate.path("cluster_id").asInt() == clusterId) { cluster = candidate; break; }
        }
        if (cluster == null) throw new IllegalArgumentException("Unknown gallery cluster: " + clusterId);

        ObjectNode result = mapper.createObjectNode();
        result.put("schema", "steward-fidelity-workbench/v1");
        result.put("private", true);
        result.put("clusterId", clusterId);
        result.put("galleryImages", galleryIndex.path("n").asInt());
        result.put("shotReceipts", receipts.size());
        result.put("fovContract", "vertical 65 degrees; native Valheim left-handed coordinates");
        result.set("promotion", promotion.deepCopy());
        ObjectNode scope = result.putObject("scope");
        scope.put("minX", cluster.path("min_x").asDouble());
        scope.put("maxX", cluster.path("max_x").asDouble());
        scope.put("minY", cluster.path("min_y").asDouble());
        scope.put("maxY", cluster.path("max_y").asDouble());
        scope.put("minZ", cluster.path("min_z").asDouble());
        scope.put("maxZ", cluster.path("max_z").asDouble());
        scope.put("clusterPieces", cluster.path("pieces").asLong());
        scope.put("topPrefab", cluster.path("top_prefab").asText());
        ArrayNode fixtureNodes = result.putArray("fixtures");
        for (int fixture : FIXTURES) fixtureNodes.add(fixture);

        ArrayNode views = result.putArray("views");
        for (JsonNode image : galleryIndex.path("images")) {
            if (image.path("cluster_id").asInt(-1) != clusterId) continue;
            String id = image.path("id").asText();
            JsonNode receipt = receipts.get(id);
            if (receipt == null || !receipt.path("lens").isObject() || !receipt.path("aim").isObject()) continue;
            ObjectNode view = views.addObject();
            view.put("id", id);
            view.put("variant", image.path("variant").asText());
            view.put("environment", image.path("environment").asText());
            view.put("image", "api/rnd/fidelity/image/" + id);
            view.set("lens", vector(receipt.path("lens")));
            view.set("aim", vector(receipt.path("aim")));
            view.put("yaw", receipt.path("yaw").asDouble());
            view.put("pitch", receipt.path("pitch").asDouble());
            view.put("fov", receipt.path("fov").asDouble(65));
            view.put("aspect", 16.0 / 9.0);
            view.put("sourcePixels", "3840x2160 capture contract");
        }
        result.put("matchedViews", views.size());
        return result;
    }

    FileInputStream image(String id) throws Exception {
        if (!id.matches("[A-Za-z0-9_-]+")) throw new IllegalArgumentException("Invalid gallery image id");
        boolean known = false;
        for (JsonNode image : galleryIndex.path("images")) {
            if (id.equals(image.path("id").asText())) { known = true; break; }
        }
        if (!known) throw new IllegalArgumentException("Unknown gallery image id");
        Path file = gallery.resolve("large").resolve(id + ".webp").normalize();
        if (!file.startsWith(gallery.resolve("large").normalize()) || !Files.isRegularFile(file)) {
            throw new IllegalArgumentException("Gallery image is unavailable");
        }
        return new FileInputStream(file.toFile());
    }

    private ArrayNode vector(JsonNode source) {
        return mapper.createArrayNode().add(source.path("x").asDouble())
            .add(source.path("y").asDouble()).add(source.path("z").asDouble());
    }
}
