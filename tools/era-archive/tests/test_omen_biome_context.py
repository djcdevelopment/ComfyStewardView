import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "omen_biome_context.py"
SPEC = importlib.util.spec_from_file_location("omen_biome_context", SCRIPT)
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


def stamp(path):
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": builder.sha256(path)}


def era_fixture(root):
    """One archived era with its world pair and three generated caches on disk."""
    source = root / "gallery"
    source.mkdir()
    world_db = source / "ComfyEra7.db"
    world_db.write_bytes(b"world database")
    world_file = source / "ComfyEra7.fwl"
    world_file.write_bytes(b"world file")
    era = {"slug": "era7", "worldId": "ComfyEra7", "snapshotId": 1001, "sourceKey": "a" * 64,
           "db": stamp(world_db), "fwl": stamp(world_file)}
    caches = root / "terrain" / "era7" / "caches"
    caches.mkdir(parents=True)
    outputs = {}
    for suffix in ("mapTexCache", "heightTexCache", "forestMaskTexCache"):
        path = caches / f"ComfyEra7_{suffix}"
        path.write_bytes(suffix.encode())
        outputs[suffix] = {**stamp(path), "width": 2048, "height": 2048}
    receipt = {"schema": "steward-current-client-terrain-cache/v1", "status": "verified",
               "era": "era7", "worldId": "ComfyEra7", "sourceKey": "a" * 64, "snapshotId": 1001,
               "source": {"db": era["db"], "fwl": era["fwl"]}, "outputs": outputs, "logs": {}}
    builder.write(root / "terrain" / "era7" / "receipt.json", receipt)
    return era, receipt


class OmenBiomeContextTests(unittest.TestCase):
    def test_cache_receipt_reads_absolute_source_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            era, _ = era_fixture(root)
            loaded = builder.cache_receipt(root / "terrain", era)
            self.assertEqual(era["db"]["path"], loaded["source"]["db"]["path"])
            self.assertEqual(Path(era["db"]["path"]),
                             builder.verify_source(loaded["source"]["db"], "era7 DB"))

    def test_cache_receipt_rejects_a_changed_world_database(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            era, _ = era_fixture(root)
            Path(era["db"]["path"]).write_bytes(b"world database edited")
            with self.assertRaisesRegex(ValueError, "Source verification failed for era7 DB"):
                builder.verify_source(
                    builder.cache_receipt(root / "terrain", era)["source"]["db"], "era7 DB")

    def test_cache_receipt_rejects_an_unverified_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            era, receipt = era_fixture(root)
            receipt["status"] = "failed"
            builder.write(root / "terrain" / "era7" / "receipt.json", receipt)
            with self.assertRaisesRegex(ValueError, "not a verified run"):
                builder.cache_receipt(root / "terrain", era)

    def test_artifact_manifest_requires_exactly_one_raster_revision(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            era, _ = era_fixture(root)
            manifest = {"schemaVersion": 1, "snapshotId": 1001,
                        "snapshot": {"fileHash": era["db"]["sha256"]}}
            first = root / "rasters" / "era7" / "32e4e988532d06bb" / "1001"
            first.mkdir(parents=True)
            (first / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            self.assertEqual(first / "manifest.json", builder.artifact_manifest(root, era))
            second = root / "rasters" / "era7" / "0000000000000000" / "1001"
            second.mkdir(parents=True)
            (second / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "one verified raster revision"):
                builder.artifact_manifest(root, era)

    def test_artifact_manifest_rejects_another_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            era, _ = era_fixture(root)
            revision = root / "rasters" / "era7" / "32e4e988532d06bb" / "1001"
            revision.mkdir(parents=True)
            (revision / "manifest.json").write_text(
                json.dumps({"snapshotId": 1001, "snapshot": {"fileHash": "b" * 64}}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                builder.artifact_manifest(root, era)

    def test_bind_sources_rejects_a_context_built_from_other_caches(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            era, receipt = era_fixture(root)
            sources = {"worldFile": {"sha256": era["fwl"]["sha256"]}}
            for suffix, name in builder.CACHE_SOURCES:
                sources[name] = {"sha256": receipt["outputs"][suffix]["sha256"]}
            builder.bind_sources({"sources": sources}, receipt, era, "era7")
            sources["heightCache"] = {"sha256": "c" * 64}
            with self.assertRaisesRegex(ValueError, "heightCache is not the generated cache"):
                builder.bind_sources({"sources": sources}, receipt, era, "era7")

    def test_runtime_versions_use_loaded_world_generator(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "Player.log"
            path.write_text("Running under Unity v6000.0.61.7643309\n"
                            "Valheim version: 0.221.12 (network version 36)\n"
                            "Worldgenerator version setup:2\n"
                            "Worldgenerator version setup:1\n", encoding="utf-8")
            self.assertEqual({"gameVersion": "0.221.12", "unityVersion": "6000.0.61.7643309",
                              "worldGeneratorVersion": 1}, builder.runtime_versions(path))


if __name__ == "__main__":
    unittest.main()
