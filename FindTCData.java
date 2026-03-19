import net.kakoen.valheim.save.archive.hints.ValheimSaveReaderHints;
import net.kakoen.valheim.save.archive.save.Zdo;
import net.kakoen.valheim.save.parser.ZPackage;
import java.io.*;
import java.util.zip.GZIPInputStream;

public class FindTCData {
    static byte[] gunzip(byte[] c) throws IOException {
        try (GZIPInputStream gz = new GZIPInputStream(new ByteArrayInputStream(c));
             ByteArrayOutputStream o = new ByteArrayOutputStream()) {
            byte[] b = new byte[4096]; int n;
            while ((n = gz.read(b)) != -1) o.write(b, 0, n);
            return o.toByteArray();
        }
    }
    public static void main(String[] args) throws Exception {
        ValheimSaveReaderHints hints = ValheimSaveReaderHints.builder()
                .resolveNames(true).failOnUnsupportedVersion(false).build();
        int[] targets = {-494364525, 650075310};
        int[] found = {0, 0};
        try (ZPackage pkg = new ZPackage(new java.io.File(args.length > 0 ? args[0] : "ComfyEra14.db"))) {
            int wv = pkg.readInt32(); pkg.readDouble(); pkg.readLong(); pkg.readUInt();
            int total = pkg.readInt32();
            for (int i = 0; i < total; i++) {
                if (i % 1000000 == 0) System.err.print(".");
                try {
                    Zdo zdo = new Zdo(pkg, wv, hints);
                    int hash = zdo.getPrefab();
                    int ti = hash == -494364525 ? 0 : hash == 650075310 ? 1 : -1;
                    if (ti < 0 || found[ti] >= 3) continue;
                    if (zdo.getByteArraysByName() == null || !zdo.getByteArraysByName().containsKey("TCData")) continue;
                    found[ti]++;
                    float x = zdo.getPosition() != null ? zdo.getPosition().getX() : 0;
                    float z = zdo.getPosition() != null ? zdo.getPosition().getZ() : 0;
                    System.out.println("\nhash:"+hash+" #"+found[ti]+" @ ("+(int)x+","+(int)z+")");
                    if (zdo.getStringsByName() != null) System.out.println("  strings: "+zdo.getStringsByName());
                    if (zdo.getIntsByName()    != null) System.out.println("  ints:    "+zdo.getIntsByName());
                    if (zdo.getFloatsByName()  != null) System.out.println("  floats:  "+zdo.getFloatsByName());
                    if (zdo.getLongsByName()   != null) System.out.println("  longs:   "+zdo.getLongsByName());
                    byte[] tc = zdo.getByteArraysByName().get("TCData");
                    System.out.println("  TCData compressed="+tc.length+"b");
                    byte[] raw = gunzip(tc);
                    System.out.println("  TCData decompressed="+raw.length+"b");
                    // Parse inner ZPackage
                    try (ZPackage inner = new ZPackage(raw)) {
                        int v = inner.readInt32();
                        int cnt = inner.readInt32();
                        System.out.println("  inner[0]="+v+" inner[4]="+cnt);
                        if (v >= 100 && v <= 120 && cnt >= 0 && cnt < 200) {
                            System.out.println("  -> INVENTORY v"+v+" items="+cnt);
                            for (int j = 0; j < Math.min(cnt, 8); j++) {
                                String nm = inner.readString();
                                int st = inner.readInt32(); float dr = inner.readSingle();
                                int px = inner.readInt32(); int py = inner.readInt32();
                                boolean eq = inner.readBool();
                                int q = v >= 101 ? inner.readInt32() : 1;
                                int va = v >= 102 ? inner.readInt32() : 0;
                                if (v >= 103) { inner.readLong(); inner.readString(); }
                                if (v >= 104) { int mc = inner.readInt32(); for (int k=0;k<mc;k++){inner.readString();inner.readString();}}
                                if (v >= 105) inner.readByte();
                                System.out.printf("    [%d] %-25s x%-4d q%-2d slot=%d,%d%n",j,nm,st,q,px,py);
                            }
                        } else {
                            // Dump hex
                            StringBuilder h = new StringBuilder("  hex: ");
                            for (int j=0;j<Math.min(64,raw.length);j++) h.append(String.format("%02x ",raw[j]));
                            System.out.println(h.toString().trim());
                        }
                    }
                } catch (Throwable e) {}
            }
        }
        System.err.println();
    }
}
