package com.valheim.viewer.parser;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** Reads the length-delimited pre-v31 format without loading or upgrading a world in Valheim.
 * Property payloads are retained verbatim; only framing/counts and quaternion orientation are
 * adapted to the existing compact decoder. No game-side property stripping is performed.
 * Formats 26–30 share one package layout; the only difference is that the byte-array group
 * (the seventh) arrived at v27, so a v26 package carries six counts instead of seven.
 */
final class LegacyZdoDecoder {
    /** Revisions, persistent, owner, ticks, pgwVersion, type, distant, prefab, sector, position, quaternion. */
    static final int FIXED_BYTES = 71;
    private ByteBuffer output = ByteBuffer.allocate(4096).order(ByteOrder.LITTLE_ENDIAN);

    static int groups(int version) { return version >= 27 ? 7 : 6; }

    ByteBuffer next(ByteBuffer world, int version) {
        if (version < WorldParser.MIN_WORLD_VERSION || version > 30) throw new IllegalArgumentException("Unsupported legacy version " + version);
        world.getLong(); // Saved ZDO user ID; construction attribution is the creator property.
        world.getInt();
        int length = world.getInt();
        int groups = groups(version);
        if (length < FIXED_BYTES + groups || length > world.remaining()) throw new IllegalArgumentException("Invalid legacy ZDO package length " + length);
        ByteBuffer body = world.slice().order(ByteOrder.LITTLE_ENDIAN);
        body.limit(length);
        world.position(world.position() + length);
        if (output.capacity() < length + 64) output = ByteBuffer.allocate(Math.addExact(length, 64)).order(ByteOrder.LITTLE_ENDIAN);
        output.clear();
        body.getInt(); body.getInt(); // network revisions
        boolean persistent = body.get() != 0;
        body.getLong(); body.getLong(); body.getInt(); // network owner, creation ticks, generation
        int type = body.get() & 3;
        boolean distant = body.get() != 0;
        int prefab = body.getInt();
        int sx = body.getInt(), sz = body.getInt();
        float x = body.getFloat(), y = body.getFloat(), z = body.getFloat();
        float[] rotation = eulerZxy(body.getFloat(), body.getFloat(), body.getFloat(), body.getFloat());
        int flags = 0x1000 | (persistent ? 0x100 : 0) | (distant ? 0x200 : 0) | (type << 10);
        output.putShort((short) flags);
        output.putShort((short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, sx)));
        output.putShort((short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, sz)));
        output.putFloat(x).putFloat(y).putFloat(z).putInt(prefab);
        for (float angle : rotation) output.putFloat(angle);
        int[] strides = {8, 16, 20, 8, 12, 0, -1};
        for (int group = 0; group < groups; group++) {
            int count = readCount(body);
            if (count == 0) continue;
            flags |= 2 << group;
            putCount(output, count);
            int start = body.position();
            if (strides[group] > 0) {
                skip(body, Math.multiplyExact(count, strides[group]));
            } else {
                for (int i = 0; i < count; i++) {
                    body.getInt();
                    int bytes = group == 5 ? stringLength(body) : body.getInt();
                    skip(body, bytes);
                }
            }
            int end = body.position();
            ByteBuffer values = body.duplicate();
            values.position(start).limit(end);
            output.put(values);
        }
        if (body.hasRemaining()) throw new IllegalArgumentException("Unconsumed legacy ZDO bytes: " + body.remaining());
        output.putShort(0, (short) flags);
        output.flip();
        return output;
    }

    private static void skip(ByteBuffer input, int bytes) {
        if (bytes < 0 || bytes > input.remaining()) throw new IllegalArgumentException("Property exceeds its ZDO package");
        input.position(input.position() + bytes);
    }

    // BinaryWriter.Write(char) uses UTF-8, rather than a fixed uint16 or plain byte.
    private static int readCount(ByteBuffer input) {
        int first = input.get() & 255;
        if (first < 128) return first;
        int following = (first & 0xe0) == 0xc0 ? 1 : (first & 0xf0) == 0xe0 ? 2 : -1;
        if (following < 0) throw new IllegalArgumentException("Invalid legacy property count");
        int value = first & (following == 1 ? 31 : 15);
        for (int i = 0; i < following; i++) {
            int b = input.get() & 255;
            if ((b & 0xc0) != 0x80) throw new IllegalArgumentException("Invalid legacy count continuation");
            value = (value << 6) | (b & 63);
        }
        if (value > 32767 || value < (following == 1 ? 128 : 2048)) throw new IllegalArgumentException("Invalid legacy property count");
        return value;
    }

    private static void putCount(ByteBuffer target, int count) {
        target.put((byte) (count < 128 ? count : (count >>> 8) | 128));
        if (count >= 128) target.put((byte) count);
    }

    private static int stringLength(ByteBuffer input) {
        int value = 0;
        for (int shift = 0; shift < 35; shift += 7) {
            int b = input.get() & 255;
            if (shift == 28 && (b & 0xf8) != 0) throw new IllegalArgumentException("Invalid string length");
            value |= (b & 127) << shift;
            if ((b & 128) == 0) return value;
        }
        throw new IllegalArgumentException("Invalid string length");
    }

    /** Unity uses Z-X-Y Euler composition, with angles expressed in degrees. */
    static float[] eulerZxy(double x, double y, double z, double w) {
        double n = x*x + y*y + z*z + w*w;
        if (!Double.isFinite(n) || n < 1e-12) throw new IllegalArgumentException("Invalid legacy rotation quaternion");
        double k = 2 / n;
        double sx = Math.max(-1, Math.min(1, k * (w*x - y*z)));
        double ax = Math.asin(sx), ay, az;
        if (Math.abs(sx) < 0.9999999) {
            ay = Math.atan2(k * (x*z + w*y), 1 - k * (x*x + y*y));
            az = Math.atan2(k * (x*y + w*z), 1 - k * (x*x + z*z));
        } else {
            ay = Math.atan2(k * (w*y - x*z), 1 - k * (y*y + z*z));
            az = 0;
        }
        return new float[]{degrees(ax), degrees(ay), degrees(az)};
    }

    private static float degrees(double radians) {
        double angle = Math.toDegrees(radians);
        return (float) (angle < 0 ? angle + 360 : angle);
    }
}
