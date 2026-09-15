package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.LinkedHashMap;
import java.util.HexFormat;
import java.security.MessageDigest;
import java.util.zip.ZipOutputStream;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipEntry;
import java.io.ByteArrayInputStream;
import static org.junit.jupiter.api.Assertions.*;

class CaptureCatalogTest {
    @TempDir Path root;
    final ObjectMapper mapper=new ObjectMapper();
    @Test void publishedSharedFixturesAgreeWithExport()throws Exception{
        var fixtures=mapper.readTree(getClass().getResourceAsStream("/static/camera-fixtures.json"));
        for(var p:fixtures.path("projections")){
            ObjectNode c=fixtures.path("camera").deepCopy();for(String key:java.util.List.of("verticalFov","width","height"))c.set(key,p.path(key));
            var spec=mapper.createObjectNode();spec.set("camera",c);spec.set("settings",mapper.readTree("{\"environment\":\"Clear\",\"timeOfDay\":0.64,\"fires\":false,\"flashBearing\":null}"));
            String[] row=CaptureCatalog.shots(spec).split("\n")[1].split("\t",-1);
            for(int i=0;i<3;i++){assertEquals(fixtures.path("playerFeet").get(i).asDouble(),Double.parseDouble(row[2+i]),1e-8);assertEquals(c.path("lens").get(i).asDouble(),Double.parseDouble(row[16+i]),1e-8);}
            assertEquals(p.path("width").asInt(),Integer.parseInt(row[20]));assertEquals(p.path("height").asInt(),Integer.parseInt(row[21]));
        }
    }
    ObjectNode camera()throws Exception{return (ObjectNode)mapper.readTree("""
      {"lens":[100,31.7,200],"yaw":90,"pitch":30,"roll":0,"verticalFov":65,"width":1920,"height":1080,"targetDistance":40}
      """);}
    String hash(byte[] data)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));}
    void runnerFixture()throws Exception{
        var files=new LinkedHashMap<String,byte[]>();
        for(String name:java.util.List.of("capture.py","capture_spec.py","capture_kit.py","Capture.ps1","capture.sh","mods/CameraProof.dll","mods/BetterServerPortals.dll"))files.put(name,name.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        var manifest=mapper.createObjectNode();manifest.put("schema","selfiestick-runner/v1");manifest.put("pluginVersion","0.3.1");var rows=manifest.putArray("files");
        for(var entry:files.entrySet())rows.addObject().put("path",entry.getKey()).put("bytes",entry.getValue().length).put("sha256",hash(entry.getValue()));
        files.put("runner-manifest.json",mapper.writeValueAsBytes(manifest));
        try(var zip=new ZipOutputStream(Files.newOutputStream(root.resolve("runner.zip")))){for(var entry:files.entrySet()){zip.putNextEntry(new ZipEntry(entry.getKey()));zip.write(entry.getValue());zip.closeEntry();}}
        var release=mapper.createObjectNode();release.put("schema","selfiestick-runner-release/v1");release.put("pluginVersion","0.3.1");release.putObject("package").put("path","runner.zip").put("bytes",Files.size(root.resolve("runner.zip"))).put("sha256",hash(Files.readAllBytes(root.resolve("runner.zip"))));
        mapper.writeValue(root.resolve("runner-release.json").toFile(),release);
        var catalog=mapper.createObjectNode();catalog.put("schema","steward-capture-catalog/v1");var photo=catalog.putArray("photos").addObject();photo.put("id","reference");photo.putObject("availability").put("replay",true);
        var source=photo.putObject("source");source.put("photoId","reference");source.put("buildKey","build");var world=source.putObject("world");world.put("id","Fixture");
        for(String key:java.util.List.of("db","fwl"))world.putObject(key).put("bytes",1).put("sha256","a".repeat(64));
        photo.set("settings",mapper.readTree("{\"environment\":\"Clear\",\"timeOfDay\":0.64,\"fires\":false,\"flashBearing\":null}"));
        Files.writeString(root.resolve("thumb.webp"),"reference");photo.putObject("thumbnailAsset").put("path","thumb.webp").put("bytes",9).put("sha256",hash(Files.readAllBytes(root.resolve("thumb.webp"))));
        mapper.writeValue(root.resolve("catalog.json").toFile(),catalog);
    }
    @Test void summaryClaimsWithoutMeasuredReceiptsCannotEnableDownloads()throws Exception{
        runnerFixture();var proof=mapper.createObjectNode();proof.put("schema","selfiestick-capture-proof/v1");proof.putNull("error");var hosts=proof.putObject("hosts");
        for(String host:java.util.List.of("OMEN","AM4")){var cases=hosts.putArray(host);for(int fov:new int[]{90,65,35})for(String frame:java.util.List.of("Landscape","Square","Portrait"))cases.addObject().put("verticalFov",fov).put("frame",frame).put("longestEdge",1920).put("status","passed").put("restored",true).put("pluginSha256",hash("mods/CameraProof.dll".getBytes())).put("receipt","missing.json").put("receiptSha256","a".repeat(64));}
        mapper.writeValue(root.resolve("capture-proof.json").toFile(),proof);var catalog=new CaptureCatalog(root,mapper);
        assertFalse(catalog.catalog().path("downloadsEnabled").asBoolean());assertThrows(io.javalin.http.ServiceUnavailableResponse.class,()->catalog.export("reference",camera()));
    }
    @Test void candidateContainsExactSpecShotListThumbnailAndBothLaunchers()throws Exception{
        runnerFixture();var catalog=new CaptureCatalog(root,mapper);byte[] bytes=catalog.candidate("reference",camera());
        var files=new LinkedHashMap<String,byte[]>();try(var zip=new ZipInputStream(new ByteArrayInputStream(bytes))){ZipEntry e;while((e=zip.getNextEntry())!=null)files.put(e.getName(),zip.readAllBytes());}
        assertTrue(files.keySet().containsAll(java.util.Set.of("Capture.ps1","capture.sh","capture.json","shots.tsv","reference.webp","runner-manifest.json")));
        assertEquals(camera(),mapper.readTree(files.get("capture.json")).path("camera"));assertEquals("reference",mapper.readTree(files.get("capture.json")).path("source").path("photoId").asText());
        assertEquals(23,new String(files.get("shots.tsv")).split("\n")[1].split("\t",-1).length);
        assertArrayEquals(bytes,catalog.candidate("reference",camera()));
        Files.writeString(root.resolve("thumb.webp"),"corrupted");assertThrows(IllegalArgumentException.class,()->catalog.candidate("reference",camera()));
    }
    @Test void incompatibleRunnerFailsClearly()throws Exception{
        runnerFixture();var release=(ObjectNode)mapper.readTree(root.resolve("runner-release.json").toFile());release.put("pluginVersion","0.2.5");mapper.writeValue(root.resolve("runner-release.json").toFile(),release);
        assertTrue(assertThrows(IllegalArgumentException.class,()->new CaptureCatalog(root,mapper)).getMessage().contains("Incompatible"));
    }
    @Test void allLensFramesPreserveLensAndExportFeetOnce()throws Exception{
        for(int fov:new int[]{35,65,90})for(int[] size:new int[][]{{1920,1080},{1920,1920},{1080,1920},{3840,2160},{3840,3840},{2160,3840}}){
            var c=camera();c.put("verticalFov",fov);c.put("width",size[0]);c.put("height",size[1]);assertEquals(c,CaptureCatalog.validateCamera(c));
            var spec=mapper.createObjectNode();spec.set("camera",c);spec.set("settings",mapper.readTree("{\"environment\":\"Clear\",\"timeOfDay\":0.64,\"fires\":false,\"flashBearing\":null}"));
            String[] row=CaptureCatalog.shots(spec).split("\n")[1].split("\t",-1);
            assertEquals(23,row.length);assertEquals(30,Double.parseDouble(row[3]),1e-9);assertEquals(31.7,Double.parseDouble(row[17]),1e-9);
            assertEquals(size[0],Integer.parseInt(row[20]));assertEquals(fov,Double.parseDouble(row[19]));assertEquals(100+40*Math.sqrt(3)/2,Double.parseDouble(row[9]),1e-8);
        }
    }
    @Test void invalidCameraIsRejected()throws Exception{
        var c=camera();c.put("width",2000);assertThrows(IllegalArgumentException.class,()->CaptureCatalog.validateCamera(c));
        var bad=camera();bad.put("pitch",90);assertThrows(IllegalArgumentException.class,()->CaptureCatalog.validateCamera(bad));
    }
    @Test void emptyCatalogIsBrowsableAndCannotDownload()throws Exception{
        var c=new CaptureCatalog(null,mapper);assertFalse(c.catalog().path("downloadsEnabled").asBoolean());assertTrue(c.catalog().path("photos").isEmpty());
        assertThrows(io.javalin.http.ServiceUnavailableResponse.class,()->c.export("none",camera()));
    }
    @Test void catalogFlagAloneNeverEnablesDownloads()throws Exception{
        Files.writeString(root.resolve("catalog.json"),"{\"schema\":\"steward-capture-catalog/v1\",\"downloadsEnabled\":true,\"photos\":[]}");
        assertFalse(new CaptureCatalog(root,mapper).catalog().path("downloadsEnabled").asBoolean());
    }
    @Test void wrongRunnerHashFailsClosed()throws Exception{
        Files.writeString(root.resolve("catalog.json"),"{\"schema\":\"steward-capture-catalog/v1\",\"photos\":[]}");Files.writeString(root.resolve("runner.zip"),"wrong");
        Files.writeString(root.resolve("runner-release.json"),"{\"schema\":\"selfiestick-runner-release/v1\",\"pluginVersion\":\"0.3.1\",\"package\":{\"path\":\"runner.zip\",\"bytes\":5,\"sha256\":\""+"a".repeat(64)+"\"}}");
        assertThrows(IllegalArgumentException.class,()->new CaptureCatalog(root,mapper));
    }
}
