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
            self.assertIn('href="./creators.css?v=5"', content, name)
        self.assertIn('src="./creators.js"', self.index)

    def test_route_guard_keeps_creators_inert_on_the_kinship_page(self):
        # kinship.html loads creators.js for its model and its participation store, then
        # kinship.js for the page. creators.js's own bootstrap reaches for #copy-activity
        # and #participant-handle, which the kinship shell does not have, so it has to
        # stand down here rather than throw on the first missing node.
        js = (WEB / "creators.js").read_text(encoding="utf-8")
        self.assertIn("dataset.stewardPage !== 'kinship'", js)
        self.assertIn('<html lang="en" data-steward-page="kinship">', self.kinship)
        self.assertIn('src="./creators.js?v=5"', self.kinship)
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
            project(document, dest, "https://example.invalid/world")
            thread = (dest / key / "index.html").read_text(encoding="utf-8")
            self.assertIn('href="../creators.css?v=5"', thread)
            self.assertIn('src="../creators.js"', thread)
            stats = (dest / "stats" / "index.html").read_text(encoding="utf-8")
            self.assertIn('href="../creators.css?v=5"', stats)


if __name__ == "__main__":
    unittest.main()
