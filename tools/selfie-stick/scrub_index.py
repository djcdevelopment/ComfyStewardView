#!/usr/bin/env python3
"""Write a deploy copy of the gallery index with location and identity removed.

The local index.json keeps full fidelity (it is gitignored for exactly this
reason); the copy that ships to a public host must not carry build coordinates
or creator ids. Nothing client-side reads the dropped fields — votes and claims
key on image_id/cluster_id, the filmstrip on run.

Usage:  python scrub_index.py <in-index.json> <out-index.json>
"""
import json
import sys

DROP = ("x", "y", "z", "top_creator_id")

# area_id and area_label deliberately survive. area_id is a sequence number
# ordered by piece mass, not a grid cell -- a grid cell index IS a coordinate at
# the cell's resolution, and would belong in DROP above. Keep it opaque: if you
# ever make it human-readable ("cell -4,2"), it has to be dropped here instead.


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    with open(sys.argv[1], encoding="utf-8") as fh:
        doc = json.load(fh)
    dropped = 0
    for row in doc.get("images", []):
        for k in DROP:
            if k in row:
                del row[k]
                dropped += 1
    with open(sys.argv[2], "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False)
    print(f"  scrubbed {dropped} field(s) across {len(doc.get('images', []))} rows "
          f"-> {sys.argv[2]}")


if __name__ == "__main__":
    main()
