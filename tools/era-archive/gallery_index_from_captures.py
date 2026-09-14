#!/usr/bin/env python3
"""Give the /valheim/<era>/ photo gallery an index for an era that was photographed by the
compare-and-reshoot loop.

The per-era gallery (tools/selfie-stick/gallery/index.html, the ERA picker at /valheim/) reads
a `build_valheim_index.py` index: one row per published frame with the facets the page filters
on. That builder walks raw capture folders and needs the masters beside it; the second-pass eras
keep their masters on the capture hosts and publish only derivatives (`publish_captures.py`),
so the index is derived here from the capture manifest instead -- the same photographs, the
same ids, the same receipt facts (`import_captures.py` already carried them across).

No coordinates and no creator ids are written, so the output is already in the shape
`scrub_index.py` produces for the public copy. `aesthetic` is omitted: these frames were
chosen by rank_frames.py / the light table, and the viewer sorts on pieces when the score is
null. `eras.json` for every era directory (each names itself `current`) is emitted beside it.

    python gallery_index_from_captures.py --manifest captures/era1/captures-era1.json \\
        --campaign campaigns/era1/run/<root>/campaign.json --out captures/era1/index-era1.json
    python gallery_index_from_captures.py eras --root /valheim/ --slugs era1 era2 ... --current era17 --out eras/
"""
import argparse
import json
from pathlib import Path
import re
import sys
import time

PERSPECTIVE = re.compile(r"^([a-z]+?)\d*(?:[-~]|$)")


def perspective_of(shot):
    """`detail1-045-26` -> detail, `orbit3` -> orbit, `detail1~aim~up20` -> detail."""
    m = PERSPECTIVE.match(shot)
    return m.group(1) if m else "shot"


def index_from_manifest(manifest, campaign=None, generated=None):
    if manifest.get("schema") != "steward-capture-gallery/v1":
        raise ValueError(f"unsupported manifest schema: {manifest.get('schema')}")
    pieces = {}
    if campaign:
        if campaign.get("sourceKey") != manifest.get("sourceKey"):
            raise ValueError("campaign.json belongs to another world")
        pieces = {b["buildKey"]: b.get("pieces") for b in campaign.get("builds", [])}
    images, facets = [], {k: set() for k in ("environments", "variants", "perspectives", "kinds", "regions", "areas", "flashes")}
    for build_key, photos in manifest["builds"].items():
        for photo in photos:
            capture = photo.get("capture") or {}
            row = {
                "id": photo["id"],
                "cluster_id": build_key[:12],
                "label": photo.get("label") or f"Build {build_key[:8]}",
                "variant": photo["shot"],
                "perspective": perspective_of(photo["shot"]),
                "source": "verdict" if photo.get("verdict") else ("rank" if photo.get("rank") else "planned"),
                "published": True,
                "environment": capture.get("environment"),
                "time_of_day": capture.get("time_of_day"),
                "occluded": bool(capture.get("occluded")),
                "pieces_near_aim": capture.get("pieces_near_aim"),
                "pieces": pieces.get(build_key),
            }
            if photo.get("rank"):
                row["rank"] = photo["rank"].get("order")
            images.append(row)
            if row["environment"]:
                facets["environments"].add(row["environment"])
            facets["variants"].add(row["variant"])
            facets["perspectives"].add(row["perspective"])
    images.sort(key=lambda r: (-(r["pieces"] or 0), r["cluster_id"], r.get("rank") or 0, r["variant"]))
    return {
        "generated": int(generated if generated is not None else time.time()),
        "world": manifest["world"],
        "era": manifest["era"],
        "n": len(images),
        "runs": 1,
        "joined": len(images),
        **{k: sorted(v) for k, v in facets.items()},
        "ranked": bool(manifest.get("ranked")),
        "judged": bool(manifest.get("judged")),
        "images": images,
    }


def era_entry(slug, label, route, current_slug):
    """The picker's row: hrefs are absolute under the route; the gallery that lives at the
    route's root (the current era) links to the root itself, as Publish-Gallery.ps1 does."""
    return {"slug": slug, "label": label, "href": route if slug == current_slug else f"{route}{slug}/"}


def eras_manifests(slugs, labels, route, root_slug):
    """One eras.json per directory, each naming itself current, plus the root's."""
    entries = [era_entry(s, labels.get(s, s), route, root_slug) for s in slugs]
    docs = {"": {"current": root_slug, "eras": entries}}
    for s in slugs:
        if s != root_slug:
            docs[s] = {"current": s, "eras": entries}
    return docs


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command")
    one = sub.add_parser("index", help="index.json for one era from its capture manifest")
    one.add_argument("--manifest", type=Path, required=True)
    one.add_argument("--campaign", type=Path, default=None, help="campaign.json of the run, for piece counts")
    one.add_argument("--out", type=Path, required=True)
    eras = sub.add_parser("eras", help="eras.json documents for every era directory")
    eras.add_argument("--route", default="/valheim/")
    eras.add_argument("--slugs", nargs="+", required=True, help="in display order")
    eras.add_argument("--labels", default=None, help="JSON map slug -> label; default ComfyEra<n>")
    eras.add_argument("--current", required=True, help="the era served at the route root")
    eras.add_argument("--out", type=Path, required=True, help="directory: <out>/eras.json (root) and <out>/<slug>/eras.json")
    args = parser.parse_args()
    if args.command == "index":
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        campaign = json.loads(args.campaign.read_text(encoding="utf-8")) if args.campaign else None
        doc = index_from_manifest(manifest, campaign)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
        print(f"{doc['era']}: {doc['n']} frames over {len({r['cluster_id'] for r in doc['images']})} builds, "
              f"perspectives {doc['perspectives']}, environments {len(doc['environments'])} -> {args.out}")
    elif args.command == "eras":
        labels = json.loads(args.labels) if args.labels else {}
        labels = {s: labels.get(s, "ComfyEra" + s[3:] if s.startswith("era") else s) for s in args.slugs}
        for sub_dir, doc in eras_manifests(args.slugs, labels, args.route, args.current).items():
            path = args.out / sub_dir / "eras.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(doc) + "\n", encoding="utf-8")
        print(f"eras.json x {len(args.slugs)} under {args.out} (root current={args.current})")
    else:
        parser.print_help()
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
