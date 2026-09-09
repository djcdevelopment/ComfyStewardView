import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from archive import REPO, load
from gallery import project


class StatsPageTests(unittest.TestCase):
    def test_stats_html_exists_and_has_complete_tables(self):
        stats_path = REPO / "tools/era-archive/web/stats.html"
        self.assertTrue(stats_path.exists(), "stats.html must exist in web directory")
        content = stats_path.read_text(encoding="utf-8")
        
        self.assertIn("<title>Archive Statistics · Comfy builders</title>", content)
        self.assertIn('class="eyebrow">THE COMFY COMMUNITY · ARCHIVE INTELLIGENCE</p>', content)
        
        self.assertIn("16,893,112", content)
        self.assertIn("318,319", content)
        self.assertIn("2,747", content)
        self.assertIn("86.4%", content)
        
        self.assertIn("1. The 2D Spread: Build Size vs. Contributor Share %", content)
        self.assertIn("2. Build Scale vs. Player Piece Contribution", content)
        self.assertIn("3. The Album Inflation Factor & Player Archetypes", content)
        self.assertIn("4. Effort Concentration (The Valheim Pareto Curve)", content)
        self.assertIn("5. Shared Build Anatomy: Solo Dominance vs. True Co-Op", content)
        self.assertIn("6. Threshold Reduction Curve: Filtering Noise Without Losing History", content)
        
        self.assertIn('href="/valheim/creators/stats/"', content)
        self.assertIn('href="/valheim/creators/"', content)
        self.assertIn('href="/valheim/"', content)

    def test_index_html_has_stats_link(self):
        index_path = REPO / "tools/era-archive/web/index.html"
        content = index_path.read_text(encoding="utf-8")
        self.assertIn('id="stats-link"', content)
        self.assertIn('href="/valheim/creators/stats/"', content)

    def test_gallery_projection_includes_stats_page(self):
        document = {
            "schema": "steward-community-private/v1",
            "generatedAt": "2026-09-09T00:00:00Z",
            "eras": [12],
            "legacyImports": [],
            "builders": [
                {
                    "builderKey": "a" * 32,
                    "displayName": "TestBuilder",
                    "aliases": ["TestBuilder"],
                    "nameStatus": "recorded",
                    "builds": ["b" * 64]
                }
            ],
            "builds": [
                {
                    "buildKey": "b" * 64,
                    "era": 12,
                    "slug": "era12",
                    "label": "Build bbb",
                    "pieces": 100,
                    "contributors": [{"builderKey": "a" * 32, "pieces": 100, "share": 1.0}],
                    "photos": []
                }
            ]
        }
        with tempfile.TemporaryDirectory() as temp:
            dest = Path(temp) / "projection"
            receipt = project(document, dest, "https://am4.tail8e749c.ts.net/world")
            
            stats_dest = dest / "stats" / "index.html"
            self.assertTrue(stats_dest.exists(), "stats/index.html must be created in projection")
            
            paths = {f["path"] for f in receipt["files"]}
            self.assertIn("stats/index.html", paths, "stats/index.html must be indexed in receipt.json")
            
            thread_page = dest / ("a" * 32) / "index.html"
            self.assertTrue(thread_page.exists())
            thread_content = thread_page.read_text(encoding="utf-8")
            self.assertIn('id="stats-link"', thread_content)

    def test_is_qualifying_album_pruning_and_preservation(self):
        from gallery import is_qualifying_album
        # 1-piece unphotographed drop is pruned
        self.assertFalse(is_qualifying_album({"pieces": 1, "photos": []}, {"pieces": 1, "share": 1.0}))
        # 1-piece drop WITH photos is preserved
        self.assertTrue(is_qualifying_album({"pieces": 1, "photos": [{"id": "p1"}]}, {"pieces": 1, "share": 1.0}))
        # 1-piece drop with rejected photoStatus is preserved
        self.assertTrue(is_qualifying_album({"pieces": 1, "photoStatus": "rejected", "photos": []}, {"pieces": 1, "share": 1.0}))
        # 15-piece structure without photos is below threshold
        self.assertFalse(is_qualifying_album({"pieces": 15, "photos": []}, {"pieces": 15, "share": 1.0}))
        # 25-piece structure solo is preserved
        self.assertTrue(is_qualifying_album({"pieces": 25, "photos": []}, {"pieces": 25, "share": 1.0}))
        # Incidental 1-piece touch on a 1000-piece build is pruned
        self.assertFalse(is_qualifying_album({"pieces": 1000, "photos": []}, {"pieces": 1, "share": 0.001}))
        # Real 35-piece contribution on a 1000-piece build is preserved
        self.assertTrue(is_qualifying_album({"pieces": 1000, "photos": []}, {"pieces": 35, "share": 0.035}))
        self.assertFalse(is_qualifying_album({"pieces": 1000, "photos": []}, {"pieces": 35, "share": 0.035}, min_builder_pieces=50))

    def test_classify_volume_tier(self):
        from gallery import classify_volume_tier
        self.assertEqual("Megabuilder", classify_volume_tier(15000))
        self.assertEqual("Major Architect", classify_volume_tier(8101))
        self.assertEqual("Established Builder", classify_volume_tier(1200))
        self.assertEqual("Homesteader", classify_volume_tier(150))
        self.assertEqual("Explorer", classify_volume_tier(25))

    def test_gallery_projection_prunes_small_drops_and_records_volume_tier(self):
        from gallery import project
        key = "b" * 32
        document = {
            "generatedAt": "now",
            "eras": [],
            "legacyImports": [],
            "builders": [
                {
                    "builderKey": key,
                    "displayName": "Tugcow",
                    "aliases": [],
                    "nameStatus": "recorded",
                    "builds": ["b1" + "0"*62, "b2" + "0"*62]
                }
            ],
            "builds": [
                {
                    "buildKey": "b1" + "0"*62,
                    "era": 10,
                    "slug": "era10",
                    "label": "Great Hall",
                    "pieces": 3000,
                    "contributors": [{"builderKey": key, "pieces": 3000, "share": 1.0}],
                    "photos": []
                },
                {
                    "buildKey": "b2" + "0"*62,
                    "era": 10,
                    "slug": "era10",
                    "label": "Campfire",
                    "pieces": 1,
                    "contributors": [{"builderKey": key, "pieces": 1, "share": 1.0}],
                    "photos": []
                }
            ]
        }
        with tempfile.TemporaryDirectory() as temp:
            dest = Path(temp) / "projection"
            receipt = project(document, dest, "https://am4.tail8e749c.ts.net/world")
            self.assertEqual(1, receipt["builders"])
            self.assertEqual(1, receipt["albums"])
            
            thread = json.loads((dest / "threads" / f"{key}.json").read_text(encoding="utf-8"))
            self.assertEqual(1, thread["albums"])
            self.assertEqual(3000, thread["pieces"])
            self.assertEqual("Major Architect", thread["tier"])
            self.assertEqual(1, len(thread["eras"][0]["albums"]))
            self.assertEqual("Great Hall", thread["eras"][0]["albums"][0]["label"])

            directory = json.loads((dest / "directory.json").read_text(encoding="utf-8"))
            b_record = directory["builders"][0]
            self.assertEqual(1, b_record["albums"])
            self.assertEqual(3000, b_record["pieces"])
            self.assertEqual("Major Architect", b_record["tier"])


if __name__ == "__main__":
    unittest.main()
