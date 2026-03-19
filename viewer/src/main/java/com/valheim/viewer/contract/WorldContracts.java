package com.valheim.viewer.contract;

import java.util.Collections;
import java.util.List;

/**
 * Typed container produced by ContractBuilder from ZdoFlatStore.
 *
 * This is the ONLY object MetricsBuilder and SectorBuilder accept.
 * No ZdoFlatStore references or raw ZDO fields cross this boundary.
 */
public class WorldContracts {

    public final WorldSummary          summary;
    public final List<Portal>          portals;
    public final List<DroppedItem>     droppedItems;
    public final List<ContractEntity>  entities;
    public final List<ContractContainer> containers;
    public final List<ContractRecord>  records;     // catch-all: item stands, signs, beds, tombstones, etc.
    public final List<Structure>       structures;  // empty in Phase 1; populated in Phase 4

    /**
     * Pre-computed dropped item density cells from ZdoFlatStore.droppedItemHeatmap.getCells().
     * Each int[] is [cx, cz, count]. Cell size is droppedItemCellSizeM.
     * Populated by ContractBuilder so MetricsBuilder can compute dropped hotspots
     * without needing a ZdoFlatStore reference.
     */
    public final List<int[]> droppedItemDensityCells;
    public final int         droppedItemCellSizeM;

    public WorldContracts(
            WorldSummary          summary,
            List<Portal>          portals,
            List<DroppedItem>     droppedItems,
            List<ContractEntity>  entities,
            List<ContractContainer> containers,
            List<ContractRecord>  records,
            List<Structure>       structures) {
        this(summary, portals, droppedItems, entities, containers, records, structures,
             Collections.emptyList(), 500);
    }

    public WorldContracts(
            WorldSummary          summary,
            List<Portal>          portals,
            List<DroppedItem>     droppedItems,
            List<ContractEntity>  entities,
            List<ContractContainer> containers,
            List<ContractRecord>  records,
            List<Structure>       structures,
            List<int[]>           droppedItemDensityCells,
            int                   droppedItemCellSizeM) {
        this.summary                 = summary;
        this.portals                 = portals;
        this.droppedItems            = droppedItems;
        this.entities                = entities;
        this.containers              = containers;
        this.records                 = records;
        this.structures              = structures;
        this.droppedItemDensityCells = droppedItemDensityCells;
        this.droppedItemCellSizeM    = droppedItemCellSizeM;
    }
}
