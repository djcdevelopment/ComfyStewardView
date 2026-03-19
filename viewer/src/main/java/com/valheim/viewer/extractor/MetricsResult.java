package com.valheim.viewer.extractor;

import com.valheim.viewer.contract.Vec2;

import java.util.ArrayList;
import java.util.List;

/**
 * Output of MetricsBuilder.build().
 * Plain serializable POJOs — no ZdoFlatStore references.
 *
 * Consumed by AlertBuilder (Phase 3a), SectorBuilder (Phase 3b),
 * and the /api/v1/metrics/summary endpoint.
 */
public class MetricsResult {

    public boolean regionsLoaded;

    /** Portal spatial clusters (hubs). */
    public List<Cluster> portalClusters = new ArrayList<>();

    /** Zone budget status per region. */
    public List<ZoneBudget> zoneBudgets = new ArrayList<>();

    /** General ZDO density statistics and hotspot cells. */
    public DensityStats densityStats     = new DensityStats();
    public List<DensityCell> hotspots    = new ArrayList<>();

    /** Dropped item density statistics and hotspot cells. */
    public DensityStats droppedDensityStats     = new DensityStats();
    public List<DensityCell> droppedHotspots    = new ArrayList<>();

    // ---- Inner types ----

    public static class Cluster {
        public String       type;         // "portal"
        public Vec2         center;
        public double       radius_m;
        public int          count;
        public List<String> member_ids = new ArrayList<>();
    }

    public static class ZoneBudget {
        public String region_name;
        public Vec2   center;
        public double radius_m;
        public int    zdo_count;
        public int    limit;
        public double pct_used;
        public boolean over_budget;
    }

    public static class DensityStats {
        public int    total_cells;
        public int    max_count;
        public double mean;
        public double stddev;
        public double threshold;
        public int    hotspot_count;
        public int    cell_size_m;
    }

    public static class DensityCell {
        public int    cx;
        public int    cz;
        public double world_x;
        public double world_z;
        public int    count;
        public double sigmas;

        public DensityCell(int cx, int cz, int cellSizeM, int count, double mean, double stddev) {
            this.cx      = cx;
            this.cz      = cz;
            this.world_x = cx * (double) cellSizeM + cellSizeM / 2.0;
            this.world_z = cz * (double) cellSizeM + cellSizeM / 2.0;
            this.count   = count;
            this.sigmas  = stddev > 0 ? (count - mean) / stddev : 0.0;
        }
    }
}
