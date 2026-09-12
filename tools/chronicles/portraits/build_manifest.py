r"""Cut a portrait corpus into a library tree that build.py ships beside slate48.

    python tools/chronicles/portraits/build_manifest.py ^
        --concepts C:\work\baseline\docs\design\valheim-portrait-picker-2026-09\concepts.json ^
        --catalog  E:\omen\DMos\artifacts\corpus-viking-profiles-20260910\catalog.json ^
        --corpus   E:\omen\DMos\artifacts\corpus-viking-profiles-20260910 ^
        --vocab    C:\work\baseline\tools\portrait-corpus\vocab.json ^
        --out      E:\omen\steward-multi-era\portraits\viking96-20260912 [--dev]

The corpus is input and stays where it is: 1,375 PNGs at 1024 square, of which only the
curated takes (`concepts.json` takes.picked) are cut, three ways each --

    <slug>.<take>.128.webp   bust, from the catalog's face crop     ribbon chips, tree nodes, pair card
    <slug>.<take>.256.webp   the same bust                          picker strip, hero on a phone
    <slug>.<take>.wide.webp  the whole frame at 768                 hero card, picker preview

-- plus `manifest.json` (chronicles-portrait-library/v1), the shape build.py's --library
reads. Every take carries the source PNG's sha256 from the receipts, and the build carries
the digests of receipts.ndjson, concepts.json and catalog.json, so a served cut traces to a
render job (FR-9).

Refusals, all before a single file is written: a concept whose takes are still
auto-ranked (`takes.source == "auto"`) unless --dev -- nothing a human has not looked at is
published (FR-7); a picked take that the concept or the catalog rejects; a take whose bytes
no longer match the catalog's sha256; and any UI-facing string in the manifest that says
character, archetype, seed or gender -- the words the archive never uses. The library tree
never carries the prompt or a character name: tags are vocabulary tokens and labels are
copied from vocab.json field by field.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

LIBRARY_SCHEMA = "chronicles-portrait-library/v1"
BANNED = re.compile(r"character|archetype|seed|gender", re.IGNORECASE)
# The tags every tile carries, in the order the picker shows its controls (vocab facets.order
# is the authority; this is the fallback when a vocab has no facets block).
FACET_TAGS = ("role", "presentation", "theme", "age", "hair", "mood", "setting", "palette", "kit")
CUTS = {"bust128": 128, "bust256": 256, "wide768": 768}
QUALITY = {"bust128": 82, "bust256": 80, "wide768": 80}
DEFAULT_CROP = (192, 0, 640)
SOURCE_SIDE = 1024


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stamp(data: bytes) -> str:
    """Eight hex digits of the cut's own bytes: a re-cut (new crop, new quality) re-busts
    under the immutable cache the same way a redrawn slate tile does."""
    return sha256_bytes(data)[:8]


def slug_of(concept_id: str, library_prefix: str = "viking_") -> str:
    return concept_id[len(library_prefix):] if concept_id.startswith(library_prefix) else concept_id


def take_id(asset_id: str, concept_id: str) -> str:
    """`viking_carpenter_f_artisan_s4` -> `s4`."""
    tail = asset_id[len(concept_id):]
    if not tail.startswith("_s") or not tail[2:].isdigit():
        raise SystemExit(f"{asset_id} is not a take of {concept_id}")
    return tail[1:]


def facet_order(vocab: dict) -> list[dict]:
    order = ((vocab.get("facets") or {}).get("order")) or []
    if order:
        return [{"tag": f["tag"], "label": f["label"], "kind": f.get("kind", "dropdown")} for f in order]
    return [{"tag": t, "label": t.capitalize(), "kind": "dropdown"} for t in FACET_TAGS]


def labels_from_vocab(vocab: dict, facets: list[dict]) -> dict[str, dict[str, str]]:
    """token -> UI label per facet, copied field by field. Never the vocab document itself:
    its notes name the words the UI must not say."""
    out: dict[str, dict[str, str]] = {}
    for facet in facets:
        tag = facet["tag"]
        axis = vocab.get(tag)
        labels: dict[str, str] = {}
        if isinstance(axis, dict):
            for token, entry in axis.items():
                if token in ("note", "default"):
                    continue
                if isinstance(entry, dict):
                    label = entry.get("label")
                elif isinstance(entry, str):
                    label = entry
                else:
                    label = None
                labels[token] = label or token.replace("-", " ").capitalize()
        elif isinstance(axis, list):
            # An axis given as a plain list is in display order (young, adult, elder):
            # the table keeps that order, and the picker's segmented rows read it back.
            for token in axis:
                if isinstance(token, str):
                    labels[token] = token.replace("-", " ").capitalize()
        out[tag] = labels
    return out


def aliases_from_vocab(vocab: dict) -> dict[str, dict[str, str]]:
    """slate48 tags that name the same trade under another word, e.g. joiner -> carpenter."""
    aliases: dict[str, str] = {}
    for token, entry in (vocab.get("role") or {}).items():
        if isinstance(entry, dict):
            other = entry.get("slate48")
            if other and other != token:
                aliases[other] = token
    return {"role": aliases} if aliases else {}


def chips_for(attrs: dict) -> list[str]:
    chips = []
    companion = attrs.get("companion")
    if companion and companion != "none":
        chips.append(f"companion:{companion}")
    if attrs.get("magic") is True:
        chips.append("magic")
    if attrs.get("face_paint") is True:
        chips.append("face-paint")
    return chips


def tags_for(concept: dict) -> dict[str, str]:
    attrs = concept.get("attributes") or {}
    tags = {"role": concept["role"], "presentation": concept["presentation"], "theme": concept["theme"]}
    for tag in FACET_TAGS[3:]:
        value = attrs.get(tag)
        if value:
            tags[tag] = value
    return tags


def crop_box(face: dict | None) -> tuple[int, int, int, int]:
    crop = (face or {}).get("bust_crop") or DEFAULT_CROP
    x, y, side = int(crop[0]), int(crop[1]), int(crop[2])
    x = max(0, min(x, SOURCE_SIDE - side))
    y = max(0, min(y, SOURCE_SIDE - side))
    return (x, y, x + side, y + side)


def to_webp(image: Image.Image, side: int, quality: int) -> bytes:
    work = image if image.size == (side, side) else image.resize((side, side), Image.LANCZOS)
    buffer = io.BytesIO()
    work.save(buffer, "WEBP", quality=quality, method=6)
    return buffer.getvalue()


def cut_take(png: Path, face: dict | None) -> dict[str, bytes]:
    with Image.open(png) as image:
        image.load()
        source = image.convert("RGB")
    if source.size != (SOURCE_SIDE, SOURCE_SIDE):
        raise SystemExit(f"{png} is {source.size}, not {SOURCE_SIDE} square")
    bust = source.crop(crop_box(face))
    return {
        "bust128": to_webp(bust, 128, QUALITY["bust128"]),
        "bust256": to_webp(bust, 256, QUALITY["bust256"]),
        "wide768": to_webp(source, 768, QUALITY["wide768"]),
    }


def lint_strings(doc: object, path: str = "manifest") -> list[str]:
    """Every string that could reach a page: keys and values alike."""
    hits: list[str] = []
    if isinstance(doc, dict):
        for key, value in doc.items():
            if BANNED.search(str(key)):
                hits.append(f"{path}.{key}")
            hits.extend(lint_strings(value, f"{path}.{key}"))
    elif isinstance(doc, list):
        for index, value in enumerate(doc):
            hits.extend(lint_strings(value, f"{path}[{index}]"))
    elif isinstance(doc, str) and BANNED.search(doc):
        hits.append(f"{path} = {doc!r}")
    return hits


def plan(concepts_doc: dict, catalog: dict, corpus: Path, dev: bool, library: str) -> list[dict]:
    """Decide every cut before making one. Returns one entry per picked take with the source
    path, the face crop and the sha the catalog expects."""
    by_asset = {row["asset_id"]: row for row in catalog.get("assets", [])}
    problems: list[str] = []
    work: list[dict] = []
    for concept in concepts_doc.get("concepts", []):
        cid = concept["concept_id"]
        takes = concept.get("takes") or {}
        picked = list(takes.get("picked") or [])
        if not picked:
            continue
        if takes.get("source") != "manual" and not dev:
            problems.append(f"{cid}: takes are still auto-ranked; review the contact sheet or pass --dev")
            continue
        rejected = {r["asset_id"] for r in takes.get("rejected") or []}
        for asset_id in picked:
            row = by_asset.get(asset_id)
            if row is None:
                problems.append(f"{cid}: {asset_id} is not in the catalog")
                continue
            if asset_id in rejected or row.get("reject"):
                problems.append(f"{cid}: {asset_id} is rejected and cannot be cut")
                continue
            png = corpus / "assets" / row["file"]
            if not png.is_file():
                problems.append(f"{cid}: {png} is missing")
                continue
            work.append({
                "concept": concept,
                "slug": slug_of(cid),
                "take": take_id(asset_id, cid),
                "asset_id": asset_id,
                "png": png,
                "sha": row["sha256"],
                "face": row.get("face"),
                "advisory": list(row.get("advisory") or []),
            })
    if problems:
        raise SystemExit("refusing to build the library:\n  " + "\n  ".join(problems))
    return work


def build(concepts_path: Path, catalog_path: Path, corpus: Path, vocab_path: Path, out: Path,
          library: str, label: str, dev: bool, verify_sha: bool = True) -> dict:
    if out.exists():
        raise SystemExit(f"{out} exists; the library tree is built fresh every time")
    concepts_doc = json.loads(concepts_path.read_text(encoding="utf-8"))
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    vocab = json.loads(vocab_path.read_text(encoding="utf-8"))
    work = plan(concepts_doc, catalog, corpus, dev, library)
    if not work:
        raise SystemExit("nothing to cut: no concept has a picked take")

    facets = facet_order(vocab)
    labels = labels_from_vocab(vocab, facets)
    started = time.monotonic()
    out.mkdir(parents=True)
    tiles: dict[str, dict] = {}
    total_bytes = 0
    for index, item in enumerate(work, 1):
        if verify_sha and sha256_file(item["png"]) != item["sha"]:
            raise SystemExit(f"{item['png']} does not match the catalog sha256 {item['sha'][:12]}; the corpus has changed")
        cuts = cut_take(item["png"], item["face"])
        files: dict[str, str] = {}
        for role, data in cuts.items():
            suffix = {"bust128": "128", "bust256": "256", "wide768": "wide"}[role]
            name = f"{item['slug']}.{item['take']}.{suffix}.webp"
            (out / name).write_bytes(data)
            files[role] = name
            total_bytes += len(data)
        concept = item["concept"]
        tile = tiles.setdefault(item["slug"], {
            "id": item["slug"],
            "tags": tags_for(concept),
            "chips": chips_for(concept.get("attributes") or {}),
            "takes": [],
        })
        tile["takes"].append({
            "id": item["take"],
            "sha": item["sha"],
            "facing": (item["face"] or {}).get("facing"),
            "advisory": item["advisory"],
            "v": stamp(cuts["bust128"]),
            "files": files,
        })
        if index % 25 == 0 or index == len(work):
            print(f"  cut {index}/{len(work)} takes", file=sys.stderr)

    receipts = corpus / "receipts.ndjson"
    manifest = {
        "schema": LIBRARY_SCHEMA,
        "library": library,
        "label": label,
        "framing": "waist-up",
        "default": False,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "dev": bool(dev),
        "facets": facets,
        "labels": labels,
        "aliases": aliases_from_vocab(vocab),
        "tiles": list(tiles.values()),
        "provenance": {
            "corpus": corpus.name,
            "sourceReceipts": {"sha256": sha256_file(receipts), "bytes": receipts.stat().st_size} if receipts.is_file() else None,
            "sourceConcepts": sha256_file(concepts_path),
            "sourceCatalog": sha256_file(catalog_path),
        },
        "footprint": {"takes": len(work), "files": len(work) * 3, "bytes": total_bytes},
    }
    # The manifest's own vocabulary, checked before it is written. `dev` and `provenance`
    # never reach a page but are linted too: cheaper than remembering which keys do.
    hits = lint_strings({k: v for k, v in manifest.items() if k != "provenance"})
    if hits:
        raise SystemExit("the manifest says a banned word:\n  " + "\n  ".join(hits[:20]))
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    elapsed = time.monotonic() - started
    print(f"built {out}: {len(tiles)} portraits, {len(work)} takes, {len(work) * 3} files, "
          f"{total_bytes / 1_048_576:.1f} MiB in {elapsed:.0f}s" + ("  [dev: auto-ranked takes included]" if dev else ""))
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--concepts", type=Path, required=True, help="concepts.json from build_catalog.py")
    parser.add_argument("--catalog", type=Path, required=True, help="catalog.json beside the corpus")
    parser.add_argument("--corpus", type=Path, required=True, help="corpus root with assets/ and receipts.ndjson")
    parser.add_argument("--vocab", type=Path, required=True, help="vocab.json (facet order and labels)")
    parser.add_argument("--out", type=Path, required=True, help="library tree to create; must not exist")
    parser.add_argument("--library", default="viking96", help="library id (default viking96)")
    parser.add_argument("--label", default="Viking", help="library label shown in the picker")
    parser.add_argument("--dev", action="store_true",
                        help="include concepts whose takes are still auto-ranked (never for a publish)")
    parser.add_argument("--no-verify", action="store_true", help="skip re-hashing every source PNG")
    args = parser.parse_args(argv)
    build(args.concepts, args.catalog, args.corpus, args.vocab, args.out, args.library, args.label, args.dev,
          verify_sha=not args.no_verify)
    return 0


if __name__ == "__main__":
    sys.exit(main())
