package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

public record LensDefinition(
        String id,
        String label,
        String question,
        String payoff,
        String units,
        Source source,
        String predicate,
        String valueExpression,
        String xColumn,
        String zColumn,
        String accent) {

    public enum Source { ZDO, CONTAINER_ITEM }

    String table() {
        return source == Source.ZDO ? "zdo" : "container_item";
    }

    String groupExpression() {
        return source == Source.ZDO
            ? "COALESCE(prefab_name, 'hash:' || CAST(prefab_hash AS VARCHAR))"
            : "item_name";
    }

    ObjectNode publicJson(ObjectMapper mapper) {
        ObjectNode node = mapper.createObjectNode();
        node.put("id", id);
        node.put("label", label);
        node.put("question", question);
        node.put("payoff", payoff);
        node.put("units", units);
        node.put("source", source.name().toLowerCase());
        node.put("accent", accent);
        return node;
    }
}
