package com.valheim.viewer.extractor;

import com.valheim.viewer.config.StConfig;
import com.valheim.viewer.contract.*;
import com.valheim.viewer.store.ZdoFlatStore;
import com.valheim.viewer.store.ZdoFlatStore.Categories;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Instant;
import java.util.*;

// Phase 2b classifiers
// (imported locally to keep ContractBuilder the single caller)

/**
 * Translates ZdoFlatStore into typed WorldContracts.
 *
 * This is the ONLY class that reads ZdoFlatStore internals.
 * All downstream consumers (MetricsBuilder, AlertBuilder, SectorBuilder)
 * receive WorldContracts only — no ZdoFlatStore references pass this boundary.
 *
 * Phase 1: classification is null on all records.
 * Phase 2b: ContractBuilder will run TaxonomyClassifier, EntityClassifier,
 *            and ContainerClassifier to stamp classification.kind on each record.
 */
public class ContractBuilder {

    private static final Logger log = LoggerFactory.getLogger(ContractBuilder.class);

    public WorldContracts build(ZdoFlatStore s) {
        long t0 = System.currentTimeMillis();

        List<Portal>            portals    = buildPortals(s);
        List<DroppedItem>       dropped    = buildDroppedItems(s);
        List<ContractEntity>    entities   = buildEntities(s);
        List<ContractContainer> containers = buildContainers(s);
        List<ContractRecord>    records    = buildRecords(s);
        List<Structure>         structures = buildStructures(s);
        WorldSummary            summary    = buildSummary(s, portals, dropped);

        // Phase 2b: stamp classification on all typed lists
        new EntityClassifier().classify(entities);
        new ContainerClassifier().classify(containers);
        TaxonomyClassifier tc = new TaxonomyClassifier();
        tc.classify(dropped);
        summary.stats.economy.unknown_types = tc.countUnknownEconomyItems(s.chestItemTotals.keySet());

        log.info("ContractBuilder: {} portals, {} dropped, {} entities, {} containers, {} records in {}ms",
            portals.size(), dropped.size(), entities.size(), containers.size(), records.size(),
            System.currentTimeMillis() - t0);

        return new WorldContracts(summary, portals, dropped, entities, containers, records, structures,
            s.droppedItemHeatmap.getCells(), s.droppedItemHeatmap.cellSize);
    }

    // ---- Portals ----

    private List<Portal> buildPortals(ZdoFlatStore s) {
        Map<Integer, Integer> pairs    = s.buildPortalPairMap();
        Map<String, Integer>  tagCount = new HashMap<>();

        for (int idx : s.portalIndices) {
            String tag = s.label1[idx];
            if (tag != null && !tag.isEmpty()) tagCount.merge(tag, 1, Integer::sum);
        }

        List<Portal> result = new ArrayList<>(s.portalIndices.size());
        for (int idx : s.portalIndices) {
            float x = s.posX[idx], z = s.posZ[idx];
            if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000) continue;

            String tag     = s.label1[idx];
            boolean hasTag = tag != null && !tag.isEmpty();

            Portal p = new Portal();
            p.id         = String.valueOf(idx);
            p.tag        = hasTag ? tag : null;
            p.position   = new Vec3(x, s.posY[idx], z);
            p.confidence = 1.0;

            Integer pairedIdx = pairs.get(idx);
            p.paired      = pairedIdx != null && pairedIdx >= 0;
            p.paired_with = p.paired ? String.valueOf(pairedIdx) : null;

            // Issues
            if (!hasTag)    p.issues.add("blank_tag");
            if (!p.paired && hasTag) p.issues.add("orphaned");
            if (hasTag && tagCount.getOrDefault(tag, 1) > 2) p.issues.add("duplicate_tag");
            if (p.paired && tagCount.getOrDefault(tag, 1) >= 3) p.issues.add("cluster_hub");

            // Nullable future fields — explicitly null
            p.biome                         = null;
            p.distance_to_nearest_structure = null;
            p.created_at                    = null;
            p.last_seen_at                  = null;
            p.sector_id                     = null;
            p.classification                = null; // Phase 2b

            result.add(p);
        }
        return result;
    }

    // ---- Dropped items ----

    private List<DroppedItem> buildDroppedItems(ZdoFlatStore s) {
        List<DroppedItem> result = new ArrayList<>();
        for (int i = 0; i < s.size(); i++) {
            if (s.category[i] != Categories.DROPPED_ITEM) continue;
            float x = s.posX[i], z = s.posZ[i];
            if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000) continue;

            DroppedItem d = new DroppedItem();
            d.id             = String.valueOf(i);
            d.prefab         = s.nameForHash(s.prefabId[i]);
            d.name           = s.label1[i];
            d.position       = new Vec3(x, s.posY[i], z);
            d.stack          = Math.max(0, s.stackOrCount[i]);
            d.sector_id      = null; // Phase 3b
            d.taxonomy       = null; // Phase 2b
            d.classification = null; // Phase 2b
            result.add(d);
        }
        return result;
    }

    // ---- Entities (creatures) ----

    private List<ContractEntity> buildEntities(ZdoFlatStore s) {
        List<ContractEntity> result = new ArrayList<>(s.creatureIndices.size());
        for (int idx : s.creatureIndices) {
            float x = s.posX[idx], z = s.posZ[idx];
            if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000) continue;

            ContractEntity e = new ContractEntity();
            e.id             = String.valueOf(idx);
            e.prefab         = s.nameForHash(s.prefabId[idx]);
            e.name           = s.label1[idx];
            e.position       = new Vec3(x, s.posY[idx], z);
            e.entity_type    = "unknown"; // Phase 2b
            e.hostility      = "unknown"; // Phase 2b
            e.biome_affinity = null;      // Phase 2b
            e.sector_id      = null;      // Phase 3b
            e.source         = null;      // Phase 2b
            e.confidence     = 0.0;       // Phase 2b
            e.classification = null;      // Phase 2b
            result.add(e);
        }
        return result;
    }

    // ---- Containers ----

    private List<ContractContainer> buildContainers(ZdoFlatStore s) {
        List<ContractContainer> result = new ArrayList<>(s.containerIndices.size());
        for (int idx : s.containerIndices) {
            float x = s.posX[idx], z = s.posZ[idx];
            if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000) continue;

            ContractContainer c = new ContractContainer();
            c.id             = String.valueOf(idx);
            c.prefab         = s.nameForHash(s.prefabId[idx]);
            c.name           = c.prefab;
            c.position       = new Vec3(x, s.posY[idx], z);
            c.sector_id      = null; // Phase 3b
            // classification.kind=container, container_type=unknown (Phase 2b will refine)
            c.classification = Classification.container("unknown");
            result.add(c);
        }
        return result;
    }

    // ---- Catch-all records (item stands, signs, beds, tombstones, ballistas, unknowns) ----

    private List<ContractRecord> buildRecords(ZdoFlatStore s) {
        List<ContractRecord> result = new ArrayList<>(
            s.itemStandIndices.size() + s.signIndices.size() +
            s.bedIndices.size() + s.tombstoneIndices.size()
        );

        addRecords(result, s, s.itemStandIndices, "item_stand");
        addRecords(result, s, s.signIndices,       "sign");
        addRecords(result, s, s.bedIndices,        "bed");
        addRecords(result, s, s.tombstoneIndices,  "tombstone");

        // BALLISTA category ZDOs (no dedicated index list — iterate flat store)
        for (int i = 0; i < s.size(); i++) {
            if (s.category[i] != Categories.BALLISTA) continue;
            float x = s.posX[i], z = s.posZ[i];
            if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000) continue;
            result.add(makeRecord(s, i, "ballista"));
        }

        // UNKNOWN-category ZDOs
        for (int i = 0; i < s.size(); i++) {
            if (s.category[i] != Categories.UNKNOWN) continue;
            float x = s.posX[i], z = s.posZ[i];
            if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000) continue;
            result.add(makeRecord(s, i, "unknown"));
        }

        return result;
    }

    private void addRecords(List<ContractRecord> result, ZdoFlatStore s, List<Integer> indices, String kind) {
        for (int idx : indices) {
            float x = s.posX[idx], z = s.posZ[idx];
            if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000) continue;
            result.add(makeRecord(s, idx, kind));
        }
    }

    private ContractRecord makeRecord(ZdoFlatStore s, int idx, String kind) {
        ContractRecord r = new ContractRecord();
        r.id             = String.valueOf(idx);
        r.prefab         = s.nameForHash(s.prefabId[idx]);
        r.name           = s.label1[idx];
        r.position       = new Vec3(s.posX[idx], s.posY[idx], s.posZ[idx]);
        r.sector_id      = null; // Phase 3b
        r.classification = Classification.of(kind);
        return r;
    }

    // ---- Structures (Phase 4) ----

    private List<Structure> buildStructures(ZdoFlatStore s) {
        List<Structure> result = new ArrayList<>(s.structureIndices.size());
        for (int idx : s.structureIndices) {
            float x = s.posX[idx], z = s.posZ[idx];
            if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000) continue;

            Structure st = new Structure();
            st.id             = String.valueOf(idx);
            st.prefab         = s.nameForHash(s.prefabId[idx]);
            st.position       = new Vec3(x, s.posY[idx], z);
            st.type           = inferStructureType(st.prefab);
            st.biome          = null;  // set by StructureDetector
            st.sector_id      = null;  // set by SectorBuilder
            st.instance_id    = null;
            st.status         = "unknown";
            st.spawner_count  = 0;
            st.spawner_active = 0;
            st.classification = Classification.of("structure");
            st.confidence     = 0.0;
            st.notes          = null;
            result.add(st);
        }
        return result;
    }

    private static String inferStructureType(String prefab) {
        if (prefab == null || prefab.startsWith("hash:")) return "unknown";
        String lower = prefab.toLowerCase();

        // 1. Dungeons (Primary targets)
        if (lower.contains("sunkencrypt"))                      return "sunken_crypt";
        if (lower.contains("burialchamber") || lower.contains("crypt")) 
                                                                return "burial_chamber";
        if (lower.contains("trollcave"))                        return "troll_cave";
        if (lower.contains("frostcave") || lower.contains("mountaincave") ||
            (lower.contains("cave") && !lower.contains("troll"))) 
                                                                return "frost_cave";

        // 2. Points of Interest
        if (lower.contains("haldor") || lower.contains("hildir") || 
            lower.contains("vendor"))                          return "vendor";
        if (lower.contains("draugr") || lower.contains("woodvillage"))
                                                                return "draugr_village";
        if (lower.contains("dvergrtown") || lower.contains("dvergr"))
                                                                return "dvergr_village";
        if (lower.contains("goblincamp") || lower.contains("fuling"))
                                                                return "fuling_village";
        if (lower.contains("drakenest"))                       return "drake_nest";
        
        // 3. Boss Altars and Ruins
        if (lower.contains("bossstone") || lower.contains("altar") ||
            lower.contains("fader"))                           return "boss_altar";
        if (lower.contains("tarpit"))                          return "ruin";
        if (lower.contains("inferno") || lower.contains("niddavalir"))
                                                                return "ashlands_ruin";

        return "unknown";
    }

    // ---- Summary ----

    private WorldSummary buildSummary(ZdoFlatStore s,
                                      List<Portal> portals,
                                      List<DroppedItem> dropped) {
        WorldSummary ws = new WorldSummary();
        ws.world_name        = null;
        ws.world_version     = s.worldVersion;
        ws.parse_duration_ms = s.parseDurationMs;
        ws.zdo_total         = s.allHeatmap.getTotalCount();
        ws.zdo_interesting   = s.size();
        ws.config_loaded     = StConfig.isConfigFileFound();
        ws.regions_loaded    = false; // Phase 2a

        // Portal stats
        int orphaned = 0, blank = 0, dupTag = 0;
        for (Portal p : portals) {
            if (p.issues.contains("orphaned"))      orphaned++;
            if (p.issues.contains("blank_tag"))     blank++;
            if (p.issues.contains("duplicate_tag")) dupTag++;
        }
        ws.stats.portals.total    = portals.size();
        ws.stats.portals.paired   = (int) portals.stream().filter(p -> p.paired).count();
        ws.stats.portals.orphaned = orphaned;
        ws.stats.portals.blank_tag = blank;
        ws.stats.portals.clusters = 0; // Phase 2a

        // Player stats
        ws.stats.players.total = s.players.size();

        // Dropped stats
        // Note: individual dropped item ZDOs are not stored in the flat arrays (only counted).
        // droppedItems list is always empty in Phase 1; positions added in a future phase.
        int namedDropped = 0;
        int totalDropped = 0;
        for (Map.Entry<Integer, Integer> e : s.droppedItemCounts.entrySet()) {
            totalDropped += e.getValue();
            String name = s.nameForHash(e.getKey());
            if (!name.startsWith("hash:")) namedDropped++;
        }
        ws.stats.dropped.total         = totalDropped;
        ws.stats.dropped.unique_types  = s.droppedItemCounts.size();
        ws.stats.dropped.named_types   = namedDropped;
        ws.stats.dropped.unknown_types = s.droppedItemCounts.size() - namedDropped;

        // Economy stats
        long totalItems = s.chestItemTotals.values().stream().mapToLong(Long::longValue).sum();
        ws.stats.economy.unique_items  = s.chestItemTotals.size();
        ws.stats.economy.total_items   = totalItems;
        ws.stats.economy.unknown_types = 0; // Phase 2b
        ws.stats.economy.skipped_v106  = 0; // exposed if WorldParser tracks this

        // Structure stats (Phase 4)
        ws.stats.structures.total          = 0;
        ws.stats.structures.likely_cleared = 0;
        ws.stats.structures.active         = 0;
        ws.stats.structures.unknown        = 0;

        // Sector stats (Phase 3b)
        ws.stats.sectors.total_occupied  = 0;
        ws.stats.sectors.high_density    = 0;
        ws.stats.sectors.sector_size_m   = StConfig.get().sectorSizeM;

        // Alert stats (Phase 3a)
        ws.stats.alerts.critical = 0;
        ws.stats.alerts.high     = 0;
        ws.stats.alerts.medium   = 0;
        ws.stats.alerts.low      = 0;

        // Top prefabs global — count from flat store (category null in Phase 1)
        ws.top_prefabs_global = buildTopPrefabs(s);

        return ws;
    }

    private List<WorldSummary.PrefabCount> buildTopPrefabs(ZdoFlatStore s) {
        Map<Integer, Integer> counts = new HashMap<>();
        for (int i = 0; i < s.size(); i++) {
            counts.merge(s.prefabId[i], 1, Integer::sum);
        }

        int topN = StConfig.get().topPrefabsGlobalN;
        List<Map.Entry<Integer, Integer>> sorted = new ArrayList<>(counts.entrySet());
        sorted.sort((a, b) -> b.getValue() - a.getValue());

        List<WorldSummary.PrefabCount> result = new ArrayList<>(topN);
        for (int i = 0; i < Math.min(topN, sorted.size()); i++) {
            Map.Entry<Integer, Integer> e = sorted.get(i);
            String resolved = s.nameForHash(e.getKey());
            boolean known   = !resolved.startsWith("hash:");
            // prefab = resolved name if known, else "hash:N"; name = resolved if known, else null
            result.add(new WorldSummary.PrefabCount(resolved, known ? resolved : null, e.getValue()));
        }
        return result;
    }
}
