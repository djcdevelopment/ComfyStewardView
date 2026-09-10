"""What the Chronicles front door is not allowed to get wrong.

Every case here runs offline against tests/fixtures, so it is the same green with the
archive host unreachable. The one thing that cannot be checked offline -- that the fixture
still resembles the live file -- is checked by the counts rule itself: the parity test
reimplements creators.js computeHeroStats and compares it with what build.py baked, so a
drift in either implementation fails here rather than on the published page.
"""
from __future__ import annotations

import hashlib
import html
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"
SOURCE_BASE = "https://fx99.tail8e749c.ts.net"
WORLD_VIEWER = "https://am4.tail8e749c.ts.net/world"
# An xmlns is an identifier, not an address: nothing is fetched from it. It is the only
# absolute URL allowed on the pages besides the world viewer.
SVG_NS = "http://www.w3.org/2000/svg"

# The words this archive does not use about the people in it.
BANNED = ("character", "archetype")

FIXED_HREFS = {
    "/valheim/",
    "/valheim/creators/",
    "/valheim/creators/stats/",
    "/valheim/creators/#participation-details",
    "/chronicles/",
    "/chronicles/guide/",
    WORLD_VIEWER,
}

TAG = re.compile(r"<[^>]+>")
ANCHOR_HREF = re.compile(r"<a\b[^>]*?\bhref=\"([^\"]*)\"", re.I)
SRC = re.compile(r"\bsrc=\"([^\"]*)\"", re.I)
SRCSET = re.compile(r"\bsrcset=\"([^\"]*)\"", re.I)
CSS_URL = re.compile(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)")
ABSOLUTE = re.compile(r"https?://[^\s\"'<>)]+", re.I)


def visible_text(markup: str) -> str:
    return TAG.sub(" ", markup)


class ChroniclesBuild(unittest.TestCase):
    """One build, many assertions: the build is the expensive part."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name) / "site"
        cls.manifest = build.build(SOURCE_BASE, cls.out, offline=FIXTURES)
        cls.pages = {
            "index.html": (cls.out / "index.html").read_text(encoding="utf-8"),
            "guide/index.html": (cls.out / "guide" / "index.html").read_text(encoding="utf-8"),
        }
        cls.directory = json.loads((FIXTURES / "directory.json").read_text(encoding="utf-8"))
        cls.eras = json.loads((FIXTURES / "eras.json").read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    # ------------------------------------------------------------------ counts

    def test_counts_match_the_creators_page_rule(self):
        """A second implementation of creators.js computeHeroStats, deliberately written
        from the live source rather than from build.py:

            const builders = directoryDoc.builders.length;
            const captures = directoryDoc.photography?.photos ?? 0;
            const populatedEras = new Set(directoryDoc.builders.flatMap((b) => b.eras)).size;
        """
        doc = self.directory
        builders = len(doc["builders"])
        captures = doc.get("photography", {}).get("photos", 0)
        populated = len({era for b in doc["builders"] for era in b["eras"]})

        counts = self.manifest["counts"]
        self.assertEqual(counts["builders"], builders)
        self.assertEqual(counts["photos"], captures)
        self.assertEqual(counts["erasWithPhotos"], populated)

        # And the same numbers reached the page, thousands-separated.
        page = self.pages["index.html"]
        for value in (builders, captures, populated):
            self.assertIn(f"{value:,}", page, f"{value:,} is not on the gateway")

    def test_photos_is_not_the_sum_of_builder_photo_counts(self):
        """The trap creators.js documents: a shared album's photographs are counted once
        per credited contributor in the per-builder field."""
        naive = sum(b["photos"] for b in self.directory["builders"])
        self.assertEqual(self.manifest["counts"]["photos"],
                         self.directory["photography"]["photos"])
        if naive != self.directory["photography"]["photos"]:
            self.assertNotEqual(self.manifest["counts"]["photos"], naive)

    def test_templates_carry_no_baked_numbers(self):
        for template in sorted((Path(build.HERE) / "templates").glob("*.html")):
            text = template.read_text(encoding="utf-8")
            self.assertIsNone(re.search(r"\b\d{3,}\b", text),
                              f"{template.name} contains a literal count")
            self.assertIsNone(re.search(r"\d,\d{3}", text),
                              f"{template.name} contains a formatted count")

    def test_era_rows_join_counts_to_galleries(self):
        rows = {row["era"]: row for row in self.manifest["eras"]}
        for era in self.directory["photography"]["eras"]:
            self.assertIn(era["era"], rows)
            self.assertEqual(rows[era["era"]]["photos"], era["photos"])
        by_slug = {e["slug"]: e["href"] for e in self.eras["eras"]}
        for row in self.manifest["eras"]:
            self.assertEqual(row["href"], by_slug.get(row["slug"]))
        self.assertTrue(any(row["current"] for row in self.manifest["eras"]))

    def test_an_era_with_no_photographs_says_so_in_words(self):
        empty = [row for row in self.manifest["eras"] if row["photos"] == 0]
        self.assertTrue(empty, "fixture no longer exercises the unphotographed era")
        guide = self.pages["guide/index.html"]
        self.assertIn("not yet photographed", guide)
        for token in ("—", "–", "&mdash;", "&ndash;"):
            self.assertNotIn(token, guide, f"the guide uses {token!r} where words belong")

    # -------------------------------------------------------------- vocabulary

    def test_neither_page_says_the_banned_words(self):
        for name, page in self.pages.items():
            lowered = page.lower()
            for word in BANNED:
                # Whole source, not just the visible text: attributes and comments ship too.
                self.assertNotIn(word, lowered, f"{name} contains {word!r}")
            self.assertNotIn("archetyp", visible_text(page).lower())

    # ------------------------------------------------------------------- links

    def test_every_anchor_href_is_allowlisted(self):
        allowed = set(FIXED_HREFS) | {e["href"] for e in self.eras["eras"]}
        for name, page in self.pages.items():
            for href in ANCHOR_HREF.findall(page):
                if href.startswith("#") or href.startswith("/chronicles/guide/#"):
                    continue
                self.assertIn(href, allowed, f"{name} links to {href}")

    def test_no_third_party_host_anywhere(self):
        for name, page in self.pages.items():
            for url in ABSOLUTE.findall(page):
                if url == SVG_NS:
                    continue
                self.assertEqual(url, WORLD_VIEWER, f"{name} reaches out to {url}")
        css = (self.out / self.manifest["assets"]["css"]).read_text(encoding="utf-8")
        self.assertEqual(ABSOLUTE.findall(css), [], "the stylesheet fetches something remote")

    def test_in_page_anchors_have_targets(self):
        for name, page in self.pages.items():
            ids = set(re.findall(r'\bid="([^"]+)"', page))
            for href in ANCHOR_HREF.findall(page):
                if href.startswith("#"):
                    self.assertIn(href[1:], ids, f"{name} links to a missing {href}")
        guide_ids = set(re.findall(r'\bid="([^"]+)"', self.pages["guide/index.html"]))
        for anchor in ("find", "study", "walk", "request", "data",
                       "claims", "data-files", "eras"):
            self.assertIn(anchor, guide_ids)
        for href in ANCHOR_HREF.findall(self.pages["index.html"]):
            if href.startswith("/chronicles/guide/#"):
                self.assertIn(href.split("#", 1)[1], guide_ids)

    # ------------------------------------------------------------------ assets

    def _resolve(self, page: str, ref: str) -> Path:
        ref = ref.split("?", 1)[0].split("#", 1)[0]
        if ref.startswith("/chronicles/"):
            return self.out / ref[len("/chronicles/"):]
        return (self.out / page).parent / ref

    def test_every_asset_reference_resolves(self):
        for name, page in self.pages.items():
            refs = list(SRC.findall(page))
            refs += re.findall(r'<link\b[^>]*?\bhref="([^"]+)"', page)
            for value in SRCSET.findall(page):
                refs += [part.strip().split()[0] for part in value.split(",") if part.strip()]
            self.assertTrue(refs)
            for ref in refs:
                self.assertFalse(ref.startswith("http"), f"{name} points at {ref}")
                path = self._resolve(name, ref)
                self.assertTrue(path.is_file(), f"{name} references missing {ref}")
        css_rel = self.manifest["assets"]["css"]
        css = (self.out / css_rel).read_text(encoding="utf-8")
        urls = CSS_URL.findall(css)
        self.assertTrue(urls, "the stylesheet lost its @font-face sources")
        for ref in urls:
            self.assertTrue(self._resolve(css_rel, ref).is_file(), f"css references {ref}")

    def test_fonts_keep_stable_names(self):
        for name in self.manifest["assets"]["fonts"]:
            self.assertTrue((self.out / name).is_file())
            self.assertRegex(name, r"^img/fonts/[a-z0-9-]+\.woff2$")
        self.assertEqual(len(self.manifest["assets"]["fonts"]), 8)

    def test_hashed_assets_are_named_for_their_content(self):
        for rel in [self.manifest["assets"]["css"], self.manifest["assets"]["js"],
                    self.manifest["assets"]["emblem"]]:
            data = (self.out / rel).read_bytes()
            self.assertIn(hashlib.sha256(data).hexdigest()[:8], rel)

    def test_cutouts_are_two_webp_sizes_plus_the_drawn_svg(self):
        cutouts = self.manifest["assets"]["cutouts"]
        for name in build.PATH_IDS:
            entry = cutouts[name]
            self.assertTrue(entry["512"].endswith(".webp"))
            self.assertTrue(entry["256"].endswith(".webp"))
            from PIL import Image
            for size in (512, 256):
                with Image.open(self.out / entry[str(size)]) as image:
                    self.assertEqual(image.size, (size, size))
                    self.assertIn("A", image.getbands(), f"{name} lost its transparency")
        self.assertTrue(cutouts["guide"]["svg"].endswith(".svg"))

    def test_receipt_lists_every_built_file_with_its_hash(self):
        receipt = json.loads((self.out / "receipt.json").read_text(encoding="utf-8"))
        listed = {entry["path"]: entry for entry in receipt["files"]}
        on_disk = {
            p.relative_to(self.out).as_posix()
            for p in self.out.rglob("*") if p.is_file()
        } - {"receipt.json"}
        self.assertEqual(set(listed), on_disk)
        for rel, entry in listed.items():
            data = (self.out / rel).read_bytes()
            self.assertEqual(entry["bytes"], len(data), rel)
            self.assertEqual(entry["sha256"], hashlib.sha256(data).hexdigest(), rel)

    def test_manifest_records_its_sources(self):
        self.assertEqual(len(self.manifest["sources"]), 2)
        for source in self.manifest["sources"]:
            name = Path(urlparse(source["url"]).path).name
            raw = (FIXTURES / name).read_bytes()
            self.assertEqual(source["bytes"], len(raw))
            self.assertEqual(source["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(self.manifest["sourceBase"], SOURCE_BASE)
        self.assertTrue(self.manifest["generatedAt"].endswith("Z"))

    # ------------------------------------------------------------------- shape

    def test_html_basics(self):
        titles = {"index.html": "Valheim Chronicles",
                  "guide/index.html": "Field Manual · Valheim Chronicles"}
        for name, page in self.pages.items():
            self.assertTrue(page.startswith("<!doctype html>"), name)
            self.assertIn('<html lang="en">', page, name)
            self.assertIn(f"<title>{titles[name]}</title>", page, name)
            self.assertIn('<meta name="viewport"', page, name)
            self.assertIn('<meta name="theme-color" content="#0e141c">', page, name)
            self.assertIn('<link rel="icon"', page, name)
            self.assertEqual(len(re.findall(r"<h1\b", page)), 1, name)
            for landmark in ("<header", "<nav", "<main", "<footer"):
                self.assertIn(landmark, page, f"{name} has no {landmark}")
            self.assertNotIn("{{", page, f"{name} has an unfilled placeholder")

    def test_the_six_cards_are_wordless(self):
        html = self.pages["index.html"]
        nav = re.search(r'<nav class="paths".*?</nav>', html, re.S)
        self.assertIsNotNone(nav)
        block = nav.group(0)
        cards = re.findall(r"<a class=\"path\".*?</a>", block, re.S)
        self.assertEqual(len(cards), 6)
        self.assertEqual([re.search(r'data-path="([^"]+)"', c).group(1) for c in cards],
                         list(build.CARD_IDS))
        for card in cards:
            self.assertNotIn("title=", card, "a card carries a tooltip")
            self.assertRegex(card, r'aria-label="[^"]+"')
            self.assertIn('<span class="ember" aria-hidden="true"></span>', card)
            self.assertIn('alt=""', card)
            self.assertEqual(visible_text(card).strip(), "", "a card shows text")
        self.assertIn('href="/chronicles/guide/"', cards[-1])

    def test_the_search_form_is_a_plain_get_to_the_builders_index(self):
        html = self.pages["index.html"]
        form = re.search(r"<form[^>]*>", html).group(0)
        self.assertIn('action="/valheim/creators/"', form)
        self.assertIn('method="get"', form)
        self.assertIn('role="search"', form)
        self.assertIn('<input id="q" name="q" type="search" maxlength="80"', html)
        self.assertIn('<label class="eyebrow" for="q">', html)

    def test_the_manual_has_one_card_per_path(self):
        html = self.pages["index.html"]
        cards = re.findall(r'<article class="slab manual-card">.*?</article>', html, re.S)
        self.assertEqual(len(cards), len(build.PATH_IDS))
        for index, card in enumerate(cards, start=1):
            self.assertIn(f">{index:02d}</p>", card)
            self.assertEqual(len(re.findall(r"<li>", card)), 3)
            self.assertIn('href="/chronicles/guide/#', card)

    def test_the_guide_has_a_section_and_a_figure_per_path(self):
        html = self.pages["guide/index.html"]
        for name in build.PATH_IDS:
            self.assertIn(f'<section id="{name}" class="chapter">', html)
        figures = re.findall(r'<div class="chapter-figure">.*?</div>', html, re.S)
        self.assertEqual(len(figures), len(build.PATH_IDS))
        for figure in figures:
            self.assertIn('alt=""', figure)
        self.assertEqual(len(re.findall(r"<tr>", html)), len(self.manifest["eras"]) + 1)

    def test_copy_is_used_verbatim(self):
        """Every visible string comes from copy.json unchanged. Only < > & are escaped,
        so an apostrophe in the fixture is an apostrophe on the page."""
        def written(value):
            return html.escape(value, quote=False)

        copy = json.loads((Path(build.HERE) / "content" / "copy.json").read_text(encoding="utf-8"))
        index, guide = self.pages["index.html"], self.pages["guide/index.html"]
        self.assertIn(written(copy["gateway"]["h1"]), index)
        self.assertIn(written(copy["gateway"]["lede"]), index)
        self.assertIn(written(copy["gateway"]["cta"]), index)
        self.assertIn(written(copy["gateway"]["search_hint"]), index)
        self.assertIn(written(copy["guide"]["h1"]), guide)
        for name in build.PATH_IDS:
            entry = copy["paths"][name]
            self.assertIn(html.escape(entry["aria_label"], quote=True), index)
            self.assertIn(written(entry["card_h3"]), index)
            for step in entry["steps"]:
                self.assertIn(written(step), index)
            self.assertIn(written(entry["guide"]["lede"]), guide)
            for step in entry["guide"]["walkthrough"]:
                self.assertIn(written(step), guide)
        for paragraph in copy["guide"]["claims"]["paragraphs"]:
            self.assertIn(written(paragraph), guide)
        for item in copy["guide"]["data"]["files"]:
            self.assertIn(written(item["path"]), guide)


class BuildRefusals(unittest.TestCase):

    def test_refuses_an_existing_output_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "site"
            out.mkdir()
            with self.assertRaises(SystemExit):
                build.build(SOURCE_BASE, out, offline=FIXTURES)

    def test_refuses_to_build_when_a_source_cannot_be_read(self):
        """No --offline and no answer: stop, rather than bake half a page of counts."""
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "site"
            with self.assertRaises(SystemExit):
                build.build("http://127.0.0.1:9", out)
            self.assertFalse(out.exists(), "a refused build left a directory behind")

    def test_refuses_a_missing_fixture(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(SystemExit):
                build.build(SOURCE_BASE, Path(tmp) / "site", offline=Path(tmp) / "nothing")


class OptionalTutorialCrops(unittest.TestCase):
    """The crops arrive later than the page does, and the page has to be finished first."""

    def test_builds_without_any_crops(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "site"
            manifest = build.build(SOURCE_BASE, out, offline=FIXTURES, shots_dir=Path(tmp) / "none")
            self.assertEqual(manifest["assets"]["shots"], {})
            html = (out / "index.html").read_text(encoding="utf-8")
            self.assertNotIn("img/shots/", html)
            self.assertIn('<article class="slab manual-card">', html)

    def test_uses_crops_when_they_are_there(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as tmp:
            shots = Path(tmp) / "shots"
            shots.mkdir()
            Image.new("RGB", (1600, 900), (30, 40, 50)).save(shots / "find.png")
            Image.new("RGB", (1600, 900), (30, 40, 50)).save(shots / "find-2.png")
            out = Path(tmp) / "site"
            manifest = build.build(SOURCE_BASE, out, offline=FIXTURES, shots_dir=shots)
            self.assertEqual(set(manifest["assets"]["shots"]), {"find", "find-2"})
            with Image.open(out / manifest["assets"]["shots"]["find"]) as image:
                self.assertEqual(image.size, build.SHOT_SIZE)
            index = (out / "index.html").read_text(encoding="utf-8")
            guide = (out / "guide" / "index.html").read_text(encoding="utf-8")
            self.assertEqual(index.count("img/shots/"), 1)
            self.assertEqual(guide.count("../img/shots/"), 2)


if __name__ == "__main__":
    unittest.main()
