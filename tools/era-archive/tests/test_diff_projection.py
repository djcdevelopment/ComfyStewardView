import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


TOOL = Path(__file__).resolve().parents[1] / "diff_projection.py"


def album(key, era, pieces, builder, photos=None):
    return {
        "buildKey": key,
        "era": era,
        "slug": f"era{era}",
        "label": f"Build {key}",
        "pieces": pieces,
        "contributors": [{"builderKey": builder, "pieces": pieces, "share": 1.0,
                            "evidence": "saved-piece-creator"}],
        "photos": photos or [],
        "attribution": "saved",
        "worldUrl": f"https://example/world/?era=era{era}&build={key}",
        "terrainStatus": "awaiting-runtime",
        "galleryUrl": None,
    }


def thread(key, name, eras):
    albums = [item for era in eras for item in era["albums"]]
    pieces = sum(sum(c["pieces"] for c in item["contributors"] if c["builderKey"] == key)
                 for item in albums)
    return {
        "builderKey": key,
        "displayName": name,
        "aliases": [name],
        "nameStatus": "recorded",
        "eras": eras,
        "albums": len(albums),
        "photos": sum(len(item["photos"]) for item in albums),
        "pieces": pieces,
        "tier": "Builder",
    }


def row(record):
    return {key: ([era["era"] for era in value] if key == "eras" else value)
            for key, value in record.items()}


class EraIntakeDiffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.old, self.new = root / "old", root / "new"
        (self.old / "threads").mkdir(parents=True)
        (self.new / "threads").mkdir(parents=True)

        old_album = album("old-build", 4, 20, "builder-one")
        self.before = thread("builder-one", "One", [{"era": 4, "albums": [old_album]}])
        new_album = album("new-build", 17, 30, "builder-one")
        self.after = thread("builder-one", "One", [
            {"era": 17, "albums": [new_album]}, {"era": 4, "albums": [old_album]}])
        only_album = album("only-build", 17, 40, "builder-two")
        self.only = thread("builder-two", "Two", [{"era": 17, "albums": [only_album]}])
        self.write_thread(self.old, self.before)
        self.write_thread(self.new, self.after)
        self.write_thread(self.new, self.only)

        photo17 = {"era": 17, "albums": 1, "albumsWithPhotos": 1, "photos": 3}
        photo4 = {"era": 4, "albums": 1, "albumsWithPhotos": 0, "photos": 0}
        common = {"schema": "steward-creator-directory/v1", "generatedAt": "old",
                  "unattributedAlbums": 0, "legacyImports": [{"slug": "era17"}]}
        self.old_directory = {**common, "builders": [row(self.before)],
                              "eras": [{"era": 4, "constructionPieces": 20}],
                              "photography": {"eras": [photo4, photo17], "photos": 3,
                                              "albumsWithPhotos": 1, "buildersWithPhotos": 1}}
        self.new_directory = copy.deepcopy(self.old_directory)
        self.new_directory.update({"generatedAt": "new", "builders": [row(self.after), row(self.only)],
                                   "eras": [{"era": 4, "constructionPieces": 20},
                                            {"era": 17, "constructionPieces": 70}]})
        self.new_directory["photography"]["eras"][1]["albums"] = 3
        self.write_directories()

    def tearDown(self):
        self.temp.cleanup()

    def write_thread(self, root, value):
        (root / "threads" / f"{value['builderKey']}.json").write_text(
            json.dumps(value), encoding="utf-8")

    def write_directories(self):
        (self.old / "directory.json").write_text(json.dumps(self.old_directory), encoding="utf-8")
        (self.new / "directory.json").write_text(json.dumps(self.new_directory), encoding="utf-8")

    def run_diff(self):
        return subprocess.run([sys.executable, str(TOOL), str(self.old), str(self.new),
                               "--allow-era-intake", "17"], text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    def run_default_diff(self):
        return subprocess.run([sys.executable, str(TOOL), str(self.old), str(self.new)],
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    def test_accepts_only_new_era_analysis(self):
        result = self.run_diff()
        self.assertEqual(0, result.returncode, result.stdout)
        self.assertIn("2 new album(s)", result.stdout)

    def test_default_capture_mode_still_rejects_unphotographed_intake(self):
        result = self.run_default_diff()
        self.assertNotEqual(0, result.returncode)
        self.assertIn("new thread with an unphotographed album", result.stdout)

    def test_accepts_name_observations_and_derived_portrait_change(self):
        self.after.update({"displayName": "One New", "aliases": ["One", "One New"],
                           "nameStatus": "ambiguous", "portrait": {"tile": "new"}})
        self.new_directory["builders"][0] = row(self.after)
        self.write_thread(self.new, self.after); self.write_directories()
        result = self.run_diff()
        self.assertEqual(0, result.returncode, result.stdout)

    def test_rejects_change_to_existing_album(self):
        self.after["eras"][1]["albums"][0]["label"] = "rewritten"
        self.write_thread(self.new, self.after)
        result = self.run_diff()
        self.assertNotEqual(0, result.returncode)
        self.assertIn("existing album changed", result.stdout)

    def test_rejects_photography_change(self):
        self.new_directory["photography"]["photos"] = 4
        self.write_directories()
        result = self.run_diff()
        self.assertNotEqual(0, result.returncode)
        self.assertIn("photography total changed", result.stdout)

    def test_rejects_album_from_another_era(self):
        self.after["eras"][0]["albums"][0]["era"] = 16
        self.write_thread(self.new, self.after)
        result = self.run_diff()
        self.assertNotEqual(0, result.returncode)
        self.assertIn("added album is not intake era", result.stdout)


class JudgedCaptureDiffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.old, self.new = root / "old", root / "new"
        (self.old / "threads").mkdir(parents=True); (self.new / "threads").mkdir(parents=True)
        self.old_manifest, self.new_manifest = root / "old-capture.json", root / "new-capture.json"
        self.verdict_receipt = root / "pair-verdicts.json"
        receipt = {"schema": "steward-pair-verdicts/v2", "era": "era1",
                   "sourceKey": "source", "verdicts": [{"buildKey": "build"}]}
        self.verdict_receipt.write_text(json.dumps(receipt), encoding="utf-8")
        self.photo1 = {"id": "p1", "thumb": "https://x/p1t", "large": "https://x/p1",
                       "href": "https://x/#b", "label": "B", "shot": "one"}
        self.photo2 = {"id": "p2", "thumb": "https://x/p2t", "large": "https://x/p2",
                       "href": "https://x/#b", "label": "B", "shot": "two"}
        before_album = album("build", 1, 20, "builder", [self.photo1, self.photo2])
        after_album = copy.deepcopy(before_album); after_album["photos"] = [self.photo2]
        self.before = thread("builder", "Builder", [{"era": 1, "albums": [before_album]}])
        self.after = thread("builder", "Builder", [{"era": 1, "albums": [after_album]}])
        self.write_projection(self.old, self.before, 2)
        self.write_projection(self.new, self.after, 1)
        base = {"schema": "steward-capture-gallery/v1", "era": "era1", "sourceKey": "source",
                "rejectedBuilds": [], "albums": 1}
        self.old_capture = {**base, "judged": False, "photographs": 2,
                            "builds": {"build": [self.photo1, self.photo2]}}
        self.new_capture = {**base, "judged": True, "photographs": 1,
                            "judgement": {"complete": True, "judgedBuilds": ["build"],
                                          "unjudgedBuilds": [],
                                          "receipt": {"path": str(self.verdict_receipt),
                                                      "bytes": self.verdict_receipt.stat().st_size,
                                                      "sha256": hashlib.sha256(self.verdict_receipt.read_bytes()).hexdigest()}},
                            "builds": {"build": [self.photo2]}}
        self.write_manifests()

    def tearDown(self):
        self.temp.cleanup()

    def write_projection(self, root, record, photos):
        (root / "threads" / "builder.json").write_text(json.dumps(record), encoding="utf-8")
        directory = {"schema": "steward-creator-directory/v1", "generatedAt": str(photos),
                     "builders": [row(record)], "eras": [{"era": 1}],
                     "photography": {"eras": [{"era": 1, "albums": 1,
                                                "albumsWithPhotos": 1, "photos": photos}],
                                     "photos": photos, "albumsWithPhotos": 1,
                                     "buildersWithPhotos": 1},
                     "unattributedAlbums": 0, "legacyImports": []}
        (root / "directory.json").write_text(json.dumps(directory), encoding="utf-8")

    def write_manifests(self):
        self.old_manifest.write_text(json.dumps(self.old_capture), encoding="utf-8")
        self.new_manifest.write_text(json.dumps(self.new_capture), encoding="utf-8")

    def run_diff(self):
        return subprocess.run([sys.executable, str(TOOL), str(self.old), str(self.new),
                               "--capture-transition", str(self.old_manifest), str(self.new_manifest)],
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    def test_accepts_photo_removal_proved_by_judged_manifest(self):
        result = self.run_diff()
        self.assertEqual(0, result.returncode, result.stdout)
        self.assertIn("-1 photograph(s)", result.stdout)

    def test_rejects_unjudged_new_manifest(self):
        self.new_capture["judged"] = False; self.write_manifests()
        result = self.run_diff()
        self.assertNotEqual(0, result.returncode)
        self.assertIn("not judged", result.stdout)

    def test_rejects_unrelated_album_change(self):
        self.after["eras"][0]["albums"][0]["label"] = "rewritten"
        self.write_projection(self.new, self.after, 1)
        result = self.run_diff()
        self.assertNotEqual(0, result.returncode)
        self.assertIn("non-photo album field changed", result.stdout)

    def test_rejects_unrelated_portrait_change(self):
        self.after["portrait"] = {"tile": "changed", "take": "s1"}
        self.write_projection(self.new, self.after, 1)
        result = self.run_diff()
        self.assertNotEqual(0, result.returncode)
        self.assertIn("non-photo thread field changed", result.stdout)

    def test_rejects_capture_manifest_count_mismatch(self):
        self.new_capture["photographs"] = 2; self.write_manifests()
        result = self.run_diff()
        self.assertNotEqual(0, result.returncode)
        self.assertIn("capture photograph count", result.stdout)

    def test_rejects_incomplete_or_modified_verdict_provenance(self):
        self.new_capture["judgement"]["complete"] = False
        self.new_capture["judgement"]["unjudgedBuilds"] = ["missing"]
        self.write_manifests()
        result = self.run_diff()
        self.assertNotEqual(0, result.returncode)
        self.assertIn("judgement is incomplete", result.stdout)
        self.new_capture["judgement"]["complete"] = True
        self.new_capture["judgement"]["unjudgedBuilds"] = []
        self.verdict_receipt.write_text("changed", encoding="utf-8")
        self.write_manifests()
        result = self.run_diff()
        self.assertNotEqual(0, result.returncode)
        self.assertIn("verdict receipt provenance failed", result.stdout)


if __name__ == "__main__":
    unittest.main()
