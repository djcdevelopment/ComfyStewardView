package com.valheim.viewer.extractor;

import com.valheim.viewer.contract.Classification;
import com.valheim.viewer.contract.ContractEntity;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Stamps entity_type, hostility, biome_affinity, source, confidence, and
 * classification on ContractEntity records.
 *
 * Lookup is keyed on prefab name (the resolved string from nameForHash).
 * Unknown prefabs (mod creatures) get source="mod", confidence=0.5.
 */
public class EntityClassifier {

    private static final class Info {
        final String type, hostility, biome;
        Info(String t, String h, String b) { type = t; hostility = h; biome = b; }
    }

    private static final Map<String, Info> TABLE = new HashMap<>(128);

    static {
        // Meadows
        add("Seagal",          "animal",   "passive",  "meadows");
        add("Deer",            "animal",   "passive",  "meadows");
        add("Boar",            "animal",   "neutral",  "meadows");
        add("Neck",            "monster",  "hostile",  "meadows");
        add("Greyling",        "monster",  "hostile",  "meadows");
        add("Hens",            "animal",   "passive",  "meadows");
        add("Hen",             "animal",   "passive",  "meadows");
        add("Chicken",         "animal",   "passive",  "meadows");
        add("Rooster",         "animal",   "passive",  "meadows");

        // Black Forest
        add("Greydwarf",       "monster",  "hostile",  "black_forest");
        add("Greydwarf_elite", "monster",  "hostile",  "black_forest");
        add("Greydwarf_shaman","monster",  "hostile",  "black_forest");
        add("Troll",           "monster",  "hostile",  "black_forest");
        add("Skeleton",        "monster",  "hostile",  "black_forest");
        add("Ghost",           "monster",  "hostile",  "black_forest");

        // Swamp
        add("Leech",           "monster",  "hostile",  "swamp");
        add("Draugr",          "monster",  "hostile",  "swamp");
        add("Draugr_Elite",    "monster",  "hostile",  "swamp");
        add("Blob",            "monster",  "hostile",  "swamp");
        add("BlobElite",       "monster",  "hostile",  "swamp");
        add("Wraith",          "monster",  "hostile",  "swamp");
        add("Surtling",        "monster",  "hostile",  "swamp");
        add("Abomination",     "monster",  "hostile",  "swamp");
        add("Growth",          "monster",  "hostile",  "swamp");

        // Mountain
        add("Wolf",            "monster",  "hostile",  "mountain");
        add("Wolf_cub",        "animal",   "passive",  "mountain");
        add("Drake",           "monster",  "hostile",  "mountain");
        add("StoneGolem",      "monster",  "hostile",  "mountain");
        add("Bat",             "monster",  "hostile",  "mountain");
        add("Fenring",         "monster",  "hostile",  "mountain");
        add("Fenring_Cultist", "monster",  "hostile",  "mountain");
        add("Ulv",             "monster",  "hostile",  "mountain");

        // Plains
        add("Goblin",          "monster",  "hostile",  "plains");
        add("GoblinArcher",    "monster",  "hostile",  "plains");
        add("GoblinBrute",     "monster",  "hostile",  "plains");
        add("GoblinShaman",    "monster",  "hostile",  "plains");
        add("GoblinKing",      "boss",     "hostile",  "plains");
        add("Deathsquito",     "monster",  "hostile",  "plains");
        add("Lox",             "animal",   "neutral",  "plains");

        // Ocean
        add("Serpent",         "monster",  "hostile",  "ocean");

        // Mistlands
        add("Seeker",          "monster",  "hostile",  "mistlands");
        add("SeekerBrute",     "monster",  "hostile",  "mistlands");
        add("SeekerQueen",     "boss",     "hostile",  "mistlands");
        add("Tick",            "monster",  "hostile",  "mistlands");
        add("Gjall",           "monster",  "hostile",  "mistlands");
        add("Hare",            "animal",   "passive",  "mistlands");
        add("Dverger",         "npc",      "neutral",  "mistlands");
        add("DvergerArbalest", "npc",      "neutral",  "mistlands");
        add("DvergerMage",     "npc",      "neutral",  "mistlands");
        add("DvergerMageFire", "npc",      "neutral",  "mistlands");
        add("DvergerMageIce",  "npc",      "neutral",  "mistlands");
        add("DvergerMageSup",  "npc",      "neutral",  "mistlands");
        add("DvergerRogue",    "npc",      "neutral",  "mistlands");

        // Ashlands
        add("Charred",         "monster",  "hostile",  "ashlands");
        add("CharredArcher",   "monster",  "hostile",  "ashlands");
        add("CharredMage",     "monster",  "hostile",  "ashlands");
        add("CharredTwitcher", "monster",  "hostile",  "ashlands");
        add("CharredWarrior",  "monster",  "hostile",  "ashlands");
        add("FaderMinion",     "monster",  "hostile",  "ashlands");
        add("MorgenBrute",     "monster",  "hostile",  "ashlands");
        add("Morgen",          "monster",  "hostile",  "ashlands");
        add("Asksvin",         "monster",  "hostile",  "ashlands");
        add("Fader",           "boss",     "hostile",  "ashlands");
        add("Fallen",          "monster",  "hostile",  "ashlands");
        add("FallenValkyrie",  "monster",  "hostile",  "ashlands");
        add("Vulture",         "monster",  "hostile",  "ashlands");
        add("Cinder",          "monster",  "hostile",  "ashlands");

        // Deep North
        add("Ulvarg",          "monster",  "hostile",  "deep_north");
        add("BearCub",         "animal",   "passive",  "deep_north");

        // Bosses (all biomes)
        add("Eikthyr",         "boss",     "hostile",  "meadows");
        add("gd_king",         "boss",     "hostile",  "black_forest");
        add("Bonemass",        "boss",     "hostile",  "swamp");
        add("Dragon",          "boss",     "hostile",  "mountain");

        // NPCs / ambient
        add("Hildir",          "npc",      "passive",  "all");
        add("Haldor",          "npc",      "passive",  "all");
        add("Crow",            "animal",   "passive",  "all");
        add("Bird",            "animal",   "passive",  "all");
    }

    private static void add(String prefab, String type, String hostility, String biome) {
        TABLE.put(prefab, new Info(type, hostility, biome));
    }

    public void classify(List<ContractEntity> entities) {
        for (ContractEntity e : entities) {
            Info info = e.prefab != null ? TABLE.get(e.prefab) : null;
            if (info != null) {
                e.entity_type    = info.type;
                e.hostility      = info.hostility;
                e.biome_affinity = info.biome;
                e.source         = "vanilla";
                e.confidence     = 1.0;
            } else {
                e.entity_type    = "unknown";
                e.hostility      = "unknown";
                e.biome_affinity = null;
                e.source         = e.prefab != null && !e.prefab.startsWith("hash:") ? "mod" : "unknown";
                e.confidence     = 0.5;
            }
            e.classification = Classification.of("creature");
        }
    }
}
