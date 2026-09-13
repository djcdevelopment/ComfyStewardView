import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]))
import rank_frames


def pose(name, index, vetoes=(), placed=(0, 0, 0), forecast=0.5, sky=0.2, luma=0.5):
    file = f"images/run/{index:04d}_{name}.png"
    return {"shot": name, "incumbent": name, "winner": name, "needs": None, "rounds": 0, "path": [name],
            "winnerFile": file, "winnerShotKey": "key-" + name, "forecast": {"rank": forecast},
            "files": {name: file}, "placed": {name: list(placed)},
            "metrics": {name: {"score": 0.01, "vetoes": list(vetoes), "skyFraction": sky, "lumaMean": luma}}}


class RankFramesTests(unittest.TestCase):
    """A pruner, not a picker: the veto and the duplicate rule drop frames, the planner's
    forecast and the eye-favoured statistics only order what is left, and a build with no
    survivor is named for a reshoot rather than silently published empty."""

    def test_veto_then_duplicates_then_order_then_top_n(self):
        poses = {p["shot"]: p for p in [
            pose("detail1", 1, placed=(0, 0, 0), forecast=0.9),
            pose("detail2", 2, vetoes=("sky",), placed=(50, 0, 0), forecast=0.8, sky=0.9),
            pose("detail3", 3, placed=(0.5, 0, 0.5), forecast=0.7),        # within 1 m of detail1
            pose("detail4", 4, placed=(100, 0, 0), forecast=0.95),
            pose("sky1", 5, placed=(150, 0, 0), forecast=0.3, sky=0.4, luma=0.6),
            pose("far1", 6, placed=(200, 0, 0), forecast=0.2),
        ]}
        refine = {"schema": "steward-refine/v3", "era": "era1", "sourceKey": "s", "builds": {"b" * 64: {**poses["detail1"], "poses": poses}}}
        ranking = rank_frames.rank(refine, 3)
        build = ranking["builds"]["b" * 64]
        self.assertEqual(["detail4", "detail1", "sky1"], [f["name"] for f in build["kept"]])
        self.assertEqual([1, 2, 3], [f["order"] for f in build["kept"]])
        reasons = {d["name"]: d["reason"] for d in build["dropped"]}
        self.assertEqual("vetoed:sky", reasons["detail2"])
        self.assertEqual("duplicate of detail1", reasons["detail3"])
        self.assertEqual("beyond the top 3", reasons["far1"])
        self.assertFalse(build["reshoot"])
        self.assertEqual({"builds": 1, "candidates": 6, "kept": 3, "reshoot": [], "pairs": 1}, ranking["summary"])

    def test_a_build_with_no_survivor_is_a_reshoot_and_v2_records_still_rank(self):
        gone = pose("detail1", 1, vetoes=("no-texture",))
        v2 = {"shot": "detail1", "incumbent": "detail1", "winner": "detail1~aim", "needs": None, "rounds": 1,
              "path": ["detail1", "detail1~aim"], "winnerFile": "images/run/0002_detail1~aim.png", "winnerShotKey": "w",
              "metrics": {"detail1": {"score": 0.001, "vetoes": []}, "detail1~aim": {"score": 0.002, "vetoes": []}}}
        refine = {"schema": "steward-refine/v2", "era": "era11", "sourceKey": "s",
                  "builds": {"a" * 64: {**gone, "poses": {"detail1": gone}}, "c" * 64: v2}}
        ranking = rank_frames.rank(refine, 2)
        self.assertEqual(["a" * 64], ranking["summary"]["reshoot"])
        # A v2 record only knows the winner's file; the other frame is dropped for want of a master.
        old = ranking["builds"]["c" * 64]
        self.assertEqual(["detail1~aim"], [f["name"] for f in old["kept"]])
        self.assertIn("no master on disk", {d["reason"] for d in old["dropped"]})

    def test_keepers_worklist_carries_the_journal_digest(self):
        poses = {"detail1": pose("detail1", 1)}
        ranking = rank_frames.rank({"schema": "steward-refine/v3", "era": "era1", "sourceKey": "s",
                                    "builds": {"b" * 64: {**poses["detail1"], "poses": poses}}}, 3)
        state = {"completed": {"key-detail1": {"file": "images/run/0001_detail1.png", "sha256": "f" * 64,
                                               "metadata": {"dimensions": [3840, 2160]}}}}
        with tempfile.TemporaryDirectory() as temp:
            work = rank_frames.keepers_worklist(ranking, state, Path(temp))
        self.assertEqual("steward-derivative-worklist/v1", work["schema"])
        self.assertEqual([{"id": "era1-bbbbbbbbbbbb-detail1", "source": "images/run/0001_detail1.png",
                           "sha256": "f" * 64, "dimensions": [3840, 2160]}], work["items"])


if __name__ == "__main__":
    unittest.main()
