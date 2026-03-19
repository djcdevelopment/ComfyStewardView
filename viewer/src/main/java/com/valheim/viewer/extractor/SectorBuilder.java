package com.valheim.viewer.extractor;

import com.valheim.viewer.config.StConfig;
import com.valheim.viewer.contract.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.*;

/**
 * Divides the world into a uniform grid of cell_size_m x cell_size_m cells,
 * assigns a sector_id to every contract record, and computes per-sector counts.
 *
 * Contract boundary rule: no ZdoFlatStore references.
 * Input: WorldContracts (mutated -- sector_id is back-filled on all records) + MetricsResult.
 *
 * Density classification:
 *   "hotspot" -- cell appeared in MetricsResult.hotspots
 *   "high"    -- total >= StConfig.highDensitySectorZdoCount
 *   "normal"  -- everything else
 *
 * Output is sorted descending by total ZDO count.
 */
public class SectorBuilder {

    private static final Logger log = LoggerFactory.getLogger(SectorBuilder.class);

    public SectorResult build(WorldContracts contracts, MetricsResult metrics) {
        long t0 = System.currentTimeMillis();
        StConfig cfg = StConfig.get();
        int cellM = cfg.sectorSizeM;

        // Build hotspot cell lookup from MetricsResult
        Set<Long> hotspotKeys = new HashSet<>(metrics.hotspots.size() * 2);
        for (MetricsResult.DensityCell cell : metrics.hotspots) {
            hotspotKeys.add(encodeKey(cell.cx, cell.cz));
        }

        // Walk all contract lists, create/update sectors, back-fill sector_id
        Map<Long, Sector> sectorMap = new LinkedHashMap<>();

        for (Portal p : contracts.portals) {
            Sector s = getOrCreate(sectorMap, p.position.x, p.position.z, cellM);
            p.sector_id = s.id;
            s.portals++;
            s.total++;
        }

        for (ContractEntity e : contracts.entities) {
            Sector s = getOrCreate(sectorMap, e.position.x, e.position.z, cellM);
            e.sector_id = s.id;
            s.entities++;
            s.total++;
        }

        for (ContractContainer c : contracts.containers) {
            Sector s = getOrCreate(sectorMap, c.position.x, c.position.z, cellM);
            c.sector_id = s.id;
            s.containers++;
            s.total++;
        }

        for (ContractRecord r : contracts.records) {
            Sector s = getOrCreate(sectorMap, r.position.x, r.position.z, cellM);
            r.sector_id = s.id;
            s.records++;
            s.total++;
        }

        for (com.valheim.viewer.contract.Structure st : contracts.structures) {
            Sector s = getOrCreate(sectorMap, st.position.x, st.position.z, cellM);
            st.sector_id = s.id;
            s.structures++;
            s.total++;
        }

        // DroppedItem list is empty in this phase (positions not stored);
        // no sector_id assignment needed.

        // Classify density and collect results
        int highThreshold = cfg.highDensitySectorZdoCount;
        List<Sector> sectors = new ArrayList<>(sectorMap.size());
        for (Map.Entry<Long, Sector> entry : sectorMap.entrySet()) {
            Sector s = entry.getValue();
            if (hotspotKeys.contains(entry.getKey())) {
                s.density = "hotspot";
            } else if (s.total >= highThreshold) {
                s.density = "high";
            } else {
                s.density = "normal";
            }
            sectors.add(s);
        }

        // Sort descending by total ZDO count
        sectors.sort((a, b) -> b.total - a.total);

        SectorResult result = new SectorResult();
        result.sectors      = sectors;
        result.cell_size_m  = cellM;
        result.total_occupied = sectors.size();
        for (Sector s : sectors) {
            if ("hotspot".equals(s.density)) { result.hotspot_count++; result.high_density++; }
            else if ("high".equals(s.density)) result.high_density++;
        }

        log.info("SectorBuilder: {} occupied sectors, {} high-density, {} hotspots in {}ms",
            result.total_occupied, result.high_density, result.hotspot_count,
            System.currentTimeMillis() - t0);

        return result;
    }

    // ---- Helpers ----

    private Sector getOrCreate(Map<Long, Sector> map, double x, double z, int cellM) {
        int  cx  = Math.floorDiv((int) x, cellM);
        int  cz  = Math.floorDiv((int) z, cellM);
        long key = encodeKey(cx, cz);
        return map.computeIfAbsent(key, _k -> {
            Sector s      = new Sector();
            s.id          = cx + ":" + cz;
            s.cx          = cx;
            s.cz          = cz;
            s.world_x     = cx * (double) cellM + cellM / 2.0;
            s.world_z     = cz * (double) cellM + cellM / 2.0;
            s.cell_size_m = cellM;
            return s;
        });
    }

    /** Same key encoding as MetricsBuilder so hotspot lookups align. */
    private static long encodeKey(int cx, int cz) {
        return (long) cx << 32 | (cz & 0xFFFFFFFFL);
    }
}
