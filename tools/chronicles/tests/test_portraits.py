"""The portrait library: 48 reproducible prompts, and a manifest that matches its files."""
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "portraits"))
import prompts  # noqa: E402

BANNED = ("character", "archetype", "persona")


class PromptMatrix(unittest.TestCase):
    def setUp(self):
        self.tiles = prompts.tiles()

    def test_forty_eight_distinct_tiles(self):
        self.assertEqual(len(self.tiles), 48)
        self.assertEqual(len({t["id"] for t in self.tiles}), 48)
        self.assertEqual(len({t["seed"] for t in self.tiles}), 48)
        self.assertEqual(len({t["prompt"] for t in self.tiles}), 48)

    def test_every_prompt_carries_the_shared_tail(self):
        for t in self.tiles:
            self.assertTrue(t["prompt"].endswith(prompts.TAIL), t["id"])
            self.assertIn("one person", t["prompt"])

    def test_tags_are_role_age_presentation_and_clean(self):
        roles = {r for r, _ in prompts.ROLES}
        for t in self.tiles:
            role, age, pres = t["tags"]
            self.assertIn(role, roles)
            self.assertIn(age, {"young", "elder"})
            self.assertIn(pres, {"woman", "man"})
            for word in BANNED:
                self.assertNotIn(word, t["prompt"].lower())

    def test_ids_are_zero_padded_and_ordered(self):
        self.assertEqual([t["id"] for t in self.tiles], [f"p{n:02d}" for n in range(1, 49)])


class CommittedLibrary(unittest.TestCase):
    """Only meaningful once assets/portraits exists; skipped before the first render."""

    def setUp(self):
        self.lib = ROOT / "assets" / "portraits"
        if not (self.lib / "manifest.json").exists():
            self.skipTest("no committed portrait library yet")
        self.manifest = json.loads((self.lib / "manifest.json").read_text(encoding="utf-8"))

    def test_manifest_matches_files(self):
        from PIL import Image
        self.assertEqual(self.manifest["schema"], "chronicles-portraits/v1")
        self.assertEqual(self.manifest["count"], len(self.manifest["tiles"]))
        for tile in self.manifest["tiles"]:
            f = self.lib / f"{tile['id']}.webp"
            self.assertTrue(f.exists(), tile["id"])
            with Image.open(f) as img:
                self.assertEqual(img.size, (512, 512), tile["id"])
            self.assertEqual(len(tile["tags"]), 3)
        stray = {p.stem for p in self.lib.glob("*.webp")} - {t["id"] for t in self.manifest["tiles"]}
        self.assertFalse(stray, f"webps not in the manifest: {sorted(stray)}")

    def test_library_is_complete(self):
        self.assertEqual(self.manifest["count"], 48)
        self.assertFalse(self.manifest.get("missing"))
        self.assertFalse(self.manifest.get("rejected"))


if __name__ == "__main__":
    unittest.main()
