"""The builder's own page (/valheim/creators/profile/?builder=<key>): its projection, its
shell, the door to it on the builder page, and what it never says.

Pinned here and nowhere else:
  * gallery.py projects profile.html into its own directory like kinship.html, with every
    relative asset link climbing one level -- profile.js and portrait-picker.js included;
  * the page wears the same brand and nav as every other shell, declares itself to the route
    guard (creators.js stands down and lends its store), and switches Discord sign-in off by
    default (an empty client id);
  * the opt-out levels are the two Derek named plus the default, in that order, and the
    page's words never include the vocabulary the archive does not use;
  * the builder page's avatar is the link here.
"""
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from archive import REPO
from gallery import project
from test_kinship_page import shared_document, ANCHOR

WEB = REPO / "tools/era-archive/web"
BANNED = ("character", "archetype", "submitted", "seed", "gender")


class ProfileProjectionTests(unittest.TestCase):
    def test_the_profile_shell_is_projected_with_rewritten_asset_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            dest = Path(temp) / "projection"
            receipt = project(shared_document(), dest, "https://example.invalid/world")
            page = (dest / "profile" / "index.html").read_text(encoding="utf-8")
            for marker in ('href="../creators.css?v=12"', 'src="../creators.js?v=12"', 'src="../portraits.js?v=12"',
                           'src="../portrait-picker.js?v=12"', 'src="../profile.js"',
                           'data-steward-page="profile"', 'name="discord-client-id"', 'id="profile-optout"'):
                self.assertIn(marker, page, f"projected profile page lost {marker}")
            for stale in ('"./creators.', '"./portraits.js', '"./portrait-picker.js', '"./profile.js'):
                self.assertNotIn(stale, page, f"{stale} would 404 from /profile/")
            paths = {f["path"] for f in receipt["files"]}
            self.assertIn("profile/index.html", paths)
            self.assertIn("profile.js", paths)
            self.assertFalse((dest / "profile.html").exists(), "a root profile.html would serve un-rewritten links")
            # The builder page's avatar is the door: an anchor, rewritten like every asset.
            thread = (dest / ANCHOR / "index.html").read_text(encoding="utf-8")
            self.assertIn('<a id="hero-avatar" class="hero-avatar"', thread)


class ProfileShellTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.page = (WEB / "profile.html").read_text(encoding="utf-8")
        cls.script = (WEB / "profile.js").read_text(encoding="utf-8")
        cls.creators = (WEB / "creators.js").read_text(encoding="utf-8")
        cls.index = (WEB / "index.html").read_text(encoding="utf-8")

    def test_the_shell_carries_the_brand_lockup_and_the_shared_nav(self):
        for marker in ('<a class="brand" href="/chronicles/">', 'class="brand-emblem"', 'href="/valheim/"',
                       'href="/valheim/creators/"', 'href="/valheim/creators/stats/"', 'href="/valheim/creators/kinship/"',
                       'href="/valheim/creators/#participation-details"', 'href="/chronicles/guide/"', 'id="kinship-link"'):
            self.assertIn(marker, self.page, f"profile shell lost {marker}")
        self.assertNotIn('href="#participation-details"', self.page)
        self.assertIn('<meta name="robots" content="noindex">', self.page, "a builder's settings page is not for search engines")

    def test_sign_in_ships_switched_off_and_the_page_says_what_it_is_not(self):
        self.assertIn('<meta name="discord-client-id" content="">', self.page)
        self.assertIn('id="discord-signin"', self.page)
        self.assertIn("Not an account", self.page)
        self.assertIn("confirmed by the coordinator on Discord", self.page)
        self.assertIn("meta[name=\"discord-client-id\"]", self.script)
        self.assertIn("response_type', 'token'", self.script)
        self.assertIn("https://discord.com/api/users/@me", self.script)

    def test_the_opt_out_levels_are_the_two_named_plus_the_default_in_order(self):
        values = re.findall(r'name="optout-level" value="([a-z]+)"', self.page)
        self.assertEqual(["none", "name", "erase"], values)
        self.assertIn("Keep the pictures, drop my name", self.page)
        self.assertIn("Erase every reference to me and don't use my builds in any process", self.page)
        self.assertIn('id="optout-send" class="primary" disabled', self.page, "Send waits for a level other than the default")
        self.assertIn("OPT_OUT_LEVELS: ['name', 'erase']", self.creators)

    def test_requests_go_to_the_relay_with_the_payload_attached_and_fall_back_to_the_copied_payload(self):
        self.assertIn("relay?wait=true", self.script)
        self.assertIn("payload_json", self.script)
        self.assertIn("'files[0]'", self.script)
        self.assertIn("allowed_mentions: {parse: []}", self.script)
        self.assertIn("Send this payload by hand and quote", self.script)
        self.assertIn("exportPayload(state)", self.script)
        self.assertIn("optOuts: Object.values(state.optOuts", self.creators)
        self.assertIn("next.optOuts = parsed.optOuts", self.creators)
        self.assertIn("state.optOuts = fresh.optOuts", self.creators)

    def test_the_page_never_says_what_the_archive_does_not(self):
        for name, content in (("profile.html", self.page), ("profile.js", self.script)):
            lowered = content.lower()
            for word in BANNED:
                self.assertNotIn(word, lowered, f"{name} says '{word}'")

    def test_creators_js_stands_down_here_and_the_avatar_is_the_door(self):
        self.assertIn("!['kinship', 'profile'].includes(document.documentElement.dataset.stewardPage)", self.creators)
        self.assertIn('<a id="hero-avatar" class="hero-avatar"', self.index)
        self.assertIn("profile/?builder=${thread.builderKey}", self.creators)
        self.assertIn("'Your profile settings'", self.creators)
        self.assertNotIn("StewardPortraitPicker.mount(", self.creators, "the picker lives on the profile page now")
        self.assertIn("StewardPortraitPicker.mount(", self.script)


class ProfileLogicSuiteTests(unittest.TestCase):
    def test_node_pure_logic_suite_passes(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not on PATH")
        result = subprocess.run([node, "--test", str(REPO / "tools/era-archive/tests/profile.logic.test.js")],
                                capture_output=True, text=True, cwd=str(REPO))
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
