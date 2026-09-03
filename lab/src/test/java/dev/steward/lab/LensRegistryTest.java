package dev.steward.lab;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class LensRegistryTest {
    @Test void exposesQuestionShapedBuiltInLensesWithoutAcceptingArbitrarySql() {
        LensRegistry registry = new LensRegistry();
        assertEquals(6, registry.all().size());
        LensDefinition birch = registry.require("birch-trees");
        assertEquals("Birch trees", birch.label());
        assertTrue(birch.question().endsWith("?"));
        assertThrows(IllegalArgumentException.class, () -> registry.require("x' OR 1=1 --"));
    }
}
