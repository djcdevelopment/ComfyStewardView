package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class EraCatalogTest {
    @TempDir Path root;
    final ObjectMapper mapper=new ObjectMapper();

    @Test void pendingEraCannotFallBackToAnotherWorld() throws Exception {
        Path file=root.resolve("catalog.json");
        Files.writeString(file,"""
            {"schema":"steward-world-catalog/v1","defaultEra":"era7","eras":[
            {"slug":"era7","label":"Era 7","snapshotId":1001,"status":"awaiting-runtime","private":"secret"},
            {"slug":"era8","label":"Era 8","snapshotId":1002,"status":"awaiting-runtime"}]}
            """);
        EraCatalog catalog=new EraCatalog(file,mapper,new LensRegistry());
        assertEquals(1001,catalog.require(null).snapshotId());
        assertEquals(1002,catalog.require("era8").snapshotId());
        assertThrows(IllegalStateException.class,()->catalog.ready("era8"));
        assertThrows(IllegalArgumentException.class,()->catalog.require("era17"));
        assertFalse(catalog.publicJson(mapper).toString().contains("secret"));
    }

    @Test void publishedPackageRequiresVerifiedContainedArtifacts() throws Exception {
        Path file=root.resolve("catalog.json");
        Files.writeString(root.resolve("cache.duckdb"),"changed bytes");
        var doc=mapper.createObjectNode();doc.put("schema","steward-world-catalog/v1");doc.put("defaultEra","era7");
        var era=doc.putArray("eras").addObject();era.put("slug","era7");era.put("status","ready");era.put("snapshotId",1001);
        var receipt=era.putArray("files").addObject();receipt.put("path","cache.duckdb");receipt.put("bytes",0);receipt.put("sha256","0".repeat(64));
        mapper.writeValue(file.toFile(),doc);
        assertThrows(IllegalArgumentException.class,()->new EraCatalog(file,mapper,new LensRegistry()));
        receipt.put("path",root.resolve("cache.duckdb").toString());mapper.writeValue(file.toFile(),doc);
        assertThrows(IllegalArgumentException.class,()->new EraCatalog(file,mapper,new LensRegistry()));
    }
}
