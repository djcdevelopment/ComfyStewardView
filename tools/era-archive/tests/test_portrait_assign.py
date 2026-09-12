"""The archive's pick: deterministic, tier-shaped, era-leaning, never empty.

    python -m unittest tools.era-archive.tests.test_portrait_assign
"""
import collections
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import portrait_assign  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "viking96-tags.json"


def library():
    doc = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return {"library": "viking96", "tiles": [
        {"id": t["id"], "library": "viking96", "tags": t["tags"], "takes": [{"id": k} for k in t["takes"]]} for t in doc["tiles"]
    ]}


def record(key, tier="Established Builder", eras=(12,)):
    return {"builderKey": key, "tier": tier, "eras": list(eras), "albums": 3, "pieces": 800}


def keys(n, prefix="a"):
    return [f"{prefix}{i:031x}"[-32:] for i in range(n)]


class PortraitAssignTests(unittest.TestCase):
    def setUp(self):
        self.lib = library()
        self.by_id = {f"viking96/{t['id']}": t for t in self.lib["tiles"]}

    def test_the_pick_is_a_pure_function_of_key_and_library(self):
        rec = record("5897d38e2a065e36a6895e70a2194738", "Major Architect", (7, 8, 9, 10, 11, 12))
        first = portrait_assign.assign_portrait(rec, self.lib)
        again = portrait_assign.assign_portrait(dict(rec), json.loads(json.dumps(self.lib)))
        self.assertEqual(first, again)
        self.assertIn(first["tile"], self.by_id)
        self.assertIn(first["take"], [k["id"] for k in self.by_id[first["tile"]]["takes"]])
        # The neighbour's key lands elsewhere; a different salt is a different world.
        other = portrait_assign.assign_portrait(record("5897d38e2a065e36a6895e70a2194739", "Major Architect", (7,)), self.lib)
        self.assertNotEqual(first, other)
        # A different salt is a different world -- for most builders; a narrow pool (one
        # veteran woman carpenter) may land the same either way, so this is counted.
        moved = sum(1 for k in keys(50, "e")
                    if portrait_assign.assign_portrait(record(k), self.lib) != portrait_assign.assign_portrait(record(k), self.lib, salt="portrait-v2"))
        self.assertGreater(moved, 35)

    def test_every_tier_draws_from_its_own_pool(self):
        for tier, roles in portrait_assign.POOLS.items():
            for key in keys(60, tier[0].lower()):
                pick = portrait_assign.assign_portrait(record(key, tier), self.lib)
                role = self.by_id[pick["tile"]]["tags"]["role"]
                self.assertIn(role, roles, f"{tier} wore a {role}")

    def test_the_pick_spreads_and_both_presentations_appear(self):
        for tier in portrait_assign.POOLS:
            picks = [portrait_assign.assign_portrait(record(k, tier), self.lib) for k in keys(500, "f")]
            tiles = collections.Counter(p["tile"] for p in picks)
            self.assertGreaterEqual(len(tiles), 12, f"{tier} spread over only {len(tiles)} tiles")
            sides = {self.by_id[p["tile"]]["tags"]["presentation"] for p in picks}
            self.assertEqual({"woman", "man"}, sides)
            self.assertLess(max(tiles.values()) / 500, 0.25, "one tile dominates the tier")

    def test_veterans_lean_senior_and_newcomers_lean_young(self):
        vets = [portrait_assign.assign_portrait(record(k, "Megabuilder", (7, 8, 9, 10, 11)), self.lib) for k in keys(120, "b")]
        senior = sum(1 for p in vets if self.by_id[p["tile"]]["id"].rsplit("_", 1)[-1] in portrait_assign.SENIOR_VARIANTS
                     or self.by_id[p["tile"]]["tags"].get("age") == "elder")
        self.assertEqual(senior, len(vets), "a five-era megabuilder always wears a senior face")
        new = [portrait_assign.assign_portrait(record(k, "Explorer", (16,)), self.lib) for k in keys(120, "c")]
        young = sum(1 for p in new if self.by_id[p["tile"]]["id"].rsplit("_", 1)[-1] in portrait_assign.JUNIOR_VARIANTS
                    or self.by_id[p["tile"]]["tags"].get("age") == "young")
        self.assertEqual(young, len(new), "a first-season explorer wears a young face when the pool has one")
        self.assertEqual("settled", portrait_assign.seniority(record("x", eras=(12, 13))))
        self.assertEqual("veteran", portrait_assign.seniority(record("x", eras=(8,))))
        self.assertEqual("settled", portrait_assign.seniority({"builderKey": "x"}))

    def test_a_pool_the_library_lacks_falls_through_and_an_empty_library_gives_none(self):
        thin = {"library": "viking96", "tiles": [t for t in self.lib["tiles"] if t["tags"]["role"] == "brewer"]}
        pick = portrait_assign.assign_portrait(record("d" * 32, "Megabuilder", (7,)), thin)
        self.assertEqual("brewer", self.by_id[pick["tile"]]["tags"]["role"])
        self.assertIsNone(portrait_assign.assign_portrait(record("d" * 32), {"tiles": []}))
        self.assertIsNone(portrait_assign.assign_portrait({}, self.lib))
        # An unknown tier is an Explorer; a tile without takes is not a tile.
        untaken = {"library": "viking96", "tiles": [{"id": "x_m_y", "tags": {"role": "hunter"}, "takes": []}]}
        self.assertIsNone(portrait_assign.assign_portrait(record("e" * 32, "Nobody"), untaken))
        self.assertIn(self.by_id[portrait_assign.assign_portrait(record("e" * 32, "Nobody"), self.lib)["tile"]]["tags"]["role"],
                      portrait_assign.POOLS["Explorer"])

    def test_a_built_portraits_json_is_read_the_same_way(self):
        doc = {"schema": "chronicles-portraits/v2", "count": 0, "libraries": {"viking96": {"default": True}},
               "tiles": [{**t, "library": "viking96"} for t in self.lib["tiles"]]}
        self.assertEqual(portrait_assign.assign_portrait(record("a" * 32), doc),
                         portrait_assign.assign_portrait(record("a" * 32), self.lib))


if __name__ == "__main__":
    unittest.main()
