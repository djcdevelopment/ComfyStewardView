package com.valheim.viewer.contract;

/**
 * Contract DTO for a dungeon entrance or other detected structure.
 * Empty list in Phase 1 — detection implemented in Phase 4.
 */
public class Structure {
    public String id;
    public String prefab;
    public String type;           // dungeon_entrance|camp|ruin|boss_altar|cave_entrance|unknown
    public Vec3   position;
    public String biome;          // null in Phase 1
    public String sector_id;     // null — Phase 3b
    public String instance_id;   // null — Phase 4
    public String status;        // unknown|active|likely_cleared
    public int    spawner_count;
    public int    spawner_active;
    public Classification classification; // kind=structure
    public double confidence;
    public String notes;
}
