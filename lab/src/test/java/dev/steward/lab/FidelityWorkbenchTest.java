package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class FidelityWorkbenchTest {
    @TempDir Path temporary;

    @Test void joinsExactCameraReceiptAndStreamsExternalImageWithoutCopyingIt() throws Exception {
        Path gallery = Files.createDirectories(temporary.resolve("gallery"));
        Path large = Files.createDirectories(gallery.resolve("large"));
        byte[] image = {1, 3, 5, 7};
        Files.write(large.resolve("run_0713_orbit1.webp"), image);
        Files.writeString(gallery.resolve("index.json"), """
            {"n":3341,"images":[{"id":"run_0713_orbit1","cluster_id":713,
            "variant":"orbit1","environment":"Clear"}]}
            """);
        Path clusters = Files.writeString(temporary.resolve("clusters.json"), """
            {"clusters":[{"cluster_id":713,"min_x":-10,"max_x":10,"min_y":2,
            "max_y":12,"min_z":-20,"max_z":20,"pieces":864,"top_prefab":"windmill"}]}
            """);
        Path receipts = Files.writeString(temporary.resolve("receipts.jsonl"), """
            {"run":"run","cluster_id":713,"shot":"orbit1","lens":{"x":1.25,"y":2.5,"z":3.75},"aim":{"x":4,"y":5,"z":6},"yaw":315,"pitch":24.06,"fov":65}
            """);
        Path candidates = Files.writeString(temporary.resolve("candidates.json"), """
            {"schema":"steward-prefab-renderers/v1","prefabs":[]}
            """);
        LabConfig config = LabConfig.parse(new String[]{"serve", "--cache", temporary.resolve("none.db").toString(),
            "--fidelity-gallery", gallery.toString(), "--fidelity-receipts", receipts.toString(),
            "--fidelity-clusters", clusters.toString(), "--fidelity-candidates", candidates.toString(),
            "--no-browser"});
        FidelityWorkbench workbench = new FidelityWorkbench(config, new ObjectMapper());

        var result = workbench.view(713);
        assertTrue(result.path("private").asBoolean());
        assertEquals(3341, result.path("galleryImages").asInt());
        assertEquals(1, result.path("matchedViews").asInt());
        assertEquals(1.25, result.path("views").get(0).path("lens").get(0).asDouble());
        assertEquals(65, result.path("views").get(0).path("fov").asInt());
        try (var input = workbench.image("run_0713_orbit1")) {
            assertArrayEquals(image, input.readAllBytes());
        }
        try (var files = Files.list(large)) {
            assertEquals(1, files.count(), "the workbench references, rather than copies, gallery data");
        }
    }
}
