import net.kakoen.valheim.save.decode.StableHashCode;
import java.util.*;

/**
 * Compute hashes for candidate prefab names to match unknowns.
 */
public class HashGuess {
    // Known top unknown hashes from our scan
    static final int[] UNKNOWNS = {
        1411875912, -1161852777, 538325542, -494364525, -2119951934,
        -1161852776, -1986582442, -2129458801, 747145, 686545676,
        650075310, -640423049, -502993694, -62980316, 109649212,
        1792656179, 1272849455, -1195767551, 1341839349, -2053541920
    };

    // Candidate prefab names from Valheim (common ones not in known_strings)
    static final String[] CANDIDATES = {
        // item stands
        "itemstand", "piece_itemstand", "piece_itemstand_thinn",
        // signs
        "sign_notext", "piece_sign02", "piece_sign", "RuneStone_Eikthyr",
        // Mistlands
        "piece_blackmarble_floor", "piece_blackmarble_floor_large",
        "piece_blackmarble_2x2x1", "piece_blackmarble_2x2x2",
        "piece_blackmarble_column_1", "piece_blackmarble_slope_1",
        "piece_blackmarble_stair", "piece_blackmarble_wall_1x2",
        "piece_blackmarble_arch", "piece_blackmarble_altar_crystal",
        "BlackMarble_floor", "BlackMarble_floor_large",
        "BlackMarble_2x2x1", "BlackMarble_Column_1",
        // Mistlands structures
        "piece_dvergr_cradle", "piece_dvergr_metal_wall_1", "piece_dvergr_shutter",
        // Plains
        "piece_stonecutter", "piece_artisanstation",
        // ballista
        "Ballista", "Ballista_MarketItem", "Ballista",
        "piece_ballista", "piece_ballista_base",
        // crafted items (have crafterName)
        "ArrowWood", "ArrowFire", "ArrowPoison", "ArrowSilver",
        "SwordBronze", "SwordIron", "SwordBlackmetal",
        "AtgeirBronze", "AtgeirIron", "AtgeirBlackmetal",
        "SpearBronze", "SpearElderbark",
        // sap / mead
        "SapCollector", "piece_sapcollector",
        "MeadPoisonResist", "MeadBasePoisonResistance",
        "ItemDrop", // dropped items
        // item stand related
        "piece_item_stand", "piece_item_stand_horizontal",
        // walls/floors
        "stone_floor", "stone_floor_2x2",
        "darkwood_pole", "darkwood_rafter",
        "dvergr_wood_pole", "dvergr_wood_rafter", "dvergr_wood_wall_1",
        // misc
        "piece_banner01", "piece_banner02", "piece_banner03",
        "piece_banner04", "piece_banner05",
        "piece_table_oak", "piece_chair", "piece_chair02",
        "piece_chair03", "piece_throne01",
        "piece_brazierceiling01", "piece_walltorch", "piece_groundtorch_wood",
        "piece_walltorch_iron", "piece_brazier",
        "PickableItem", "Pickable_Item",
        "Raspberry", "Blueberries",
        "TurretBolt", "piece_turretbow", "turretbow", "Ballista_Turret",
        "turret", "piece_turret", "Turret",
        // newer content
        "piece_dvergr_pole", "piece_dvergr_beam",
        "piece_dvergr_wood_door", "piece_dvergr_wood_wall",
        "piece_clay_floor", "piece_clay_wall", "clay_wall",
        "piece_thatch_base", "piece_log_floor",
    };

    public static void main(String[] args) {
        Set<Integer> unknownSet = new HashSet<>();
        for (int h : UNKNOWNS) unknownSet.add(h);

        System.out.println("=== HASH MATCHES ===");
        Map<Integer, String> found = new HashMap<>();
        for (String name : CANDIDATES) {
            int hash = StableHashCode.getStableHashCode(name);
            if (unknownSet.contains(hash)) {
                found.put(hash, name);
                System.out.printf("  %d -> '%s'%n", hash, name);
            }
        }

        System.out.println("\n=== UNRESOLVED ===");
        for (int h : UNKNOWNS) {
            if (!found.containsKey(h)) {
                System.out.println("  " + h + " (still unknown)");
            }
        }
    }
}
