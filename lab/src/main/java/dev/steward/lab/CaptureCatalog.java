package dev.steward.lab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.javalin.http.ServiceUnavailableResponse;
import io.javalin.http.NotFoundResponse;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/** Photography identity comes only from a projected archive catalog. Browser edits are camera-only. */
public final class CaptureCatalog {
    private final ObjectMapper mapper;
    private final ObjectNode catalog;
    private final Path root;
    private final Map<String,JsonNode> photos = new LinkedHashMap<>();
    private final Map<String,byte[]> runner = new LinkedHashMap<>();
    private final boolean enabled;

    public CaptureCatalog(Path root, ObjectMapper mapper) throws Exception {
        this.root = root == null ? null : root.toRealPath(); this.mapper=mapper;
        if (root == null) {
            catalog=mapper.createObjectNode(); catalog.put("schema","steward-capture-catalog/v1");
            catalog.putArray("photos"); enabled=false;
        } else {
            catalog=(ObjectNode)mapper.readTree(root.resolve("catalog.json").toFile());
            if (!"steward-capture-catalog/v1".equals(catalog.path("schema").asText())) throw new IllegalArgumentException("Unsupported capture catalog");
            for(JsonNode photo:catalog.path("photos")) {
                String id=photo.path("id").asText();
                if(!id.matches("[A-Za-z0-9_-]{1,180}") || photos.putIfAbsent(id,photo)!=null) throw new IllegalArgumentException("Invalid or duplicate photo identity");
            }
            Path release=root.resolve("runner-release.json");
            if(Files.exists(release)) loadRunner(mapper.readTree(release.toFile()));
            // Public downloads require measured proof from both operating systems for this exact runner.
            enabled = !runner.isEmpty() && verifiedProof(root.resolve("capture-proof.json"));
        }
        catalog.put("downloadsEnabled",enabled);
    }
    public ObjectNode catalog() { return catalog.deepCopy(); }
    public JsonNode photo(String id) {
        var result=photos.get(id); if(result==null)throw new NotFoundResponse("Photograph not found");return result.deepCopy();
    }
    private static String sha(byte[] bytes) throws Exception {return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}
    private Path local(String name) throws Exception {
        Path file=root.resolve(name).normalize().toRealPath();
        if(!file.startsWith(root))throw new IllegalArgumentException("Capture asset escaped its package");return file;
    }
    private void loadRunner(JsonNode release) throws Exception {
        if(!"selfiestick-runner-release/v1".equals(release.path("schema").asText()) || !"0.3.1".equals(release.path("pluginVersion").asText())) throw new IllegalArgumentException("Incompatible capture runner");
        JsonNode entry=release.path("package");Path file=local(entry.path("path").asText());
        if(Files.size(file)>32*1024*1024 || Files.size(file)!=entry.path("bytes").asLong())throw new IllegalArgumentException("Runner size mismatch");
        byte[] bytes=Files.readAllBytes(file);
        if(!sha(bytes).equals(entry.path("sha256").asText()))throw new IllegalArgumentException("Runner hash mismatch");
        try(var zip=new ZipInputStream(new ByteArrayInputStream(bytes))) {
            ZipEntry item;long total=0;
            while((item=zip.getNextEntry())!=null) {
                String name=item.getName();
                if(item.isDirectory())continue;
                if(name.startsWith("/")||name.contains("..")||name.contains("\\")||name.contains(":"))throw new IllegalArgumentException("Unsafe runner entry");
                byte[] data=zip.readNBytes(16*1024*1024+1);total+=data.length;
                if(data.length>16*1024*1024||total>32*1024*1024||runner.putIfAbsent(name,data)!=null)throw new IllegalArgumentException("Invalid runner package");
            }
        }
        if(!runner.keySet().containsAll(java.util.Set.of("capture.py","capture_spec.py","capture_kit.py","Capture.ps1","capture.sh","runner-manifest.json","mods/CameraProof.dll","mods/BetterServerPortals.dll")))throw new IllegalArgumentException("Incomplete runner package");
        JsonNode manifest=mapper.readTree(runner.get("runner-manifest.json"));
        if(!"selfiestick-runner/v1".equals(manifest.path("schema").asText())||!"0.3.1".equals(manifest.path("pluginVersion").asText()))throw new IllegalArgumentException("Incompatible dependency manifest");
        var declared = new java.util.HashSet<String>();
        for(JsonNode item:manifest.path("files")) {
            if(!declared.add(item.path("path").asText()))throw new IllegalArgumentException("Duplicate runner dependency");
            byte[] data=runner.get(item.path("path").asText());
            if(data==null||data.length!=item.path("bytes").asLong()||!sha(data).equals(item.path("sha256").asText()))throw new IllegalArgumentException("Runner dependency mismatch");
        }
        var expected=new java.util.HashSet<>(runner.keySet());expected.remove("runner-manifest.json");
        if(!declared.equals(expected))throw new IllegalArgumentException("Unpinned runner dependency");
    }
    private boolean verifiedProof(Path file) throws Exception {
        if(!Files.exists(file))return false;
        try {
        JsonNode proof=mapper.readTree(file.toFile());
        if(!"selfiestick-capture-proof/v1".equals(proof.path("schema").asText())||!proof.path("error").isNull())return false;
        String hash=sha(runner.get("mods/CameraProof.dll"));
        for(String host:java.util.List.of("OMEN","AM4")) {
            var cases=proof.path("hosts").path(host); if(!cases.isArray())return false;
            for(int fov:new int[]{90,65,35}) for(String frame:java.util.List.of("Landscape","Square","Portrait")) {
                boolean passed=false;
                for(JsonNode c:cases) if(c.path("verticalFov").asInt()==fov&&frame.equals(c.path("frame").asText())
                    &&"passed".equals(c.path("status").asText())&&hash.equals(c.path("pluginSha256").asText())
                    &&c.path("longestEdge").asInt()==1920&&c.path("restored").asBoolean()&&verifiedCase(c,host))passed=true;
                if(!passed)return false;
            }
        }
        return true;
        }catch(Exception invalid){return false;}
    }
    private boolean verifiedCase(JsonNode entry,String host)throws Exception {
        Path receiptFile=local(entry.path("receipt").asText());byte[] bytes=Files.readAllBytes(receiptFile);
        if(bytes.length>1024*1024||!sha(bytes).equals(entry.path("receiptSha256").asText()))return false;
        JsonNode receipt=mapper.readTree(bytes),requested=receipt.path("requested"),observed=receipt.path("observed");
        if(!"selfiestick-capture-case/v1".equals(receipt.path("schema").asText())||!host.equals(receipt.path("host").asText())
            ||!mapper.readTree(runner.get("runner-manifest.json")).equals(receipt.path("runner")))return false;
        if(!"selfiestick-capture/v1".equals(requested.path("schema").asText())||!"0.3.1".equals(requested.path("requiredPluginVersion").asText()))return false;
        ObjectNode camera=validateCamera(requested.path("camera"));validateSource(requested.path("source"),requested.path("settings"));
        if(camera.path("verticalFov").asDouble()!=entry.path("verticalFov").asDouble())return false;
        int w=camera.path("width").asInt(),h=camera.path("height").asInt();
        String frame=w==h?"Square":w>h?"Landscape":"Portrait";
        if(!frame.equals(entry.path("frame").asText())||Math.max(w,h)!=entry.path("longestEdge").asInt())return false;
        if(!"0.3.1".equals(observed.path("plugin_version").asText())||!observed.path("exact").asBoolean()
            ||observed.has("skipped")||!observed.path("camera_restored").asBoolean())return false;
        JsonNode actual=observed.path("observed"),lens=actual.path("lens");
        if(!lens.isArray()||lens.size()!=3)return false;
        double squared=0;for(int i=0;i<3;i++){
            if(!lens.get(i).isNumber()||!Double.isFinite(lens.get(i).asDouble()))return false;
            squared+=Math.pow(lens.get(i).asDouble()-camera.path("lens").get(i).asDouble(),2);
        }
        if(squared>.0001)return false;
        for(String key:java.util.List.of("yaw","pitch","roll")){
            double value=number(actual,key,-1000000,1000000)-camera.path(key).asDouble();
            if(Math.abs(Math.IEEEremainder(value,360))>.02)return false;
        }
        if(Math.abs(number(actual,"verticalFov",1,179)-camera.path("verticalFov").asDouble())>.01
            ||actual.path("width").asInt()!=w||actual.path("height").asInt()!=h)return false;
        var restoration=receipt.path("restoration");
        for(String key:java.util.List.of("pluginsAndControls","sourceSavesUnchanged","discoverySavesUnchanged"))if(!restoration.path(key).asBoolean())return false;
        String before=restoration.path("beforeSha256").asText();
        if(!before.matches("[a-f0-9]{64}")||!before.equals(restoration.path("afterSha256").asText()))return false;
        var identity=receipt.path("identity");
        if(!"selfiestick-local-identity/v1".equals(identity.path("schema").asText())
            ||!"Local".equals(identity.path("worldSource").asText())||!"Local".equals(identity.path("characterSource").asText())
            ||!identity.path("worldFile").asText().matches("selfiestick-[a-f0-9]{32}")
            ||!identity.path("characterFile").asText().matches("proof-kit-[a-f0-9]{10}"))return false;
        var png=receipt.path("png");Path image=local(root.relativize(receiptFile.getParent()).resolve(png.path("file").asText()).toString());
        if(Files.size(image)>64*1024*1024||Files.size(image)!=png.path("bytes").asLong())return false;
        byte[] imageBytes=Files.readAllBytes(image);
        if(imageBytes.length<24||!sha(imageBytes).equals(png.path("sha256").asText())
            ||!png.path("sha256").asText().equals(observed.path("image_sha256").asText()))return false;
        var header=java.nio.ByteBuffer.wrap(imageBytes);
        return header.getLong(0)==0x89504e470d0a1a0aL&&header.getInt(16)==w&&header.getInt(20)==h
            &&png.path("dimensions").size()==2&&png.path("dimensions").get(0).asInt()==w&&png.path("dimensions").get(1).asInt()==h;
    }
    private static void validateSource(JsonNode source,JsonNode settings){
        for(String key:java.util.List.of("photoId","buildKey"))if(!source.path(key).isTextual()||source.path(key).asText().isBlank()||source.path(key).asText().length()>256)throw new IllegalArgumentException("Missing source "+key);
        String world=source.path("world").path("id").asText();
        if(world.isBlank()||world.length()>128||world.equals(".")||world.equals("..")||world.matches(".*[\\\\/:*?\"<>|\\p{Cntrl}].*"))throw new IllegalArgumentException("Invalid archive identity");
        for(String key:java.util.List.of("db","fwl")){
            var item=source.path("world").path(key);
            if(!item.path("sha256").asText().matches("[a-f0-9]{64}")||!item.path("bytes").isIntegralNumber()||item.path("bytes").asLong()<=0)throw new IllegalArgumentException("Missing archive digest");
        }
        if(!settings.path("environment").asText().matches("[A-Za-z0-9_ -]{1,80}")||!settings.path("fires").isBoolean())throw new IllegalArgumentException("Invalid recorded lighting");
        number(settings,"timeOfDay",0,1);if(settings.hasNonNull("flashBearing"))number(settings,"flashBearing",-360,360);
    }
    public static double number(JsonNode node,String key,double low,double high) {
        var n=node.get(key);if(n==null||!n.isNumber()||!Double.isFinite(n.asDouble())||n.asDouble()<low||n.asDouble()>high)throw new IllegalArgumentException("Invalid camera "+key);return n.asDouble();
    }
    public static ObjectNode validateCamera(JsonNode value) {
        if(!(value instanceof ObjectNode c))throw new IllegalArgumentException("Camera required");
        var lens=c.path("lens");if(!lens.isArray()||lens.size()!=3)throw new IllegalArgumentException("Lens required");
        for(JsonNode n:lens)if(!n.isNumber()||!Double.isFinite(n.asDouble())||Math.abs(n.asDouble())>1e6)throw new IllegalArgumentException("Invalid lens");
        number(c,"yaw",-360,360);number(c,"pitch",-89.9,89.9);number(c,"verticalFov",1,179);
        if(c.has("roll"))number(c,"roll",-180,180);if(c.has("targetDistance"))number(c,"targetDistance",.1,10000);
        int w=(int)number(c,"width",1080,3840),h=(int)number(c,"height",1080,3840);
        if(c.path("width").asDouble()!=w||c.path("height").asDouble()!=h||!java.util.Set.of("1920x1080","1080x1920","1920x1920","3840x2160","2160x3840","3840x3840").contains(w+"x"+h))throw new IllegalArgumentException("Unsupported capture dimensions");
        return c.deepCopy();
    }
    public ObjectNode specification(String id,JsonNode camera) {
        JsonNode photo=photo(id);
        if(!photo.path("availability").path("replay").asBoolean())throw new IllegalArgumentException(photo.path("availability").path("reason").asText("Local replay unavailable"));
        validateSource(photo.path("source"),photo.path("settings"));
        ObjectNode spec=mapper.createObjectNode();spec.put("schema","selfiestick-capture/v1");spec.put("requiredPluginVersion","0.3.1");
        spec.set("source",photo.path("source"));spec.set("settings",photo.path("settings"));spec.set("camera",validateCamera(camera));return spec;
    }
    public byte[] export(String id,JsonNode camera) throws Exception {
        if(!enabled)throw new ServiceUnavailableResponse("Downloads await verified OMEN and AM4 capture proof");
        return candidate(id,camera);
    }
    /** Same package builder used in tests and proof preparation; never a public bypass. */
    byte[] candidate(String id,JsonNode camera) throws Exception {
        if(runner.isEmpty())throw new IllegalStateException("Pinned runner unavailable");
        ObjectNode spec=specification(id,camera);
        JsonNode thumb=photo(id).path("thumbnailAsset");Path image=local(thumb.path("path").asText());
        byte[] thumbnail=Files.readAllBytes(image);
        if(thumbnail.length>2*1024*1024||thumbnail.length!=thumb.path("bytes").asLong()||!sha(thumbnail).equals(thumb.path("sha256").asText()))throw new IllegalArgumentException("Reference thumbnail mismatch");
        ByteArrayOutputStream out=new ByteArrayOutputStream();
        try(var zip=new ZipOutputStream(out)) {
            for(var entry:runner.entrySet())put(zip,entry.getKey(),entry.getValue());
            put(zip,"capture.json",mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(spec));
            put(zip,"shots.tsv",shots(spec).getBytes(StandardCharsets.UTF_8));
            put(zip,"reference.webp",thumbnail);
        }
        return out.toByteArray();
    }
    static String shots(JsonNode spec) {
        var c=spec.path("camera");var s=spec.path("settings");var lens=c.path("lens");
        double x=lens.get(0).asDouble(),y=lens.get(1).asDouble(),z=lens.get(2).asDouble(),yaw=Math.toRadians(c.path("yaw").asDouble()),pitch=Math.toRadians(c.path("pitch").asDouble()),distance=c.path("targetDistance").asDouble(40);
        return "# cluster_id\tshot\tcam_x\tcam_y\tcam_z\tyaw\tpitch\tenv\ttime\taim_x\taim_y\taim_z\tlabel\tmode\tfires\tflash\tlens_x\tlens_y\tlens_z\tvertical_fov\twidth\theight\troll\n"
            +String.join("\t","0","capture",""+x,""+(y-1.7),""+z,c.path("yaw").asText(),c.path("pitch").asText(),s.path("environment").asText(),s.path("timeOfDay").asText(),
              ""+(x+Math.sin(yaw)*Math.cos(pitch)*distance),""+(y-Math.sin(pitch)*distance),""+(z+Math.cos(yaw)*Math.cos(pitch)*distance),"Gallery capture","exact",s.path("fires").asBoolean()?"1":"0",s.path("flashBearing").isNull()?"":s.path("flashBearing").asText(),
              ""+x,""+y,""+z,c.path("verticalFov").asText(),c.path("width").asText(),c.path("height").asText(),c.path("roll").asText("0"))+"\n";
    }
    private static void put(ZipOutputStream zip,String name,byte[] bytes)throws Exception{var entry=new ZipEntry(name);entry.setTime(0);zip.putNextEntry(entry);zip.write(bytes);zip.closeEntry();}
}
