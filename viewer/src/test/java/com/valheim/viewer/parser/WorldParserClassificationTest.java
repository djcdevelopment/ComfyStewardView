package com.valheim.viewer.parser;

import com.valheim.viewer.store.ZdoFlatStore;
import com.valheim.viewer.store.ZdoFlatStore.Categories;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Classification tests over a hand-built world file.
 *
 * <p>The synthetic-history corpus placed 288 {@code wood_floor} pieces through ComfyQuestLab's
 * ZDO builder. Those ZDOs carry no creator, health or support field, so the property-shape
 * heuristic could not see them and they landed in UNKNOWN — visible in the all-zdos raster but
 * absent from build-activity. Classification by prefab identity closes that gap; these tests pin
 * both the fix and the boundaries that must not move with it.
 */
class WorldParserClassificationTest {

    private static final int WORLD_VERSION = 34;

    @TempDir
    Path tempDir;

    @Test
    void dictionaryIdentifiesConstructionPiecesAndNothingElse() {
        PrefabDictionary dict = PrefabDictionary.load(null);
        assertTrue(dict.size() > 3_000, "bundled dictionary should have loaded");

        // Piece + WearNTear: the standard construction set, across build stations and materials.
        for (String name : new String[]{"wood_floor", "wood_wall_roof", "wood_beam", "woodwall",
                "wood_door", "stone_wall_2x1", "blackmarble_2x2x2", "piece_workbench"}) {
            assertTrue(dict.byHash(WorldParser.sh(name)).isBuildPiece(), name + " should be a build piece");
        }

        // Piece without WearNTear — saplings, roads and terrain operations are not construction.
        for (String name : new String[]{"sapling_carrot", "cultivate", "paved_road", "raise"}) {
            assertFalse(dict.byHash(WorldParser.sh(name)).isBuildPiece(), name + " is not construction");
        }

        // WearNTear without Piece — world-generated props with no build recipe.
        for (String name : new String[]{"vines", "goblin_woodwall_1m", "Ashlands_Wall_2x2"}) {
            assertFalse(dict.byHash(WorldParser.sh(name)).isBuildPiece(), name + " is world-gen, not a piece");
        }

        // Neither: vegetation, rock and inventory items.
        for (String name : new String[]{"Birch1", "Rock_4", "Pickable_Stone", "Hammer"}) {
            assertFalse(dict.byHash(WorldParser.sh(name)).isBuildPiece(), name + " is not a piece");
        }

        assertTrue(dict.buildPieceHashes().contains(WorldParser.sh("wood_floor")));
        assertFalse(dict.buildPieceHashes().contains(WorldParser.sh("sapling_carrot")));
    }

    @Test
    void classifiesCreatorlessConstructionPiecesAsBuilding() throws Exception {
        List<Zdo> world = new ArrayList<>();

        // The synthetic-history shape: a placed piece with no creator, health or support.
        world.add(new Zdo("wood_floor", 2.2f, 0.25f, 2.2f).withString("tag", ""));
        // A piece with no properties at all must not read as nature either.
        world.add(new Zdo("wood_wall_roof", 4f, 1f, 4f));
        // A player-placed piece, carrying both signals.
        world.add(new Zdo("stone_wall_2x1", 10f, 2f, 10f)
            .withFloat("health", 500f).withLong("creator", 1234L));
        // Not a dictionary piece, but it has the property shape of one — the original heuristic
        // must still stand on its own.
        world.add(new Zdo("goblin_woodwall_1m", 12f, 2f, 12f)
            .withFloat("support", 100f).withLong("creator", 1234L));

        // Boundaries. A sapling carries Piece but no WearNTear; vegetation carries neither.
        world.add(new Zdo("sapling_carrot", 20f, 0f, 20f).withString("tag", ""));
        world.add(new Zdo("Birch1", 30f, 0f, 30f).withFloat("health", 80f));
        // A prefab the dictionary does not know at all stays unknown.
        world.add(new Zdo("NotAPrefabAnyoneShipped", 40f, 0f, 40f).withString("tag", ""));

        // Pieces that belong to a more specific category must keep it — every one of those
        // branches runs before the building check.
        world.add(new Zdo("piece_chest_wood", 50f, 0f, 50f).withString("items", ""));
        world.add(new Zdo("sign", 60f, 0f, 60f).withString("text", "Trader"));
        world.add(new Zdo("bed", 70f, 0f, 70f).withLong("owner", 99L));
        world.add(new Zdo("portal_wood", 80f, 0f, 80f).withString("tag", "home"));

        ZdoFlatStore store = parse(world);

        assertEquals(4, store.categoryCounts[Categories.BUILDING]);
        assertEquals(4, store.buildingCount);
        assertEquals(3, store.categoryCounts[Categories.UNKNOWN]);
        assertEquals(0, store.categoryCounts[Categories.NATURE]);
        assertEquals(1, store.categoryCounts[Categories.CONTAINER]);
        assertEquals(1, store.categoryCounts[Categories.SIGN]);
        assertEquals(1, store.categoryCounts[Categories.BED]);
        assertEquals(1, store.categoryCounts[Categories.PORTAL]);
    }

    // ----- Minimal world-file writer -----
    //
    // Mirrors exactly what WorldParser.parseZdo reads: header, then per ZDO a flag word, sector,
    // position, prefab hash and the property groups in their fixed order.

    private ZdoFlatStore parse(List<Zdo> zdos) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ByteBuffer header = ByteBuffer.allocate(28).order(ByteOrder.LITTLE_ENDIAN);
        header.putInt(WORLD_VERSION);
        header.putDouble(0.0);   // netTime
        header.putLong(0L);      // myId
        header.putInt(0);        // nextUid
        header.putInt(zdos.size());
        out.write(header.array());
        for (Zdo zdo : zdos) out.write(zdo.bytes());

        File dbFile = tempDir.resolve("classification.db").toFile();
        Files.write(dbFile.toPath(), out.toByteArray());
        return new WorldParser().parse(dbFile);
    }

    private static final class Zdo {
        private final int hash;
        private final float x, y, z;
        private final List<Object[]> floats = new ArrayList<>();
        private final List<Object[]> longs  = new ArrayList<>();
        private final List<Object[]> strings = new ArrayList<>();

        Zdo(String prefab, float x, float y, float z) {
            this.hash = WorldParser.sh(prefab);
            this.x = x; this.y = y; this.z = z;
        }

        Zdo withFloat(String key, float value)  { floats.add(new Object[]{key, value});  return this; }
        Zdo withLong(String key, long value)    { longs.add(new Object[]{key, value});   return this; }
        Zdo withString(String key, String value){ strings.add(new Object[]{key, value}); return this; }

        byte[] bytes() {
            int flags = 0;
            if (!floats.isEmpty())  flags |= 2;    // FLAG_FLOATS
            if (!longs.isEmpty())   flags |= 32;   // FLAG_LONGS
            if (!strings.isEmpty()) flags |= 64;   // FLAG_STRINGS

            ByteBuffer buf = ByteBuffer.allocate(1024).order(ByteOrder.LITTLE_ENDIAN);
            buf.putShort((short) flags);
            buf.putShort((short) 0);               // sector x
            buf.putShort((short) 0);               // sector z
            buf.putFloat(x); buf.putFloat(y); buf.putFloat(z);
            buf.putInt(hash);

            if (!floats.isEmpty()) {
                buf.put((byte) floats.size());
                for (Object[] f : floats) {
                    buf.putInt(WorldParser.sh((String) f[0]));
                    buf.putFloat((Float) f[1]);
                }
            }
            if (!longs.isEmpty()) {
                buf.put((byte) longs.size());
                for (Object[] l : longs) {
                    buf.putInt(WorldParser.sh((String) l[0]));
                    buf.putLong((Long) l[1]);
                }
            }
            if (!strings.isEmpty()) {
                buf.put((byte) strings.size());
                for (Object[] s : strings) {
                    buf.putInt(WorldParser.sh((String) s[0]));
                    byte[] utf8 = ((String) s[1]).getBytes(StandardCharsets.UTF_8);
                    // 7-bit varint length; the test strings are all well under 128 bytes.
                    buf.put((byte) utf8.length);
                    buf.put(utf8);
                }
            }

            byte[] record = new byte[buf.position()];
            buf.flip();
            buf.get(record);
            return record;
        }
    }
}
