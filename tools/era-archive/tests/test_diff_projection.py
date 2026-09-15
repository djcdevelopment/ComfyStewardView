import copy
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


if __name__ == "__main__":
    unittest.main()
