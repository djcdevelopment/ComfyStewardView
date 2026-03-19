package com.valheim.viewer.contract;

import java.util.ArrayList;
import java.util.List;

/**
 * Contract DTO for a portal ZDO.
 * classification is null in Phase 1; populated in Phase 2b.
 */
public class Portal {
    public String id;
    public String tag;                          // null = blank/missing tag
    public Vec3   position;
    public boolean paired;
    public String  paired_with;                 // null if orphaned
    public String  biome;                       // null — not available in v0.2
    public Double  distance_to_nearest_structure; // null — Phase 4
    public String  created_at;                  // null — ZDO has no creation timestamp
    public String  last_seen_at;                // null — reserved for future
    public String  sector_id;                   // null — Phase 3b
    public List<String> issues = new ArrayList<>();
    public Classification classification;       // null — Phase 2b
    public double confidence;
}
