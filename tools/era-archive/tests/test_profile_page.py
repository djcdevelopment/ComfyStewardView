"""The builder's own page (/valheim/creators/profile/?builder=<key>): its projection, its
shell, the door to it on the builder page, and what it never says.

Pinned here and nowhere else:
  * gallery.py projects profile.html into its own directory like kinship.html, with every
    relative asset link climbing one level -- profile.js and portrait-picker.js included;
  * the page wears the same brand and nav as every other shell and declares itself to the
    route guard (creators.js stands down and lends its store);
  * anyone may try a portrait; a choice is noted to the archive by a beacon the front door
    logs (archive tokens only on the query string), never by a write path;
  * the opt-out levels are the two Derek named plus the default, in that order, and a level
    becomes a message to paste to @Tugcow -- the page's words never include the vocabulary
    the archive does not use;
  * the builder page's avatar is the link here.
"""
import json
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
            for marker in ('href="../creators.css?v=13"', 'src="../creators.js?v=13"', 'src="../portraits.js?v=13"',
                           'src="../portrait-picker.js?v=13"', 'src="../profile.js"',
                           'data-steward-page="profile"', 'id="profile-optout"', 'id="optout-message"'):
                self.assertIn(marker, page, f"projected profile page lost {marker}")
            for stale in ('"./creators.', '"./portraits.js', '"./portrait-picker.js', '"./profile.js'):
                self.assertNotIn(stale, page, f"{stale} would 404 from /profile/")
            paths = {f["path"] for f in receipt["files"]}
            self.assertIn("profile/index.html", paths)
            self.assertIn("profile.js", paths)
            self.assertIn("portrait-beacon.txt", paths, "the beacon the profile page requests ships with the projection")
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

    def test_anyone_may_try_a_portrait_and_the_choice_is_noted_by_a_logged_beacon(self):
        self.assertIn("Not an account", self.page)
        self.assertIn("anyone can try a portrait", self.page)
        self.assertNotIn("discord-client-id", self.page, "no sign-in on this page")
        self.assertNotIn("standingForBuilder", self.script, "no standing gate on the picker")
        self.assertIn("const PROFILE_BEACON = 'portrait-beacon.txt'", self.script)
        for token in ("'action'", "'builder'", "'tile'", "'take'", "'level'", "'receipt'"):
            self.assertIn(f"url.searchParams.set({token}", self.script)
        self.assertNotIn("searchParams.set('note'", self.script, "free text never rides the beacon")
        self.assertNotIn("method: 'POST'", self.script, "no write path: the beacon is a GET the log keeps")
        self.assertIn("StewardPortraitPicker.mount(", self.script)
        self.assertIn("'Your profile settings'", self.creators)

    def test_the_opt_out_levels_are_the_two_named_plus_the_default_in_order(self):
        values = re.findall(r'name="optout-level" value="([a-z]+)"', self.page)
        self.assertEqual(["none", "name", "erase"], values)
        self.assertIn("Keep the pictures, drop my name", self.page)
        self.assertIn("Erase every reference to me and don't use my builds in any process", self.page)
        self.assertIn('id="optout-message-wrap" class="optout-message-wrap" hidden', self.page, "the message appears once a level is picked")
        self.assertIn('id="optout-copy" class="primary">Copy message', self.page)
        self.assertIn("OPT_OUT_LEVELS: ['name', 'erase']", self.creators)

    def test_an_opt_out_is_a_message_to_paste_to_the_coordinator(self):
        self.assertIn("const COORDINATOR_HANDLE = 'Tugcow'", self.script)
        self.assertIn("@Tugcow", self.page)
        self.assertIn("a request from the Valheim Chronicles archive", self.script)
        self.assertNotIn("discord.com", self.script, "nothing is posted anywhere; the builder pastes the message")
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
        self.assertNotIn("StewardPortraitPicker.mount(", self.creators, "the picker lives on the profile page now")


class BeaconLogTests(unittest.TestCase):
    """read_portrait_beacons.py turns the access log back into the choices and the requests."""

    def test_well_formed_lines_become_notes_and_the_latest_choice_per_builder_becomes_a_payload(self):
        import read_portrait_beacons as rpb
        key = "a" * 32
        other = "b" * 32
        lines = [
            {"ts": 1.0, "request": {"remote_ip": "10.0.0.5", "uri": f"/valheim/creators/portrait-beacon.txt?action=choose&builder={key}&tile=viking96%2Fjarl_m_chieftain&take=s7&receipt=r-20260912-deadbeef"}},
            {"ts": 2.0, "request": {"remote_ip": "10.0.0.5", "uri": f"/valheim/creators/portrait-beacon.txt?action=optout&builder={key}&level=name&receipt=r-20260912-cafebabe"}},
            {"ts": 3.0, "request": {"remote_ip": "10.0.0.6", "uri": f"/valheim/creators/portrait-beacon.txt?action=choose&builder={other}&tile=viking96%2Fskald_f_harpist&take=s3&receipt=r-20260912-00000001"}},
            {"ts": 4.0, "request": {"remote_ip": "10.0.0.6", "uri": f"/valheim/creators/portrait-beacon.txt?action=revert&builder={other}&receipt=r-20260912-00000002"}},
            {"ts": 5.0, "request": {"remote_ip": "10.0.0.7", "uri": f"/valheim/creators/portrait-beacon.txt?action=choose&builder=nope&tile=viking96%2Fx"}},
            {"ts": 6.0, "request": {"remote_ip": "10.0.0.7", "uri": f"/valheim/creators/portrait-beacon.txt?action=choose&builder={key}&tile=..%2F..%2Fetc&take=s1"}},
            {"ts": 7.0, "request": {"remote_ip": "10.0.0.7", "uri": "/valheim/creators/search-beacon.txt?q=tug&n=1"}},
            "not json",
        ]
        with tempfile.TemporaryDirectory() as temp:
            log = Path(temp) / "access.log"
            log.write_text("\n".join(json.dumps(l) if isinstance(l, dict) else l for l in lines), encoding="utf-8")
            found = list(rpb.notes([log]))
            self.assertEqual([n["action"] for n in found], ["choose", "optout", "choose", "revert"])
            self.assertEqual(found[0]["tile"], "viking96/jarl_m_chieftain")
            self.assertEqual(found[0]["addr"], "10.0.0.5")
            doc = rpb.payload(found)
            self.assertEqual(doc["schema"], "steward-creator-participation-export/v1")
            by_key = {p["builderKey"]: p for p in doc["portraits"]}
            self.assertEqual(by_key[key]["tile"], "viking96/jarl_m_chieftain")
            self.assertEqual(by_key[key]["take"], "s7")
            self.assertIsNone(by_key[other]["tile"], "the later revert is the latest word")
            self.assertEqual(by_key[key]["receipt"], "r-20260912-deadbeef")
            # And coordinate.py reads it: the accepted shape, with the sha unchecked when absent.
            import coordinate
            cleaned = coordinate.clean_portrait(by_key[key])
            self.assertEqual(cleaned["tile"], "viking96/jarl_m_chieftain")
            self.assertIsNone(coordinate.clean_portrait(by_key[other])["tile"])


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
