import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    "shuttle_masters", Path(__file__).resolve().parents[1] / "shuttle_masters.py")
SHUTTLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SHUTTLE)


class KeeperSelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = {"sourceKey": "source", "completed": {
            "shot-a": {"file": "images/run/a.png", "sha256": "a" * 64,
                       "metadata": {"bytes": 10, "dimensions": [3840, 2160]}},
            "shot-b": {"file": "images/run/b.png", "sha256": "b" * 64,
                       "metadata": {"bytes": 20, "dimensions": [3840, 2160]}},
        }}
        self.worklist = {"schema": "steward-derivative-worklist/v1", "era": "era1",
                         "items": [{"id": "a", "source": "images/run/a.png",
                                    "sha256": "a" * 64, "dimensions": [3840, 2160]}]}
        self.path = self.root / "keepers.json"
        self.write()

    def tearDown(self):
        self.temp.cleanup()

    def write(self):
        self.path.write_text(json.dumps(self.worklist), encoding="utf-8")

    def test_selects_only_exact_keep_and_receipts_omissions(self):
        entries, selector = SHUTTLE.select_entries(self.state, self.path)
        self.assertEqual(["images/run/a.png"], [name for name, _entry in entries])
        self.assertEqual((1, 1), (selector["selected"], selector["omitted"]))
        self.assertEqual(SHUTTLE.sha256(self.path), selector["sha256"])

    def test_legacy_mode_selects_every_completed_master(self):
        entries, selector = SHUTTLE.select_entries(self.state)
        self.assertEqual(2, len(entries)); self.assertIsNone(selector)

    def test_remote_root_is_one_named_capture_campaign(self):
        self.assertEqual("/home/derek/valheim-capture/era1-run",
                         SHUTTLE.safe_remote_root("/home/derek/valheim-capture/era1-run"))
        for root in ("/home/derek/valheim-capture", "/home/derek/valheim-capture/..", "/"):
            with self.subTest(root=root), self.assertRaisesRegex(SystemExit, "named-campaign"):
                SHUTTLE.safe_remote_root(root)

    def test_rejects_unknown_source(self):
        self.worklist["items"][0]["source"] = "images/run/missing.png"; self.write()
        with self.assertRaisesRegex(SystemExit, "absent"):
            SHUTTLE.select_entries(self.state, self.path)

    def test_rejects_hash_or_dimensions_mismatch(self):
        self.worklist["items"][0]["sha256"] = "c" * 64; self.write()
        with self.assertRaisesRegex(SystemExit, "sha256"):
            SHUTTLE.select_entries(self.state, self.path)
        self.worklist["items"][0]["sha256"] = "a" * 64
        self.worklist["items"][0]["dimensions"] = [1, 1]; self.write()
        with self.assertRaisesRegex(SystemExit, "dimensions"):
            SHUTTLE.select_entries(self.state, self.path)

    def test_rejects_duplicate_or_unsafe_source(self):
        self.worklist["items"].append(dict(self.worklist["items"][0])); self.write()
        with self.assertRaisesRegex(SystemExit, "duplicate"):
            SHUTTLE.select_entries(self.state, self.path)
        self.worklist["items"] = [{"source": "../a.png", "sha256": "a" * 64,
                                    "dimensions": [3840, 2160]}]; self.write()
        with self.assertRaisesRegex(SystemExit, "unsafe"):
            SHUTTLE.select_entries(self.state, self.path)

    def test_rejects_control_character_or_noncanonical_source(self):
        for source in ("images/run/a.png\nother", "images//run/a.png", r"images\run\a.png"):
            with self.subTest(source=source):
                self.worklist["items"] = [{"source": source, "sha256": "a" * 64,
                                            "dimensions": [3840, 2160]}]
                self.write()
                with self.assertRaisesRegex(SystemExit, "unsafe"):
                    SHUTTLE.select_entries(self.state, self.path)


if __name__ == "__main__":
    unittest.main()
