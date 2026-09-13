import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "am4_terrain_cache.py"
SPEC = importlib.util.spec_from_file_location("am4_terrain_cache", SCRIPT)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


import sys
sys.path.insert(0, str(Path(__file__).parents[1]))
from load_census import load_census


class Am4TerrainCacheTests(unittest.TestCase):
    def test_the_client_written_world_is_kept_as_a_derived_artefact(self):
        """The 0.221.12 client rewrites the save in its own format on quit and backs the
        original up beside it. That rewrite is the only game-side witness the decoders can be
        checked against, so it is kept -- and an unchanged file is reported, not copied."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); worlds = root / "worlds_local"; worlds.mkdir()
            original = struct.pack("<idqii", 26, 10.0, 1, 2, 4_624_771) + b"orig"
            source_db = root / "source" / "Booty.db"; source_db.parent.mkdir(); source_db.write_bytes(original)
            source = {"db": {"path": str(source_db), **runner.stamp(source_db)}, "fwl": {"bytes": 1, "sha256": "x"}}
            (worlds / "Booty.db").write_bytes(original)
            self.assertEqual({"resaved": False, "reason": "world file unchanged"},
                             runner.converted_world(worlds, "Booty", source, root / "out"))
            self.assertFalse((root / "out").exists())
            (worlds / "Booty.db").write_bytes(struct.pack("<idqii", 37, 10.0, 1, 2, 4_624_760) + b"new")
            (worlds / "Booty.fwl").write_bytes(b"fwl")
            (worlds / "Booty_backup_20260913-000000.db").write_bytes(original)
            receipt = runner.converted_world(worlds, "Booty", source, root / "out")
            self.assertTrue(receipt["resaved"])
            self.assertEqual((26, 4_624_771, 37, 4_624_760),
                             (receipt["worldVersionIn"], receipt["declaredZdosIn"], receipt["worldVersionOut"], receipt["declaredZdosOut"]))
            self.assertEqual(["Booty_backup_20260913-000000.db"], receipt["backups"])
            self.assertEqual(sorted(("db", "fwl")), sorted(receipt["files"]))
            runner.verify(root / "out" / "Booty.db", receipt["files"]["db"], "kept db")
            self.assertEqual({"worldVersion": 26, "declaredZdos": 4_624_771}, runner.world_header(source_db))

    def test_a_chunked_valheim_1_resave_is_described_not_copied(self):
        """On 2026-09-13 AM4 turned out to be on Valheim 1.0.x: the quit writes a chunk directory,
        not a monolithic .db. That is recorded by digest and count and left where it is."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); worlds = root / "worlds_local"; (worlds / "ComfyEra13").mkdir(parents=True)
            (worlds / "ComfyEra13" / "_main.1.db2").write_bytes(b"db2"); (worlds / "ComfyEra13" / "_main.1.fwl2").write_bytes(b"fwl2")
            for i in range(3): (worlds / "ComfyEra13" / f"00_0{i}__0_1.chunk").write_bytes(b"c")
            (worlds / "ComfyEra13_backup_20260913-050711.db").write_bytes(b"orig")
            source = {"db": {"path": str(root / "nowhere.db"), "bytes": 4, "sha256": "x"}, "fwl": {"bytes": 1, "sha256": "y"}}
            receipt = runner.converted_world(worlds, "ComfyEra13", source, root / "out")
            self.assertEqual(("chunked-db2", 3, True), (receipt["format"], receipt["chunks"], receipt["resaved"]))
            self.assertEqual(sorted(("_main.1.db2", "_main.1.fwl2")), sorted(receipt["files"]))
            self.assertEqual(["ComfyEra13_backup_20260913-050711.db"], receipt["backups"])
            self.assertFalse((root / "out").exists())

    def test_game_build_reads_steam_manifest_and_assembly(self):
        with tempfile.TemporaryDirectory() as temp:
            game = Path(temp) / "steamapps" / "common" / "Valheim"; (game / "valheim_Data/Managed").mkdir(parents=True)
            (game / "valheim_Data/Managed/assembly_valheim.dll").write_bytes(b"dll")
            (Path(temp) / "steamapps" / "appmanifest_892970.acf").write_text('"AppState"\n{\n\t"buildid"\t\t"20034017"\n}\n')
            build = runner.game_build(game)
            self.assertEqual("20034017", build["steamBuildId"])
            self.assertEqual(runner.sha256(game / "valheim_Data/Managed/assembly_valheim.dll"), build["assemblySha256"])
            self.assertEqual({}, runner.game_build(Path(temp) / "nowhere" / "deep" / "Valheim"))

    def test_load_census_reads_both_client_generations(self):
        legacy = """09/09/2026 00:18:46: Valheim version: 0.221.12 (network version 36)
09/09/2026 00:18:53: Load world: ComfyEra7 (ComfyEra7)
09/09/2026 00:18:53: Loading 7049984 zdos, my sessionID: 1854250265, data version: 29
09/09/2026 00:19:45: Found 46024 ZDOs with unknown prefabs. Will load anyway.
Converted 3717 Creation Times.
ConvertPortals => Make sure all 11927 portals are in a good state.
ConvertPortals => fixed 3509 portals.
ConvertSpawners => Will try and convert 110950 spawners.
ConvertSpawners => Converted 12752 spawners, and 98198 'done' spawners.
ConvertSyncTransforms => Will try and convert 2190 SyncTransforms.
ConvertSeed => Converted 6711 ZDOs.
09/09/2026 00:19:53: Converting Dungeons
09/09/2026 00:20:53: Saved 7049975 ZDOs
"""
        census = load_census(legacy)
        self.assertEqual(("0.221.12", 36, "ComfyEra7", 7049984, 29, 46024, 7049975, -9),
                         (census["gameVersion"], census["networkVersion"], census["worldLoaded"], census["declaredZdos"],
                          census["dataVersion"], census["unknownPrefabZdos"], census["savedZdos"], census["savedDelta"]))
        self.assertEqual({"creationTimes": 3717, "portalsChecked": 11927, "portalsFixed": 3509, "spawnersTried": 110950,
                          "spawnersConverted": 12752, "spawnersDone": 98198, "syncTransforms": 2190, "itemSeeds": 6711,
                          "dungeons": True}, census["conversions"])
        modern = """09/12/2026 13:45:13: Valheim version: 1.0.12 (network version 40)
09/12/2026 13:45:19: Load world: ComfyEra16 (ComfyEra16)
09/12/2026 13:45:19: ZDOMan.Load - Starting to load 9,155,593 zdos. SessionID: 380965192, WorldVersion: 37 [Celebration]
09/12/2026 13:46:08: Found 49482 ZDOs with unknown prefabs. Will load anyway.
ConvertInventories => Converted 428048 ZDOs.
ConvertContainers => Converted 69344 ZDOs.
ConvertPrefabStrings => Converted 84232 strings to hashes.
Missing location:675942648
"""
        census = load_census(modern)
        self.assertEqual((9155593, 37, [675942648]), (census["declaredZdos"], census["dataVersion"], census["missingLocations"]))
        self.assertEqual({"inventories": 428048, "containers": 69344, "prefabStrings": 84232}, census["conversions"])
        self.assertNotIn("savedDelta", census)

    def test_capture_handoff_requires_terminal_idle_capture(self):
        self.assertEqual((True, "capture-complete"), runner.capture_handoff(
            {"state": "complete"}, False, False))
        self.assertEqual((True, "capture-natural-limit"), runner.capture_handoff(
            {"state": "stopped", "reason": "output-limit"}, False, False))
        self.assertEqual((False, "capture-or-game-active"), runner.capture_handoff(
            {"state": "complete"}, True, False))
        self.assertEqual((False, "operator-stop"), runner.capture_handoff(
            {"state": "stopped", "reason": "operator-stop"}, False, False))

    def test_png_size_reads_ihdr(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "cache"
            path.write_bytes(b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" +
                             struct.pack(">II", 2048, 2048))
            self.assertEqual((2048, 2048), runner.png_size(path))


if __name__ == "__main__":
    unittest.main()
