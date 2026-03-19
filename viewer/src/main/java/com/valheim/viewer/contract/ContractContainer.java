package com.valheim.viewer.contract;

/**
 * Contract DTO for a container ZDO (chest, ship, wagon).
 * classification.container_type is "unknown" in Phase 1;
 * properly set by ContainerClassifier in Phase 2b.
 */
public class ContractContainer {
    public String id;
    public String prefab;
    public String name;
    public Vec3   position;
    public String sector_id;          // null — Phase 3b
    public Classification classification; // kind=container, container_type=unknown in Phase 1
}
