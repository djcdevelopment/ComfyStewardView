import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import prune_run_worlds as prune


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def campaign(base, name, world, status="complete", journal="complete", game_pid=None):
    """A finished campaign with one attempt that kept its world copies and one that did not."""
    root = base / name
    write(root / "campaign.json", {"schema": "steward-local-campaign/v1", "world": world,
                                   "sourceKey": "src", "builds": []})
    write(root / "state.json", {"sourceKey": "src", "completed": {}, "attempts": {}, "status": journal,
                                "activeAttempt": "runs/batch-0000-attempt-01"})
    write(root / "status.json", {"state": status, "gamePid": game_pid})
    (root / "source").mkdir(parents=True)
    (root / "source" / (world + ".db")).write_bytes(b"w" * 1000)
    (root / "source" / (world + ".fwl")).write_bytes(b"f" * 10)
    attempt = root / "runs" / "batch-0000-attempt-01"
    valheim = attempt / "xdg" / "unity3d" / "IronGate" / "Valheim"
    worlds = valheim / "worlds_local"
    worlds.mkdir(parents=True)
    (worlds / (world + ".db")).write_bytes(b"w" * 1000)            # byte-identical to source
    (worlds / (world + ".db.old")).write_bytes(b"o" * 500)
    (worlds / (world + "_backup_auto-20260909120446.db")).write_bytes(b"b" * 300)
    (worlds / (world + ".fwl")).write_bytes(b"f" * 10)
    (worlds / (world + "_mapTexCache")).write_bytes(b"m" * 10)
    (valheim / "characters_local").mkdir()
    (valheim / "characters_local" / "questyfour.fch").write_bytes(b"c" * 5)
    (valheim / "Player.log").write_text("log", encoding="utf-8")
    for name_ in ("result.json", "dispatch.json"):
        write(attempt / name_, {"ok": True})
    (attempt / "stdout.log").write_text("out", encoding="utf-8")
    second = root / "runs" / "batch-0001-attempt-01"
    write(second / "result.json", {"ok": True})
    return root


def tree(temp):
    base = Path(temp)
    campaign(base, "era9-x", "ComfyEra9")
    campaign(base, "era11-detail-x", "ComfyEra11")
    smoke = base / "smoke-x" / "saves" / "worlds_local"
    smoke.mkdir(parents=True)
    (smoke / "ComfyEra14.db").write_bytes(b"s" * 100)
    (smoke / "ComfyEra14.fwl").write_bytes(b"f" * 10)
    return base


def run(base, *extra, processes=()):
    argv = ["--local", "--base", str(base), "--reason", "test", *extra]
    out = io.StringIO()
    with patch.object(prune, "acquire_lock", lambda _root: None), \
            patch.object(prune, "live_processes", lambda _root: list(processes)), \
            contextlib.redirect_stdout(out):
        prune.main(argv)
    line = [l for l in out.getvalue().splitlines() if l.startswith(prune.RESULT_MARKER)][-1]
    return json.loads(line[len(prune.RESULT_MARKER):])


def survivors(root):
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())


class SelectionTests(unittest.TestCase):
    def test_only_world_save_copies_under_attempt_xdg_trees_are_selected(self):
        with tempfile.TemporaryDirectory() as temp:
            base = tree(temp)
            chosen = prune.select_world_files(base / "era9-x")
            names = sorted(p.name for p in chosen)
            self.assertEqual(["ComfyEra9.db", "ComfyEra9.db.old",
                              "ComfyEra9_backup_auto-20260909120446.db"], names)
            for path in chosen:
                self.assertIn("runs/batch-0000-attempt-01/xdg/", path.as_posix())

    def test_a_world_of_another_name_is_not_a_copy_of_this_campaign(self):
        with tempfile.TemporaryDirectory() as temp:
            base = tree(temp)
            worlds = base / "era9-x/runs/batch-0000-attempt-01/xdg/unity3d/IronGate/Valheim/worlds_local"
            (worlds / "Stray.db").write_bytes(b"x")
            self.assertNotIn("Stray.db", [p.name for p in prune.select_world_files(base / "era9-x")])

    def test_extra_roots_reach_a_smoke_run_but_never_the_originals(self):
        with tempfile.TemporaryDirectory() as temp:
            base = tree(temp)
            self.assertEqual(["ComfyEra14.db"],
                             [p.name for p in prune.select_world_files(base / "smoke-x", ["saves"])])
            with self.assertRaises(SystemExit):
                prune.split_extra_root("smoke-x/source", ["smoke-x"])
            with self.assertRaises(SystemExit):
                prune.split_extra_root("smoke-x/../era9-x", ["smoke-x"])
            with self.assertRaises(SystemExit):
                prune.split_extra_root("era11-detail-x/saves", ["smoke-x"])


class RunTests(unittest.TestCase):
    def test_dry_run_touches_nothing_and_writes_no_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            base = tree(temp)
            before = survivors(base)
            result = run(base, "--campaign", "era9-x", "--dry-run")
            self.assertEqual(before, survivors(base))
            self.assertTrue(result["dryRun"])
            self.assertEqual(3, result["campaigns"]["era9-x"]["inventory"]["fileCount"])
            self.assertEqual(0, result["campaigns"]["era9-x"]["receipt"]["filesUnlinked"])
            self.assertIsNone(result["campaigns"]["era9-x"]["inventoryPath"])

    def test_a_real_run_unlinks_exactly_the_copies_and_writes_both_receipts(self):
        with tempfile.TemporaryDirectory() as temp:
            base = tree(temp)
            root = base / "era9-x"
            result = run(base, "--campaign", "era9-x")
            doc = result["campaigns"]["era9-x"]
            inventory = json.loads(Path(doc["inventoryPath"]).read_text(encoding="utf-8"))
            receipt = json.loads(Path(doc["receiptPath"]).read_text(encoding="utf-8"))
            self.assertEqual(prune.INVENTORY_SCHEMA, inventory["schema"])
            self.assertEqual(prune.RECEIPT_SCHEMA, receipt["schema"])
            rows = {r["path"].split("/")[-1]: r for r in inventory["files"]}
            self.assertTrue(rows["ComfyEra9.db"]["identicalToSource"])
            self.assertFalse(rows["ComfyEra9.db.old"]["identicalToSource"])
            self.assertEqual("batch-0000-attempt-01", rows["ComfyEra9.db"]["attempt"])
            self.assertEqual(3, receipt["filesUnlinked"])
            self.assertEqual(1800, receipt["bytesFreed"])
            self.assertEqual(receipt["attemptDirsBefore"], receipt["attemptDirsAfter"])
            self.assertEqual(2, receipt["attemptDirsAfter"])
            left = survivors(root)
            for kept in ("runs/batch-0000-attempt-01/dispatch.json", "runs/batch-0000-attempt-01/result.json",
                         "runs/batch-0000-attempt-01/stdout.log",
                         "runs/batch-0000-attempt-01/xdg/unity3d/IronGate/Valheim/Player.log",
                         "runs/batch-0000-attempt-01/xdg/unity3d/IronGate/Valheim/worlds_local/ComfyEra9.fwl",
                         "runs/batch-0000-attempt-01/xdg/unity3d/IronGate/Valheim/worlds_local/ComfyEra9_mapTexCache",
                         "runs/batch-0000-attempt-01/xdg/unity3d/IronGate/Valheim/characters_local/questyfour.fch",
                         "runs/batch-0001-attempt-01/result.json", "source/ComfyEra9.db", "source/ComfyEra9.fwl"):
                self.assertIn(kept, left)
            self.assertFalse(any(p.endswith((".db", ".db.old")) and "worlds_local" in p for p in left))
            self.assertTrue((root / "runs/batch-0000-attempt-01/xdg/unity3d/IronGate/Valheim/worlds_local").is_dir())

    def test_denied_and_malformed_campaign_names_are_refused_before_anything_is_read(self):
        with tempfile.TemporaryDirectory() as temp:
            base = tree(temp)
            before = survivors(base)
            for name in ("era11-detail-x", "era9-x/../era11-detail-x", "a/b", ".."):
                with self.assertRaises(SystemExit):
                    run(base, "--campaign", name)
            # An allowed campaign in the same invocation does not rescue a denied one.
            with self.assertRaises(SystemExit):
                run(base, "--campaign", "era9-x", "--campaign", "era11-detail-x")
            self.assertEqual(before, survivors(base))

    def test_a_campaign_that_is_not_idle_is_refused(self):
        for kwargs, extra_processes in (({"status": "capturing"}, ()), ({"game_pid": 4242}, ()),
                                        ({"journal": "capturing"}, ()), ({}, ("123 python3 capture_worker.py",))):
            with tempfile.TemporaryDirectory() as temp:
                base = Path(temp)
                campaign(base, "era9-x", "ComfyEra9", **kwargs)
                before = survivors(base)
                with self.assertRaises(SystemExit):
                    run(base, "--campaign", "era9-x", processes=extra_processes)
                self.assertEqual(before, survivors(base))

    def test_a_smoke_run_without_a_journal_prunes_through_its_extra_root(self):
        with tempfile.TemporaryDirectory() as temp:
            base = tree(temp)
            result = run(base, "--campaign", "smoke-x", "--extra-root", "smoke-x/saves")
            self.assertEqual(1, result["campaigns"]["smoke-x"]["receipt"]["filesUnlinked"])
            self.assertFalse((base / "smoke-x/saves/worlds_local/ComfyEra14.db").exists())
            self.assertTrue((base / "smoke-x/saves/worlds_local/ComfyEra14.fwl").exists())
            with self.assertRaises(SystemExit):
                run(base, "--campaign", "smoke-x", "--extra-root", "era9-x/saves")

    def test_a_file_that_changed_after_the_inventory_is_skipped_and_listed(self):
        with tempfile.TemporaryDirectory() as temp:
            base = tree(temp)
            target = base / "era9-x/runs/batch-0000-attempt-01/xdg/unity3d/IronGate/Valheim/worlds_local/ComfyEra9.db.old"
            real_save = prune.save

            def save_then_touch(path, document):
                real_save(path, document)
                if document.get("schema") == prune.INVENTORY_SCHEMA:
                    with target.open("ab") as stream:
                        stream.write(b"grew")
            with patch.object(prune, "save", save_then_touch):
                result = run(base, "--campaign", "era9-x")
            receipt = result["campaigns"]["era9-x"]["receipt"]
            self.assertEqual(2, receipt["filesUnlinked"])
            self.assertEqual([{"path": "runs/batch-0000-attempt-01/xdg/unity3d/IronGate/Valheim/worlds_local/ComfyEra9.db.old",
                               "why": "changed since inventory"}], receipt["skipped"])
            self.assertTrue(target.exists())


if __name__ == "__main__":
    unittest.main()
