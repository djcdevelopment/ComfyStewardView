import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location("deploy_world_terrain", ROOT / "deploy_world_terrain.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DeployWorldTerrainTests(unittest.TestCase):
    def context(self, root):
        variant = root / "terrain-detail.png"
        variant.write_bytes(b"png")
        height = root / "terrain-height.r16"
        height.write_bytes(bytes(range(8)))
        record = lambda path: {
            "file": path.name, "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        manifest = {
            "schemaVersion": 3, "kind": "steward-terrain-context",
            "snapshot": {"id": 1006, "sha256": "a" * 64},
            "variants": [record(variant)],
            "heightfield": {**record(height), "width": 2, "height": 2, "encoding": "uint16-le"},
        }
        (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    def test_accepts_a_complete_schema_three_context(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.context(root)
            manifest, files = MODULE.validate_terrain_context(root)
            self.assertEqual(1006, manifest["snapshot"]["id"])
            self.assertEqual(
                ["manifest.json", "terrain-detail.png", "terrain-height.r16"],
                [path.name for path in files])

    def test_rejects_undeclared_context_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.context(root)
            (root / "surprise.bin").write_bytes(b"drift")
            with self.assertRaisesRegex(ValueError, "file set drift"):
                MODULE.validate_terrain_context(root)

    def test_remote_program_compiles_and_uses_hardlink_clone(self):
        compile(MODULE.REMOTE, "<deploy-world-terrain-remote>", "exec")
        self.assertIn("copy_function=os.link", MODULE.REMOTE)
        self.assertIn("os.replace(candidate,path)", MODULE.REMOTE)
        self.assertIn("(staging/'context').rmdir();staging.rmdir()", MODULE.REMOTE)
        self.assertIn("'catalogTransferred':False", MODULE.REMOTE)
        self.assertIn("'imageBuilt':False", MODULE.REMOTE)
        self.assertNotIn("docker','build", MODULE.REMOTE)


if __name__ == "__main__":
    unittest.main()
