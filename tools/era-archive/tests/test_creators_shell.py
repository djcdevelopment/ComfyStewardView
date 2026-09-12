"""Chronicler design-system coverage for the creator directory shell.

Two things this pins that nothing else does:
  * the pure-logic JS suite (creators.logic.test.js, which now covers the Top 8 ranking)
    runs under the same `python -m unittest discover` the rest of the archive uses, so a
    broken ranking cannot pass a green Python run;
  * the restyle itself -- tokens present, the retired teal palette gone, the brand lockup
    and nav in both shells, and the cache-busted stylesheet href still carrying the
    `"./creators.` prefix that gallery.py rewrites to `"../creators.` for thread pages.
"""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from archive import REPO
from gallery import project

WEB = REPO / "tools/era-archive/web"
# Every literal the pre-Chronicler teal/green palette was built from.
RETIRED_PALETTE = [
    "#101c21", "#e2e9e5", "#b8dfbd", "#7cae90", "#304247", "#223438", "#9fb5af",
    "#8da69e", "#7f9691", "#94b2a7", "#c8deda", "#b6c8c2", "#a9c7bf", "#aac0b6",
    "#cfe6d5", "#44615a", "#49615c", "#1b2c31", "#16262b", "#16252b", "#17262a",
    "#152428", "#142226", "#121f23", "#1d3137", "#1f3339", "#22383e", "#274038",
    "#0c1417",
]
REQUIRED_TOKENS = [
    "--surface:", "--surface-low:", "--surface-container:", "--surface-high:",
    "--flame:", "--primary:", "--bronze:", "--on-surface:", "--parchment:",
    "--outline:", "--outline-variant:", "--ember:", "--chisel:",
    "--font-display:", "--font-body:", "--font-mono:",
]


class CreatorsLogicSuiteTests(unittest.TestCase):
    """The JS ranking is real logic; run it where the Python gate can see it."""

    def test_node_pure_logic_suite_passes(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not on PATH")
        suite = REPO / "tools/era-archive/tests/creators.logic.test.js"
        result = subprocess.run(
            [node, "--test", str(suite)],
            capture_output=True, text=True, cwd=str(REPO),
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("computeTopEight", result.stdout, "Top 8 ranking coverage did not run")

    def test_the_pair_logic_suite_runs_under_the_same_gate(self):
        """Red on this branch alone -- tests/pair.logic.test.js is the other builder's
        file this iteration. Green at the merge, and the pairing model is then covered by
        the same `python -m unittest` run everything else is."""
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not on PATH")
        suite = REPO / "tools/era-archive/tests/pair.logic.test.js"
        self.assertTrue(suite.exists(), "pair.logic.test.js has not landed yet")
        result = subprocess.run(
            [node, "--test", str(suite)],
            capture_output=True, text=True, cwd=str(REPO),
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("buildKinshipPair", result.stdout, "pairing model coverage did not run")


class ChroniclerStyleTests(unittest.TestCase):
    def setUp(self):
        self.css = (WEB / "creators.css").read_text(encoding="utf-8")
        self.index = (WEB / "index.html").read_text(encoding="utf-8")
        self.stats = (WEB / "stats.html").read_text(encoding="utf-8")
        self.kinship = (WEB / "kinship.html").read_text(encoding="utf-8")

    def test_self_hosted_faces_and_tokens_lead_the_stylesheet(self):
        self.assertEqual(8, self.css.count("@font-face"))
        for family in ("'Bodoni Moda'", "'Plus Jakarta Sans'", "'JetBrains Mono'"):
            self.assertIn(family, self.css)
        self.assertEqual(8, self.css.count("font-display: swap"))
        self.assertIn("/chronicles/img/fonts/", self.css)
        for token in REQUIRED_TOKENS:
            self.assertIn(token, self.css, f"design token {token} is missing")

    def test_the_teal_palette_is_gone(self):
        survivors = [c for c in RETIRED_PALETTE if c in self.css]
        self.assertEqual([], survivors, f"retired palette still in creators.css: {survivors}")

    def test_chips_are_stone_tablets_not_pills(self):
        self.assertNotIn("border-radius: 999px", self.css)
        self.assertIn("rgba(245, 158, 11, 0.5)", self.css, "active era tablet lost its ember border")

    def test_hero_numbers_wear_a_recessed_counter_cell(self):
        counter = self.css[self.css.index(".stat-tile-value,\n.stat-num,\n.counter {"):]
        counter = counter[:counter.index("}")]
        for rule in ("font-variant-numeric: tabular-nums", "letter-spacing: 0.12em",
                     "background: #090f16", "box-shadow: inset 0 2px 4px #000"):
            self.assertIn(rule, counter)

    def test_focus_ring_and_hidden_rules_survive(self):
        self.assertIn("outline: 2px solid #ffc174", self.css)
        self.assertIn("[hidden] {\n  display: none !important;\n}", self.css)
        self.assertIn(".modal[hidden] {\n  display: none !important;\n}", self.css)
        self.assertIn(".modal.open .sheet {\n  display: block;\n}", self.css)
        self.assertIn("@media (prefers-reduced-motion: reduce)", self.css)

    def test_both_shells_carry_the_brand_lockup_and_nav(self):
        shells = (("index.html", self.index), ("stats.html", self.stats),
                  ("kinship.html", self.kinship))
        for name, content in shells:
            self.assertIn('<a class="brand" href="/chronicles/">', content, name)
            self.assertIn('class="brand-emblem"', content, name)
            self.assertIn('<span class="brand-eyebrow">THE COMFY COMMUNITY</span>', content, name)
            self.assertIn('<span class="brand-name">Valheim Chronicles</span>', content, name)
            for href in ('href="/valheim/"', 'href="/valheim/creators/"',
                         'href="/valheim/creators/stats/"', 'href="/valheim/creators/kinship/"',
                         'href="/chronicles/guide/"'):
                self.assertIn(href, content, f"{name} lost {href}")
            self.assertIn('id="kinship-link"', content, name)
        self.assertIn('href="#participation-details"', self.index)
        for name, content in (("stats.html", self.stats), ("kinship.html", self.kinship)):
            self.assertNotIn('href="#participation-details"', content,
                             "the participation deep link belongs to the directory only")

    def test_the_directory_shell_carries_both_claim_kinds(self):
        # One dialog answers "is this yours" both ways. The shell declares the default
        # mode and holds the guidance copy for each; creators.js swaps data-claim-kind,
        # the title and the confirm label when it opens, and shows the matching block.
        self.assertIn('<section id="claim-modal" class="modal" data-claim-kind="built" hidden>', self.index)
        self.assertIn('data-claim-kind="disavow"', self.index)
        self.assertIn('<h2 id="claim-title">Claim build</h2>', self.index)
        # The wording never says "submitted": nothing leaves this browser on its own.
        self.assertIn("recorded on this device", self.index)
        self.assertNotIn("submitted", self.index)

    def test_the_kinship_shell_carries_both_claim_kinds(self):
        """Red on this branch alone -- kinship.html is the other builder's file this
        iteration, and gets the same claim-modal change there. Green at the merge."""
        self.assertIn('data-claim-kind="disavow"', self.kinship)

    def test_the_disavow_control_is_rendered_and_is_not_the_primary_action(self):
        # The class and the data attribute are the hooks the stylesheet and the smoke
        # reach for, so they are pinned where they are written: the album card is drawn
        # by creators.js, not by the shell.
        js = (WEB / "creators.js").read_text(encoding="utf-8")
        self.assertIn("'claim-disavow'", js)
        self.assertIn("disavow.dataset.claimKind = 'disavow'", js)
        self.assertIn("claim.dataset.claimKind = 'built'", js)
        self.assertIn("node('button', 'I built this', 'primary')", js,
                      "the claim control stays the primary action of the card")
        self.assertIn("standingForBuild", js)

    def test_the_pair_view_script_speaks_the_archive_vocabulary(self):
        """Red on this branch alone -- web/pair.js is the other builder's file this
        iteration. The lint is the same one every other surface gets, and it has to exist
        before the file does or the file lands unlinted."""
        for name in ("pair.js", "kin-tree.js"):
            script = WEB / name
            self.assertTrue(script.exists(), f"web/{name} has not landed yet")
            source = script.read_text(encoding="utf-8").casefold()
            for banned in ("character", "archetype", "submitted"):
                self.assertNotIn(banned, source, f"{name} says '{banned}'")

    def test_the_pair_view_folds_its_detail_under_a_native_disclosure(self):
        # Photo, status line and the shared-builds ledger stay in view; laurels, hearth,
        # affinity, the facts and the tiles open on one <details>. Native, so no script
        # owns the open state -- and a repaint reads it back rather than snapping it shut.
        pair = (WEB / "pair.js").read_text(encoding="utf-8")
        self.assertIn("pairNode('details', null, 'pair-more')", pair)
        self.assertIn("pairNode('summary', 'Details')", pair)
        self.assertIn("pairMoreEl({open: pairMoreOpen()})", pair)

    def test_the_tree_drawing_is_shared_by_both_pages(self):
        tree = (WEB / "kin-tree.js").read_text(encoding="utf-8")
        kinship = (WEB / "kinship.js").read_text(encoding="utf-8")
        creators = (WEB / "creators.js").read_text(encoding="utf-8")
        self.assertIn("function drawKinshipTree(", tree)
        self.assertIn("function layoutKinshipTree(", tree)
        for name, source in (("kinship.js", kinship), ("creators.js", creators)):
            self.assertIn("drawKinshipTree(", source, f"{name} does not draw with the shared tree")
        # A classic script's top-level names are page globals; a second declaration is a
        # load-time SyntaxError that takes the whole page script down with it.
        for moved in ("const KIN_LAYOUT", "function layoutKinshipTree", "function kinBranchCap", "function isUnnamed", "function renderNodes", "function showTip"):
            self.assertNotIn(moved, kinship, f"kinship.js still declares {moved}")

    def test_the_confirmed_tag_sweep_is_scoped_to_the_album_cards(self):
        # renderConfirmedTagChips() clears before it draws, because participation.json and
        # the thread land in either order. Unscoped, that sweep also deleted the pair
        # view's own laurel chips -- which are drawn at mount, i.e. always first.
        js = (WEB / "creators.js").read_text(encoding="utf-8")
        self.assertIn("'article.album .kin-chip'", js,
                      "the confirmed-tag sweep would clear kinship chips outside the albums")

    def test_the_participation_surface_speaks_of_builders_not_characters(self):
        # A builder is a person, not a game object and not a class. The participation
        # surfaces say so: verify_sweep.ps1 holds the same line on the kinship page.
        # (stats.html is the documented exception -- "Player Archetypes" is a section
        # heading about a distribution, pinned by test_stats_page.py, and it is talking
        # about build patterns rather than about anybody.)
        for banned in ("character", "archetype"):
            self.assertNotIn(banned, self.index.casefold(), f"index.html says '{banned}'")

    def test_stylesheet_href_is_cache_busted_and_still_rewritable(self):
        for name, content in (("index.html", self.index), ("stats.html", self.stats)):
            self.assertIn('href="./creators.css?v=8"', content, name)
        self.assertIn('src="./creators.js"', self.index)
        # pair.js and kin-tree.js ride beside creators.js and wear the same cache policy it
        # does: unversioned here, where the stylesheet carries the bust for the whole shell.
        self.assertIn('src="./pair.js"', self.index)
        self.assertIn('src="./kin-tree.js"', self.index)

    def test_route_guard_keeps_creators_inert_on_the_kinship_page(self):
        # kinship.html loads creators.js for its model and its participation store, then
        # kinship.js for the page. creators.js's own bootstrap reaches for #copy-activity
        # and #participant-handle, which the kinship shell does not have, so it has to
        # stand down here rather than throw on the first missing node.
        js = (WEB / "creators.js").read_text(encoding="utf-8")
        self.assertIn("dataset.stewardPage !== 'kinship'", js)
        self.assertIn('<html lang="en" data-steward-page="kinship">', self.kinship)
        self.assertIn('src="./creators.js?v=8"', self.kinship)
        self.assertIn('src="./kin-tree.js?v=8"', self.kinship)
        self.assertIn('src="./kinship.js"', self.kinship)
        self.assertNotIn("data-steward-page", self.index,
                         "the directory shell is the default route, not a named one")

    def test_projected_thread_page_keeps_the_rewritten_asset_paths(self):
        key = "a" * 32
        document = {
            "schema": "steward-community-private/v1",
            "generatedAt": "2026-09-10T00:00:00Z",
            "eras": [12],
            "legacyImports": [],
            "builders": [{"builderKey": key, "displayName": "Skald", "aliases": [],
                          "nameStatus": "recorded", "builds": ["b" * 64]}],
            "builds": [{"buildKey": "b" * 64, "era": 12, "slug": "era12", "label": "Great Hall",
                        "pieces": 900, "contributors": [{"builderKey": key, "pieces": 900, "share": 1.0}],
                        "photos": []}],
        }
        with tempfile.TemporaryDirectory() as temp:
            dest = Path(temp) / "projection"
            receipt = project(document, dest, "https://example.invalid/world")
            thread = (dest / key / "index.html").read_text(encoding="utf-8")
            self.assertIn('href="../creators.css?v=8"', thread)
            self.assertIn('src="../creators.js"', thread)
            # The pair view's script and the tree's get the same climb. A thread page is
            # one directory down, so a surviving "./pair.js would 404 on every profile.
            self.assertIn('src="../pair.js"', thread)
            self.assertNotIn('"./pair.js', thread)
            self.assertIn('src="../kin-tree.js"', thread)
            self.assertNotIn('"./kin-tree.js', thread)
            paths = {f["path"] for f in receipt["files"]}
            self.assertIn("pair.js", paths, "the projection does not ship the pair view's script")
            self.assertIn("kin-tree.js", paths, "the projection does not ship the tree's script")
            stats = (dest / "stats" / "index.html").read_text(encoding="utf-8")
            self.assertIn('href="../creators.css?v=8"', stats)


if __name__ == "__main__":
    unittest.main()
