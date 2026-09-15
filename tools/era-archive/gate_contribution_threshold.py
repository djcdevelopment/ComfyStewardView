"""Audit a deliberate 20-piece creator-profile transition against the live release.

The old projection must match the current live receipt. Every creator identity must
remain; the new profile albums must be exactly the old public albums whose own
saved-piece credit clears the new threshold (or a historical import with unmeasured
leading-contributor evidence). Photographs remain counted archive-wide.

    python tools/era-archive/gate_contribution_threshold.py \
      --previous <byte-identical-live-projection> --projection <candidate> \
      --portrait-library <manifest.json>
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import sys
import urllib.request

from gallery import classify_volume_tier, is_qualifying_album
import portrait_assign

LIVE = "https://fx99.tail8e749c.ts.net/valheim/creators/receipt.json"
DERIVED = {"eras", "albums", "photos", "pieces", "tier", "portrait"}
PRESENTATION = {"creators.js", "creators.css", "pair.js", "kinship.js"}


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def file_shas(receipt: dict) -> dict[str, str]:
    return {f["path"]: f["sha256"] for f in receipt["files"]}


def album_credit(album: dict, builder_key: str) -> dict:
    credits = [c for c in album.get("contributors", []) if c.get("builderKey") == builder_key]
    if len(credits) != 1:
        raise ValueError(f"{builder_key} must have exactly one saved-piece credit on {album['buildKey']}")
    return credits[0]


def thread_expected(old: dict) -> dict:
    key = old["builderKey"]
    eras = []
    for group in old["eras"]:
        albums = [a for a in group["albums"] if is_qualifying_album(a, album_credit(a, key))]
        if albums:
            eras.append({"era": group["era"], "albums": albums})
    expected = {k: v for k, v in old.items() if k not in DERIVED}
    expected["eras"] = eras
    expected["albums"] = sum(len(g["albums"]) for g in eras)
    expected["photos"] = sum(len(a["photos"]) for g in eras for a in g["albums"])
    expected["pieces"] = sum(
        album_credit(a, key).get("pieces") or 0
        for g in eras for a in g["albums"]
    )
    expected["tier"] = classify_volume_tier(expected["pieces"])
    return expected


def public_header(thread: dict) -> dict:
    return {**{k: v for k, v in thread.items() if k != "eras"},
            "eras": [g["era"] for g in thread["eras"]]}


def photo_and_album_counts(old_threads: dict[str, dict], new_threads: dict[str, dict]) -> dict:
    photo_albums: dict[str, dict] = {}
    published: dict[str, dict] = {}
    for thread in old_threads.values():
        for group in thread["eras"]:
            for album in group["albums"]:
                if album["photos"]:
                    key = album["buildKey"]
                    if key in photo_albums and photo_albums[key] != album:
                        raise ValueError(f"Public photograph album {key} has divergent copies")
                    photo_albums[key] = album
    for thread in new_threads.values():
        for group in thread["eras"]:
            for album in group["albums"]:
                key = album["buildKey"]
                if key in published and published[key] != album:
                    raise ValueError(f"Public profile album {key} has divergent copies")
                published[key] = album
    global_albums = {**photo_albums, **published}
    by_era = defaultdict(lambda: {"albums": 0, "albumsWithPhotos": 0, "photos": 0})
    for album in global_albums.values():
        e = by_era[album["era"]]
        e["albums"] += 1
        e["albumsWithPhotos"] += bool(album["photos"])
        e["photos"] += len(album["photos"])
    return {
        "eras": [{"era": era, **by_era[era]} for era in sorted(by_era)],
        "photos": sum(e["photos"] for e in by_era.values()),
        "albumsWithPhotos": sum(e["albumsWithPhotos"] for e in by_era.values()),
        "buildersWithPhotos": len({c["builderKey"] for a in photo_albums.values()
                                   for c in a.get("contributors", []) if c.get("builderKey") in new_threads}),
    }


def audit(previous: Path, projection: Path, portrait_library: dict) -> dict:
    old_receipt, new_receipt = load(previous / "receipt.json"), load(projection / "receipt.json")
    old_shas, new_shas = file_shas(old_receipt), file_shas(new_receipt)
    if old_shas.keys() != new_shas.keys():
        raise ValueError("Projection file set changed; missing or new creator pages/assets")
    changed = {p for p in old_shas if old_shas[p] != new_shas[p]}
    unexpected = [p for p in changed if not (
        p.startswith("threads/") and p.endswith(".json")
        or p == "directory.json" or p.endswith(".html") or p in PRESENTATION
    )]
    # A clean checkout on Windows copies CRLF presentation assets while the live
    # projection may have copied LF. Admit only byte-for-byte identical text after
    # normalising line endings; a real change to an unrelated script still fails.
    line_ending_only = {p for p in unexpected if
        (previous / p).read_bytes().replace(b"\r\n", b"\n") ==
        (projection / p).read_bytes().replace(b"\r\n", b"\n")}
    unexpected = [p for p in unexpected if p not in line_ending_only]
    if unexpected:
        raise ValueError(f"Unrelated public files changed: {unexpected[:8]}")
    for path, expected_sha in new_shas.items():
        actual_sha = hashlib.sha256((projection / path).read_bytes()).hexdigest()
        if actual_sha != expected_sha:
            raise ValueError(f"Candidate changed after its receipt: {path}")

    old_paths = {p for p in old_shas if p.startswith("threads/") and p.endswith(".json")}
    new_paths = {p for p in new_shas if p.startswith("threads/") and p.endswith(".json")}
    if old_paths != new_paths:
        raise ValueError("Creator identity pages disappeared or were added")
    old_threads, new_threads = {}, {}
    excluded_records = 0
    empty_profiles = 0
    for path in sorted(old_paths):
        key = Path(path).stem
        old, new = load(previous / path), load(projection / path)
        if old["builderKey"] != key or new["builderKey"] != key:
            raise ValueError(f"Thread filename/identity mismatch: {path}")
        expected = thread_expected(old)
        old_portrait, new_portrait = old.get("portrait"), new.get("portrait")
        if old_portrait and old_portrait.get("by") == "builder":
            if new_portrait != old_portrait:
                raise ValueError(f"Confirmed builder portrait changed: {key}")
        else:
            pick = portrait_assign.assign_portrait({**expected, "eras": [g["era"] for g in expected["eras"]]}, portrait_library)
            if new_portrait != ({**pick, "by": "archive"} if pick else None):
                raise ValueError(f"Archive portrait is not the deterministic pick: {key}")
        if {k: v for k, v in new.items() if k != "portrait"} != expected:
            raise ValueError(f"Thread has an unrelated data change or wrong cutoff: {key}")
        old_threads[key], new_threads[key] = old, new
        excluded_records += old["albums"] - new["albums"]
        empty_profiles += new["albums"] == 0

    old_dir, new_dir = load(previous / "directory.json"), load(projection / "directory.json")
    old_keys = {b["builderKey"] for b in old_dir["builders"]}
    if old_keys != set(new_threads) or {b["builderKey"] for b in new_dir["builders"]} != old_keys:
        raise ValueError("Directory identity set does not match retained threads")
    expected_builders = sorted((public_header(t) for t in new_threads.values()),
                               key=lambda b: (b["displayName"].casefold(), b["builderKey"]))
    if new_dir["builders"] != expected_builders:
        raise ValueError("Directory builder summaries differ from verified threads")
    # generatedAt is the analysis receipt timestamp, not public content; the live
    # gate likewise admits its movement while comparing every substantive field.
    for field in ("schema", "eras", "legacyImports"):
        if new_dir[field] != old_dir[field]:
            raise ValueError(f"Unrelated directory field changed: {field}")
    if not (0 <= new_dir["unattributedAlbums"] <= old_dir["unattributedAlbums"]):
        raise ValueError("Unattributed-album count did not decrease under the larger size cutoff")
    expected_photography = photo_and_album_counts(old_threads, new_threads)
    if new_dir["photography"] != expected_photography:
        raise ValueError("Archive photography is not the verified public photo/build union")
    if any(new_dir["photography"][field] != old_dir["photography"][field]
           for field in ("photos", "albumsWithPhotos", "buildersWithPhotos")):
        raise ValueError("Public photographs or photographed-builder coverage disappeared")
    unique_albums = {a["buildKey"] for t in new_threads.values() for g in t["eras"] for a in g["albums"]}
    if new_receipt["builders"] != len(new_threads) or new_receipt["albums"] != len(unique_albums):
        raise ValueError("Candidate receipt totals do not match verified threads")
    return {"builders": len(new_threads), "empty_profiles": empty_profiles,
            "excluded_profile_records": excluded_records, "albums": len(unique_albums),
            "photographs": expected_photography["photos"],
            "photographed_builders": expected_photography["buildersWithPhotos"],
            "changed_files": len(changed), "line_ending_only_files": len(line_ending_only)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--previous", type=Path, required=True)
    ap.add_argument("--projection", type=Path, required=True)
    ap.add_argument("--portrait-library", type=Path, required=True)
    ap.add_argument("--live-receipt-url", default=LIVE)
    args = ap.parse_args()
    previous_shas = file_shas(load(args.previous / "receipt.json"))
    live = json.loads(urllib.request.urlopen(args.live_receipt_url, timeout=60).read())
    if previous_shas != file_shas(live):
        raise ValueError("Baseline projection no longer matches the live release")
    result = audit(args.previous, args.projection, load(args.portrait_library))
    print("GATE PASS: " + ", ".join(f"{key}={value:,}" for key, value in result.items()))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError) as exc:
        print(f"GATE FAIL: {exc}", file=sys.stderr)
        sys.exit(1)
