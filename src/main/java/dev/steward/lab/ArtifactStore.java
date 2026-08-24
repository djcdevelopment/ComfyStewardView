package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.regex.Pattern;

public final class ArtifactStore {
    public static final int SCHEMA_VERSION = 1;
    private static final Pattern SAFE_FILE = Pattern.compile("[a-z0-9][a-z0-9._-]*");

    private final Path root;
    private final ObjectMapper mapper;

    public ArtifactStore(Path root, ObjectMapper mapper) throws IOException {
        this.root = root.toAbsolutePath().normalize();
        this.mapper = mapper;
        Files.createDirectories(this.root);
    }

    public Path root() { return root; }

    public Path snapshotDirectory(long snapshotId) throws IOException {
        if (snapshotId <= 0) throw new IllegalArgumentException("Invalid snapshot id");
        Path directory = root.resolve(Long.toString(snapshotId)).normalize();
        ensureWithinRoot(directory);
        Files.createDirectories(directory);
        return directory;
    }

    public Path manifestPath(long snapshotId) {
        Path path = root.resolve(Long.toString(snapshotId)).resolve("manifest.json").normalize();
        ensureWithinRoot(path);
        return path;
    }

    public synchronized ObjectNode readManifest(long snapshotId) throws IOException {
        Path path = manifestPath(snapshotId);
        if (!Files.isRegularFile(path)) return null;
        return (ObjectNode) mapper.readTree(path.toFile());
    }

    public ObjectNode newManifest(SnapshotRepository.Snapshot snapshot, LensRegistry lenses) {
        ObjectNode root = mapper.createObjectNode();
        root.put("schemaVersion", SCHEMA_VERSION);
        root.put("snapshotId", snapshot.snapshotId());
        root.put("generatedAt", Instant.now().toString());
        root.set("snapshot", snapshot.toJson(mapper));
        ObjectNode bounds = root.putObject("worldBounds");
        bounds.put("minX", WorldBounds.VALHEIM.minX());
        bounds.put("maxX", WorldBounds.VALHEIM.maxX());
        bounds.put("minZ", WorldBounds.VALHEIM.minZ());
        bounds.put("maxZ", WorldBounds.VALHEIM.maxZ());
        root.set("lenses", lenses.publicJson(mapper));
        root.set("layers", mapper.createArrayNode());
        return root;
    }

    public synchronized void writeManifest(long snapshotId, ObjectNode manifest) throws IOException {
        Path target = manifestPath(snapshotId);
        Files.createDirectories(target.getParent());
        manifest.put("generatedAt", Instant.now().toString());
        Path temporary = target.resolveSibling("manifest.json.tmp");
        mapper.writerWithDefaultPrettyPrinter().writeValue(temporary.toFile(), manifest);
        atomicReplace(temporary, target);
    }

    public ObjectNode findLayer(ObjectNode manifest, String lensId, int cellSize) {
        if (manifest == null || !manifest.path("layers").isArray()) return null;
        for (var node : manifest.withArray("layers")) {
            if (lensId.equals(node.path("lensId").asText()) && cellSize == node.path("cellSize").asInt()) {
                return (ObjectNode) node;
            }
        }
        return null;
    }

    public void replaceLayer(ObjectNode manifest, ObjectNode layer) {
        ArrayNode layers = manifest.withArray("layers");
        String lensId = layer.path("lensId").asText();
        int cellSize = layer.path("cellSize").asInt();
        for (int i = layers.size() - 1; i >= 0; i--) {
            var existing = layers.get(i);
            if (lensId.equals(existing.path("lensId").asText()) &&
                    cellSize == existing.path("cellSize").asInt()) {
                layers.remove(i);
            }
        }
        layers.add(layer);
    }

    public Path resolveArtifact(long snapshotId, String fileName) {
        if (fileName == null || !SAFE_FILE.matcher(fileName).matches()) {
            throw new IllegalArgumentException("Invalid artifact filename");
        }
        Path path = root.resolve(Long.toString(snapshotId)).resolve(fileName).normalize();
        ensureWithinRoot(path);
        return path;
    }

    public static void atomicReplace(Path temporary, Path target) throws IOException {
        try {
            Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException ignored) {
            Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private void ensureWithinRoot(Path path) {
        if (!path.toAbsolutePath().normalize().startsWith(root)) {
            throw new IllegalArgumentException("Artifact path escaped root: " + path);
        }
    }
}
