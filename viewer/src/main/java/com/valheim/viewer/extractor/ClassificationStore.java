package com.valheim.viewer.extractor;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * Loads classification.json (item_name → {category, subcategory, tier, biome, source, mod})
 * derived from our pattern-driven classifier + V3 prefab dictionary. Covers ~617 items
 * with tier 0-7 progression numbers and biome tags.
 *
 * Falls back to TaxonomyClassifier's hand-mapped ~250 items when ours doesn't have an entry.
 *
 * Loaded once at app startup; thread-safe after construction.
 */
public class ClassificationStore {

    private static final Logger log = LoggerFactory.getLogger(ClassificationStore.class);

    public static final class Entry {
        public final String category, subcategory, biome, source;
        public final int tier;       // -1 = unknown
        public final boolean mod;

        Entry(String category, String subcategory, int tier, String biome, String source, boolean mod) {
            this.category    = category;
            this.subcategory = subcategory;
            this.tier        = tier;
            this.biome       = biome;
            this.source      = source;
            this.mod         = mod;
        }
    }

    private final Map<String, Entry> byName;
    private final File sourceFile;

    private ClassificationStore(Map<String, Entry> byName, File sourceFile) {
        this.byName = byName;
        this.sourceFile = sourceFile;
    }

    /** Look up classification by item name. Returns null if unknown. */
    public Entry get(String itemName) {
        return itemName == null ? null : byName.get(itemName);
    }

    public int size() { return byName.size(); }

    public File sourceFile() { return sourceFile; }

    /** Emit category/subcategory/tier/biome/source/mod onto an existing ObjectNode if known. */
    public boolean enrich(String itemName, ObjectNode node) {
        Entry e = get(itemName);
        if (e == null) return false;
        node.put("category",    e.category);
        node.put("subcategory", e.subcategory);
        if (e.tier >= 0)        node.put("tier", e.tier);
        if (e.biome != null)    node.put("biome", e.biome);
        node.put("source",      e.source);
        if (e.mod)              node.put("mod", true);
        return true;
    }

    /**
     * Load classification.json from one of several candidate paths. First-match wins.
     * Returns an empty store if no file found (caller should still create one to keep API uniform).
     */
    public static ClassificationStore loadOrEmpty(String... candidatePaths) {
        File found = null;
        for (String p : candidatePaths) {
            if (p == null) continue;
            File f = new File(p);
            if (f.exists()) { found = f; break; }
        }
        if (found == null) {
            log.warn("No classification.json found at any of {} candidate paths; classification will be disabled",
                candidatePaths.length);
            return new ClassificationStore(new HashMap<>(), null);
        }
        Map<String, Entry> out = new HashMap<>();
        try {
            ObjectMapper m = new ObjectMapper();
            JsonNode root = m.readTree(found);
            Iterator<Map.Entry<String, JsonNode>> it = root.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> kv = it.next();
                String name = kv.getKey();
                JsonNode v = kv.getValue();
                String cat = v.path("category").asText(null);
                String sub = v.path("subcategory").asText(null);
                int tier   = v.has("tier") ? v.get("tier").asInt(-1) : -1;
                String biome = v.has("biome") && !v.get("biome").isNull() ? v.get("biome").asText() : null;
                String source = v.path("source").asText(null);
                boolean mod = v.path("mod").asBoolean(false);
                if (cat == null) continue;
                out.put(name, new Entry(cat, sub, tier, biome, source, mod));
            }
            log.info("ClassificationStore: loaded {} entries from {}", out.size(), found.getAbsolutePath());
        } catch (Exception e) {
            log.error("Failed to load classification.json from {}: {}", found, e.toString());
        }
        return new ClassificationStore(out, found);
    }
}
