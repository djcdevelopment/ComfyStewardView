package com.valheim.viewer.contract;

import java.util.ArrayList;
import java.util.List;

/**
 * Contract DTO for the world-summary API response data payload.
 * Served via GET /api/v1/world-summary wrapped in a schema-version envelope.
 */
public class WorldSummary {

    public String  world_name;          // null — not available from ZDO parse
    public Integer world_version;
    public long    parse_duration_ms;
    public int     zdo_total;           // all ZDOs with valid positions (allHeatmap count)
    public int     zdo_interesting;     // ZDOs stored in flat arrays
    public boolean config_loaded;
    public boolean regions_loaded;      // false until Phase 2a
    public List<PrefabCount> top_prefabs_global = new ArrayList<>();
    public Stats   stats = new Stats();

    // ---- Nested types ----

    public static class PrefabCount {
        public String prefab;
        public String name;     // null if not resolved
        public int    count;
        public String category; // null in Phase 1

        public PrefabCount(String prefab, String name, int count) {
            this.prefab = prefab;
            this.name   = name;
            this.count  = count;
        }
    }

    public static class Stats {
        public PortalStats   portals    = new PortalStats();
        public PlayerStats   players    = new PlayerStats();
        public DroppedStats  dropped    = new DroppedStats();
        public EconomyStats  economy    = new EconomyStats();
        public StructStats   structures = new StructStats();
        public SectorStats   sectors    = new SectorStats();
        public AlertStats    alerts     = new AlertStats();
    }

    public static class PortalStats {
        public int total;
        public int paired;
        public int orphaned;
        public int blank_tag;
        public int clusters;    // 0 until Phase 2a cluster detection
    }

    public static class PlayerStats {
        public int total;
    }

    public static class DroppedStats {
        public int total;
        public int unique_types;
        public int named_types;
        public int unknown_types;
    }

    public static class EconomyStats {
        public int  unique_items;
        public long total_items;
        public int  unknown_types;  // 0 until Phase 2b taxonomy
        public int  skipped_v106;   // containers skipped due to v106 format
    }

    public static class StructStats {
        public int total;
        public int likely_cleared;
        public int active;
        public int unknown;
    }

    public static class SectorStats {
        public int total_occupied;  // 0 until Phase 3b
        public int high_density;    // 0 until Phase 3b
        public int sector_size_m;   // from config
    }

    public static class AlertStats {
        public int critical;
        public int high;
        public int medium;
        public int low;
    }
}
