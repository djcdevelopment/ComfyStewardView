package com.valheim.viewer.contract;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A single steward alert.
 *
 * type values:
 *   portal_orphaned    — portal has a tag but no partner
 *   portal_blank_tag   — portal has no tag (aggregate)
 *   portal_duplicate_tag — 3+ portals share a tag
 *   portal_cluster     — large spatial cluster of portals
 *   zone_budget        — region approaching or over ZDO budget
 *   build_hotspot      — high-density building area (performance risk)
 *   dropped_hotspot    — high-density dropped item area
 *   economy_unknown_surge — too many unrecognised item types in chests
 *
 * severity: critical | high | medium | low
 *
 * world_x / world_z: null for non-location alerts.
 * meta: type-specific key/value context included in the JSON.
 */
public class Alert {

    public String id;
    public String type;
    public String severity;
    public String title;
    public String description;
    public Double world_x;
    public Double world_z;
    public Map<String, Object> meta = new LinkedHashMap<>();

    public Alert() {}

    public Alert(String id, String type, String severity, String title, String description) {
        this.id          = id;
        this.type        = type;
        this.severity    = severity;
        this.title       = title;
        this.description = description;
    }

    /** Convenience: set world position and return this. */
    public Alert at(double x, double z) {
        this.world_x = x;
        this.world_z = z;
        return this;
    }

    /** Convenience: add a meta entry and return this. */
    public Alert meta(String key, Object value) {
        this.meta.put(key, value);
        return this;
    }
}
