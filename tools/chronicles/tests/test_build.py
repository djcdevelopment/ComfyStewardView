"""What the Chronicles front door is not allowed to get wrong.

Every case here runs offline against tests/fixtures, so it is the same green with the
archive host unreachable. The one thing that cannot be checked offline -- that the fixture
still resembles the live file -- is checked by the counts rule itself: the parity test
reimplements creators.js computeHeroStats and compares it with what build.py baked, so a
drift in either implementation fails here rather than on the published page.
"""
from __future__ import annotations

import colorsys
import hashlib
import html
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"
PORTRAIT_COUNT = 48
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


def synth_portraits(directory: Path, count: int = PORTRAIT_COUNT) -> Path:
    """Stand-in tiles, the way the crop cases synthesize shots.

    Another lane draws the real ones. Everything this build does with a tile -- copy the
    full size byte for byte, derive the 128, stamp it, spell it into the manifest -- works
    on a flat colour, and a test that waited for the artist would never run."""
    directory.mkdir(parents=True, exist_ok=True)
    tiles = []
    for i in range(count):
        tile_id = f"p{i + 1:02d}"
        r, g, b = colorsys.hsv_to_rgb(i / count, 0.45, 0.55)
        Image.new("RGBA", (512, 512), (int(r * 255), int(g * 255), int(b * 255), 255)).save(
            directory / f"{tile_id}.webp", "WEBP", quality=82, method=6
        )
        tiles.append({"id": tile_id, "seed": 1000 + i, "tags": ["stand-in"]})
    (directory / "manifest.json").write_text(
        json.dumps({"schema": build.PORTRAITS_SCHEMA, "count": count, "tiles": tiles}),
        encoding="utf-8",
    )
    return directory


class ChroniclesBuild(unittest.TestCase):
    """One build, many assertions: the build is the expensive part."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name) / "site"
        # Synthesized rather than read from assets/portraits: this suite has to say the
        # same thing before and after the portrait lane lands its first tile.
        cls.portraits = synth_portraits(Path(cls.tmp.name) / "portraits")
        cls.manifest = build.build(SOURCE_BASE, cls.out, offline=FIXTURES,
                                   portraits_dir=cls.portraits)
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

        # And the same numbers reached the guide, thousands-separated. They used to sit on
        # the front page; the door has room for one question now, so the glance moved to
        # the top of the manual and took the era row with it.
        page = self.pages["guide/index.html"]
        for value in (builders, captures, populated):
            self.assertIn(f"{value:,}", page, f"{value:,} is not on the guide")

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

    def test_the_shipped_script_and_manifest_do_not_say_them_either(self):
        """The gateway writes visible strings into the page at runtime and the portrait
        manifest carries tags another lane wrote, so neither can be left out of the lint
        just because it is not markup."""
        shipped = {
            self.manifest["assets"]["js"]: (self.out / self.manifest["assets"]["js"]),
            "portraits.json": (self.out / "portraits.json"),
        }
        for name, path in shipped.items():
            lowered = path.read_text(encoding="utf-8").lower()
            for word in BANNED:
                self.assertNotIn(word, lowered, f"{name} contains {word!r}")

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

    def test_the_front_page_is_the_box_and_the_button(self):
        """Everything that used to sit under the fold is gone from the index: the six
        wordless figures, the runic rule, the stat slabs, the era chips and the five
        how-to cards. What is left is a line, a search box and one large button."""
        index = self.pages["index.html"]
        for gone in ('class="path"', 'class="paths"', "runic-rule", "manual-card",
                     'class="stats"', 'class="chips"'):
            self.assertNotIn(gone, index, f"{gone} is still on the front page")
        door = re.search(r'<section class="door">.*?</section>', index, re.S)
        self.assertIsNotNone(door, "the index has no door section")
        self.assertEqual(len(re.findall(r"<img\b", door.group(0))), 0,
                         "the door renders an image the page never asked for")

    def test_the_search_box_is_a_combobox_over_a_plain_get_form(self):
        """Scripting off, this is still a GET to the builders index and Enter still works.
        Scripting on, the same element is the combobox gateway.js drives."""
        index = self.pages["index.html"]
        form = re.search(r"<form[^>]*>", index).group(0)
        self.assertIn('action="/valheim/creators/"', form)
        self.assertIn('method="get"', form)
        self.assertIn('role="search"', form)

        box = re.search(r'<input id="q"[^>]*>', index).group(0)
        self.assertIn('name="q"', box)
        self.assertIn('type="search"', box)
        self.assertIn('maxlength="80"', box)
        self.assertIn('role="combobox"', box)
        self.assertIn('aria-controls="suggestions"', box)
        self.assertIn('aria-expanded="false"', box)
        self.assertIn('aria-autocomplete="list"', box)
        self.assertIn('autocomplete="off"', box)
        # Touch keyboards get a Search key instead of a newline: there is no Find button.
        self.assertIn('enterkeyhint="search"', box)
        self.assertNotIn('type="submit"', index, "the door grew a visible Find button")

        self.assertIn('<ul id="suggestions" role="listbox"', index)
        self.assertIn('<label class="eyebrow" for="q">', index)
        self.assertIn('<p id="finder-status"', index)

        copy = json.loads((Path(build.HERE) / "content" / "copy.json").read_text(encoding="utf-8"))
        for key in ("loading", "load_failed", "no_match"):
            self.assertIn(html.escape(copy["gateway"][key], quote=True), index,
                          f"the list carries no {key} string for the script to read")

    def test_one_large_button_goes_to_the_gallery(self):
        index = self.pages["index.html"]
        cta = re.findall(r'<a class="button forged wide"[^>]*>([^<]*)</a>', index)
        self.assertEqual(len(cta), 1, "the door has more or less than one forged button")
        copy = json.loads((Path(build.HERE) / "content" / "copy.json").read_text(encoding="utf-8"))
        self.assertEqual(cta[0], html.escape(copy["gateway"]["cta"], quote=False))
        self.assertIn('<a class="button forged wide" href="/valheim/"', index)

    # ------------------------------------------------------------- portraits

    def _inlined_manifest(self) -> dict:
        block = re.search(
            r'<script type="application/json" id="portrait-manifest">(.*?)</script>',
            self.pages["index.html"], re.S,
        )
        self.assertIsNotNone(block, "the gateway carries no portrait manifest")
        return json.loads(block.group(1).replace("<\\/", "</"))

    def test_the_portrait_manifest_is_inlined_and_every_tile_is_on_disk(self):
        inlined = self._inlined_manifest()
        self.assertEqual(inlined["schema"], build.PORTRAITS_SCHEMA)
        self.assertEqual(inlined["count"], PORTRAIT_COUNT)
        self.assertEqual(inlined["count"], len(inlined["tiles"]))
        self.assertEqual(inlined["base"], "/chronicles/img/portraits/")
        for tile in inlined["tiles"]:
            full = self.out / "img" / "portraits" / tile["file"]
            thumb = self.out / "img" / "portraits" / tile["thumb"]
            self.assertTrue(full.is_file(), f"{tile['file']} is not in the output")
            self.assertTrue(thumb.is_file(), f"{tile['thumb']} is not in the output")
            self.assertEqual(tile["v"], hashlib.sha256(full.read_bytes()).hexdigest()[:8],
                             f"{tile['id']} carries a stale cache buster")

    def test_the_inlined_manifest_is_the_file_at_the_output_root(self):
        """deploy.py links portraits.json the way it links build.json, so a consumer that
        reads the file and a consumer that reads the page must not disagree."""
        on_disk = json.loads((self.out / "portraits.json").read_text(encoding="utf-8"))
        self.assertEqual(on_disk, self._inlined_manifest())
        self.assertEqual(on_disk["head"], self.manifest["head"])
        for name in build.PATH_IDS:
            self.assertEqual(on_disk["paths"][name]["line"],
                             json.loads((Path(build.HERE) / "content" / "copy.json")
                                        .read_text(encoding="utf-8"))["paths"][name]["card_h3"])
            cutout = on_disk["cutouts"][name]
            for key in ("file", "thumb"):
                self.assertTrue(cutout[key].startswith("/chronicles/img/cutouts/"))
                self.assertTrue((self.out / cutout[key][len("/chronicles/"):]).is_file())

    def test_the_art_has_stable_names_beside_the_hashed_ones(self):
        """The hashed name is what the page links. The stable name is what anything that
        did not read this build's manifest can still ask for, with ?v= from the manifest
        doing the cache busting the filename used to do."""
        for name in build.PATH_IDS:
            full = self.out / "img" / "cutouts" / f"{name}.webp"
            thumb = self.out / "img" / "cutouts" / f"{name}.256.webp"
            self.assertTrue(full.is_file(), f"{name}.webp is missing")
            self.assertTrue(thumb.is_file(), f"{name}.256.webp is missing")
            entry = self.manifest["assets"]["cutouts"][name]
            # Same bytes as the hashed copy, not a second encode of the same source.
            self.assertEqual(full.read_bytes(), (self.out / entry["512"]).read_bytes())
            self.assertEqual(thumb.read_bytes(), (self.out / entry["256"]).read_bytes())
            with Image.open(full) as image:
                self.assertEqual(image.size, (512, 512))
            with Image.open(thumb) as image:
                self.assertEqual(image.size, (256, 256))
        for tile in self.manifest["assets"]["portraits"]["tiles"]:
            full = self.out / "img" / "portraits" / tile["file"]
            thumb = self.out / "img" / "portraits" / tile["thumb"]
            self.assertRegex(tile["file"], r"^p\d{2}\.webp$")
            self.assertRegex(tile["thumb"], r"^p\d{2}\.128\.webp$")
            # The full tile is the artist's file, copied, not re-encoded.
            self.assertEqual(full.read_bytes(),
                             (self.portraits / tile["file"]).read_bytes())
            with Image.open(full) as image:
                self.assertEqual(image.size, (512, 512))
            with Image.open(thumb) as image:
                self.assertEqual(image.size, (128, 128))

    def test_the_guide_carries_the_glance(self):
        guide = self.pages["guide/index.html"]
        glance = re.search(r'<section class="glance".*?</section>', guide, re.S)
        self.assertIsNotNone(glance, "the glance did not land on the guide")
        block = glance.group(0)
        self.assertEqual(len(re.findall(r'<div class="slab stat">', block)), 3)
        for value in (self.manifest["counts"]["builders"], self.manifest["counts"]["photos"],
                      self.manifest["counts"]["erasWithPhotos"]):
            self.assertIn(f"{value:,}", block, f"{value:,} is not in the glance")
        for era in self.eras["eras"]:
            self.assertIn(f'href="{era["href"]}"', block, f"{era['slug']} lost its chip")
        self.assertIn('<span class="eyebrow stat-label">Builders</span>', block)
        self.assertNotIn('class="glance"', self.pages["index.html"])

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
        for key in ("h1", "cta", "search_label", "search_hint", "claim_hint"):
            self.assertIn(written(copy["gateway"][key]), index, key)
        for key in ("search_placeholder", "loading", "load_failed", "no_match"):
            self.assertIn(html.escape(copy["gateway"][key], quote=True), index, key)
        # The lede is no longer read on the door; it is what a link preview shows.
        self.assertIn(f'content="{html.escape(copy["gateway"]["lede"], quote=True)}"', index)
        self.assertIn(written(copy["guide"]["h1"]), guide)
        self.assertIn(written(copy["guide"]["glance_h2"]), guide)
        for name in build.PATH_IDS:
            entry = copy["paths"][name]
            self.assertIn(html.escape(entry["aria_label"], quote=True),
                          (self.out / "portraits.json").read_text(encoding="utf-8"))
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
            manifest = build.build(SOURCE_BASE, out, offline=FIXTURES,
                                   shots_dir=Path(tmp) / "none",
                                   portraits_dir=Path(tmp) / "none")
            self.assertEqual(manifest["assets"]["shots"], {})
            guide = (out / "guide" / "index.html").read_text(encoding="utf-8")
            self.assertNotIn("img/shots/", guide)
            self.assertIn('<section id="find" class="chapter">', guide)

    def test_uses_crops_when_they_are_there(self):
        with tempfile.TemporaryDirectory() as tmp:
            shots = Path(tmp) / "shots"
            shots.mkdir()
            Image.new("RGB", (1600, 900), (30, 40, 50)).save(shots / "find.png")
            Image.new("RGB", (1600, 900), (30, 40, 50)).save(shots / "find-2.png")
            out = Path(tmp) / "site"
            manifest = build.build(SOURCE_BASE, out, offline=FIXTURES, shots_dir=shots,
                                   portraits_dir=Path(tmp) / "none")
            self.assertEqual(set(manifest["assets"]["shots"]), {"find", "find-2"})
            with Image.open(out / manifest["assets"]["shots"]["find"]) as image:
                self.assertEqual(image.size, build.SHOT_SIZE)
            index = (out / "index.html").read_text(encoding="utf-8")
            guide = (out / "guide" / "index.html").read_text(encoding="utf-8")
            # The crops belong to the walkthroughs now; the door shows no pictures at all.
            self.assertEqual(index.count("img/shots/"), 0)
            self.assertEqual(guide.count("../img/shots/"), 2)


class PortraitsAreOptional(unittest.TestCase):
    """The tiles come from another lane and land later than this page does."""

    def test_builds_with_no_portrait_tree_at_all(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "site"
            manifest = build.build(SOURCE_BASE, out, offline=FIXTURES,
                                   portraits_dir=Path(tmp) / "nothing-here")
            self.assertEqual(manifest["assets"]["portraits"], {"count": 0, "tiles": []})
            doc = json.loads((out / "portraits.json").read_text(encoding="utf-8"))
            self.assertEqual(doc["count"], 0)
            self.assertEqual(doc["tiles"], [])
            # The cutouts and the path lines are still named: this file is not only tiles.
            self.assertEqual(set(doc["cutouts"]), set(build.PATH_IDS))
            self.assertFalse((out / "img" / "portraits").exists())
            index = (out / "index.html").read_text(encoding="utf-8")
            self.assertIn('id="portrait-manifest"', index)
            self.assertIn('"count":0', index)

    def test_refuses_a_manifest_that_does_not_match_its_own_tiles(self):
        with tempfile.TemporaryDirectory() as tmp:
            portraits = synth_portraits(Path(tmp) / "portraits", count=3)
            (portraits / "p02.webp").unlink()
            with self.assertRaises(SystemExit):
                build.build(SOURCE_BASE, Path(tmp) / "site", offline=FIXTURES,
                            portraits_dir=portraits)

    def test_refuses_a_manifest_from_another_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            portraits = synth_portraits(Path(tmp) / "portraits", count=2)
            doc = json.loads((portraits / "manifest.json").read_text(encoding="utf-8"))
            doc["schema"] = "chronicles-portraits/v99"
            (portraits / "manifest.json").write_text(json.dumps(doc), encoding="utf-8")
            with self.assertRaises(SystemExit):
                build.build(SOURCE_BASE, Path(tmp) / "site", offline=FIXTURES,
                            portraits_dir=portraits)


class GatewayLogicSuite(unittest.TestCase):
    """The ranking behind the search box is real logic; run it where this gate sees it."""

    def test_node_pure_logic_suite_passes(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not on PATH")
        suite = Path(__file__).resolve().parent / "gateway.logic.test.js"
        result = subprocess.run(
            [node, "--test", str(suite)],
            capture_output=True, text=True, cwd=str(build.REPO),
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("rankBuilders", result.stdout, "the ranking parity cases did not run")
        self.assertIn("portraitIndex", result.stdout, "the tile mapping was not exercised")


if __name__ == "__main__":
    unittest.main()
