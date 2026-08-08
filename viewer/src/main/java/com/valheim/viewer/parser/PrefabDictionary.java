package com.valheim.viewer.parser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Verified prefab hash → name dictionary, extracted from the game assembly.
 *
 * <p>Source: {@code comfy-prefab-dump/v1}, generated from {@code assembly_valheim.dll}
 * by the extractor in the baseline repo at
 * {@code C:\work\baseline\tools\component-packets}. See
 * {@code docs/comfy-integration/PREFAB_DICTIONARY.md} for the refresh procedure.
 *
 * <p><b>Why this class exists.</b> Without it, {@link com.valheim.viewer.store.ZdoFlatStore#nameForHash}
 * falls back to the literal string {@code "hash:N"} for every prefab outside a ~100-entry
 * hardcoded table, and five downstream classifiers treat that prefix as a hard failure and
 * degrade to {@code "unknown"}. On ComfyEra16 that was 84% of 9.15M ZDOs.
 *
 * <p><b>Why it is trusted over hand-maintained names.</b> Every entry is validated at load with
 * {@code WorldParser.sh(name) == hash} — the same stable-hash function the parser uses to read
 * the world file. An entry that fails is rejected, never inserted, and counted. Hand-written
 * entries carry no such check, and eight of them were measurably wrong.
 */
public final class PrefabDictionary {

    private static final Logger log = LoggerFactory.getLogger(PrefabDictionary.class);

    /** Bundled into the shaded jar via the default Maven resource root. */
    public static final String RESOURCE_PATH = "/prefab-dump.json";

    /** System property to point at a newer dump without rebuilding. */
    public static final String OVERRIDE_PROPERTY = "prefab.dump";

    public static final String EXPECTED_SCHEMA = "comfy-prefab-dump/v1";

    public static final class Entry {
        public final String  name;
        public final int     hash;
        public final boolean piece;
        public final boolean wearNTear;
        /** Build-menu category (Furniture, BuildingStonecutter, ...); null on most entries. */
        public final String  category;

        Entry(String name, int hash, boolean piece, boolean wearNTear, String category) {
            this.name = name;
            this.hash = hash;
            this.piece = piece;
            this.wearNTear = wearNTear;
            this.category = category;
        }
    }

    private final Map<Integer, Entry> byHash;
    private final String source;
    private final String gameVersion;
    private final String generatedAt;
    private final int    rejected;

    private PrefabDictionary(Map<Integer, Entry> byHash, String source,
                             String gameVersion, String generatedAt, int rejected) {
        this.byHash = byHash;
        this.source = source;
        this.gameVersion = gameVersion;
        this.generatedAt = generatedAt;
        this.rejected = rejected;
    }

    private static PrefabDictionary empty(String source) {
        return new PrefabDictionary(Collections.emptyMap(), source, null, null, 0);
    }

    // ----- Accessors -----

    public Entry  byHash(int hash)      { return byHash.get(hash); }
    /** Resolved name, or null when this dictionary does not know the hash. Never {@code "hash:N"}. */
    public String nameForHash(int hash) { Entry e = byHash.get(hash); return e == null ? null : e.name; }
    public int    size()                { return byHash.size(); }
    public int    rejectedCount()       { return rejected; }
    public String gameVersion()         { return gameVersion; }
    public String generatedAt()         { return generatedAt; }
    public String sourceDescription()   { return source; }
    public Iterable<Entry> entries()    { return byHash.values(); }

    // ----- Loading -----

    /**
     * Load from the first available source: the {@code prefab.dump} system property, a
     * {@code prefab-dump.json} in the working directory, one beside the save file, then the
     * bundled classpath resource.
     *
     * <p>Mirrors {@link com.valheim.viewer.extractor.ClassificationStore#loadOrEmpty} with one
     * difference: the bundled resource is a guaranteed last resort, so a normal deployment can
     * never silently run without a dictionary.
     *
     * @param saveFileDir directory holding the world file; may be null
     */
    public static PrefabDictionary load(File saveFileDir) {
        List<String> candidates = new ArrayList<>();
        String override = System.getProperty(OVERRIDE_PROPERTY);
        if (override != null && !override.isBlank()) candidates.add(override);
        candidates.add("prefab-dump.json");
        if (saveFileDir != null) candidates.add(new File(saveFileDir, "prefab-dump.json").getPath());

        for (String path : candidates) {
            File f = new File(path);
            if (!f.isFile()) continue;
            try (InputStream in = new java.io.FileInputStream(f)) {
                return parse(in, f.getAbsolutePath());
            } catch (Exception e) {
                log.warn("PrefabDictionary: failed to read {} ({}); trying next candidate",
                    f.getAbsolutePath(), e.toString());
            }
        }

        try (InputStream in = PrefabDictionary.class.getResourceAsStream(RESOURCE_PATH)) {
            if (in == null) {
                log.error("PrefabDictionary: bundled resource {} is missing from the jar — "
                    + "prefab names will fall back to the hardcoded table only", RESOURCE_PATH);
                return empty("<missing>");
            }
            return parse(in, "classpath:" + RESOURCE_PATH);
        } catch (Exception e) {
            log.error("PrefabDictionary: failed to load bundled resource {}: {}", RESOURCE_PATH, e.toString());
            return empty("<error>");
        }
    }

    static PrefabDictionary parse(InputStream in, String source) throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        JsonNode root = mapper.readTree(in);

        String schema      = root.path("schema").asText(null);
        String gameVersion = root.path("gameVersion").asText(null);
        String generatedAt = root.path("generatedAt").asText(null);

        if (schema != null && !EXPECTED_SCHEMA.equals(schema)) {
            log.warn("PrefabDictionary: {} declares schema '{}', expected '{}' — "
                + "loading anyway, but check the refresh procedure", source, schema, EXPECTED_SCHEMA);
        }

        JsonNode prefabs = root.path("prefabs");
        if (!prefabs.isArray()) {
            log.error("PrefabDictionary: {} has no 'prefabs' array", source);
            return empty(source);
        }

        Map<Integer, Entry> out = new HashMap<>(Math.max(16, prefabs.size() * 2));
        int rejected = 0;
        int collisions = 0;

        for (JsonNode p : prefabs) {
            String name = p.path("name").asText(null);
            if (name == null || name.isEmpty() || !p.has("hash")) { rejected++; continue; }
            int hash = p.get("hash").asInt();

            // The invariant that makes this dictionary authoritative: the recorded hash must be
            // what the parser will actually read out of the world file for this name.
            if (WorldParser.sh(name) != hash) {
                if (rejected < 10) {
                    log.warn("PrefabDictionary: rejecting '{}' — declared hash {} but sh(name)={}",
                        name, hash, WorldParser.sh(name));
                }
                rejected++;
                continue;
            }

            String category = p.hasNonNull("category") ? p.get("category").asText() : null;
            Entry e = new Entry(name, hash,
                p.path("piece").asBoolean(false),
                p.path("wearNTear").asBoolean(false),
                category);

            Entry prev = out.putIfAbsent(hash, e);
            if (prev != null) {
                collisions++;
                log.warn("PrefabDictionary: hash collision {} between '{}' and '{}' — keeping '{}'",
                    hash, prev.name, e.name, prev.name);
            }
        }

        int declared = root.path("prefabCount").asInt(-1);
        if (declared >= 0 && declared != prefabs.size()) {
            log.warn("PrefabDictionary: {} declares prefabCount={} but contains {} entries",
                source, declared, prefabs.size());
        }

        log.info("PrefabDictionary: {} entries from {} (game {}, generated {}), {} rejected{}",
            out.size(), source, gameVersion, generatedAt, rejected,
            collisions > 0 ? ", " + collisions + " collisions" : "");

        return new PrefabDictionary(out, source, gameVersion, generatedAt, rejected);
    }
}
