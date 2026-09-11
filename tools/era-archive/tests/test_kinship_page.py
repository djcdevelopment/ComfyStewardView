"""The kinship page: its projection, its shell, and the one route it must not steal.

Three things this pins that nothing else does:
  * gallery.py projects kinship.html into its own directory the way it already projects
    stats.html, so every relative asset link climbs one level -- including kinship.js,
    which is a second script and would otherwise 404 from `/valheim/creators/kinship/`;
  * the tag vocabulary is one closed list in three places -- the checkboxes a volunteer
    ticks, the ids creators.js will write into the ledger, and the allowlist gallery.py
    sanitises the public file against -- and a tag that exists in only two of them is a
    tag that is recorded and then silently dropped;
  * creators.js stands down on this page. It is loaded here for its model and its
    participation store, not to render a directory, and its bootstrap reaches for
    #copy-activity and #participant-handle, neither of which the kinship shell has.
"""
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gallery
from archive import REPO
from gallery import project

WEB = REPO / "tools/era-archive/web"
# "Character" and "archetype" are the vocabulary this archive does not use: a builder is a
# builder, credited from a saved construction piece.
BANNED_VOCABULARY = ("character", "archetype")
ANCHOR = "a" * 32
CO_BUILDER = "b" * 32
SHARED_BUILD = "c" * 64
SOLO_BUILD = "d" * 64


class TagCheckboxes(HTMLParser):
    """The `value=` of every kinship tag checkbox, in document order."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.values = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "input" and attrs.get("name") == "kin-tag" and attrs.get("type") == "checkbox":
            self.values.append(attrs.get("value"))


def tag_checkbox_values(markup):
    parser = TagCheckboxes()
    parser.feed(markup)
    return parser.values


def creators_js_tag_ids(source):
    """The ids inside creators.js's own KINSHIP_TAGS, relationship group then role group."""
    block = source[source.index("const KINSHIP_TAGS = {"):]
    block = block[:block.index("\n};")]
    return re.findall(r"\['([a-z-]+)', '", block)


def shared_document():
    """Two builders, one build they share and one the anchor holds alone."""
    return {
        "schema": "steward-community-private/v1",
        "generatedAt": "2026-09-10T00:00:00Z",
        "eras": [12],
        "legacyImports": [],
        "builders": [
            {"builderKey": ANCHOR, "displayName": "Skald", "aliases": [],
             "nameStatus": "recorded", "builds": [SHARED_BUILD, SOLO_BUILD]},
            {"builderKey": CO_BUILDER, "displayName": "Runa", "aliases": [],
             "nameStatus": "recorded", "builds": [SHARED_BUILD]},
        ],
        "builds": [
            {"buildKey": SHARED_BUILD, "era": 12, "slug": "era12", "label": "Great Hall",
             "pieces": 900, "photos": [],
             "contributors": [{"builderKey": ANCHOR, "pieces": 600, "share": 0.67},
                              {"builderKey": CO_BUILDER, "pieces": 300, "share": 0.33}]},
            {"buildKey": SOLO_BUILD, "era": 12, "slug": "era12", "label": "Smithy",
             "pieces": 200, "photos": [],
             "contributors": [{"builderKey": ANCHOR, "pieces": 200, "share": 1.0}]},
        ],
    }


class KinshipProjectionTests(unittest.TestCase):
    def test_the_kinship_shell_is_projected_with_rewritten_asset_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            dest = Path(temp) / "projection"
            receipt = project(shared_document(), dest, "https://example.invalid/world")
            page = (dest / "kinship" / "index.html").read_text(encoding="utf-8")
            for marker in ('href="../creators.css?v=5"', 'src="../creators.js?v=5"',
                           'src="../kinship.js"', 'data-steward-page="kinship"', 'id="kin-tree"'):
                self.assertIn(marker, page, f"projected kinship page lost {marker}")
            # The rewrite must not leave a same-directory link behind for either script.
            self.assertNotIn('"./creators.', page)
            self.assertNotIn('"./kinship.js', page)
            self.assertTrue((dest / "kinship.js").exists(), "kinship.js ships beside creators.js")
            paths = {f["path"] for f in receipt["files"]}
            self.assertIn("kinship/index.html", paths)
            self.assertIn("kinship.js", paths)
            # stats keeps its root copy; kinship has no published root URL to preserve.
            self.assertTrue((dest / "stats.html").exists())
            self.assertFalse((dest / "kinship.html").exists(),
                             "a root kinship.html would serve un-rewritten asset links")


class KinshipShellTests(unittest.TestCase):
    def setUp(self):
        self.page = (WEB / "kinship.html").read_text(encoding="utf-8")
        self.script = (WEB / "kinship.js").read_text(encoding="utf-8")
        self.creators = (WEB / "creators.js").read_text(encoding="utf-8")

    def test_the_shell_carries_the_brand_lockup_and_the_shared_nav(self):
        self.assertIn('<a class="brand" href="/chronicles/">', self.page)
        self.assertIn('class="brand-emblem"', self.page)
        self.assertIn('<span class="brand-eyebrow">THE COMFY COMMUNITY</span>', self.page)
        self.assertIn('<span class="brand-name">Valheim Chronicles</span>', self.page)
        for href in ('href="/valheim/"', 'href="/valheim/creators/"',
                     'href="/valheim/creators/stats/"', 'href="/valheim/creators/kinship/"',
                     'href="/chronicles/guide/"'):
            self.assertIn(href, self.page, f"kinship.html lost {href}")
        self.assertIn('id="kinship-link"', self.page)
        # The participation fold is a <details> that only exists on the directory page,
        # so the bare fragment would jump to nothing here.
        self.assertNotIn('href="#participation-details"', self.page)

    def test_both_dialogs_the_page_drives_are_present(self):
        self.assertIn('id="claim-modal"', self.page)
        self.assertIn('id="kin-tag-modal"', self.page)

    def test_one_tag_vocabulary_across_the_checkboxes_the_model_and_the_sanitiser(self):
        checkboxes = tag_checkbox_values(self.page)
        self.assertEqual(list(gallery.KINSHIP_TAGS), checkboxes,
                         "the ticked boxes and gallery.py's allowlist have drifted")
        self.assertEqual(list(gallery.KINSHIP_TAGS), creators_js_tag_ids(self.creators),
                         "creators.js KINSHIP_TAGS and gallery.py KINSHIP_TAGS have drifted")
        self.assertEqual(10, len(gallery.KINSHIP_TAGS))

    def test_the_kinship_page_never_calls_a_builder_a_character(self):
        for name, content in (("kinship.html", self.page), ("kinship.js", self.script)):
            for word in BANNED_VOCABULARY:
                self.assertNotIn(word, content.lower(), f"{name} says '{word}'")

    def test_creators_js_stands_down_here_but_still_lends_its_store(self):
        self.assertIn("dataset.stewardPage !== 'kinship'", self.creators,
                      "creators.js would boot the directory renderer on the kinship page")
        self.assertIn("const StewardParticipation", self.creators,
                      "kinship.js reads the participation store off creators.js")


class KinshipLogicSuiteTests(unittest.TestCase):
    """The layout is real logic; run it where the Python gate can see it."""

    def test_node_pure_logic_suite_passes(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not on PATH")
        suite = REPO / "tools/era-archive/tests/kinship.logic.test.js"
        result = subprocess.run(
            [node, "--test", str(suite)],
            capture_output=True, text=True, cwd=str(REPO),
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        # The named-coverage pin arms itself. While layoutKinshipTree is still the
        # skeleton's stub there is no layout to cover, so requiring a test that names it
        # would only be red for a reason nobody can fix. The moment the stub is replaced
        # the requirement becomes real, and a layout shipped without its own case in this
        # suite fails the Python gate the same way a broken Top 8 ranking does.
        script = (WEB / "kinship.js").read_text(encoding="utf-8")
        if "Placeholder: Builder A replaces this" in script:
            self.skipTest("kinship.js layout is still the skeleton stub")
        self.assertIn("layoutKinshipTree", result.stdout, "kinship layout coverage did not run")


if __name__ == "__main__":
    unittest.main()
