"""portraits/build_manifest.py and build.py --library, on a synthetic corpus.

No E:\\, no baseline checkout: three concepts, three PNG takes each, a hand-written
catalog.json / concepts.json / vocab.json in a temp dir. The real corpus is 1,375 files;
everything the cut step does to one of them it does to a flat colour.

    python -m unittest tools.chronicles.tests.test_build_manifest
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "portraits"))
import build  # noqa: E402
import build_manifest  # noqa: E402
from test_build import FIXTURES, SOURCE_BASE, synth_portraits  # noqa: E402

VOCAB = {
    "role": {"carpenter": {"label": "Carpenter", "slate48": "joiner"}, "seer": {"label": "Runecaster"},
             "berserker": {"label": "Berserker"}},
    "presentation": {"woman": {"label": "Woman"}, "man": {"label": "Man"}},
    "theme": {"builders": {"label": "Builders"}, "warriors-mystics": {"label": "Warriors & mystics"}},
    "age": {"young": {"label": "Young"}, "adult": {"label": "Adult"}, "elder": {"label": "Elder"}},
    "hair": {"red": {"label": "Red"}, "grey": {"label": "Grey"}, "dark": {"label": "Dark"}},
    "mood": {"proud": {"label": "Proud"}, "calm": {"label": "Calm"}},
    "setting": {"workshop": {"label": "Workshop"}, "fortress": {"label": "Fortress"}},
    "palette": {"golden": {"label": "Golden"}, "ember": {"label": "Ember"}},
    "kit": {"civilian": {"label": "Civilian"}, "armoured": {"label": "Armoured"}},
    "facets": {"order": [
        {"tag": "role", "label": "Trade", "kind": "dropdown"},
        {"tag": "presentation", "label": "Presentation", "kind": "segmented"},
        {"tag": "age", "label": "Age", "kind": "segmented"},
        {"tag": "mood", "label": "Mood", "kind": "segmented"},
        {"tag": "hair", "label": "Hair", "kind": "dropdown"},
        {"tag": "setting", "label": "Setting", "kind": "dropdown"},
        {"tag": "palette", "label": "Palette", "kind": "dropdown"},
        {"tag": "kit", "label": "Kit", "kind": "segmented"},
        {"tag": "theme", "label": "Theme", "kind": "dropdown"},
    ]},
}

CONCEPTS = [
    ("viking_carpenter_f_artisan", "carpenter", "woman", "builders",
     {"age": "adult", "hair": "red", "mood": "proud", "setting": "workshop", "palette": "golden", "kit": "civilian",
      "companion": "none", "magic": False, "face_paint": False}, "manual"),
    ("viking_seer_m_runecaster", "seer", "man", "warriors-mystics",
     {"age": "elder", "hair": "grey", "mood": "calm", "setting": "fortress", "palette": "ember", "kit": "armoured",
      "companion": "raven", "magic": True, "face_paint": True}, "manual"),
    ("viking_berserker_m_wolfskin", "berserker", "man", "warriors-mystics",
     {"age": "adult", "hair": "dark", "mood": "proud", "setting": "fortress", "palette": "ember", "kit": "armoured",
      "companion": "none", "magic": False, "face_paint": False}, "auto"),
]


def synth_corpus(root: Path) -> tuple[Path, Path, Path, Path]:
    """corpus/, catalog.json, concepts.json, vocab.json. Take s3 of every concept is
    rejected in the catalog and by the concept; s1/s2 are picked."""
    corpus = root / "corpus"
    (corpus / "assets").mkdir(parents=True)
    receipts = []
    assets = []
    concepts = []
    for index, (cid, role, presentation, theme, attrs, source) in enumerate(CONCEPTS):
        picked, rejected = [], []
        for n in (1, 2, 3):
            aid = f"{cid}_s{n}"
            png = corpus / "assets" / f"{aid}.png"
            colour = (40 + 60 * index, 90 + 20 * n, 60)
            image = Image.new("RGB", (1024, 1024), colour)
            # A brighter square where the "face" is, so a crop can be told from the frame.
            image.paste((230, 200, 170), (400 + 20 * n, 150, 560 + 20 * n, 310))
            image.save(png)
            sha = hashlib.sha256(png.read_bytes()).hexdigest()
            receipts.append({"asset_id": aid, "concept_id": cid, "sha256": sha, "job_id": f"job_{index}_{n}"})
            reject = ["bg_dropped"] if n == 3 else []
            assets.append({
                "asset_id": aid, "concept_id": cid, "seed_idx": n, "file": png.name, "sha256": sha,
                "reject": reject, "advisory": ["face_small"] if n == 2 else [],
                "face": {"facing": "left" if n == 1 else "right", "bust_crop": [300 + 20 * n, 40, 480]},
            })
            (rejected if reject else picked).append(aid)
        concepts.append({
            "concept_id": cid, "role": role, "presentation": presentation, "theme": theme,
            "character_name": "Never Shown", "prompt": "a prompt with the word character in it",
            "takes": {"auto": picked, "picked": picked,
                      "rejected": [{"asset_id": a, "why": ["bg_dropped"]} for a in rejected], "source": source},
            "attributes": attrs,
        })
    (corpus / "receipts.ndjson").write_text("\n".join(json.dumps(r) for r in receipts) + "\n", encoding="utf-8")
    catalog = root / "catalog.json"
    catalog.write_text(json.dumps({"schema": "portrait-corpus-catalog/1", "assets": assets}), encoding="utf-8")
    concepts_path = root / "concepts.json"
    concepts_path.write_text(json.dumps({"schema": "portrait-corpus-concepts/1", "concepts": concepts}), encoding="utf-8")
    vocab = root / "vocab.json"
    vocab.write_text(json.dumps(VOCAB), encoding="utf-8")
    return corpus, catalog, concepts_path, vocab


def manual_only(concepts_path: Path) -> Path:
    doc = json.loads(concepts_path.read_text(encoding="utf-8"))
    doc["concepts"] = [c for c in doc["concepts"] if c["takes"]["source"] == "manual"]
    out = concepts_path.with_name("concepts-manual.json")
    out.write_text(json.dumps(doc), encoding="utf-8")
    return out


class BuildManifest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.corpus, self.catalog, self.concepts, self.vocab = synth_corpus(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def run_build(self, concepts: Path, out: str, dev: bool = False) -> dict:
        return build_manifest.build(concepts, self.catalog, self.corpus, self.vocab, self.root / out,
                                    "viking96", "Viking", dev)

    def test_refuses_auto_ranked_takes_unless_dev(self):
        with self.assertRaises(SystemExit) as caught:
            self.run_build(self.concepts, "lib")
        self.assertIn("auto-ranked", str(caught.exception))
        self.assertFalse((self.root / "lib").exists(), "nothing is written before the refusal")
        manifest = self.run_build(self.concepts, "lib-dev", dev=True)
        self.assertTrue(manifest["dev"])
        self.assertEqual(len(manifest["tiles"]), 3)

    def test_cuts_only_picked_takes_and_carries_provenance(self):
        manifest = self.run_build(manual_only(self.concepts), "lib")
        self.assertEqual(manifest["schema"], build_manifest.LIBRARY_SCHEMA)
        self.assertEqual(manifest["library"], "viking96")
        self.assertFalse(manifest["dev"])
        self.assertFalse(manifest["default"])
        self.assertEqual([t["id"] for t in manifest["tiles"]], ["carpenter_f_artisan", "seer_m_runecaster"])
        catalog = {a["asset_id"]: a for a in json.loads(self.catalog.read_text(encoding="utf-8"))["assets"]}
        out = self.root / "lib"
        for tile in manifest["tiles"]:
            self.assertEqual([t["id"] for t in tile["takes"]], ["s1", "s2"], "the rejected s3 was cut")
            for take in tile["takes"]:
                asset = catalog[f"viking_{tile['id']}_{take['id']}"]
                self.assertEqual(take["sha"], asset["sha256"])
                self.assertEqual(set(take["files"]), {"bust128", "bust256", "wide768"})
                for role, name in take["files"].items():
                    path = out / name
                    self.assertTrue(path.is_file(), f"{name} missing")
                    with Image.open(path) as image:
                        side = {"bust128": 128, "bust256": 256, "wide768": 768}[role]
                        self.assertEqual(image.size, (side, side))
                # The buster is the cut's own bytes, not the source's.
                self.assertEqual(take["v"], hashlib.sha256((out / take["files"]["bust128"]).read_bytes()).hexdigest()[:8])
        self.assertFalse(list(out.glob("*.s3.*")), "a rejected take left files behind")
        # Tags are vocabulary tokens; chips only where the attribute says so.
        carpenter, seer = manifest["tiles"]
        self.assertEqual(carpenter["tags"], {"role": "carpenter", "presentation": "woman", "theme": "builders",
                                             "age": "adult", "hair": "red", "mood": "proud", "setting": "workshop",
                                             "palette": "golden", "kit": "civilian"})
        self.assertEqual(carpenter["chips"], [])
        self.assertEqual(seer["chips"], ["companion:raven", "magic", "face-paint"])
        # Labels field by field, the facet order, the alias, the digests.
        self.assertEqual(manifest["labels"]["role"]["seer"], "Runecaster")
        self.assertEqual([f["tag"] for f in manifest["facets"]][:3], ["role", "presentation", "age"])
        self.assertEqual(manifest["aliases"], {"role": {"joiner": "carpenter"}})
        receipts = self.corpus / "receipts.ndjson"
        self.assertEqual(manifest["provenance"]["sourceReceipts"],
                         {"sha256": hashlib.sha256(receipts.read_bytes()).hexdigest(), "bytes": receipts.stat().st_size})
        self.assertEqual(manifest["provenance"]["sourceCatalog"], hashlib.sha256(self.catalog.read_bytes()).hexdigest())
        self.assertEqual(manifest["footprint"]["takes"], 4)
        # And nothing that must not reach a page reached the tree.
        text = (out / "manifest.json").read_text(encoding="utf-8").lower()
        for word in ("character", "archetype", "seed", "gender", "prompt", "never shown"):
            self.assertNotIn(word, text)

    def test_refuses_a_changed_source_and_a_banned_label(self):
        concepts = manual_only(self.concepts)
        png = self.corpus / "assets" / "viking_carpenter_f_artisan_s1.png"
        png.write_bytes(png.read_bytes() + b"\n")
        with self.assertRaises(SystemExit) as caught:
            self.run_build(concepts, "lib")
        self.assertIn("does not match the catalog sha256", str(caught.exception))
        png.write_bytes(png.read_bytes()[:-1])
        vocab = json.loads(self.vocab.read_text(encoding="utf-8"))
        vocab["role"]["seer"]["label"] = "Seed keeper"
        self.vocab.write_text(json.dumps(vocab), encoding="utf-8")
        with self.assertRaises(SystemExit) as caught:
            self.run_build(concepts, "lib2")
        self.assertIn("banned word", str(caught.exception))


class BuildShipsLibraries(unittest.TestCase):
    """build.py --library: the cuts land under img/portraits/<library>/ and the document is
    v2 while every v1 reader still finds today's rows first."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.corpus, cls.catalog, concepts, cls.vocab = synth_corpus(root)
        cls.library = root / "viking96"
        build_manifest.build(manual_only(concepts), cls.catalog, cls.corpus, cls.vocab, cls.library, "viking96", "Viking", False)
        cls.portraits = synth_portraits(root / "portraits", count=4)
        cls.out = root / "site"
        cls.manifest = build.build(SOURCE_BASE, cls.out, offline=FIXTURES, portraits_dir=cls.portraits,
                                   library_dirs=[cls.library])
        cls.doc = json.loads((cls.out / "portraits.json").read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_v1_readers_find_the_slate_rows_first(self):
        doc = self.doc
        self.assertEqual(doc["schema"], build.PORTRAITS_DOC_SCHEMA)
        self.assertEqual(doc["count"], 4)
        self.assertEqual(doc["index"], "parseInt(builderKey.slice(0,8),16) % count")
        slate = doc["tiles"][:doc["count"]]
        self.assertEqual([t["id"] for t in slate], ["p01", "p02", "p03", "p04"])
        for tile in slate:
            self.assertEqual(tile["library"], "slate48")
            self.assertEqual(tile["cuts"], {"bust128": tile["thumb"], "bust512": tile["file"]})
            self.assertEqual(tile["tags"], ["stand-in"])
            self.assertEqual(tile["tagMap"], {"role": "stand-in"})
        self.assertEqual(doc["libraries"], {"slate48": {"label": "Slate", "framing": "bust", "default": True},
                                            "viking96": {"label": "Viking", "framing": "waist-up", "default": False}})

    def test_library_rows_follow_with_their_cuts_on_disk(self):
        rows = self.doc["tiles"][self.doc["count"]:]
        self.assertEqual([r["id"] for r in rows], ["carpenter_f_artisan", "seer_m_runecaster"])
        for row in rows:
            self.assertEqual(row["library"], "viking96")
            self.assertIsInstance(row["tags"], dict)
            self.assertEqual(set(row["cuts"]), {"bust128", "bust256", "wide768"})
            for take in row["takes"]:
                self.assertNotIn("files", take, "a take spells no path of its own; the tile's pattern does")
                for role, pattern in row["cuts"].items():
                    name = pattern.replace("{take}", take["id"])
                    self.assertTrue(name.startswith("viking96/"))
                    path = self.out / "img" / "portraits" / name
                    self.assertTrue(path.is_file(), f"{name} is not in the output")
                    self.assertEqual(path.read_bytes(), (self.library / name[len("viking96/"):]).read_bytes(),
                                     "a cut was re-encoded instead of copied")
                bust = row["cuts"]["bust128"].replace("{take}", take["id"])
                self.assertEqual(take["v"], hashlib.sha256((self.out / "img" / "portraits" / bust).read_bytes()).hexdigest()[:8])
        self.assertEqual(self.doc["labels"]["role"]["carpenter"], "Carpenter")
        self.assertEqual(self.doc["aliases"], {"role": {"joiner": "carpenter"}})
        self.assertEqual([f["tag"] for f in self.doc["facets"]][0], "role")
        self.assertIn("viking96", self.doc["provenance"])
        # The build manifest keeps the library apart from the slate list every other test reads.
        assets = self.manifest["assets"]["portraits"]
        self.assertEqual(len(assets["tiles"]), 4)
        self.assertEqual(assets["libraries"][0]["library"], "viking96")

    def test_the_page_inlines_the_default_slice_only(self):
        index = (self.out / "index.html").read_text(encoding="utf-8")
        self.assertIn('id="portrait-manifest"', index)
        self.assertNotIn("carpenter_f_artisan", index)
        self.assertIn('"count":4', index)

    def test_a_dev_library_is_not_publishable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            corpus, catalog, concepts, vocab = synth_corpus(root)
            dev = root / "dev-lib"
            build_manifest.build(concepts, catalog, corpus, vocab, dev, "viking96", "Viking", True)
            os.environ.pop("CHRONICLES_ALLOW_DEV_LIBRARY", None)
            with self.assertRaises(SystemExit) as caught:
                build.build(SOURCE_BASE, root / "site", offline=FIXTURES, portraits_dir=self.portraits, library_dirs=[dev])
            self.assertIn("not publishable", str(caught.exception))
            os.environ["CHRONICLES_ALLOW_DEV_LIBRARY"] = "1"
            try:
                manifest = build.build(SOURCE_BASE, root / "site2", offline=FIXTURES, portraits_dir=self.portraits, library_dirs=[dev])
            finally:
                os.environ.pop("CHRONICLES_ALLOW_DEV_LIBRARY", None)
            self.assertEqual(len(manifest["assets"]["portraits"]["libraries"][0]["tiles"]), 3)


if __name__ == "__main__":
    unittest.main()
