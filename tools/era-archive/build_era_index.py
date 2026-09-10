#!/usr/bin/env python3
"""Turn a published capture manifest into the photo gallery's index.json.

`publish_captures.py` ships webp into /srv/sites/valheim/<era>/ and nothing else, so
an era directory has images but no page: the viewer (tools/selfie-stick/gallery/index.html)
fetches index.json and 404s without it. The other producer, build_valheim_index.py, reads
the selfie-stick capture flow -- raw orbit captures, clusters, receipts -- and cannot see
era-archive derivatives at all. This bridges that gap.

Only measured values are emitted. Fields the era-archive genuinely does not have --
region, kind, area, footprint, height, the structure ranking score -- are left out rather
than invented; the viewer builds each facet from the values present and simply does not
render a chip row it has no data for. era16 already ships a reduced schema and works.

cluster_id is the build key's first 12 hex characters, matching the `#build=` deep links
that import_captures.py writes into every album, so a link from the creators directory
lands on the right album instead of Caddy's 404.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import time
from pathlib import Path


def read(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value), encoding="utf-8")
    temporary.replace(path)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--captures", type=Path, required=True, action="append",
                   help="captures-<era>.json; repeatable. When an era was shot twice -- "
                        "a 1080p pass later superseded by 4K, say -- pass both, and a "
                        "photo present in several manifests is taken from the one with "
                        "the most pixels, matching attach_captures in community.py.")
    p.add_argument("--campaign", type=Path, required=True,
                   help="campaign.json, for per-build piece counts")
    p.add_argument("--quality", type=Path, default=None, help="quality-<era>.json")
    p.add_argument("--depth", type=Path, default=None,
                   help="depth-<era>.json; also copied beside index.json by the caller")
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args()

    manifests = [read(path) for path in args.captures]
    for m in manifests:
        if m.get("schema") != "steward-capture-gallery/v1":
            raise SystemExit("not a steward-capture-gallery/v1 manifest")
    eras = {m.get("era") for m in manifests}
    if len(eras) != 1:
        raise SystemExit(f"manifests span several eras: {sorted(eras)}")
    manifest = manifests[0]

    # Merge by photo id, keeping the largest frame. Later manifests do not simply win:
    # a re-shoot that covered only half the era must not demote the half it skipped.
    merged = {}
    for m in manifests:
        for build_key, photos in m["builds"].items():
            for photo in photos:
                seen = merged.get(photo["id"])
                pixels = (photo.get("width") or 0) * (photo.get("height") or 0)
                if seen is None or pixels > seen[2]:
                    merged[photo["id"]] = (build_key, photo, pixels)
    by_build = {}
    for build_key, photo, _ in merged.values():
        by_build.setdefault(build_key, []).append(photo)
    plan = read(args.campaign)
    verdicts = (read(args.quality) or {}).get("frames", {}) if args.quality else {}
    depth = read(args.depth) if args.depth else {}

    builds = {b["buildKey"]: b for b in plan.get("builds", [])}
    images = []
    for build_key, photos in by_build.items():
        build = builds.get(build_key, {})
        for photo in photos:
            frame = verdicts.get(photo["id"], {})
            capture = photo.get("capture", {})
            depths = depth.get(photo["id"], {})
            record = {
                "id": photo["id"],
                "cluster_id": build_key[:12],
                "label": photo.get("label"),
                "variant": photo.get("shot"),
                "perspective": "orbit",
                "source": "orbit",
                "published": True,
            }
            # Straight passthrough of what the runner measured. These arrive from
            # import_captures.RECEIPT_FIELDS; anything absent is simply not emitted,
            # so an older manifest still produces a valid (smaller) index.
            for key in ("environment", "time_of_day", "occluded", "pieces_near_aim",
                        "run", "lens_offset_m", "fires", "flash", "flash_bearing_deg",
                        "shot_distance_m"):
                if capture.get(key) is not None:
                    record[key] = capture[key]
            # The gallery sorts "recent" on an epoch int; the receipt carries an ISO
            # timestamp with an offset. Convert rather than ship a string the sort
            # would compare lexically.
            when = capture.get("at")
            if when:
                try:
                    record["ts"] = int(dt.datetime.fromisoformat(when).timestamp())
                except ValueError:
                    pass
            if capture.get("clearance") and capture["clearance"] != "planned":
                record["clearance"] = capture["clearance"]
            if build.get("pieces") is not None:
                record["pieces"] = build["pieces"]
            if "aesthetic" in frame:
                record["aesthetic"] = frame["aesthetic"]
            # Fog is the viewer's word for a near surface across the eye-line; the
            # depth pass measures it directly and score_frames uses the same threshold.
            if depths.get("center_block") is not None:
                record["fog"] = depths["center_block"] > 0.45
            images.append(record)

    images.sort(key=lambda r: (-(r.get("aesthetic") or 0), r["id"]))
    values = lambda key: sorted({r[key] for r in images if r.get(key) is not None})
    document = {
        "generated": int(time.time()),
        "world": manifest.get("world"),
        "n": len(images),
        "runs": 1,
        "joined": len(images),
        "environments": values("environment"),
        "variants": values("variant"),
        "perspectives": values("perspective"),
        "kinds": [],
        "regions": [],
        "areas": [],
        "flashes": [],
        "images": images,
    }
    write(args.out, document)
    scored = sum(1 for r in images if "aesthetic" in r)
    print(f"{len(images):,} images, {len(by_build):,} albums -> {args.out}")
    print(f"  aesthetic on {scored:,} | depth on {sum(1 for r in images if 'fog' in r):,}"
          f" | environments {document['environments']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
