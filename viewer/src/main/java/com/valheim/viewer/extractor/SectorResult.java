package com.valheim.viewer.extractor;

import com.valheim.viewer.contract.Sector;

import java.util.List;

/**
 * Output of SectorBuilder.build().
 * Plain serializable POJO -- no ZdoFlatStore or WorldContracts references.
 *
 * Consumed by ApiServer (/api/v1/sectors) and used to back-fill
 * WorldSummary.stats.sectors.
 */
public class SectorResult {

    public List<Sector> sectors;

    public int total_occupied;  // number of occupied sectors
    public int high_density;    // sectors classified "high" or "hotspot"
    public int hotspot_count;   // sectors classified "hotspot"
    public int cell_size_m;
}
