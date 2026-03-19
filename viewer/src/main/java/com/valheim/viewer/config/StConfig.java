package com.valheim.viewer.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.IOException;

/**
 * Config singleton. Reads steward-config.json from the working directory,
 * validates all fields, corrects invalid values with WARN logs, and writes
 * defaults if the file is absent (self-documenting on first run).
 *
 * Call StConfig.load() once at startup before building the pipeline.
 * Access via StConfig.get() anywhere thereafter.
 */
public class StConfig {

    private static final Logger log = LoggerFactory.getLogger(StConfig.class);
    private static final String CONFIG_FILE = "steward-config.json";

    private static StConfig instance;
    private static boolean  configFileFound = false;

    // ---- Sector ----
    public int sectorSizeM = 200;

    // ---- Cluster ----
    public int    portalClusterRadiusM  = 200;
    public int    portalClusterMinSize  = 5;
    public int    entityClusterRadiusM  = 100;

    // ---- Density ----
    public int    buildRiskZdoCount          = 800;
    public double hotspotSigmaMultiplier     = 2.0;
    public int    hotspotMinCells            = 10;
    public int    highDensitySectorZdoCount  = 500;

    // ---- Budgets ----
    public int defaultSpawnRadiusM = 500;
    public int defaultSpawnMaxZdos = 2000;

    // ---- Structures ----
    public int      spawnerScanRadiusM = 300;
    public String[] entrancePrefabs    = {
        "Crypt2", "Crypt3", "Crypt4",
        "SunkenCrypt2", "SunkenCrypt3", "SunkenCrypt4",
        "FrostCaves", "MountainCave",
        "Mistlands_DvergrTownEntrance1", "AshlandsGjall"
    };

    // ---- Taxonomy ----
    public int unknownSurgeThresholdPct = 20;

    // ---- Metrics ----
    public int topPrefabsGlobalN = 20;

    // ------------------------------------------------------------------

    private StConfig() {}

    public static StConfig get() {
        if (instance == null) throw new IllegalStateException("StConfig.load() must be called before get()");
        return instance;
    }

    public static boolean isConfigFileFound() { return configFileFound; }

    public static void load() {
        StConfig cfg = new StConfig();
        File file = new File(CONFIG_FILE);

        if (file.exists()) {
            configFileFound = true;
            try {
                ObjectMapper mapper = new ObjectMapper();
                JsonNode root = mapper.readTree(file);
                cfg.applyJson(root);
                log.info("Loaded config from {}", file.getAbsolutePath());
            } catch (IOException e) {
                log.warn("Failed to parse {} — using defaults: {}", CONFIG_FILE, e.getMessage());
            }
        } else {
            log.info("No {} found — using defaults, writing template", CONFIG_FILE);
            cfg.writeDefaults(file);
        }

        cfg.validate();
        instance = cfg;
    }

    private void applyJson(JsonNode root) {
        sectorSizeM = intVal(root, "sector_size_m", sectorSizeM);

        JsonNode cluster = root.path("cluster");
        portalClusterRadiusM = intVal(cluster, "portal_radius_m", portalClusterRadiusM);
        portalClusterMinSize = intVal(cluster, "portal_min_size",  portalClusterMinSize);
        entityClusterRadiusM = intVal(cluster, "entity_radius_m",  entityClusterRadiusM);

        JsonNode density = root.path("density");
        buildRiskZdoCount         = intVal(density, "build_risk_zdo_count",         buildRiskZdoCount);
        hotspotSigmaMultiplier    = dblVal(density, "hotspot_sigma_multiplier",      hotspotSigmaMultiplier);
        hotspotMinCells           = intVal(density, "hotspot_min_cells",             hotspotMinCells);
        highDensitySectorZdoCount = intVal(density, "high_density_sector_zdo_count", highDensitySectorZdoCount);

        JsonNode budgets = root.path("budgets");
        defaultSpawnRadiusM = intVal(budgets, "default_spawn_radius_m", defaultSpawnRadiusM);
        defaultSpawnMaxZdos = intVal(budgets, "default_spawn_max_zdos", defaultSpawnMaxZdos);

        JsonNode structures = root.path("structures");
        spawnerScanRadiusM = intVal(structures, "spawner_scan_radius_m", spawnerScanRadiusM);
        if (structures.has("entrance_prefabs") && structures.get("entrance_prefabs").isArray()) {
            JsonNode arr = structures.get("entrance_prefabs");
            entrancePrefabs = new String[arr.size()];
            for (int i = 0; i < arr.size(); i++) entrancePrefabs[i] = arr.get(i).asText();
        }

        JsonNode taxonomy = root.path("taxonomy");
        unknownSurgeThresholdPct = intVal(taxonomy, "unknown_surge_threshold_pct", unknownSurgeThresholdPct);

        JsonNode metrics = root.path("metrics");
        topPrefabsGlobalN = intVal(metrics, "top_prefabs_global_n", topPrefabsGlobalN);
    }

    private void validate() {
        sectorSizeM              = requirePositive("sector_size_m",              sectorSizeM,              200);
        portalClusterRadiusM     = requireNonNeg  ("portal_cluster_radius_m",    portalClusterRadiusM,     200);
        portalClusterMinSize     = requireMin2    ("portal_cluster_min_size",     portalClusterMinSize,     5);
        entityClusterRadiusM     = requireNonNeg  ("entity_cluster_radius_m",    entityClusterRadiusM,     100);
        buildRiskZdoCount        = requirePositive("build_risk_zdo_count",       buildRiskZdoCount,        800);
        hotspotSigmaMultiplier   = requirePositiveD("hotspot_sigma_multiplier",  hotspotSigmaMultiplier,   2.0);
        hotspotMinCells          = requirePositive("hotspot_min_cells",          hotspotMinCells,          10);
        highDensitySectorZdoCount= requirePositive("high_density_sector_zdo_count", highDensitySectorZdoCount, 500);
        defaultSpawnRadiusM      = requirePositive("default_spawn_radius_m",     defaultSpawnRadiusM,      500);
        defaultSpawnMaxZdos      = requirePositive("default_spawn_max_zdos",     defaultSpawnMaxZdos,      2000);
        spawnerScanRadiusM       = requirePositive("spawner_scan_radius_m",      spawnerScanRadiusM,       300);
        unknownSurgeThresholdPct = requireRange   ("unknown_surge_threshold_pct",unknownSurgeThresholdPct, 20, 0, 100);
        topPrefabsGlobalN        = requirePositive("top_prefabs_global_n",       topPrefabsGlobalN,        20);
    }

    // ---- Validation helpers ----

    private int requirePositive(String name, int val, int def) {
        if (val <= 0) { log.warn("Config {}: {} is invalid (<=0), resetting to {}", CONFIG_FILE, name, def); return def; }
        return val;
    }

    private int requireNonNeg(String name, int val, int def) {
        if (val < 0) { log.warn("Config {}: {} is invalid (<0), resetting to {}", CONFIG_FILE, name, def); return def; }
        return val;
    }

    private int requireMin2(String name, int val, int def) {
        if (val < 2) { log.warn("Config {}: {} is invalid (<2), resetting to {}", CONFIG_FILE, name, def); return def; }
        return val;
    }

    private double requirePositiveD(String name, double val, double def) {
        if (val <= 0) { log.warn("Config {}: {} is invalid (<=0), resetting to {}", CONFIG_FILE, name, def); return def; }
        return val;
    }

    private int requireRange(String name, int val, int def, int min, int max) {
        if (val < min || val > max) {
            log.warn("Config {}: {} is out of range [{},{}], resetting to {}", CONFIG_FILE, name, min, max, def);
            return def;
        }
        return val;
    }

    // ---- JSON read helpers ----

    private static int intVal(JsonNode node, String field, int def) {
        JsonNode n = node.path(field);
        return n.isInt() || n.isLong() ? n.intValue() : def;
    }

    private static double dblVal(JsonNode node, String field, double def) {
        JsonNode n = node.path(field);
        return n.isNumber() ? n.doubleValue() : def;
    }

    // ---- Write defaults ----

    private void writeDefaults(File file) {
        ObjectMapper mapper = new ObjectMapper();
        ObjectNode root = mapper.createObjectNode();
        root.put("_comment", "Valheim World Viewer — Steward Config. Restart to apply.");
        root.put("sector_size_m", 200);

        ObjectNode cluster = root.putObject("cluster");
        cluster.put("portal_radius_m", 200);
        cluster.put("portal_min_size", 5);
        cluster.put("entity_radius_m", 100);

        ObjectNode density = root.putObject("density");
        density.put("build_risk_zdo_count", 800);
        density.put("hotspot_sigma_multiplier", 2.0);
        density.put("hotspot_min_cells", 10);
        density.put("high_density_sector_zdo_count", 500);

        ObjectNode budgets = root.putObject("budgets");
        budgets.put("default_spawn_radius_m", 500);
        budgets.put("default_spawn_max_zdos", 2000);

        ObjectNode structures = root.putObject("structures");
        structures.put("spawner_scan_radius_m", 300);
        com.fasterxml.jackson.databind.node.ArrayNode prefabs = structures.putArray("entrance_prefabs");
        for (String p : entrancePrefabs) prefabs.add(p);

        ObjectNode taxonomy = root.putObject("taxonomy");
        taxonomy.put("unknown_surge_threshold_pct", 20);

        ObjectNode metrics = root.putObject("metrics");
        metrics.put("top_prefabs_global_n", 20);

        try {
            mapper.writerWithDefaultPrettyPrinter().writeValue(file, root);
            log.info("Wrote default config to {}", file.getAbsolutePath());
        } catch (IOException e) {
            log.warn("Could not write default config: {}", e.getMessage());
        }
    }
}
