import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "am4_terrain_cache.py"
SPEC = importlib.util.spec_from_file_location("am4_terrain_cache", SCRIPT)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class Am4TerrainCacheTests(unittest.TestCase):
    def test_capture_handoff_requires_terminal_idle_capture(self):
        self.assertEqual((True, "capture-complete"), runner.capture_handoff(
            {"state": "complete"}, False, False))
        self.assertEqual((True, "capture-natural-limit"), runner.capture_handoff(
            {"state": "stopped", "reason": "output-limit"}, False, False))
        self.assertEqual((False, "capture-or-game-active"), runner.capture_handoff(
            {"state": "complete"}, True, False))
        self.assertEqual((False, "operator-stop"), runner.capture_handoff(
            {"state": "stopped", "reason": "operator-stop"}, False, False))

    def test_png_size_reads_ihdr(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "cache"
            path.write_bytes(b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" +
                             struct.pack(">II", 2048, 2048))
            self.assertEqual((2048, 2048), runner.png_size(path))


if __name__ == "__main__":
    unittest.main()
