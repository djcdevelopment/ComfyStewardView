"""The coordinator's end of a lane that has no endpoint.

`coordinate.py` owns `<output-root>/analysis/participation.json`. It is the only place the
handles, notes and contact addresses volunteers send ever land, and the last of these tests
is the one that matters most: whatever it holds, what `gallery.py` publishes from it is
five keys per confirmed tag and four counts, and none of the rest can reach a public page.
"""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import coordinate
import gallery
from gallery import project

BUILDER = "a" * 32
CONTRIBUTOR = "b" * 32
BUILD = "c" * 64
OTHER_BUILD = "d" * 64
WORLD = "https://example.invalid/world"

# Everything a volunteer typed. The coordinator keeps all of it; the projection keeps none.
HANDLE = "Skald the Loud"
NOTE = "we built the roof together"
CONTACT = "skald@example.invalid"


def run(*argv):
    """Drive the real CLI, so the argparse wiring is covered and not just the functions."""
    saved = sys.argv
    sys.argv = ["coordinate.py", *[str(a) for a in argv]]
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            coordinate.main()
    finally:
        sys.argv = saved
    return out.getvalue()


def claim(claim_id="claim-1", kind="built", build_key=BUILD, participant=HANDLE):
    return {"claimId": claim_id, "buildKey": build_key, "builderKey": BUILDER, "kind": kind,
            "participant": participant, "buildLabel": "Great Hall", "era": 12,
            "note": NOTE, "createdAt": "2026-09-10T00:00:00Z", "deliveryStatus": "queued"}


def request(request_id="request-1", participant=HANDLE, **extra):
    payload = {"requestId": request_id, "buildKey": BUILD, "builderKey": BUILDER,
               "claimId": "claim-1", "buildLabel": "Great Hall", "era": 12,
               "participant": participant, "styles": ["night-tone"], "note": NOTE,
               "contact": CONTACT, "urgency": "normal", "createdAt": "2026-09-10T00:00:00Z"}
    payload.update(extra)
    return payload


def tag(tag_id="kintag-1", tags=("mason", "basemate"), participant=HANDLE, contributor=CONTRIBUTOR):
    return {"tagId": tag_id, "buildKey": BUILD, "era": 12, "builderKey": BUILDER,
            "contributorKey": contributor, "tags": list(tags), "note": NOTE,
            "participant": participant, "claimId": "claim-1",
            "createdAt": "2026-09-10T00:00:00Z", "deliveryStatus": "queued"}


def write_payload(root, payload, name="payload.json"):
    path = root / name
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def read_file(root):
    return json.loads(coordinate.participation_path(root).read_text(encoding="utf-8"))


def document():
    return {
        "schema": "steward-community-private/v1",
        "generatedAt": "2026-09-10T00:00:00Z",
        "eras": [12],
        "legacyImports": [],
        "builders": [{"builderKey": BUILDER, "displayName": "Skald", "aliases": [],
                      "nameStatus": "recorded", "builds": [BUILD]}],
        "builds": [{"buildKey": BUILD, "era": 12, "slug": "era12", "label": "Great Hall",
                    "pieces": 900, "photos": [],
                    "contributors": [{"builderKey": BUILDER, "pieces": 600, "share": 0.67},
                                     {"builderKey": CONTRIBUTOR, "pieces": 300, "share": 0.33}]}],
    }


class CoordinateTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def seed(self):
        run("--output-root", self.root, "seed")

    def ingest(self, payload, name="payload.json"):
        return run("--output-root", self.root, "ingest", write_payload(self.root, payload, name))


class SeedTests(CoordinateTestCase):
    def test_seed_writes_an_empty_file_and_then_refuses_to_do_it_again(self):
        self.seed()
        seeded = read_file(self.root)
        self.assertEqual(coordinate.SCHEMA, seeded["schema"])
        for count in ("participants", "claims", "disavowals", "requests", "openRequests"):
            self.assertEqual(0, seeded[count], count)
        for empty in ("confirmedTags", "claimRecords", "requestRecords", "tagRecords"):
            self.assertEqual([], seeded[empty], empty)
        # Seeding over a live file would silently discard every record a volunteer sent.
        with self.assertRaises(SystemExit):
            self.seed()

    def test_a_dry_run_seed_writes_nothing(self):
        run("--output-root", self.root, "seed", "--dry-run")
        self.assertFalse(coordinate.participation_path(self.root).exists())

    def test_every_other_command_refuses_an_unseeded_root(self):
        # "-" among them on purpose: `ingest` must reach that refusal without first
        # reading stdin, or a mistyped root blocks the terminal waiting for a payload it
        # could never have filed. This assertion is what proves it does not hang.
        for argv in (("ingest", "-"), ("ingest", str(self.root / "missing.json")),
                     ("confirm-tag", f"{BUILD}:{CONTRIBUTOR}"),
                     ("revoke-tag", f"{BUILD}:{CONTRIBUTOR}"), ("forget", HANDLE), ("status",)):
            with self.assertRaises(SystemExit, msg=argv[0]):
                run("--output-root", self.root, *argv)


class IngestTests(CoordinateTestCase):
    def setUp(self):
        super().setUp()
        self.seed()

    def test_the_whole_ledger_export_lands_as_records_and_counts(self):
        self.ingest({"schema": coordinate.EXPORT_SCHEMA, "createdAt": "2026-09-10T01:00:00Z",
                     "participant": HANDLE, "claims": [claim()], "requests": [request()],
                     "kinshipTags": [tag()]})
        stored = read_file(self.root)
        self.assertEqual(1, len(stored["claimRecords"]))
        self.assertEqual(1, len(stored["requestRecords"]))
        self.assertEqual(1, len(stored["tagRecords"]))
        self.assertEqual({"participants": 1, "claims": 1, "disavowals": 0,
                          "requests": 1, "openRequests": 1},
                         {k: stored[k] for k in ("participants", "claims", "disavowals",
                                                 "requests", "openRequests")})
        # The note and the contact are exactly why this file exists: somebody has to be
        # able to answer the person who sent it.
        self.assertEqual(NOTE, stored["claimRecords"][0]["note"])
        self.assertEqual(CONTACT, stored["requestRecords"][0]["contact"])
        self.assertTrue(stored["claimRecords"][0]["receivedAt"], "an ingested record is stamped")

    def test_a_single_build_payload_is_one_card_worth_of_the_same_thing(self):
        self.ingest({"schema": coordinate.BUILD_SCHEMA, "exportAt": "2026-09-10T01:00:00Z",
                     "builderKey": BUILDER, "buildKey": BUILD, "buildLabel": "Great Hall",
                     "claim": claim(), "requests": [request()], "kinshipTags": [tag()]})
        stored = read_file(self.root)
        self.assertEqual(["claim-1"], [c["claimId"] for c in stored["claimRecords"]])
        self.assertEqual(["request-1"], [r["requestId"] for r in stored["requestRecords"]])
        self.assertEqual(["kintag-1"], [t["tagId"] for t in stored["tagRecords"]])

    def test_each_event_shape_lands_on_its_own_list(self):
        self.ingest({"schema": coordinate.EVENT_SCHEMA, "eventType": "claim", "claim": claim()},
                    "claim-event.json")
        self.ingest({"schema": coordinate.EVENT_SCHEMA, "eventType": "photoRequest",
                     "request": request()}, "request-event.json")
        self.ingest({"schema": coordinate.EVENT_SCHEMA, "eventType": "kinshipTag",
                     "kinshipTag": tag()}, "tag-event.json")
        stored = read_file(self.root)
        self.assertEqual(1, len(stored["claimRecords"]))
        self.assertEqual(1, len(stored["requestRecords"]))
        self.assertEqual(1, len(stored["tagRecords"]))

    def test_stdin_is_a_payload_source(self):
        saved = sys.stdin
        sys.stdin = io.StringIO(json.dumps(
            {"schema": coordinate.EVENT_SCHEMA, "eventType": "claim", "claim": claim()}))
        try:
            run("--output-root", self.root, "ingest", "-")
        finally:
            sys.stdin = saved
        self.assertEqual(1, len(read_file(self.root)["claimRecords"]))

    def test_an_unknown_schema_or_event_is_refused_rather_than_half_read(self):
        for payload in ({"schema": "steward-something-else/v1", "claims": [claim()]},
                        {"schema": coordinate.EVENT_SCHEMA, "eventType": "vote"}):
            with self.assertRaises(SystemExit):
                self.ingest(payload, "bad.json")

    def test_a_resent_record_replaces_its_earlier_copy_rather_than_doubling_it(self):
        self.ingest({"schema": coordinate.EXPORT_SCHEMA, "claims": [claim()],
                     "requests": [request()], "kinshipTags": [tag()]}, "first.json")
        amended = claim()
        amended["note"] = "actually it was the west wing"
        self.ingest({"schema": coordinate.EXPORT_SCHEMA, "claims": [amended],
                     "kinshipTags": [tag(tags=("roof",))]}, "second.json")
        stored = read_file(self.root)
        self.assertEqual(["claim-1"], [c["claimId"] for c in stored["claimRecords"]])
        self.assertEqual("actually it was the west wing", stored["claimRecords"][0]["note"])
        self.assertEqual(["roof"], stored["tagRecords"][0]["tags"], "the later word wins")
        self.assertEqual(1, stored["claims"])

    def test_a_disavowal_is_counted_apart_from_a_claim_and_defaults_the_other_way(self):
        no_kind = claim("claim-legacy")
        no_kind.pop("kind")
        self.ingest({"schema": coordinate.EXPORT_SCHEMA, "claims": [
            claim("claim-1", kind="built"),
            claim("claim-2", kind="disavow", build_key=OTHER_BUILD),
            no_kind]}, "kinds.json")
        stored = read_file(self.root)
        self.assertEqual(2, stored["claims"])
        self.assertEqual(1, stored["disavowals"])
        self.assertEqual("built", stored["claimRecords"][2]["kind"],
                         "a ledger written before disavowal existed is a ledger of built claims")

    def test_records_that_name_no_build_are_dropped(self):
        broken_claim = claim("claim-2", build_key="not-a-build-key")
        broken_tag = tag("kintag-2", contributor="nope")
        self.ingest({"schema": coordinate.EXPORT_SCHEMA,
                     "claims": [broken_claim, {"buildKey": BUILD}],
                     "requests": [{"requestId": "", "buildKey": BUILD, "builderKey": BUILDER}],
                     "kinshipTags": [broken_tag]}, "broken.json")
        stored = read_file(self.root)
        self.assertEqual([], stored["claimRecords"])
        self.assertEqual([], stored["requestRecords"])
        self.assertEqual([], stored["tagRecords"])

    def test_tag_ids_outside_the_closed_vocabulary_are_dropped_with_the_tag_they_orphan(self):
        self.ingest({"schema": coordinate.EXPORT_SCHEMA, "kinshipTags": [
            tag("kintag-known", tags=("mason", "landlord", "mason")),
            tag("kintag-unknown", tags=("landlord", "sheriff"), contributor="e" * 32)]},
            "vocab.json")
        stored = read_file(self.root)
        self.assertEqual(["kintag-known"], [t["tagId"] for t in stored["tagRecords"]],
                         "a record with nothing left in the vocabulary is not a tag")
        self.assertEqual(["mason"], stored["tagRecords"][0]["tags"])

    def test_an_open_request_closes_when_a_resent_copy_carries_closedAt(self):
        self.ingest({"schema": coordinate.EXPORT_SCHEMA, "requests": [request()]}, "open.json")
        self.assertEqual(1, read_file(self.root)["openRequests"])
        self.ingest({"schema": coordinate.EXPORT_SCHEMA,
                     "requests": [request(closedAt="2026-09-11T00:00:00Z")]}, "closed.json")
        stored = read_file(self.root)
        self.assertEqual(1, stored["requests"])
        self.assertEqual(0, stored["openRequests"])

    def test_a_dry_run_ingest_reports_and_writes_nothing(self):
        before = coordinate.participation_path(self.root).read_text(encoding="utf-8")
        run("--output-root", self.root, "ingest",
            write_payload(self.root, {"schema": coordinate.EXPORT_SCHEMA, "claims": [claim()]}),
            "--dry-run")
        self.assertEqual(before, coordinate.participation_path(self.root).read_text(encoding="utf-8"))


class ConfirmAndForgetTests(CoordinateTestCase):
    def setUp(self):
        super().setUp()
        self.seed()
        self.ingest({"schema": coordinate.EXPORT_SCHEMA, "participant": HANDLE,
                     "claims": [claim()], "requests": [request()], "kinshipTags": [tag()]})

    def pair(self):
        return f"{BUILD}:{CONTRIBUTOR}"

    def test_confirming_copies_the_public_fields_and_remembers_where_it_came_from(self):
        run("--output-root", self.root, "confirm-tag", self.pair())
        confirmed = read_file(self.root)["confirmedTags"]
        self.assertEqual(1, len(confirmed))
        entry = confirmed[0]
        self.assertEqual({"buildKey", "contributorKey", "builderKey", "tags", "confirmedAt", "tagId"},
                         set(entry))
        self.assertEqual(BUILD, entry["buildKey"])
        self.assertEqual(CONTRIBUTOR, entry["contributorKey"])
        self.assertEqual(BUILDER, entry["builderKey"])
        self.assertEqual(["basemate", "mason"], entry["tags"])
        self.assertTrue(entry["confirmedAt"])
        self.assertEqual("kintag-1", entry["tagId"], "the receipt forget() follows")
        for private in (NOTE, CONTACT):
            self.assertNotIn(private, json.dumps(entry))

    def test_confirming_twice_replaces_rather_than_duplicates(self):
        run("--output-root", self.root, "confirm-tag", self.pair())
        self.ingest({"schema": coordinate.EXPORT_SCHEMA,
                     "kinshipTags": [tag(tags=("portal",))]}, "retag.json")
        run("--output-root", self.root, "confirm-tag", self.pair())
        confirmed = read_file(self.root)["confirmedTags"]
        self.assertEqual(1, len(confirmed))
        self.assertEqual(["portal"], confirmed[0]["tags"])

    def test_confirming_a_tag_nobody_sent_is_refused(self):
        with self.assertRaises(SystemExit):
            run("--output-root", self.root, "confirm-tag", f"{OTHER_BUILD}:{CONTRIBUTOR}")
        with self.assertRaises(SystemExit):
            run("--output-root", self.root, "confirm-tag", "not-a-pair")

    def test_revoking_removes_the_published_tag_and_leaves_the_record(self):
        run("--output-root", self.root, "confirm-tag", self.pair())
        run("--output-root", self.root, "revoke-tag", self.pair())
        stored = read_file(self.root)
        self.assertEqual([], stored["confirmedTags"])
        self.assertEqual(1, len(stored["tagRecords"]), "revoking unpublishes; it does not forget")
        with self.assertRaises(SystemExit):
            run("--output-root", self.root, "revoke-tag", self.pair())

    def test_forget_removes_every_record_that_handle_sent_and_the_tags_they_carried(self):
        run("--output-root", self.root, "confirm-tag", self.pair())
        # A second volunteer, whose records must survive somebody else's withdrawal.
        survivor = claim("claim-9", build_key=OTHER_BUILD, participant="Other")
        survivor["note"] = "the longhouse by the docks is mine"
        self.ingest({"schema": coordinate.EXPORT_SCHEMA, "participant": "Other",
                     "claims": [survivor]}, "other.json")
        self.assertEqual(2, read_file(self.root)["participants"])
        run("--output-root", self.root, "forget", "  skald THE loud ")
        stored = read_file(self.root)
        self.assertEqual([], stored["requestRecords"])
        self.assertEqual([], stored["tagRecords"])
        self.assertEqual([], stored["confirmedTags"],
                         "a confirmed tag is the handle's words about a second person")
        self.assertEqual(["claim-9"], [c["claimId"] for c in stored["claimRecords"]])
        self.assertEqual(1, stored["participants"])
        raw = coordinate.participation_path(self.root).read_text(encoding="utf-8")
        for private in (HANDLE, NOTE, CONTACT):
            self.assertNotIn(private, raw, f"forget left '{private}' behind")

    def test_a_handle_the_console_cannot_spell_does_not_kill_the_command(self):
        # Real handles in this archive include "Talᵀʳᵒˡˡᵖᵘⁿᶜʰᵉʳ". A legacy Windows console
        # cannot encode that, and the write has already happened by the time it prints.
        exotic = "Talᵀʳᵒˡˡᵖᵘⁿᶜʰᵉʳ"
        self.ingest({"schema": coordinate.EXPORT_SCHEMA, "participant": exotic,
                     "claims": [claim("claim-x", build_key=OTHER_BUILD, participant=exotic)]},
                    "exotic.json")
        printed = run("--output-root", self.root, "status")
        self.assertIn("participants   2", printed)
        run("--output-root", self.root, "forget", exotic)
        self.assertEqual(1, read_file(self.root)["participants"])

    def test_status_names_the_next_three_commands_with_this_roots_paths(self):
        printed = run("--output-root", self.root, "status")
        self.assertIn("1 built · 0 disavowed", printed)
        self.assertIn("1 open", printed)
        self.assertIn("0 confirmed · 1 pending", printed)
        for tool in ("gallery.py", "gate_creators.py", "deploy_gallery.py"):
            self.assertIn(tool, printed)
        self.assertIn(str(self.root), printed)


class ProjectionTests(CoordinateTestCase):
    """The whole point: what this file holds, and what a visitor can ever see of it."""

    def test_the_public_projection_of_a_coordinator_file_carries_no_personal_data(self):
        self.seed()
        self.ingest({"schema": coordinate.EXPORT_SCHEMA, "participant": HANDLE,
                     "claims": [claim(), claim("claim-2", kind="disavow", build_key=OTHER_BUILD)],
                     "requests": [request()], "kinshipTags": [tag()]})
        run("--output-root", self.root, "confirm-tag", f"{BUILD}:{CONTRIBUTOR}")
        dest = self.root / "projection"
        project(document(), dest, WORLD, self.root)
        raw = (dest / "participation.json").read_text(encoding="utf-8")
        published = json.loads(raw)

        self.assertEqual("steward-creator-participation-public/v1", published["schema"])
        self.assertEqual(1, published["participants"])
        self.assertEqual(1, published["claims"])
        self.assertEqual(1, published["disavowals"])
        self.assertEqual(1, published["requests"])
        self.assertEqual(1, published["openRequests"])
        self.assertEqual(1, len(published["confirmedTags"]))
        self.assertEqual({"buildKey", "contributorKey", "builderKey", "tags", "confirmedAt"},
                         set(published["confirmedTags"][0]),
                         "the public tag is a whitelist; the coordinator's tagId stays home")
        # Values first, then the keys themselves -- quoted, because "participants" is a
        # published count and contains the very key this must prove is absent.
        for leaked in (HANDLE, NOTE, CONTACT, "claim-1", "kintag-1", "request-1"):
            self.assertNotIn(leaked, raw, f"the published file leaks '{leaked}'")
        for key in ("participant", "note", "contact", "tagId",
                    "claimRecords", "requestRecords", "tagRecords"):
            self.assertNotIn(f'"{key}"', raw, f"the published file carries a '{key}' key")

    def test_a_forgotten_handle_leaves_the_public_file_too(self):
        self.seed()
        self.ingest({"schema": coordinate.EXPORT_SCHEMA, "participant": HANDLE,
                     "claims": [claim()], "kinshipTags": [tag()]})
        run("--output-root", self.root, "confirm-tag", f"{BUILD}:{CONTRIBUTOR}")
        run("--output-root", self.root, "forget", HANDLE)
        dest = self.root / "projection"
        project(document(), dest, WORLD, self.root)
        published = json.loads((dest / "participation.json").read_text(encoding="utf-8"))
        self.assertEqual([], published["confirmedTags"])
        self.assertEqual(0, published["participants"])
        self.assertEqual(0, published["claims"])

    def test_an_older_coordinator_file_without_disavowals_reads_as_zero(self):
        path = coordinate.participation_path(self.root)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"schema": coordinate.SCHEMA, "participants": 2, "claims": 3,
                                    "requests": 1, "openRequests": 0, "confirmedTags": []}),
                        encoding="utf-8")
        dest = self.root / "projection"
        project(document(), dest, WORLD, self.root)
        published = json.loads((dest / "participation.json").read_text(encoding="utf-8"))
        self.assertEqual(0, published["disavowals"], "a new count is additive, not required")
        self.assertEqual(3, published["claims"])


class VocabularyParityTests(unittest.TestCase):
    def test_the_tool_validates_against_gallerys_closed_vocabulary_and_not_a_copy(self):
        # Two lists would drift, and the one that drifts is the one nobody reads.
        self.assertIn("basemate", gallery.KINSHIP_TAGS)
        self.assertIsNone(coordinate.clean_tag(tag(tags=("landlord",))))
        self.assertEqual(["visitor"], coordinate.clean_tag(tag(tags=("visitor",)))["tags"])


if __name__ == "__main__":
    unittest.main()
