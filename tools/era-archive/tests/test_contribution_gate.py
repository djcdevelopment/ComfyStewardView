"""The release gate admits only the chosen cutoff, not incidental archive drift."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from gate_contribution_threshold import audit, photo_and_album_counts, public_header, thread_expected
from gallery import classify_volume_tier, project


def album(key, pieces, own, photos=(), evidence=None):
    credit = {"builderKey": "a" * 32, "pieces": own}
    if evidence:
        credit["evidence"] = evidence
    return {"buildKey": key * 64, "era": 4, "pieces": pieces,
            "contributors": [credit], "photos": [{"id": p} for p in photos]}


def thread(key, albums):
    pieces = sum(a["contributors"][0]["pieces"] or 0 for a in albums)
    return {"builderKey": key, "displayName": key[:4], "aliases": [],
            "nameStatus": "recorded", "eras": [{"era": 4, "albums": albums}],
            "albums": len(albums), "photos": sum(len(a["photos"]) for a in albums),
            "pieces": pieces, "tier": classify_volume_tier(pieces)}


def write_projection(root, threads, unattributed=4):
    paths = {}
    for key, entry in threads.items():
        path = f"threads/{key}.json"
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(entry), encoding="utf-8")
        paths[path] = hashlib.sha256(target.read_bytes()).hexdigest()
    directory = {"schema": "steward-creator-directory/v1", "generatedAt": "now",
                 "builders": sorted((public_header(t) for t in threads.values()),
                                    key=lambda b: (b["displayName"].casefold(), b["builderKey"])),
                 "eras": [4], "legacyImports": [], "unattributedAlbums": unattributed,
                 "photography": photo_and_album_counts(threads, threads)}
    target = root / "directory.json"
    target.write_text(json.dumps(directory), encoding="utf-8")
    paths["directory.json"] = hashlib.sha256(target.read_bytes()).hexdigest()
    unique = {a["buildKey"] for t in threads.values() for group in t["eras"] for a in group["albums"]}
    (root / "receipt.json").write_text(json.dumps({"builders": len(threads),
        "albums": len(unique), "files": [{"path": p, "sha256": sha} for p, sha in paths.items()]}), encoding="utf-8")
    return directory


def add_asset(root, path, data):
    target = root / path
    target.write_bytes(data)
    receipt_path = root / "receipt.json"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    record = next((f for f in receipt["files"] if f["path"] == path), None)
    if record is None:
        record = {"path": path}
        receipt["files"].append(record)
    record["sha256"] = hashlib.sha256(data).hexdigest()
    receipt_path.write_text(json.dumps(receipt), encoding="utf-8")


class ThresholdGateTests(unittest.TestCase):
    def test_projection_keeps_searchable_identity_and_archive_photo(self):
        with tempfile.TemporaryDirectory() as temp:
            previous, candidate = Path(temp) / "old", Path(temp) / "new"
            a, b = "a" * 32, "b" * 32
            photographed = {"id": "p1", "thumb": "https://pics.example/t.webp",
                            "large": "https://pics.example/l.webp", "href": "https://pics.example/",
                            "label": "Little shed"}
            document = {"generatedAt": "now", "eras": [4], "legacyImports": [],
                "builders": [{"builderKey": key, "displayName": key[:4], "aliases": [],
                    "nameStatus": "recorded", "builds": [build_key]}
                    for key, build_key in ((a, "1" * 64), (b, "2" * 64))],
                "builds": [{"buildKey": key, "era": 4, "slug": "era4", "label": label,
                    "pieces": pieces, "contributors": [{"builderKey": builder,
                        "pieces": pieces, "share": 1.0}], "photos": photos}
                    for key, builder, label, pieces, photos in (
                        ("1" * 64, a, "Little shed", 19, [photographed]),
                        ("2" * 64, b, "Workshop", 20, []))]}
            project(document, previous, "https://world.example/", min_build_pieces=10,
                    min_builder_pieces=10)
            project(document, candidate, "https://world.example/", retain_empty_from=previous)
            result = audit(previous, candidate, {"tiles": []})
            self.assertEqual((2, 1, 1), (result["builders"], result["empty_profiles"], result["photographs"]))
            self.assertEqual(1, result["photographed_builders"])
            self.assertEqual([], json.loads((candidate / "threads" / f"{a}.json").read_text())["eras"])

    def test_exact_twenty_boundary_and_historical_import(self):
        old = thread("a" * 32, [album("1", 100, 19), album("2", 100, 20, ["photo"]),
                               album("3", 500, None, ["legacy"], "legacy-leading-contributor")])
        expected = thread_expected(old)
        self.assertEqual(["2" * 64, "3" * 64], [a["buildKey"] for a in expected["eras"][0]["albums"]])
        self.assertEqual((2, 2, 20), (expected["albums"], expected["photos"], expected["pieces"]))

    def test_real_audit_retains_empty_identity_and_public_photographs(self):
        with tempfile.TemporaryDirectory() as temp:
            previous, candidate = Path(temp) / "old", Path(temp) / "new"
            previous.mkdir(); candidate.mkdir()
            old = {"a" * 32: thread("a" * 32, [album("1", 100, 19),
                album("2", 100, 20, ["photo"]),
                album("3", 500, None, ["legacy"], "legacy-leading-contributor")]),
                   "b" * 32: thread("b" * 32, [{**album("4", 100, 19),
                       "contributors": [{"builderKey": "b" * 32, "pieces": 19}]}])}
            new = {key: thread_expected(entry) for key, entry in old.items()}
            write_projection(previous, old)
            new_dir = write_projection(candidate, new)
            new_dir["photography"] = photo_and_album_counts(old, new)
            target = candidate / "directory.json"
            target.write_text(json.dumps(new_dir), encoding="utf-8")
            receipt = json.loads((candidate / "receipt.json").read_text(encoding="utf-8"))
            next(f for f in receipt["files"] if f["path"] == "directory.json")["sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
            (candidate / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
            add_asset(previous, "profile.js", b"const same = true;\n")
            add_asset(candidate, "profile.js", b"const same = true;\r\n")
            result = audit(previous, candidate, {"tiles": []})
            self.assertEqual((2, 1, 2, 2), (result["builders"], result["empty_profiles"],
                                           result["excluded_profile_records"], result["photographs"]))
            self.assertEqual(1, result["line_ending_only_files"])
            add_asset(candidate, "profile.js", b"const same = false;\r\n")
            with self.assertRaisesRegex(ValueError, "Unrelated public files"):
                audit(previous, candidate, {"tiles": []})
            add_asset(candidate, "profile.js", b"const same = true;\r\n")
            new_dir["photography"]["photos"] -= 1
            target.write_text(json.dumps(new_dir), encoding="utf-8")
            receipt = json.loads((candidate / "receipt.json").read_text(encoding="utf-8"))
            next(f for f in receipt["files"] if f["path"] == "directory.json")["sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
            (candidate / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "photography"):
                audit(previous, candidate, {"tiles": []})


if __name__ == "__main__":
    unittest.main()
