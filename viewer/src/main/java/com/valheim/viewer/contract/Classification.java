package com.valheim.viewer.contract;

/**
 * Lightweight classification stamp computed once in ContractBuilder (Phase 2b).
 * Null on all records in Phase 1.
 *
 * kind values: structure | dropped_item | creature | container | other | unknown
 * container_type: chest | ship | wagon | unknown (only meaningful when kind=container)
 */
public class Classification {
    public String kind;
    public String container_type;

    public Classification() {}

    public static Classification of(String kind) {
        Classification c = new Classification();
        c.kind = kind;
        return c;
    }

    public static Classification container(String containerType) {
        Classification c = new Classification();
        c.kind = "container";
        c.container_type = containerType;
        return c;
    }
}
