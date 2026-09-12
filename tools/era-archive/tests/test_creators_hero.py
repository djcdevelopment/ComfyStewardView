"""The builder hero card and the look-out step at the foot of a builder page.

Three things this pins that nothing else does:
  * the hero card and the path nav ship HIDDEN in the shared shell, so the directory page
    -- which renders the same index.html and never calls renderThread() -- cannot show
    either of them;
  * the five wordless figures carry EXACTLY the strings tools/chronicles/content/copy.json
    already publishes, asserted against that file rather than restated here, so the
    landing page and a builder page can never drift into two vocabularies for one path;
  * gallery.py's projection rewrite still reaches both asset links at their new cache-bust,
    and the projected thread page still carries the hidden hero and nav.

The cards are wordless on purpose: an aria-label, a figure and one action line, with no
`title=` anywhere -- a tooltip would be a second, unreviewed caption.
"""
import json
import re
import sys
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from archive import REPO
from gallery import project

WEB = REPO / "tools/era-archive/web"
COPY = REPO / "tools/chronicles/content/copy.json"
PATH_ORDER = ["find", "study", "walk", "request", "data"]
CUTOUT = re.compile(r"^/chronicles/img/cutouts/(find|study|walk|request|data)(\.256)?\.webp$")
# "Character" and "archetype" are the vocabulary this archive does not use: a builder is a
# builder, credited from a saved construction piece.
BANNED_VOCABULARY = ("character", "archetype")


class PathCards(HTMLParser):
    """Collect the <a class="path"> cards inside #look-out, in document order."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.cards = []
        self._depth = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "a" and "path" in (attrs.get("class") or "").split():
            self.cards.append({"attrs": attrs, "imgs": [], "line": ""})
            self._depth = 1
            return
        if not self.cards or not self._depth:
            return
        if tag == "img":
            self.cards[-1]["imgs"].append(attrs)
        if "path-line" in (attrs.get("class") or "").split():
            self._depth = 2  # inside the one action line

    def handle_endtag(self, tag):
        if tag == "a":
            self._depth = 0
        elif tag == "span" and self._depth == 2:
            self._depth = 1

    def handle_data(self, data):
        if self.cards and self._depth == 2:
            self.cards[-1]["line"] += data


def path_cards(markup):
    parser = PathCards()
    parser.feed(markup)
    return parser.cards


class HeroShellTests(unittest.TestCase):
    def setUp(self):
        self.index = (WEB / "index.html").read_text(encoding="utf-8")
        self.js = (WEB / "creators.js").read_text(encoding="utf-8")
        self.copy = json.loads(COPY.read_text(encoding="utf-8"))["paths"]

    def test_the_hero_card_ships_hidden_with_every_slot_renderThread_fills(self):
        self.assertIn('<section id="builder-hero" class="builder-hero" hidden', self.index)
        # Pass 3 took the labelled facts row and the signature panel out of the hero: the
        # tier and the eras ride the one intro line now, beside the counters.
        for marker in ('id="hero-avatar"', 'id="hero-aliases"', 'class="hero-text"'):
            self.assertIn(marker, self.index, f"hero card lost {marker}")
        for gone in ('id="hero-facts"', 'id="hero-signature"', 'id="hero-kinship"'):
            self.assertNotIn(gone, self.index, f"the hero grew {gone} back")
        # The notes strip at the foot of a builder page: hidden until the thread renders.
        self.assertIn('<section id="thread-notes" class="notes" hidden', self.index)
        # The directory renders this same file and never calls renderThread(): the card and
        # the nav have to be invisible until the thread renderer un-hides them.
        self.assertIn('<nav id="look-out" class="paths" hidden', self.index)

    def test_the_thread_renderer_is_the_only_thing_that_reveals_them(self):
        for target in ("builder-hero", "look-out", "thread-notes"):
            self.assertIn(f"$('{target}')", self.js, f"nothing un-hides #{target}")
        self.assertIn("renderHeroCard();", self.js)
        # renderDirectory() must not touch any of them.
        directory = self.js[self.js.index("function renderDirectory()"):]
        directory = directory[:directory.index("\n  function ", 10)]
        for target in ("builder-hero", "look-out", "hero-avatar", "thread-notes"):
            self.assertNotIn(target, directory, f"the directory renderer reaches for #{target}")

    def test_the_builder_page_tells_one_story_in_order(self):
        # The work, then who they built beside, then the albums -- renderThread() appends
        # them in that order, and each is a real section a reader (and a test) can find.
        thread = self.js[self.js.index("function renderThread()"):]
        order = [thread.index(marker) for marker in
                 ("renderWorkMosaic()", "renderKinshipEmbed()", "'Albums by era'", "renderThreadNotes()")]
        self.assertEqual(order, sorted(order), "the builder page lost its order")
        # The attribution sentence is said once for the page, not once per album.
        self.assertIn("distinctAttributions(", self.js)
        self.assertIn("'albums-note muted'", self.js)
        # Album rows collapse: the toggle owns aria-expanded and the body is hidden by default.
        for marker in ("'album-toggle'", "aria-expanded", "'album-more'", "setAlbumExpanded("):
            self.assertIn(marker, self.js, f"album rows lost {marker}")
        # The tree is drawn on the profile with the shared drawing, and the ribbon is its
        # caption: no second heading for the same eight names.
        self.assertIn("drawKinshipTree(", self.js)
        self.assertNotIn("'Top 8 · Shield-wall fellows'", self.js)
        self.assertIn("top8-kinship-link", self.js)

    def test_five_wordless_figures_in_order_with_the_published_strings(self):
        cards = path_cards(self.index)
        self.assertEqual(5, len(cards), "the look-out step is exactly five paths")
        self.assertEqual(PATH_ORDER, [c["attrs"].get("data-path") for c in cards])
        for card in cards:
            key = card["attrs"]["data-path"]
            published = self.copy[key]
            self.assertEqual(published["aria_label"], card["attrs"].get("aria-label"), key)
            self.assertEqual(published["href"], card["attrs"].get("href"), key)
            self.assertEqual(published["card_h3"], card["line"].strip(), key)

    def test_every_figure_is_stable_cutout_art_and_never_a_tooltip(self):
        cards = path_cards(self.index)
        for card in cards:
            key = card["attrs"]["data-path"]
            self.assertNotIn("title", card["attrs"], f"{key} card grew a tooltip")
            self.assertEqual(1, len(card["imgs"]), key)
            image = card["imgs"][0]
            self.assertNotIn("title", image, f"{key} figure grew a tooltip")
            self.assertEqual("", image.get("alt"), f"{key} figure must be decorative")
            self.assertRegex(image.get("src", ""), CUTOUT, key)
            for candidate in image.get("srcset", "").split(","):
                url = candidate.strip().split(" ")[0]
                if url:
                    self.assertRegex(url, CUTOUT, f"{key} srcset entry {url}")

    def test_the_page_never_calls_a_builder_a_character(self):
        tree = (WEB / "kin-tree.js").read_text(encoding="utf-8")
        for name, content in (("index.html", self.index), ("creators.js", self.js), ("kin-tree.js", tree)):
            for word in BANNED_VOCABULARY:
                self.assertNotIn(word, content.lower(), f"{name} says '{word}'")


class HeroProjectionTests(unittest.TestCase):
    """gallery.py rewrites `"./creators.` to `"../creators.` for every thread page."""

    def test_projected_thread_page_carries_the_hidden_hero_and_the_bumped_stylesheet(self):
        key = "5897d38e2a065e36a6895e70a2194738"
        document = {
            "schema": "steward-community-private/v1",
            "generatedAt": "2026-09-10T00:00:00Z",
            "eras": [12],
            "legacyImports": [],
            "builders": [{"builderKey": key, "displayName": "Tugcow", "aliases": ["tugcow"],
                          "nameStatus": "recorded", "builds": ["b" * 64]}],
            "builds": [{"buildKey": "b" * 64, "era": 12, "slug": "era12", "label": "Harbour Gate",
                        "pieces": 1204, "contributors": [{"builderKey": key, "pieces": 1204, "share": 1.0}],
                        "photos": []}],
        }
        with tempfile.TemporaryDirectory() as temp:
            destination = Path(temp) / "projection"
            project(document, destination, "https://example.invalid/world")
            thread = (destination / key / "index.html").read_text(encoding="utf-8")
        self.assertIn('href="../creators.css?v=8"', thread)
        self.assertIn('src="../creators.js"', thread)
        self.assertIn('src="../kin-tree.js"', thread)
        self.assertNotIn('"./kin-tree.js', thread)
        self.assertIn('<section id="builder-hero" class="builder-hero" hidden', thread)
        self.assertIn('<nav id="look-out" class="paths" hidden', thread)
        # Absolute figure and destination URLs are shared with the landing page and must
        # survive the rewrite untouched -- only the two "./creators. asset links move.
        self.assertEqual(PATH_ORDER, [c["attrs"].get("data-path") for c in path_cards(thread)])
        self.assertIn('src="/chronicles/img/cutouts/find.webp"', thread)


if __name__ == "__main__":
    unittest.main()
