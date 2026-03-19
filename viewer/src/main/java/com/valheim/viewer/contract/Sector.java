package com.valheim.viewer.contract;

/**
 * Contract DTO for a single occupied world sector.
 *
 * Sectors are axis-aligned square cells of cell_size_m x cell_size_m metres.
 * id format: "{cx}:{cz}" where cx/cz are grid coordinates (world / cell_size_m, floor-divided).
 *
 * world_x / world_z are the cell centre coordinates.
 *
 * density:
 *   "hotspot" -- cell appears in MetricsResult.hotspots (statistically anomalous ZDO count)
 *   "high"    -- total ZDOs >= highDensitySectorZdoCount config value
 *   "normal"  -- everything else
 */
public class Sector {

    public String id;          // "{cx}:{cz}"
    public int    cx;
    public int    cz;
    public double world_x;     // cell centre x
    public double world_z;     // cell centre z
    public int    cell_size_m;

    // ZDO counts by contract kind
    public int portals;
    public int entities;
    public int containers;
    public int records;        // beds + signs + tombstones + item_stands + ballistas + unknowns
    public int structures;     // dungeon / boss-site entrances
    public int total;          // sum of all kinds

    public String density;     // "normal" | "high" | "hotspot"
}
