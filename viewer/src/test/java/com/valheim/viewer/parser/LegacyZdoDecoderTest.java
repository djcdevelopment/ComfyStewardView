package com.valheim.viewer.parser;

import com.valheim.viewer.db.AnalyticsCache;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import static org.junit.jupiter.api.Assertions.*;

class LegacyZdoDecoderTest {
    @TempDir Path temp;

    static ByteBuffer record(int floats, boolean corruptLength) {
        ByteBuffer b = ByteBuffer.allocate(8192).order(ByteOrder.LITTLE_ENDIAN);
        b.putLong(17).putInt(3).putInt(0);
        int start = b.position();
        b.putInt(1).putInt(1).put((byte)1).putLong(23).putLong(1000).putInt(0);
        b.put((byte)0).put((byte)0).putInt(WorldParser.sh("wood_floor"));
        b.putInt(-1).putInt(2).putFloat(-10).putFloat(40).putFloat(130);
        b.putFloat(0).putFloat((float)Math.sqrt(.5)).putFloat(0).putFloat((float)Math.sqrt(.5));
        b.put(String.valueOf((char)floats).getBytes(StandardCharsets.UTF_8));
        for (int i=0;i<floats;i++) b.putInt(i == 0 ? WorldParser.sh("health") : i).putFloat(i == 0 ? 100 : i);
        b.put((byte)0).put((byte)0).put((byte)0);
        b.put((byte)1).putInt(WorldParser.sh("creator")).putLong(9007199254740993L);
        b.put((byte)1).putInt(WorldParser.sh("text")).put((byte)3).put(new byte[]{'h','e','j'});
        b.put((byte)0);
        b.putInt(12, corruptLength ? Integer.MAX_VALUE : b.position() - start);
        b.flip(); return b;
    }

    @Test void legacyPropertiesAndLargeCharacterCountsReachTheNormalCache() throws Exception {
        for (int count : new int[]{1,128,200}) {
            ByteBuffer record = record(count, false);
            ByteBuffer world = ByteBuffer.allocate(28 + record.remaining()).order(ByteOrder.LITTLE_ENDIAN);
            world.putInt(29).putDouble(10).putLong(1).putInt(2).putInt(1).put(record);
            Path save = temp.resolve("legacy" + count + ".db");
            Files.write(save, world.array());
            try (AnalyticsCache cache = new AnalyticsCache(temp.resolve("cache" + count + ".duckdb").toFile(),true,true)) {
                var parser = new WorldParser(); parser.setAnalyticsCache(cache); parser.parse(save.toFile()); cache.finish();
                try (var st = cache.connection().createStatement(); var rows=st.executeQuery("SELECT creator_id,x,y,z FROM zdo")) {
                    assertTrue(rows.next()); assertEquals(9007199254740993L,rows.getLong(1));
                    assertEquals(-10,rows.getDouble(2)); assertEquals(40,rows.getDouble(3)); assertEquals(130,rows.getDouble(4));
                }
                try (var st=cache.connection().createStatement();var rows=st.executeQuery("SELECT count(*) FROM zdo_field WHERE field_type='float'")) {
                    rows.next(); assertEquals(count,rows.getInt(1));
                }
            }
        }
    }

    @Test void corruptPackageLengthsFailBeforeAllocation() {
        assertThrows(IllegalArgumentException.class,()->new LegacyZdoDecoder().next(record(1,true),29));
        ByteBuffer truncated=record(1,false); truncated.limit(truncated.limit()-1);
        assertThrows(IllegalArgumentException.class,()->new LegacyZdoDecoder().next(truncated,29));
    }

    @Test void quaternionUsesUnityZxyOrder() {
        assertArrayEquals(new float[]{0,90,0},LegacyZdoDecoder.eulerZxy(0,Math.sqrt(.5),0,Math.sqrt(.5)),.001f);
        assertArrayEquals(new float[]{90,0,0},LegacyZdoDecoder.eulerZxy(Math.sqrt(.5),0,0,Math.sqrt(.5)),.001f);
        assertArrayEquals(new float[]{0,0,90},LegacyZdoDecoder.eulerZxy(0,0,Math.sqrt(.5),Math.sqrt(.5)),.001f);
        assertThrows(IllegalArgumentException.class,()->LegacyZdoDecoder.eulerZxy(0,0,0,0));
    }
}
