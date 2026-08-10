package com.valheim.viewer.db;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * Maps a prefab name to a harvestable-resource group.
 *
 * <p><b>Why by name.</b> The obvious implementation is to group by {@code zdo.category}, and it
 * does not work: {@code Categories.NATURE} is assigned only to ZDOs with no property flags at
 * all, so on a real world it matches nothing — 0 rows on ComfyEra16, against 3,826,367 sitting in
 * {@code UNKNOWN}. Every tree and ore deposit carries at least one flag and falls through. Fixing
 * that means re-ingesting, because categories are frozen into the row at parse time, so the
 * resource series reads prefab names instead. {@link com.valheim.viewer.parser.PrefabDictionary}
 * validates every name against the same stable hash the parser reads, so a name is either a real
 * prefab or it matches nothing.
 *
 * <p>Loaded from {@code resource-prefabs.json} — working directory first, then the bundled
 * resource — mirroring {@link com.valheim.viewer.parser.PrefabDictionary#load}, so a modded server
 * can extend the groups without a rebuild.
 */
public final class ResourceGroups {

    private static final Logger log = LoggerFactory.getLogger(ResourceGroups.class);

    public static final String RESOURCE_PATH = "/resource-prefabs.json";
    public static final String EXPECTED_SCHEMA = "steward-resource-prefabs/v1";

    /** A named bucket plus the compiled patterns that select prefabs into it. */
    public record Group(String id, String label, List<Pattern> patterns) {}

    private final List<Group> groups;
    private final String source;
    /** Resolved name -> group id. Prefab vocabularies are small and queried repeatedly. */
    private final Map<String, String> memo = new LinkedHashMap<>();

    private ResourceGroups(List<Group> groups, String source) {
        this.groups = groups;
        this.source = source;
    }

    public List<Group> groups()      { return groups; }
    public String sourceDescription(){ return source; }
    public boolean isEmpty()         { return groups.isEmpty(); }

    /**
     * The group this prefab belongs to, or {@code null} when it is not a tracked resource.
     *
     * <p>First match wins, so ordering in the file is meaningful: {@code rock4_copper_frac} has to
     * reach the ore patterns before the general rock ones.
     */
    public String groupFor(String prefabName) {
        if (prefabName == null || prefabName.isEmpty()) return null;
        String cached = memo.get(prefabName);
        if (cached != null) return cached.isEmpty() ? null : cached;
        String found = "";
        outer:
        for (Group g : groups) {
            for (Pattern p : g.patterns()) {
                if (p.matcher(prefabName).find()) { found = g.id(); break outer; }
            }
        }
        memo.put(prefabName, found);
        return found.isEmpty() ? null : found;
    }

    // ----- Loading -----

    public static ResourceGroups load() {
        File override = new File("resource-prefabs.json");
        if (override.isFile()) {
            try (InputStream in = new java.io.FileInputStream(override)) {
                return parse(in, override.getAbsolutePath());
            } catch (Exception e) {
                log.warn("ResourceGroups: could not read {} ({}); falling back to the bundled copy",
                    override.getAbsolutePath(), e.toString());
            }
        }
        try (InputStream in = ResourceGroups.class.getResourceAsStream(RESOURCE_PATH)) {
            if (in == null) {
                log.error("ResourceGroups: bundled {} is missing; the resource series will report "
                    + "zero coverage rather than guess", RESOURCE_PATH);
                return new ResourceGroups(List.of(), "<missing>");
            }
            return parse(in, "classpath:" + RESOURCE_PATH);
        } catch (Exception e) {
            log.error("ResourceGroups: failed to load {}: {}", RESOURCE_PATH, e.toString());
            return new ResourceGroups(List.of(), "<error>");
        }
    }

    static ResourceGroups parse(InputStream in, String source) throws Exception {
        JsonNode root = new ObjectMapper().readTree(in);
        String schema = root.path("schema").asText(null);
        if (schema != null && !EXPECTED_SCHEMA.equals(schema)) {
            log.warn("ResourceGroups: {} declares schema '{}', expected '{}' — loading anyway",
                source, schema, EXPECTED_SCHEMA);
        }

        List<Group> out = new ArrayList<>();
        int rejected = 0;
        for (JsonNode g : root.path("groups")) {
            String id = g.path("id").asText(null);
            if (id == null || id.isBlank()) { rejected++; continue; }
            List<Pattern> patterns = new ArrayList<>();
            for (JsonNode p : g.path("patterns")) {
                String regex = p.asText(null);
                if (regex == null || regex.isBlank()) continue;
                try {
                    patterns.add(Pattern.compile(regex, Pattern.CASE_INSENSITIVE));
                } catch (PatternSyntaxException e) {
                    // One bad regex must not silently widen or narrow a whole group.
                    log.warn("ResourceGroups: group '{}' has an invalid pattern '{}': {}",
                        id, regex, e.getDescription());
                    rejected++;
                }
            }
            if (patterns.isEmpty()) { rejected++; continue; }
            out.add(new Group(id, g.path("label").asText(id), patterns));
        }

        log.info("ResourceGroups: {} groups from {}{}", out.size(), source,
            rejected > 0 ? ", " + rejected + " rejected" : "");
        return new ResourceGroups(out, source);
    }
}
