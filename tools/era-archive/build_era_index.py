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
    p.add_argument("--captures", type=Path, required=True, help="captures-<era>.json")
    p.add_argument("--campaign", type=Path, required=True,
                   help="campaign.json, for per-build piece counts")
    p.add_argument("--quality", type=Path, default=None, help="quality-<era>.json")
    p.add_argument("--depth", type=Path, default=None,
                   help="depth-<era>.json; also copied beside index.json by the caller")
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args()

    manifest = read(args.captures)
    if manifest.get("schema") != "steward-capture-gallery/v1":
        raise SystemExit("not a steward-capture-gallery/v1 manifest")
    plan = read(args.campaign)
    verdicts = (read(args.quality) or {}).get("frames", {}) if args.quality else {}
    depth = read(args.depth) if args.depth else {}

    builds = {b["buildKey"]: b for b in plan.get("builds", [])}
    images = []
    for build_key, photos in manifest["builds"].items():
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
            for key in ("environment", "time_of_day", "occluded", "pieces_near_aim"):
                if key in capture:
                    record[key] = capture[key]
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
    print(f"{len(images):,} images, {len(manifest['builds']):,} albums -> {args.out}")
    print(f"  aesthetic on {scored:,} | depth on {sum(1 for r in images if 'fog' in r):,}"
          f" | environments {document['environments']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
