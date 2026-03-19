package com.valheim.viewer.contract;

/**
 * Contract DTO for a creature/NPC ZDO.
 * classification is null in Phase 1; populated in Phase 2b.
 */
public class ContractEntity {
    public String id;
    public String prefab;
    public String name;
    public Vec3   position;
    public String entity_type;   // monster|boss|npc|animal|fish|unknown
    public String hostility;     // hostile|passive|neutral|unknown
    public String biome_affinity; // null — Phase 2b
    public String sector_id;     // null — Phase 3b
    public Classification classification; // null — Phase 2b; kind always = "creature"
    public String source;        // vanilla|mod|unknown — null in Phase 1
    public double confidence;
}
