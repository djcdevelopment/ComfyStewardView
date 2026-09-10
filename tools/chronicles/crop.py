#!/usr/bin/env python3
"""Cut a fixed window out of a full-page screenshot and save it as WebP.

`shoot.mjs` captures whole pages, which can be six thousand pixels tall. That is the right
artefact to keep and the wrong thing to put in a document, so this cuts the part the step
was actually about. The window size is fixed rather than fitted: a page of illustrations
all the same shape reads as a set, and one where every frame has its own aspect ratio
reads as a pile.

A window that runs off the edge of the source is clamped, and one larger than the source is
padded with the archive's own background rather than white.

Usage:
  python tools/chronicles/crop.py --src page.png --dst page.crop.webp --box X,Y,W,H [--quality 82]
"""
import argparse
from pathlib import Path
import sys

BACKDROP = (9, 15, 22)          # surface-container-lowest, so padding reads as page, not paper


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--src", type=Path, required=True)
    parser.add_argument("--dst", type=Path, required=True)
    parser.add_argument("--box", required=True, help="X,Y,W,H in source pixels")
    parser.add_argument("--quality", type=int, default=82)
    args = parser.parse_args()

    try:
        from PIL import Image
    except ImportError:
        raise SystemExit("Pillow is not installed: python -m pip install pillow")

    try:
        x, y, width, height = (int(part) for part in args.box.split(","))
    except ValueError:
        raise SystemExit("--box takes four integers: X,Y,W,H")
    if width <= 0 or height <= 0:
        raise SystemExit("--box needs a positive width and height")

    with Image.open(args.src) as source:
        page = source.convert("RGB")
    x = max(0, min(x, max(0, page.width - width)))
    y = max(0, min(y, max(0, page.height - height)))
    window = Image.new("RGB", (width, height), BACKDROP)
    window.paste(page.crop((x, y, min(x + width, page.width), min(y + height, page.height))), (0, 0))
    args.dst.parent.mkdir(parents=True, exist_ok=True)
    window.save(args.dst, "WEBP", quality=args.quality, method=6)
    print(f"{args.dst} {args.dst.stat().st_size:,} B from {args.src.name} at {x},{y} {width}x{height}")


if __name__ == "__main__":
    main()
