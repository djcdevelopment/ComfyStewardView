import importlib.util
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "am4_biome_context.py"
SPEC = importlib.util.spec_from_file_location("am4_biome_context", SCRIPT)
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class Am4BiomeContextTests(unittest.TestCase):
    def test_existing_context_must_have_a_verified_schema_three_heightfield(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            height = root / "terrain-height.r16"
            height.write_bytes(bytes(range(8)))
            with self.assertRaisesRegex(ValueError, "not schema 3"):
                builder.require_heightfield({"schemaVersion": 2}, root)
            manifest = {"schemaVersion": 3, "heightfield": {
                "file": height.name, "width": 2, "height": 2, "encoding": "uint16-le",
                "bytes": height.stat().st_size, "sha256": builder.sha256(height),
            }}
            self.assertEqual(height.name, builder.require_heightfield(manifest, root)["file"])

    def test_runtime_versions_use_loaded_world_generator(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "Player.log"
            path.write_text("Running under Unity v6000.0.61.7643309\n"
                            "Valheim version: 0.221.12 (network version 36)\n"
                            "Worldgenerator version setup:2\n"
                            "Worldgenerator version setup:1\n", encoding="utf-8")
            self.assertEqual({"gameVersion": "0.221.12", "unityVersion": "6000.0.61.7643309",
                              "worldGeneratorVersion": 1}, builder.runtime_versions(path))


if __name__ == "__main__":
    unittest.main()
