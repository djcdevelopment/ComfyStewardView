package com.valheim.viewer.contract;

/**
 * Contract DTO for a dropped item ZDO.
 * taxonomy and classification are null in Phase 1; populated in Phase 2b.
 */
public class DroppedItem {
    public String id;
    public String prefab;
    public String name;         // null if not resolved from hash registry
    public Vec3   position;
    public int    stack;
    public String sector_id;   // null — Phase 3b
    public Taxonomy taxonomy;  // null — Phase 2b
    public Classification classification; // null — Phase 2b

    public static class Taxonomy {
        public String category;    // weapon|armor|tool|consumable|resource|structure|trophy|utility|unknown
        public String subcategory;
        public String tier;
        public String source;      // vanilla|mod|unknown
        public double confidence;
    }
}
