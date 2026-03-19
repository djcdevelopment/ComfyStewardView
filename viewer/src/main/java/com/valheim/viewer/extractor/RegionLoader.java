package com.valheim.viewer.extractor;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.valheim.viewer.config.StConfig;
import com.valheim.viewer.contract.Region;
import com.valheim.viewer.contract.Vec2;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Loads steward-defined regions from regions.json in the working directory.
 *
 * Falls back to a single origin-based "Spawn Island" region if the file
 * is absent or unparseable.
 *
 * LIMITATION: World origin (0,0) may not be the actual spawn island on
 * custom seeds. Stewards should provide regions.json to override.
 */
public class RegionLoader {

    private static final Logger log = LoggerFactory.getLogger(RegionLoader.class);
    private static final String REGIONS_FILE = "regions.json";

    private static boolean fileFound = false;

    /** True if regions.json was successfully loaded from disk on the last load() call. */
    public static boolean isFileFound() { return fileFound; }

    public static List<Region> load() {
        fileFound = false;
        File file = new File(REGIONS_FILE);
        if (!file.exists()) {
            log.info("No {} found — using origin fallback for zone budgets", REGIONS_FILE);
            return Collections.singletonList(originFallback());
        }
        try {
            ObjectMapper mapper = new ObjectMapper();
            JsonNode root = mapper.readTree(file);
            JsonNode arr  = root.path("regions");
            if (!arr.isArray() || arr.size() == 0) {
                log.warn("{} has no regions array — using origin fallback", REGIONS_FILE);
                return Collections.singletonList(originFallback());
            }
            List<Region> regions = new ArrayList<>(arr.size());
            for (JsonNode n : arr) {
                Region r = new Region();
                r.name    = n.path("name").asText("unnamed");
                r.radiusM = n.path("radius_m").asDouble(StConfig.get().defaultSpawnRadiusM);
                r.maxZdos = n.path("max_zdos").asInt(StConfig.get().defaultSpawnMaxZdos);
                JsonNode c = n.path("center");
                r.center  = new Vec2(c.path("x").asDouble(0), c.path("z").asDouble(0));
                if (n.has("rules") && n.get("rules").isArray()) {
                    for (JsonNode rule : n.get("rules")) r.rules.add(rule.asText());
                }
                regions.add(r);
            }
            fileFound = true;
            log.info("Loaded {} region(s) from {}", regions.size(), REGIONS_FILE);
            return regions;
        } catch (Exception e) {
            log.warn("Failed to parse {} — using origin fallback: {}", REGIONS_FILE, e.getMessage());
            return Collections.singletonList(originFallback());
        }
    }

    private static Region originFallback() {
        Region r = new Region();
        r.name    = "Spawn Island";
        r.center  = new Vec2(0, 0);
        r.radiusM = StConfig.get().defaultSpawnRadiusM;
        r.maxZdos = StConfig.get().defaultSpawnMaxZdos;
        r.rules.add("spawn_budget");
        return r;
    }
}
