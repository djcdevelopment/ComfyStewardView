package dev.steward.lab;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

class LabConfigTest {
    @TempDir Path temp;

    @Test void publicModeRequiresAnExplicitSnapshot() {
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
            () -> LabConfig.parse(new String[]{"serve", "--public"}));
        assertTrue(error.getMessage().contains("--snapshot"));
    }

    @Test void parsesPublicBindingAndBaseUrl() {
        LabConfig config = LabConfig.parse(new String[]{"serve", "--public", "--snapshot", "107",
            "--bind", "0.0.0.0", "--public-url", "https://example.test/world"});
        assertTrue(config.publicMode());
        assertEquals(107, config.snapshotId());
        assertEquals("0.0.0.0", config.bindAddress());
        assertEquals("https://example.test/world/", config.publicUrl());
        assertEquals("/world/", config.feedback().cookiePath());
    }

    @Test void parsesManifestContextAndRejectsTwoContextSources() throws Exception {
        Path manifest = Files.writeString(temp.resolve("manifest.json"), "{}");
        Path image = Files.write(temp.resolve("context.png"), new byte[]{1});
        LabConfig config = LabConfig.parse(new String[]{"serve", "--context-manifest", manifest.toString()});
        assertEquals(manifest.toAbsolutePath(), config.contextManifest());

        IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
            () -> LabConfig.parse(new String[]{"serve", "--context-manifest", manifest.toString(),
                "--context-image", image.toString()}));
        assertTrue(error.getMessage().contains("not both"));
    }
}
