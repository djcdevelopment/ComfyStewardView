package com.valheim.viewer.extractor;

import com.valheim.viewer.contract.Classification;
import com.valheim.viewer.contract.ContractContainer;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Refines ContractContainer.classification.container_type from "unknown" to
 * chest | cart | ship | ward | unknown.
 *
 * Keyed on the resolved prefab name from nameForHash (registered in WorldParser).
 * Containers whose hash is unresolved ("hash:N") remain "unknown".
 */
public class ContainerClassifier {

    private static final Set<String> CHEST_PREFABS = new HashSet<>(Arrays.asList(
        "piece_chest_wood",
        "piece_chest",
        "piece_chest_blackmetal",
        "piece_chest_private",
        "piece_chest_trailer",    // Hearth & Home cart companion chest (if present)
        "loot_chest_wood",
        "loot_chest_stone"
    ));

    private static final Set<String> SHIP_PREFABS = new HashSet<>(Arrays.asList(
        "VikingShip",
        "Karve",
        "Raft",
        "Longship",
        "Sailraftr"               // Raft variant
    ));

    private static final Set<String> CART_PREFABS = new HashSet<>(Arrays.asList(
        "Cart",
        "piece_chest_cart"        // Cart storage container ZDO
    ));

    public void classify(List<ContractContainer> containers) {
        for (ContractContainer c : containers) {
            c.classification = Classification.container(resolveType(c.prefab));
        }
    }

    private String resolveType(String prefab) {
        if (prefab == null) return "unknown";

        if (CHEST_PREFABS.contains(prefab)) return "chest";
        if (SHIP_PREFABS.contains(prefab))  return "ship";
        if (CART_PREFABS.contains(prefab))  return "cart";

        // Unresolved hash — no name registered
        if (prefab.startsWith("hash:")) return "unknown";

        // Fallback: classify by name patterns for modded containers
        String lower = prefab.toLowerCase();
        if (lower.contains("ship") || lower.contains("karve") || lower.contains("raft"))  return "ship";
        if (lower.contains("cart") || lower.contains("wagon"))                            return "cart";
        if (lower.contains("chest") || lower.contains("crate") || lower.contains("box")) return "chest";

        return "chest"; // most containers are chests
    }
}
