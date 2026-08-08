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

    // Names verified against the prefab dictionary (comfy-prefab-dump/v1, game 0.221.12).
    // Removed piece_chest_trailer, Longship, Sailraftr and piece_chest_cart — none of them are
    // prefabs in any Valheim build, so they could never match a resolved name.
    private static final Set<String> CHEST_PREFABS = new HashSet<>(Arrays.asList(
        "piece_chest_wood",
        "piece_chest",
        "piece_chest_blackmetal",
        "piece_chest_private",
        "piece_chest_barrel",
        "piece_chest_treasure",
        "loot_chest_wood",
        "loot_chest_stone",
        "stonechest",
        "crypt_skeleton_chest",
        "shipwreck_karve_chest",
        "chest_hildir1", "chest_hildir2", "chest_hildir3"
    ));

    private static final Set<String> SHIP_PREFABS = new HashSet<>(Arrays.asList(
        "VikingShip",
        "VikingShip_Ashlands",
        "Karve",
        "Raft"
    ));

    private static final Set<String> CART_PREFABS = new HashSet<>(Arrays.asList(
        "Cart"
    ));

    /** World-generated loot chests: 22 TreasureChest_* variants, matched by prefix. */
    private static final String TREASURE_CHEST_PREFIX = "TreasureChest_";

    public void classify(List<ContractContainer> containers) {
        for (ContractContainer c : containers) {
            c.classification = Classification.container(resolveType(c.prefab));
        }
    }

    private String resolveType(String prefab) {
        if (prefab == null) return "unknown";

        if (CHEST_PREFABS.contains(prefab))            return "chest";
        if (SHIP_PREFABS.contains(prefab))             return "ship";
        if (CART_PREFABS.contains(prefab))             return "cart";
        if (prefab.startsWith(TREASURE_CHEST_PREFIX))  return "chest";

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
