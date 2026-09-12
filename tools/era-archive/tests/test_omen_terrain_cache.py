import importlib.util
import gzip
from pathlib import Path
import struct
import tempfile
import unittest
import zlib


SCRIPT = Path(__file__).parents[1] / "omen_terrain_cache.py"
SPEC = importlib.util.spec_from_file_location("omen_terrain_cache", SCRIPT)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class OmenTerrainCacheTests(unittest.TestCase):
    def test_png_size_reads_ihdr(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "cache"
            path.write_bytes(b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", 2048, 2048))
            self.assertEqual((2048, 2048), runner.png_size(path))

    def test_verify_file_rejects_changed_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "world.db"
            path.write_bytes(b"before")
            expected = runner.stamp(path)
            path.write_bytes(b"after")
            with self.assertRaisesRegex(ValueError, "does not match"):
                runner.verify_file(path, expected, "world")

    def test_current_color_cache_becomes_north_up_png(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "cacheMinimapBiome"
            # Unity rows are south-to-north. The PNG contract is north-up.
            path.write_bytes(gzip.compress(bytes((1, 2, 3, 4, 5, 6, 7, 8,
                                                  9, 10, 11, 12, 13, 14, 15, 16))))
            png = runner.color_cache_png(path, width=2, height=2, rgb=True)
            self.assertEqual((2, 2), self._png_dimensions(png))
            self.assertEqual(bytes((0, 9, 10, 11, 13, 14, 15,
                                    0, 1, 2, 3, 5, 6, 7)), self._png_scanlines(png))

    def test_current_half_float_height_matches_legacy_encoding(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "cacheMinimapHeight"
            # The second Unity row becomes the first PNG row.
            raw = b"".join(struct.pack("<e", value) for value in (-1.0, 30.0, 1.5, 600.0))
            path.write_bytes(gzip.compress(raw))
            png = runner.height_cache_png(path, width=2, height=2)
            encoded_1_5 = int(1.5 * runner.HEIGHT_SCALE)
            self.assertEqual(bytes((0, encoded_1_5 >> 8, encoded_1_5 & 255, 0, 255,
                                    254, 1, 0, 255,
                                    0, 0, 0, 0, 255,
                                    14, 241, 0, 255)), self._png_scanlines(png))

    def test_current_metadata_is_bound_to_world_seed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fwl = root / "world.fwl"
            name = b"World"
            seed_name = b"Seed"
            payload = (struct.pack("<i", 37) + bytes((len(name),)) + name
                       + bytes((len(seed_name),)) + seed_name + struct.pack("<i", 1234))
            fwl.write_bytes(struct.pack("<i", len(payload)) + payload)
            meta = root / "cacheMinimapMeta"
            meta.write_bytes(struct.pack("<ii", 1234, 1))
            self.assertEqual({"seed": 1234, "version": 1}, runner.verify_current_meta(meta, fwl))
            meta.write_bytes(struct.pack("<ii", 9999, 1))
            with self.assertRaisesRegex(ValueError, "does not match world seed"):
                runner.verify_current_meta(meta, fwl)

    @staticmethod
    def _png_dimensions(png):
        return struct.unpack(">II", png[16:24])

    @staticmethod
    def _png_scanlines(png):
        offset = 8
        compressed = bytearray()
        while offset < len(png):
            length = struct.unpack_from(">I", png, offset)[0]
            kind = png[offset + 4:offset + 8]
            payload = png[offset + 8:offset + 8 + length]
            if kind == b"IDAT":
                compressed.extend(payload)
            offset += 12 + length
        return zlib.decompress(compressed)


if __name__ == "__main__":
    unittest.main()
