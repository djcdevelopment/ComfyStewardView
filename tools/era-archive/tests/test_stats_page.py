import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from archive import REPO, load
from gallery import is_qualifying_album, project
import stats

TEMPLATE = REPO / "tools/era-archive/web/stats.html"
LIVE_DOCUMENT = Path(r"E:\omen\steward-multi-era\analysis\community-private.json")
SECTION_TITLES = (
    "1. The 2D Spread: Build Size vs. Contributor Share %",
    "2. Build Scale vs. Player Piece Contribution",
    "3. The Album Inflation Factor & Player Archetypes",
    "4. Effort Concentration (The Valheim Pareto Curve)",
    "5. Shared Build Anatomy: Solo Dominance vs. True Co-Op",
    "6. Threshold Reduction Curve: Filtering Noise Without Losing History",
    "7. Photographs &amp; Residency: What the Archive Added Since the Census",
)

A, B, C, L = "a" * 32, "b" * 32, "c" * 32, "d" * 32


def photo(build_key):
    return {"id": f"{build_key[:12]}-orbit1", "thumb": "https://fx99.tail8e749c.ts.net/t.webp",
            "large": "https://fx99.tail8e749c.ts.net/l.webp", "href": "https://fx99.tail8e749c.ts.net/", "label": "a frame"}


def build(key, era, pieces, contributors, **extra):
    record = {"buildKey": key, "era": era, "slug": f"era{era}", "label": f"Build {key[:4]}", "pieces": pieces,
              "contributors": contributors, "photos": []}
    record.update(extra)
    return record


def builder(key, name, builds):
    return {"builderKey": key, "displayName": name, "aliases": [name], "nameStatus": "recorded", "builds": builds}


def hand_checkable_document():
    """Six builds a reader can count: a shared photographed build on the 80% boundary, a
    one-piece drop, a big solo build with a bed, a solo mid-size build, a legacy gallery
    credit with no piece count, and an unattributed build."""
    b1, b2, b3, b4, b5, b6 = ("1" * 64, "2" * 64, "3" * 64, "4" * 64, "5" * 64, "6" * 64)
    return {
        "schema": "steward-community/v1",
        "generatedAt": "2026-09-09T00:00:00Z",
        "eras": [10, 12],
        "legacyImports": [],
        "builders": [builder(A, "Alpha", [b1, b2, b3]), builder(B, "Beta", [b1]), builder(C, "Gamma", [b4]), builder(L, "Legacy", [b5])],
        "builds": [
            build(b1, 10, 100, [{"builderKey": A, "pieces": 80, "share": 0.8}, {"builderKey": B, "pieces": 20, "share": 0.2}], photos=[photo(b1)]),
            build(b2, 10, 1, [{"builderKey": A, "pieces": 1, "share": 1.0}]),
            build(b3, 12, 600, [{"builderKey": A, "pieces": 600, "share": 1.0}],
                  residents=[{"builderKey": A, "beds": 2, "evidence": "bed-owner-in-footprint"}]),
            build(b4, 12, 30, [{"builderKey": C, "pieces": 30, "share": 1.0}]),
            build(b5, 17, 300, [{"builderKey": L, "pieces": None, "evidence": "legacy-leading-contributor"}],
                  photos=[photo(b5)], legacyClusterId=5, galleryUrl="https://fx99.tail8e749c.ts.net/valheim/era17/#build=c5"),
            build(b6, 12, 50, []),
        ],
    }


class StatsTemplateTests(unittest.TestCase):
    def test_template_is_a_shell_of_tokens(self):
        content = TEMPLATE.read_text(encoding="utf-8")
        self.assertIn("<title>Archive Statistics · Comfy builders</title>", content)
        self.assertIn('class="eyebrow">THE COMFY COMMUNITY · ARCHIVE INTELLIGENCE</p>', content)
        for title in SECTION_TITLES:
            self.assertIn(title, content)
        self.assertIn('href="/valheim/creators/stats/"', content)
        self.assertIn('href="/valheim/creators/"', content)
        self.assertIn('href="/valheim/"', content)
        self.assertIn('href="/chronicles/"', content)
        self.assertIn('id="data-stamp"', content)
        used = set(re.findall(r"\{\{([a-z0-9_]+)\}\}", content))
        self.assertEqual(set(stats.TOKENS), used, "every token stats.py produces is used, and nothing else is asked for")
        # The census figures were typed into the page once; none may survive as text.
        for figure in ("16,893,112", "318,319", "2,747", "86.4%", "283,476", "21,902"):
            self.assertNotIn(figure, content)

    def test_index_html_has_stats_link(self):
        content = (REPO / "tools/era-archive/web/index.html").read_text(encoding="utf-8")
        self.assertIn('id="stats-link"', content)
        self.assertIn('href="/valheim/creators/stats/"', content)


class StatsArithmeticTests(unittest.TestCase):
    def test_percentile_is_numpy_type_7(self):
        self.assertEqual(2.5, stats.percentile([1, 2, 3, 4], 0.5))
        self.assertEqual(1.75, stats.percentile([1, 2, 3, 4], 0.25))
        self.assertAlmostEqual(3.7, stats.percentile([1, 2, 3, 4], 0.9))
        self.assertAlmostEqual(1.9, stats.percentile(list(range(1, 11)), 0.1))
        self.assertAlmostEqual(9.55, stats.percentile(list(range(1, 11)), 0.95))
        self.assertEqual(7, stats.percentile([7], 0.5))
        self.assertEqual(1, stats.percentile([1, 2, 3, 4], 0.0))
        self.assertEqual(4, stats.percentile([1, 2, 3, 4], 1.0))
        with self.assertRaises(ValueError):
            stats.percentile([], 0.5)

    def test_describe_of_nothing_is_all_none(self):
        d = stats.describe([], (0.5,))
        self.assertEqual(0, d["n"])
        self.assertIsNone(d["p50"])
        self.assertIsNone(d["mean"])

    def test_era_phrases(self):
        self.assertEqual("7, 8, 9, 10, 11, 12, and 14", stats.era_list([7, 8, 9, 10, 11, 12, 14]))
        self.assertEqual("16 and 17", stats.era_list([16, 17]))
        self.assertEqual("12", stats.era_list([12]))
        self.assertEqual("eras 7–12, 14", stats.era_runs([7, 8, 9, 10, 11, 12, 14]))
        self.assertEqual("eras 16–17", stats.era_runs([16, 17]))
        self.assertEqual("era 12", stats.era_runs([12]))
        self.assertEqual("no eras", stats.era_runs([]))

    def test_formatting(self):
        self.assertEqual("16,893,112", stats.fmt_int(16893112))
        self.assertEqual("380", stats.fmt_int(379.7))
        self.assertEqual("6,465.0", stats.fmt_1dp(6465.03))
        self.assertEqual("86.4%", stats.fmt_pct(86.4))
        self.assertEqual("2,198.0x", stats.fmt_x(2198.0))
        self.assertEqual("—", stats.fmt_int(None))
        self.assertEqual("—", stats.fmt_pct(None))


class StatsComputeTests(unittest.TestCase):
    def setUp(self):
        self.document = hand_checkable_document()
        self.before = json.dumps(self.document, sort_keys=True)
        self.figures = stats.compute(self.document, qualifies=is_qualifying_album, exemplar_builder_key=A)

    def test_compute_reads_without_writing(self):
        self.assertEqual(self.before, json.dumps(self.document, sort_keys=True))

    def test_headline_and_populations(self):
        f = self.figures
        self.assertEqual(731, f["pieces_total"])
        self.assertEqual(6, f["clusters"])
        self.assertEqual(4, f["builders"])
        self.assertEqual((6, 5, 1), (f["rows"], f["measured_rows"], f["legacy_rows"]))
        self.assertEqual([10, 12], f["eras"])
        self.assertEqual([17], f["legacy_eras"])
        self.assertEqual("2026-09-09", f["generated_date"])
        self.assertEqual("Alpha", f["exemplar_name"])

    def test_cross_tabs_exclude_the_legacy_credit(self):
        t1, t2 = self.figures["table_1"], self.figures["table_2"]
        self.assertEqual([0, 0, 0, 1, 0, 0, 1, 0], t1[4], "the 100-piece build: a 20% share and an 80% share")
        self.assertEqual(1, t1[0][7], "the one-piece drop is solo")
        self.assertEqual(1, t1[3][7], "the 30-piece build is solo")
        self.assertEqual(1, t1[6][7], "the 600-piece build is solo")
        self.assertEqual([0] * 8, t1[5], "the 300-piece legacy album has no share to bin")
        self.assertEqual(5, sum(map(sum, t1)))
        self.assertEqual([0, 0, 1, 0, 1, 0, 0], t2[4], "20 pieces placed and 80 pieces placed")
        self.assertEqual(1, t2[6][6], "600 pieces placed is >500")
        self.assertEqual(0, sum(t2[5]), "no impossible >500 cell for the legacy album")
        self.assertEqual(0, self.figures["tourism"])

    def test_portfolio_percentiles(self):
        t3 = self.figures["table_3"]
        self.assertEqual(4, t3["n"])
        self.assertEqual(3, t3["n_with_pieces"], "the legacy-only builder has albums but no piece count")
        self.assertEqual(1, t3["n_active"])
        self.assertEqual((1, 3, 1.0, 1.5), (t3["albums"]["min"], t3["albums"]["max"], t3["albums"]["p50"], t3["albums"]["mean"]))
        self.assertEqual(3, t3["pieces"]["n"])
        self.assertEqual(681, t3["pieces"]["max"])
        self.assertEqual(1.5, t3["inflation"]["p50"], "three albums over two real builds")
        self.assertAlmostEqual(88.1, round(self.figures["table_4"][1]["p50"], 1))
        self.assertEqual(100.0, self.figures["table_4"][3]["p50"])

    def test_shared_build_on_the_dominated_boundary(self):
        self.assertEqual(1, self.figures["shared_builds"])
        row = self.figures["table_5"][3]
        self.assertEqual("51–100 pieces", row["label"])
        self.assertEqual((1, 2.0, 2, 80.0), (row["builds"], row["avg_builders"], row["max_builders"], row["avg_lead"]))
        self.assertEqual((100.0, 0.0, 0.0), (row["dominated"], row["moderate"], row["coop"]),
                         "a lead share of exactly 0.80 is dominated, not moderate as well")
        self.assertIsNone(self.figures["table_5"][0]["avg_builders"])

    def test_threshold_rules_and_the_shipped_row(self):
        t6 = self.figures["table_6"]
        self.assertEqual((6, 4, 731, 3), (t6[0]["records"], t6[0]["builders"], t6[0]["pieces"], t6[0]["exemplar"]))
        self.assertEqual((4, 3, 730), (t6[1]["records"], t6[1]["builders"], t6[1]["pieces"]), "placed >= 5")
        self.assertEqual((2, 1, 680), (t6[4]["records"], t6[4]["builders"], t6[4]["pieces"]), "placed >= 50")
        shipped = t6[-1]
        self.assertEqual("As shipped in the directory (Recommended)", shipped["label"])
        self.assertEqual((5, 4, 4, 730, 2), (shipped["records"], shipped["albums"], shipped["builders"], shipped["pieces"], shipped["exemplar"]))

    def test_photographs_and_residency(self):
        t7 = self.figures["table_7"]
        self.assertEqual([{"era": 10, "albums": 1, "photographed": 1, "photos": 1},
                          {"era": 12, "albums": 2, "photographed": 0, "photos": 0},
                          {"era": 17, "albums": 1, "photographed": 1, "photos": 1}], t7["eras"])
        self.assertEqual((4, 2, 2, 3), (t7["albums"], t7["photographed"], t7["photos"], t7["builders_with_photos"]))
        self.assertEqual((1, 2, 1), (t7["builders_with_bed"], t7["beds"], t7["albums_with_beds"]))

    def test_render_fills_every_token_and_rejects_unknown_ones(self):
        page = stats.render(self.figures, TEMPLATE.read_text(encoding="utf-8"))
        self.assertNotIn("{{", page)
        self.assertIn("Generated 2026-09-09 from 6 spatial clusters and 6 credited contributions across eras 10, 12.", page)
        self.assertIn("<th>Alpha Albums</th>", page)
        self.assertIn("1 legacy gallery albums (era 17)", page)
        with self.assertRaises(KeyError):
            stats.render(self.figures, "<p>{{no_such_token}}</p>")


class StatsProjectionTests(unittest.TestCase):
    def test_gallery_projection_renders_stats_page(self):
        document = hand_checkable_document()
        with tempfile.TemporaryDirectory() as temp:
            dest = Path(temp) / "projection"
            receipt = project(document, dest, "https://am4.tail8e749c.ts.net/world")
            paths = {f["path"] for f in receipt["files"]}
            self.assertIn("stats/index.html", paths)
            self.assertIn("stats.html", paths)
            page = (dest / "stats" / "index.html").read_text(encoding="utf-8")
            root = (dest / "stats.html").read_text(encoding="utf-8")
            for content, css in ((page, '"../creators.css'), (root, '"./creators.css')):
                self.assertNotIn("{{", content)
                self.assertIn(css, content)
                self.assertIn('id="data-stamp"', content)
                self.assertIn("Generated 2026-09-09", content)
                self.assertIn('id="stats-link"', content)
                for title in SECTION_TITLES:
                    self.assertIn(title, content)
            # The page's shipped row is the receipt's population, by construction.
            figures = stats.compute(document, qualifies=is_qualifying_album)
            shipped = figures["table_6"][-1]
            self.assertEqual(receipt["albums"], shipped["albums"])
            self.assertEqual(receipt["builders"], shipped["builders"])
            self.assertIn(f"<strong>{shipped['albums']} distinct albums for {shipped['builders']} builders</strong>", page)
            # And section 7 is directory.json's photography block, restated.
            photography = json.loads((dest / "directory.json").read_text(encoding="utf-8"))["photography"]
            self.assertEqual(photography["photos"], figures["table_7"]["photos"])
            self.assertEqual(photography["albumsWithPhotos"], figures["table_7"]["photographed"])
            self.assertEqual(photography["buildersWithPhotos"], figures["table_7"]["builders_with_photos"])
            self.assertEqual([(e["era"], e["albums"], e["albumsWithPhotos"], e["photos"]) for e in photography["eras"]],
                             [(e["era"], e["albums"], e["photographed"], e["photos"]) for e in figures["table_7"]["eras"]])
            thread_page = dest / A / "index.html"
            self.assertIn('id="stats-link"', thread_page.read_text(encoding="utf-8"))

    def test_is_qualifying_album_pruning_and_preservation(self):
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
            # A document with no eras and a bare generatedAt still renders a page.
            page = (dest / "stats" / "index.html").read_text(encoding="utf-8")
            self.assertIn("Generated now from 2 spatial clusters", page)
            self.assertNotIn("{{", page)


@unittest.skipUnless(os.environ.get("STEWARD_STATS_LIVE") == "1" and LIVE_DOCUMENT.exists(),
                     "set STEWARD_STATS_LIVE=1 with the archive document on E: to prove the census reproduces")
class StatsCensusReproductionTests(unittest.TestCase):
    """The 2026-09-08 census, as the page first carried it, from the live document."""

    @classmethod
    def setUpClass(cls):
        cls.figures = stats.compute(load(LIVE_DOCUMENT), qualifies=is_qualifying_album)

    def test_headline(self):
        f = self.figures
        self.assertEqual((16893112, 318319, 2747, 283476, 282941, 535),
                         (f["pieces_total"], f["clusters"], f["builders"], f["rows"], f["measured_rows"], f["legacy_rows"]))
        self.assertEqual(38619, f["table_6"][3]["records"])
        self.assertEqual(2170, f["table_6"][3]["builders"])
        self.assertEqual(21902, f["tourism"])
        self.assertEqual(115997, f["table_1"][0][7])

    def test_portfolios(self):
        t3 = self.figures["table_3"]
        self.assertEqual((2747, 2613, 1416), (t3["n"], t3["n_with_pieces"], t3["n_active"]))
        self.assertEqual(11, t3["albums"]["p50"])
        self.assertAlmostEqual(6465.0, t3["pieces"]["mean"], places=1)
        self.assertAlmostEqual(3.7, stats.round1(t3["inflation"]["p10"]))
        self.assertAlmostEqual(46.0, stats.round1(self.figures["table_4"][1]["p50"]))

    def test_shared_builds(self):
        t5 = self.figures["table_5"]
        self.assertEqual(27946, self.figures["shared_builds"])
        self.assertEqual((46.7, 37.9, 15.4), (t5[-1]["dominated"], t5[-1]["moderate"], t5[-1]["coop"]))
        self.assertEqual(90.0, t5[0]["moderate"], "the 0.80 boundary counted once")
        self.assertEqual(100, t5[-1]["max_builders"])

    def test_pieces_kept_for_every_rule(self):
        t6 = self.figures["table_6"]
        base = t6[0]["pieces"]
        kept = [round(100 * r["pieces"] / base, 1) for r in t6]
        self.assertEqual([100.0, 98.1, 97.3, 96.5, 94.5, 96.7, 96.2, 97.0], kept)
        self.assertEqual((48130, 27336, 2682, 39), (t6[-1]["records"], t6[-1]["albums"], t6[-1]["builders"], t6[-1]["exemplar"]))
        self.assertEqual([427, 66, 40, 33, 18, 39, 37], [r["exemplar"] for r in t6[:-1]])


if __name__ == "__main__":
    unittest.main()
