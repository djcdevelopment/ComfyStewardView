import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location("deploy_world_code", ROOT / "deploy_world_code.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DeployWorldCodeTests(unittest.TestCase):
    def test_accepts_a_thin_application_jar(self):
        with tempfile.TemporaryDirectory() as temporary:
            jar = Path(temporary) / "application.jar"
            with zipfile.ZipFile(jar, "w") as archive:
                for name in MODULE.REQUIRED_ENTRIES:
                    archive.writestr(name, b"x" * 20_000)
            self.assertEqual(jar.resolve(), MODULE.validate_thin_jar(jar))

    def test_rejects_a_shaded_sized_jar(self):
        with tempfile.TemporaryDirectory() as temporary:
            jar = Path(temporary) / "shaded.jar"
            with jar.open("wb") as stream:
                stream.truncate(6_000_000)
            with self.assertRaisesRegex(ValueError, "thin application JAR"):
                MODULE.validate_thin_jar(jar)

    def test_remote_program_compiles_and_keeps_bundle_immutable(self):
        compile(MODULE.REMOTE, "<deploy-world-code-remote>", "exec")
        self.assertIn("catalogTransferred':False", MODULE.REMOTE)
        self.assertIn("imageBuilt':False", MODULE.REMOTE)
        self.assertIn("application[release_flag+1]=settings['release']", MODULE.REMOTE)
        self.assertNotIn("docker','build", MODULE.REMOTE)


if __name__ == "__main__":
    unittest.main()
