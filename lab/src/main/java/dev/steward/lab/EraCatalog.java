package dev.steward.lab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.ArrayList;

/** Immutable, validated public packages. Selection never mutates shared server state. */
public final class EraCatalog {
    public record Era(String slug, String label, String status, long snapshotId,
                      SnapshotRepository snapshots, ArtifactStore artifacts, TerrainContext context) {}
    private final Map<String, Era> eras = new LinkedHashMap<>();
    private final String defaultEra;

    public EraCatalog(Path file, ObjectMapper mapper, LensRegistry lenses) throws Exception {
        JsonNode doc = mapper.readTree(file.toFile());
        if (!"steward-world-catalog/v1".equals(doc.path("schema").asText()))
            throw new IllegalArgumentException("Unknown world catalog schema");
        defaultEra = doc.path("defaultEra").asText();
        Path root = file.toAbsolutePath().getParent().toRealPath();
        for (JsonNode node : doc.path("eras")) {
            String slug = node.path("slug").asText(), status = node.path("status").asText();
            if (!slug.matches("era[0-9]+") || eras.containsKey(slug))
                throw new IllegalArgumentException("Invalid or duplicate era slug");
            long snapshot = node.path("snapshotId").asLong();
            SnapshotRepository repository = null; ArtifactStore artifacts = null; TerrainContext context = null;
            if ("ready".equals(status)) {
                Map<Path, Boolean> verified = new LinkedHashMap<>();
                for (JsonNode receipt : node.path("files")) {
                    Path artifact = resolve(root, receipt.path("path").asText());
                    if (Files.size(artifact) != receipt.path("bytes").asLong(-1)
                            || !sha256(artifact).equals(receipt.path("sha256").asText()))
                        throw new IllegalArgumentException("Era package artifact integrity failure");
                    verified.put(artifact, true);
                }
                Path cache = resolve(root, node.path("cache").asText());
                Path manifest = node.path("contextManifest").asText().isBlank() ? null
                    : resolve(root, node.path("contextManifest").asText());
                Path artifactRoot = resolve(root, node.path("artifacts").asText());
                var requiredFiles = new ArrayList<Path>(); requiredFiles.add(cache);
                var directories = new ArrayList<Path>(); directories.add(artifactRoot);
                if (manifest != null) { requiredFiles.add(manifest); directories.add(manifest.getParent()); }
                for (Path required : requiredFiles)
                    if (!verified.containsKey(required)) throw new IllegalArgumentException("Missing artifact receipt");
                for (Path directory : directories) {
                    try (var paths = Files.walk(directory)) {
                        for (Path path : paths.filter(Files::isRegularFile).toList())
                            if (!verified.containsKey(path.toRealPath()))
                                throw new IllegalArgumentException("Unreceipted era artifact: " + path.getFileName());
                    }
                }
                repository = new SnapshotRepository(cache,lenses,mapper,true);
                var saved = repository.requireSnapshot(snapshot);
                if (repository.snapshots().size()!=1 || !saved.worldId().replaceAll("[^A-Za-z0-9]","").equalsIgnoreCase("Comfy"+slug))
                    throw new IllegalArgumentException("Era cache world or snapshot mismatch");
                artifacts = new ArtifactStore(artifactRoot,mapper);
                var raster = artifacts.readManifest(snapshot);
                if (raster==null || !saved.fileHash().equals(raster.path("snapshot").path("fileHash").asText()))
                    throw new IllegalArgumentException("Era raster snapshot mismatch");
                context = manifest == null ? null : TerrainContext.load(manifest,mapper,snapshot,saved.fileHash(),saved.worldId());
                repository.validatePublicRelease(context);
            } else if (!"awaiting-runtime".equals(status)) {
                throw new IllegalArgumentException("Unsupported era publication status");
            }
            if (snapshot<=0 || eras.values().stream().anyMatch(e -> e.snapshotId()==snapshot))
                throw new IllegalArgumentException("Invalid or duplicate era snapshot");
            eras.put(slug,new Era(slug,node.path("label").asText(slug),status,snapshot,repository,artifacts,context));
        }
        require(defaultEra);
    }
    public Era require(String slug) {
        Era era = eras.get(slug==null || slug.isBlank() ? defaultEra : slug);
        if (era==null) throw new IllegalArgumentException("Unknown era");
        return era;
    }
    public Era ready(String slug) {
        Era era=require(slug);
        if (!"ready".equals(era.status())) throw new IllegalStateException("This era's spatial package is being prepared");
        return era;
    }
    public ObjectNode publicJson(ObjectMapper mapper) {
        ObjectNode result=mapper.createObjectNode();result.put("defaultEra",defaultEra);
        var array=result.putArray("eras");
        for(Era era:eras.values()) {
            var item=array.addObject();item.put("slug",era.slug());item.put("label",era.label());
            item.put("status",era.status());item.put("snapshotId",era.snapshotId());
            item.put("terrainAvailable",era.context()!=null);
            item.put("sceneAvailable",era.snapshots()!=null);
        }
        return result;
    }
    private static Path resolve(Path root,String relative) throws Exception {
        if(relative.isBlank() || Path.of(relative).isAbsolute()) throw new IllegalArgumentException("Era paths must be relative");
        Path result=root.resolve(relative).normalize().toRealPath();
        if(!result.startsWith(root)) throw new IllegalArgumentException("Era artifact escaped package root");
        return result;
    }
    private static String sha256(Path file) throws Exception {
        MessageDigest digest=MessageDigest.getInstance("SHA-256");
        try(var stream=Files.newInputStream(file)) { byte[] buffer=new byte[1024*1024];int n;
            while((n=stream.read(buffer))!=-1) digest.update(buffer,0,n); }
        return HexFormat.of().formatHex(digest.digest());
    }
}
