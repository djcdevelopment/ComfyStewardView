package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class LensRegistry {
    private final Map<String, LensDefinition> definitions = new LinkedHashMap<>();

    public LensRegistry() {
        register(new LensDefinition(
            "build-density", "Build density",
            "Where has the community concentrated construction?",
            "Find settlements, infrastructure, and areas likely to carry server load.",
            "objects", LensDefinition.Source.ZDO,
            "category = 'BUILDING'", "COUNT(*)", "x", "z", "#ef8a75"));
        register(new LensDefinition(
            "dropped-items", "Dropped items",
            "Where are unattended items accumulating?",
            "Find cleanup opportunities, farms, and unexplained concentrations.",
            "objects", LensDefinition.Source.ZDO,
            "category = 'DROPPED_ITEM'", "COUNT(*)", "x", "z", "#e8c77b"));
        register(new LensDefinition(
            "all-zdos", "All ZDOs",
            "Where does the world carry persistent state?",
            "See the complete surface footprint and use it as an inferred coastline.",
            "objects", LensDefinition.Source.ZDO,
            "(category IS NULL OR category <> 'INTERIOR')", "COUNT(*)", "x", "z", "#8fa8d8"));
        register(new LensDefinition(
            "coins", "Coins",
            "Where is container wealth concentrated?",
            "Reveal economic centers and unusually large stores of liquid value.",
            "coins", LensDefinition.Source.CONTAINER_ITEM,
            "item_name = 'Coins'", "SUM(stack)", "container_x", "container_z", "#f5c451"));
        register(new LensDefinition(
            "birch-trees", "Birch trees",
            "Where are the world's birch groves?",
            "Test a custom prefab lens from world scale down to exact tree positions.",
            "trees", LensDefinition.Source.ZDO,
            "prefab_name IN ('Birch1','Birch1_aut','Birch2','Birch2_aut')",
            "COUNT(*)", "x", "z", "#9fd18b"));
        register(new LensDefinition(
            "tombstones", "Tombstones",
            "Where have players died?",
            "Find dangerous routes, difficult encounters, and recovery hotspots.",
            "tombstones", LensDefinition.Source.ZDO,
            "category = 'TOMBSTONE'", "COUNT(*)", "x", "z", "#e66a78"));
    }

    private void register(LensDefinition definition) {
        definitions.put(definition.id(), definition);
    }

    public LensDefinition require(String id) {
        LensDefinition definition = definitions.get(id);
        if (definition == null) throw new IllegalArgumentException("Unknown lens: " + id);
        return definition;
    }

    public List<LensDefinition> all() {
        return List.copyOf(definitions.values());
    }

    public ArrayNode publicJson(ObjectMapper mapper) {
        ArrayNode result = mapper.createArrayNode();
        definitions.values().forEach(lens -> result.add(lens.publicJson(mapper)));
        return result;
    }
}
