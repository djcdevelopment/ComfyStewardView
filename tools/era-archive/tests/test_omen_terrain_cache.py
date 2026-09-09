import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest


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


if __name__ == "__main__":
    unittest.main()
