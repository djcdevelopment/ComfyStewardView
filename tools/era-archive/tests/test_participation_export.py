"""What leaves the coordinator's participation file, and what never does.

The coordinator's `analysis/participation.json` is a working file: it holds volunteer
handles, free-text notes, contact addresses and the claim a tag rode in on, because a
human has to be able to answer someone. The public `participation.json` gallery.py writes
beside the directory is read by every visitor. So the projection is a whitelist, not a
redaction pass -- five keys per confirmed tag and nothing else survives, and a tag whose
keys do not parse is dropped rather than repaired.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gallery
from gallery import project

BUILDER = "a" * 32
CONTRIBUTOR = "b" * 32
BUILD = "c" * 64
WORLD = "https://example.invalid/world"

# Every string a volunteer typed. None of it belongs on a page anyone can open.
PRIVATE_STRINGS = ("Skald the Loud", "we built the roof together", "skald@example.invalid",
                   "claim-0102030405")


def document():
    return {
        "schema": "steward-community-private/v1",
        "generatedAt": "2026-09-10T00:00:00Z",
        "eras": [12],
        "legacyImports": [],
        "builders": [{"builderKey": BUILDER, "displayName": "Skald", "aliases": [],
                      "nameStatus": "recorded", "builds": [BUILD]}],
        "builds": [{"buildKey": BUILD, "era": 12, "slug": "era12", "label": "Great Hall",
                    "pieces": 900, "photos": [],
                    "contributors": [{"builderKey": BUILDER, "pieces": 600, "share": 0.67},
                                     {"builderKey": CONTRIBUTOR, "pieces": 300, "share": 0.33}]}],
    }


def coordinator_file(root, **overrides):
    """The shape the coordinator keeps, with its four counts and whatever tags are passed."""
    payload = {
        "schema": "steward-creator-participation/v1",
        "generatedAt": "2026-09-09T00:00:00Z",
        "updatedAt": "2026-09-10T00:00:00Z",
        "participants": 12,
        "claims": 30,
        "requests": 7,
        "openRequests": 3,
    }
    payload.update(overrides)
    path = root / "analysis" / "participation.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


class ParticipationExportTests(unittest.TestCase):
    def test_only_the_five_public_keys_of_a_well_formed_tag_are_published(self):
        confirmed = [
            # Valid, and carrying every private field the coordinator keeps beside it.
            {"buildKey": BUILD, "contributorKey": CONTRIBUTOR, "builderKey": BUILDER,
             "tags": ["mason", "basemate"], "confirmedAt": "2026-09-09T12:00:00Z",
             "participant": "Skald the Loud", "note": "we built the roof together",
             "contact": "skald@example.invalid", "claimId": "claim-0102030405"},
            # Nothing but a tag id nobody publishes: an empty tag list is not a tag.
            {"buildKey": "d" * 64, "contributorKey": CONTRIBUTOR, "builderKey": BUILDER,
             "tags": ["landlord"], "confirmedAt": "2026-09-09T12:00:00Z"},
            # A key that is not the hex it claims to be attaches to no build at all.
            {"buildKey": "not-a-build-key", "contributorKey": CONTRIBUTOR, "builderKey": BUILDER,
             "tags": ["visitor"], "confirmedAt": "2026-09-09T12:00:00Z",
             "note": "we built the roof together"},
            "basemate",
        ]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            coordinator_file(root, confirmedTags=confirmed)
            dest = root / "projection"
            project(document(), dest, WORLD, root)
            path = dest / "participation.json"
            raw = path.read_text(encoding="utf-8")
            published = json.loads(raw)

        self.assertEqual("steward-creator-participation-public/v1", published["schema"])
        self.assertEqual(12, published["participants"])
        self.assertEqual(30, published["claims"])
        self.assertEqual(7, published["requests"])
        self.assertEqual(3, published["openRequests"])

        self.assertEqual(1, len(published["confirmedTags"]), "only the well-formed tag survives")
        tag = published["confirmedTags"][0]
        self.assertEqual(
            {"buildKey", "contributorKey", "builderKey", "tags", "confirmedAt"},
            set(tag), "the public tag is a whitelist, not a redaction")
        self.assertEqual(BUILD, tag["buildKey"])
        self.assertEqual(CONTRIBUTOR, tag["contributorKey"])
        self.assertEqual(BUILDER, tag["builderKey"])
        self.assertEqual(["basemate", "mason"], tag["tags"], "sorted, so the file is stable")
        self.assertEqual("2026-09-09T12:00:00Z", tag["confirmedAt"])
        for private in PRIVATE_STRINGS:
            self.assertNotIn(private, raw, f"the published file leaks '{private}'")

    def test_a_coordinator_file_with_no_tags_publishes_an_empty_list(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            coordinator_file(root)
            dest = root / "projection"
            project(document(), dest, WORLD, root)
            published = json.loads((dest / "participation.json").read_text(encoding="utf-8"))
        # An empty list, not a missing key: the page tests `doc.confirmedTags?.length`
        # and a missing key would read the same as "not published yet".
        self.assertEqual([], published["confirmedTags"])

    def test_no_coordinator_file_means_no_public_file_at_all(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            dest = root / "projection"
            project(document(), dest, WORLD, root)
            self.assertFalse((dest / "participation.json").exists(),
                             "an absent coordinator file must not be published as zeroes")

    def test_sanitize_confirmed_tags_is_ordered_and_tolerates_junk(self):
        first = {"buildKey": "1" * 64, "contributorKey": "2" * 32, "builderKey": BUILDER,
                 "tags": ["visitor"], "confirmedAt": "2026-01-01T00:00:00Z"}
        second = {"buildKey": "1" * 64, "contributorKey": "3" * 32, "builderKey": BUILDER,
                  "tags": ["roof", "roof"], "confirmedAt": None}
        third = {"buildKey": "9" * 64, "contributorKey": "2" * 32, "builderKey": BUILDER,
                 "tags": ["portal"]}
        kept = gallery.sanitize_confirmed_tags([third, second, first, None, 7, {"tags": "mason"}])
        self.assertEqual([("1" * 64, "2" * 32), ("1" * 64, "3" * 32), ("9" * 64, "2" * 32)],
                         [(t["buildKey"], t["contributorKey"]) for t in kept])
        self.assertEqual(["roof"], kept[1]["tags"], "a repeated tag is one tag")
        self.assertIsNone(kept[1]["confirmedAt"])
        self.assertIsNone(kept[2]["confirmedAt"], "an unstamped tag states no stamp")
        self.assertEqual([], gallery.sanitize_confirmed_tags(None))
        self.assertEqual([], gallery.sanitize_confirmed_tags([]))


if __name__ == "__main__":
    unittest.main()
