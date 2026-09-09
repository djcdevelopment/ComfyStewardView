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


if __name__ == "__main__":
    unittest.main()
