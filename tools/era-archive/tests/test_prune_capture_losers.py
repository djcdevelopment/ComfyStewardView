import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("prune_capture_losers", ROOT / "prune_capture_losers.py")
PRUNE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PRUNE)


class PrunePlanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.dest = self.root / "masters"
        keeper = self.dest / "images" / "run" / "keep.png"
        keeper.parent.mkdir(parents=True); keeper.write_bytes(b"keeper")
        loser = b"loser"
        self.state = {"sourceKey": "source", "completed": {
            "keep": {"file": "images/run/keep.png", "sha256": PRUNE.sha256(keeper),
                     "metadata": {"bytes": keeper.stat().st_size, "dimensions": [4, 4]}},
            "lose": {"file": "images/run/lose.png",
                     "sha256": __import__("hashlib").sha256(loser).hexdigest(),
                     "metadata": {"bytes": len(loser), "dimensions": [4, 4]}},
        }}
        self.state_path = self.root / "state.json"
        self.worklist_path = self.root / "worklist.json"
        self.relocation_path = self.root / "relocation.json"
        self.state_path.write_text(json.dumps(self.state), encoding="utf-8")
        self.worklist = {"schema": "steward-derivative-worklist/v1", "era": "era1",
                         "items": [{"id": "keep", "source": "images/run/keep.png",
                                    "sha256": self.state["completed"]["keep"]["sha256"],
                                    "dimensions": [4, 4]}]}
        self.worklist_path.write_text(json.dumps(self.worklist), encoding="utf-8")
        _entries, selector = PRUNE.select_entries(self.state, self.worklist_path)
        self.relocation = {"schema": "steward-master-relocation/v1", "sourceKey": "source",
                           "remoteRoot": "/home/derek/valheim-capture/era1-run",
                           "selector": selector, "moved": [{"file": "images/run/keep.png",
                           "sha256": self.state["completed"]["keep"]["sha256"], "bytes": 6}]}
        self.write_relocation()

    def tearDown(self):
        self.temp.cleanup()

    def write_relocation(self):
        self.relocation_path.write_text(json.dumps(self.relocation), encoding="utf-8")

    def plan(self):
        return PRUNE.plan_prune(self.state_path, self.worklist_path, self.relocation_path,
                                self.dest, "/home/derek/valheim-capture/era1-run")

    def test_plan_names_only_unselected_completed_master(self):
        plan = self.plan()
        self.assertFalse(plan["executed"])
        self.assertEqual(1, plan["keepersVerified"])
        self.assertEqual(["images/run/lose.png"], [row["file"] for row in plan["candidates"]])

    def test_refuses_incomplete_relocation_receipt(self):
        self.relocation["moved"] = []; self.write_relocation()
        with self.assertRaisesRegex(SystemExit, "exactly the final keepers"):
            self.plan()

    def test_refuses_missing_or_modified_local_keeper(self):
        (self.dest / "images" / "run" / "keep.png").write_bytes(b"changed")
        with self.assertRaisesRegex(SystemExit, "failed verification"):
            self.plan()

    def test_refuses_broad_remote_root(self):
        with self.assertRaisesRegex(SystemExit, "named-campaign"):
            PRUNE.plan_prune(self.state_path, self.worklist_path, self.relocation_path,
                             self.dest, "/home/derek/valheim-capture")

    def test_refuses_parent_remote_root(self):
        with self.assertRaisesRegex(SystemExit, "named-campaign"):
            PRUNE.plan_prune(self.state_path, self.worklist_path, self.relocation_path,
                             self.dest, "/home/derek/valheim-capture/..")


if __name__ == "__main__":
    unittest.main()
