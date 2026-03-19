package com.valheim.viewer.extractor;

import com.valheim.viewer.config.StConfig;
import com.valheim.viewer.contract.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.*;

/**
 * Computes derived metrics from WorldContracts.
 *
 * Accepts ONLY WorldContracts — no ZdoFlatStore references.
 * Called in Phase 2a after ContractBuilder produces WorldContracts.
 */
public class MetricsBuilder {

    private static final Logger log = LoggerFactory.getLogger(MetricsBuilder.class);

    /**
     * @param contracts      typed world data from ContractBuilder
     * @param regions        loaded from RegionLoader (may be single origin fallback)
     * @param regionsFromFile true if regions.json was successfully loaded from disk
     */
    public MetricsResult build(WorldContracts contracts, List<Region> regions, boolean regionsFromFile) {
        long t0 = System.currentTimeMillis();
        StConfig cfg = StConfig.get();

        MetricsResult result = new MetricsResult();
        result.regionsLoaded  = regionsFromFile;
        result.portalClusters = buildPortalClusters(contracts.portals, cfg);
        result.zoneBudgets    = buildZoneBudgets(contracts, regions);
        buildDensity(contracts, cfg, result);
        buildDroppedDensity(contracts, cfg, result);

        log.info("MetricsBuilder: {} clusters, {} budgets, {} hotspots, {} droppedHotspots in {}ms",
            result.portalClusters.size(), result.zoneBudgets.size(),
            result.hotspots.size(), result.droppedHotspots.size(),
            System.currentTimeMillis() - t0);

        return result;
    }

    // ---- Portal clusters (O(n²), squared-distance, no sqrt during scan) ----

    private List<MetricsResult.Cluster> buildPortalClusters(List<Portal> portals, StConfig cfg) {
        int n = portals.size();
        if (n == 0) return Collections.emptyList();

        double radiusSq = (double) cfg.portalClusterRadiusM * cfg.portalClusterRadiusM;
        boolean[] visited = new boolean[n];
        List<MetricsResult.Cluster> result = new ArrayList<>();

        for (int i = 0; i < n; i++) {
            if (visited[i]) continue;
            Portal pi = portals.get(i);
            double ix = pi.position.x, iz = pi.position.z;

            // Collect all portals within radius of portal[i]
            List<Integer> members = new ArrayList<>();
            members.add(i);
            for (int j = i + 1; j < n; j++) {
                Portal pj = portals.get(j);
                double dx = ix - pj.position.x;
                double dz = iz - pj.position.z;
                if (dx * dx + dz * dz <= radiusSq) {
                    members.add(j);
                }
            }

            if (members.size() < cfg.portalClusterMinSize) continue;

            for (int m : members) visited[m] = true;

            // Centroid
            double sumX = 0, sumZ = 0;
            for (int m : members) {
                sumX += portals.get(m).position.x;
                sumZ += portals.get(m).position.z;
            }
            double cx = sumX / members.size();
            double cz = sumZ / members.size();

            // Actual radius = max distance from centroid to any member
            double maxDistSq = 0;
            for (int m : members) {
                Portal pm = portals.get(m);
                double dx = pm.position.x - cx;
                double dz = pm.position.z - cz;
                double d2 = dx * dx + dz * dz;
                if (d2 > maxDistSq) maxDistSq = d2;
            }

            MetricsResult.Cluster cluster = new MetricsResult.Cluster();
            cluster.type     = "portal";
            cluster.center   = new Vec2(cx, cz);
            cluster.radius_m = Math.sqrt(maxDistSq);
            cluster.count    = members.size();
            for (int m : members) cluster.member_ids.add(portals.get(m).id);

            result.add(cluster);
        }
        return result;
    }

    // ---- Zone budgets ----

    private List<MetricsResult.ZoneBudget> buildZoneBudgets(WorldContracts contracts, List<Region> regions) {
        List<MetricsResult.ZoneBudget> result = new ArrayList<>(regions.size());
        for (Region region : regions) {
            double cx = region.center.x, cz = region.center.z;
            double r2 = region.radiusM * region.radiusM;
            int count = 0;

            // Count "interesting" ZDOs from all typed lists within the region radius.
            // Note: building ZDOs are not tracked in WorldContracts (only in heatmaps).
            for (Portal            p : contracts.portals)    if (distSq(p.position.x, p.position.z, cx, cz) <= r2) count++;
            for (ContractEntity    e : contracts.entities)   if (distSq(e.position.x, e.position.z, cx, cz) <= r2) count++;
            for (ContractContainer c : contracts.containers) if (distSq(c.position.x, c.position.z, cx, cz) <= r2) count++;
            for (ContractRecord    r : contracts.records)    if (distSq(r.position.x, r.position.z, cx, cz) <= r2) count++;

            MetricsResult.ZoneBudget zb = new MetricsResult.ZoneBudget();
            zb.region_name = region.name;
            zb.center      = region.center;
            zb.radius_m    = region.radiusM;
            zb.zdo_count   = count;
            zb.limit       = region.maxZdos;
            zb.pct_used    = region.maxZdos > 0 ? (count * 100.0) / region.maxZdos : 0.0;
            zb.over_budget = count > region.maxZdos;
            result.add(zb);
        }
        return result;
    }

    private static double distSq(double ax, double az, double bx, double bz) {
        double dx = ax - bx, dz = az - bz;
        return dx * dx + dz * dz;
    }

    // ---- General ZDO density grid (from typed lists, at sectorSizeM resolution) ----

    private void buildDensity(WorldContracts contracts, StConfig cfg, MetricsResult result) {
        int cellM = cfg.sectorSizeM;
        Map<Long, Integer> grid = new HashMap<>();

        for (Portal            p : contracts.portals)    addCell(grid, p.position.x, p.position.z, cellM);
        for (ContractEntity    e : contracts.entities)   addCell(grid, e.position.x, e.position.z, cellM);
        for (ContractContainer c : contracts.containers) addCell(grid, c.position.x, c.position.z, cellM);
        for (ContractRecord    r : contracts.records)    addCell(grid, r.position.x, r.position.z, cellM);

        result.densityStats = computeStats(grid, cellM, cfg);
        result.hotspots     = computeHotspots(grid, result.densityStats, cellM);
    }

    // ---- Dropped item density (pre-computed cells from droppedItemHeatmap) ----

    private void buildDroppedDensity(WorldContracts contracts, StConfig cfg, MetricsResult result) {
        List<int[]> cells = contracts.droppedItemDensityCells;
        if (cells == null || cells.isEmpty()) {
            result.droppedDensityStats = new MetricsResult.DensityStats();
            result.droppedHotspots     = Collections.emptyList();
            return;
        }

        int cellM = contracts.droppedItemCellSizeM;
        Map<Long, Integer> grid = new HashMap<>(cells.size());
        for (int[] cell : cells) {
            long key = (long) cell[0] << 32 | (cell[1] & 0xFFFFFFFFL);
            grid.put(key, cell[2]);
        }

        result.droppedDensityStats = computeStats(grid, cellM, cfg);
        result.droppedHotspots     = computeHotspots(grid, result.droppedDensityStats, cellM);
    }

    // ---- Grid helpers ----

    private static void addCell(Map<Long, Integer> grid, double x, double z, int cellM) {
        int cx  = Math.floorDiv((int) x, cellM);
        int cz  = Math.floorDiv((int) z, cellM);
        long key = (long) cx << 32 | (cz & 0xFFFFFFFFL);
        grid.merge(key, 1, Integer::sum);
    }

    private MetricsResult.DensityStats computeStats(Map<Long, Integer> grid, int cellM, StConfig cfg) {
        MetricsResult.DensityStats stats = new MetricsResult.DensityStats();
        stats.cell_size_m = cellM;
        if (grid.isEmpty()) return stats;

        int total = 0, maxC = 0;
        for (int v : grid.values()) {
            total += v;
            if (v > maxC) maxC = v;
        }
        double mean = (double) total / grid.size();
        double sumSq = 0;
        for (int v : grid.values()) {
            double d = v - mean;
            sumSq += d * d;
        }
        double stddev = Math.sqrt(sumSq / grid.size());

        // Low-sample guard: if too few occupied cells, use fixed build-risk threshold
        double threshold = grid.size() < cfg.hotspotMinCells
            ? cfg.buildRiskZdoCount
            : mean + cfg.hotspotSigmaMultiplier * stddev;

        int hotspotCount = 0;
        for (int v : grid.values()) {
            if (v > threshold) hotspotCount++;
        }

        stats.total_cells   = grid.size();
        stats.max_count     = maxC;
        stats.mean          = mean;
        stats.stddev        = stddev;
        stats.threshold     = threshold;
        stats.hotspot_count = hotspotCount;
        return stats;
    }

    private List<MetricsResult.DensityCell> computeHotspots(
            Map<Long, Integer> grid, MetricsResult.DensityStats stats, int cellM) {

        List<MetricsResult.DensityCell> result = new ArrayList<>();
        for (Map.Entry<Long, Integer> entry : grid.entrySet()) {
            if (entry.getValue() <= stats.threshold) continue;
            long key = entry.getKey();
            int cx = (int) (key >> 32);
            int cz = (int) (key & 0xFFFFFFFFL);
            result.add(new MetricsResult.DensityCell(cx, cz, cellM, entry.getValue(), stats.mean, stats.stddev));
        }
        result.sort((a, b) -> Integer.compare(b.count, a.count));
        return result;
    }
}
