package com.valheim.viewer.contract;

/**
 * Catch-all contract DTO for ZDOs that are not Portal, DroppedItem, Structure,
 * ContractEntity, or ContractContainer.
 *
 * Covers: item stands, signs, beds, tombstones, ballistas, and unrecognized ZDOs.
 * No raw ZDO fields exposed.
 *
 * classification.kind defaults to "unknown" in Phase 1;
 * set by TaxonomyClassifier in Phase 2b.
 */
public class ContractRecord {
    public String id;
    public String prefab;
    public String name;         // null if not resolved
    public Vec3   position;
    public String sector_id;   // null — Phase 3b
    public Classification classification; // kind=unknown in Phase 1
}
