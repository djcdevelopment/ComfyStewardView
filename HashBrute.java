import net.kakoen.valheim.save.decode.StableHashCode;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.stream.*;

/**
 * Brute-force resolve unknown hashes using known_strings.txt + variants
 */
public class HashBrute {
    static final int[] UNKNOWNS = {
        1411875912, -1161852777, 538325542, -494364525, -2119951934,
        -1161852776, -1986582442, -2129458801, 747145, 686545676,
        650075310, -640423049, -502993694, -62980316, 109649212,
        1792656179, 1272849455, -1195767551, 1341839349, -2053541920
    };

    public static void main(String[] args) throws Exception {
        Set<Integer> targets = new HashSet<>();
        for (int h : UNKNOWNS) targets.add(h);
        Map<Integer, String> resolved = new HashMap<>();

        // Load known_strings
        List<String> knownStrings = new ArrayList<>();
        try (var is = HashBrute.class.getResourceAsStream("/known_strings.txt");
             var br = new java.io.BufferedReader(new java.io.InputStreamReader(is, StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) {
                knownStrings.add(line.trim());
            }
        }

        // Also add a big list of Valheim prefabs from community wikis
        String[] extraPrefabs = {
            // item stands (vertical)
            "itemstand", "itemstand_thinn",
            // signs
            "sign_notext", "piece_sign02",
            // Mistlands
            "BlackMarble_floor", "BlackMarble_floor_large", "BlackMarble_2x2x1",
            "BlackMarble_Column_1", "BlackMarble_Column_3", "BlackMarble_Column_4",
            "BlackMarble_Stair", "BlackMarble_Arch", "BlackMarble_Ribs",
            "BlackMarble_Slope_1x2", "BlackMarble_floor_triangle",
            "piece_blackmarble_floor", "piece_blackmarble_floor_large",
            "piece_blackmarble_2x2x1", "piece_blackmarble_2x2x2",
            "piece_blackmarble_column_1", "piece_blackmarble_column_2",
            "piece_blackmarble_arch", "piece_blackmarble_stair",
            "piece_blackmarble_wall_1x2", "piece_blackmarble_wall_2x4",
            "piece_dvergr_pole", "piece_dvergr_beam", "piece_dvergr_beam_26",
            "piece_dvergr_cradle", "piece_dvergr_metal_wall_1",
            "piece_dvergr_shutter", "piece_dvergr_suction_tube",
            // ballista
            "Ballista", "Turret", "piece_turret", "BallListaBolt",
            "SiegeBallista", "Ballista_Ammo",
            // Ashlands
            "piece_grausten_floor", "piece_grausten_floor_large",
            "piece_grausten_floor_triangle", "piece_grausten_wall_1x2",
            "piece_grausten_wall_2x4", "piece_grausten_arch",
            "piece_grausten_stair", "piece_grausten_column",
            "piece_ashwood_floor", "piece_ashwood_wall_1",
            "AshTreeBranch", "VineAsh",
            // stone/darkwood
            "stone_floor", "stone_floor_2x2", "stone_wall_4x2",
            "stone_pillar", "stone_arch",
            "darkwood_pole", "darkwood_rafter", "darkwood_wall_half",
            "darkwood_gate", "darkwood_stair",
            // Miscellaneous new pieces
            "piece_cloth_hanging_door_double", "piece_cloth_hanging_door",
            "piece_shieldgenerator", "piece_groundtorchstone",
            "piece_groundtorch_green", "piece_groundtorch_blue",
            "piece_groundtorch_mist", "piece_ironpole",
            "piece_dvergr_lantern", "piece_dvergr_lantern_pole",
            // wards/beds
            "piece_ward", "piece_bed01", "piece_bed_valhalla",
            // crops/plants
            "Pickable_Barley", "Pickable_Flax", "Pickable_Grausten",
            "Pickable_DolmenTreasure", "Pickable_Onion",
            "Pickable_Turnip", "Pickable_Carrot",
            "Pickable_SmokePuff", "Pickable_BlackMarble",
            // creatures
            "Serpent", "Leviathan", "Seeker", "SeekerBrute", "SeekerSoldier",
            "Tick", "Gjall", "Dverger", "DvergerMage", "DvergerMageFireLarge",
            "Fader", "Fallen_Valkyrie", "BlobTar",
            "Charred_Melee", "Charred_Archer", "Charred_Mage", "Charred_Twitcher",
            "Volture", "Asksvin", "Morgen", "CrawlerMelee",
            // misc
            "Chest_ashlands", "chest_hildir", "chest_hildir1",
            "chest_hildir2", "chest_hildir3",
            "portal_wood", // might be resolved already, just double check
        };

        Set<String> allCandidates = new LinkedHashSet<>(knownStrings);
        for (String s : extraPrefabs) allCandidates.add(s);

        for (String name : allCandidates) {
            int h = StableHashCode.getStableHashCode(name);
            if (targets.contains(h)) resolved.put(h, name);
            // also try lowercase
            h = StableHashCode.getStableHashCode(name.toLowerCase());
            if (targets.contains(h) && !resolved.containsKey(h)) resolved.put(h, name.toLowerCase() + " [lowercase]");
        }

        System.out.println("=== RESOLVED HASHES ===");
        for (int u : UNKNOWNS) {
            String name = resolved.get(u);
            System.out.printf("  %d -> %s%n", u, name != null ? name : "(still unknown)");
        }
    }
}
