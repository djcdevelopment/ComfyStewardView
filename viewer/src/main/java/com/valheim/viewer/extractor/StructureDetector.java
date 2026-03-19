package com.valheim.viewer.extractor;

import com.valheim.viewer.config.StConfig;
import com.valheim.viewer.contract.ContractEntity;
import com.valheim.viewer.contract.Structure;
import com.valheim.viewer.contract.WorldContracts;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.*;

/**
 * Classifies Structure records (dungeon/boss-site entrances) as
 * active | likely_cleared | unknown by scanning nearby entities.
 *
 * Contract boundary rule: no ZdoFlatStore references.
 * Requires SectorBuilder to have already set sector_id on all entities.
 *
 * Algorithm:
 *   1. Build a spatial index of hostile/neutral entities keyed by sector_id.
 *   2. For each structure, scan a 5x5 sector neighbourhood (covers spawnerScanRadiusM).
 *   3. Count entities within the exact scan radius.
 *   4. Set status and confidence.
 *
 * spawner_count = estimated spawner points based on structure type.
 * spawner_active = hostile/neutral entity count found within scan radius.
 */
public class StructureDetector {

    private static final Logger log = LoggerFactory.getLogger(StructureDetector.class);

    // Estimated spawner counts by structure type (heuristic, not parsed from ZDOs)
    private static final Map<String, Integer> SPAWNER_ESTIMATES = new HashMap<>();
    static {
        SPAWNER_ESTIMATES.put("dungeon_entrance", 4);
        SPAWNER_ESTIMATES.put("cave_entrance",    3);
        SPAWNER_ESTIMATES.put("camp",             2);
        SPAWNER_ESTIMATES.put("ruin",             1);
        SPAWNER_ESTIMATES.put("boss_altar",       1);
        SPAWNER_ESTIMATES.put("unknown",          0);
    }

    // Biome affinity by prefab prefix — used to set Structure.biome
    private static final Map<String, String> BIOME_MAP = new HashMap<>();
    static {
        BIOME_MAP.put("Crypt",                  "black_forest");
        BIOME_MAP.put("SunkenCrypt",            "swamp");
        BIOME_MAP.put("FrostCaves",             "mountain");
        BIOME_MAP.put("MountainCave",           "mountain");
        BIOME_MAP.put("GoblinCamp",             "plains");
        BIOME_MAP.put("GoblinKing_BossStone",   "plains");
        BIOME_MAP.put("Mistlands_Dvergr",       "mistlands");
        BIOME_MAP.put("AshlandsGjall",          "ashlands");
        BIOME_MAP.put("Inferno",                "ashlands");
        BIOME_MAP.put("FaderAltar",             "ashlands");
        BIOME_MAP.put("BossStone_Eikthyr",      "meadows");
        BIOME_MAP.put("BossStone_TheElder",     "black_forest");
        BIOME_MAP.put("BossStone_Bonemass",     "swamp");
        BIOME_MAP.put("BossStone_Dragon",       "mountain");
        BIOME_MAP.put("BossStone_Yagluth",      "plains");
        BIOME_MAP.put("SeekerQueen_BossStone",  "mistlands");
        BIOME_MAP.put("TarPit",                 "plains");
    }

    public void classify(WorldContracts contracts, int cellSizeM) {
        long t0 = System.currentTimeMillis();
        StConfig cfg = StConfig.get();
        double radSq = (double) cfg.spawnerScanRadiusM * cfg.spawnerScanRadiusM;

        // Build spatial index of hostile/neutral entities
        // (sector_id was set by SectorBuilder)
        Map<String, List<ContractEntity>> entityGrid = new HashMap<>();
        for (ContractEntity e : contracts.entities) {
            if ("passive".equals(e.hostility)) continue;
            if (e.sector_id == null) continue;
            entityGrid.computeIfAbsent(e.sector_id, _k -> new ArrayList<>()).add(e);
        }

        int active = 0, cleared = 0, unknown = 0;

        for (Structure st : contracts.structures) {
            st.biome         = inferBiome(st.prefab);
            st.spawner_count = SPAWNER_ESTIMATES.getOrDefault(st.type, 0);

            int nearby = countNearbyEntities(
                entityGrid, (float) st.position.x, (float) st.position.z, cellSizeM, radSq);
            st.spawner_active = nearby;

            if (nearby > 0) {
                st.status     = "active";
                st.confidence = Math.min(1.0, 0.6 + nearby * 0.08);
                active++;
            } else if (st.spawner_count > 0) {
                // Has expected spawners but none found — likely cleared
                st.status     = "likely_cleared";
                st.confidence = 0.75;
                cleared++;
            } else {
                // Boss altar or unknown — no spawner expectation
                st.status     = "unknown";
                st.confidence = 0.4;
                unknown++;
            }
        }

        log.info("StructureDetector: {} structures (active={} cleared={} unknown={}) in {}ms",
            contracts.structures.size(), active, cleared, unknown,
            System.currentTimeMillis() - t0);
    }

    private int countNearbyEntities(Map<String, List<ContractEntity>> grid,
                                    float sx, float sz, int cellM, double radSq) {
        int scx = Math.floorDiv((int) sx, cellM);
        int scz = Math.floorDiv((int) sz, cellM);
        int count = 0;

        // 5x5 neighbourhood covers spawnerScanRadiusM (default 300m) with 200m cells
        for (int dx = -2; dx <= 2; dx++) {
            for (int dz = -2; dz <= 2; dz++) {
                String sid = (scx + dx) + ":" + (scz + dz);
                List<ContractEntity> nearby = grid.get(sid);
                if (nearby == null) continue;
                for (ContractEntity e : nearby) {
                    double ex = e.position.x - sx;
                    double ez = e.position.z - sz;
                    if (ex * ex + ez * ez <= radSq) count++;
                }
            }
        }
        return count;
    }

    private static String inferBiome(String prefab) {
        if (prefab == null) return null;
        for (Map.Entry<String, String> entry : BIOME_MAP.entrySet()) {
            if (prefab.startsWith(entry.getKey())) return entry.getValue();
        }
        return null;
    }
}
