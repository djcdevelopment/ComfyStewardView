"""Matte the die-cut persona cutouts onto transparency.

The Stitch renders are 1024x1024 RGB with no alpha: four sit on a flat charcoal
field, one (the stonemason) on a painted checkerboard. This tool handles the flat
field with a corner flood-fill; pass --rembg for the checkerboard file (needs the
rembg package in a scratch venv; not a project dependency).

    python matte.py IN.png OUT.png [--tol 28] [--rembg] [--pad 0.04]
"""
from __future__ import annotations
import argparse, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageOps


def flood_matte(img: Image.Image, tol: int) -> Image.Image:
    rgb = img.convert("RGB").filter(ImageFilter.GaussianBlur(1))
    w, h = rgb.size
    # Flood from every corner into a sentinel colour, then read the sentinel back
    # as the background mask. Tolerance is a per-channel max distance.
    work = rgb.copy()
    sentinel = (255, 0, 255)
    for seed in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        ImageDraw.floodfill(work, seed, sentinel, thresh=tol)
    px = work.load()
    mask = Image.new("L", (w, h), 255)
    mp = mask.load()
    for y in range(h):
        for x in range(w):
            if px[x, y] == sentinel:
                mp[x, y] = 0
    # Erode a hair, then soften the edge so the sticker border keeps its torn look.
    mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1))
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def rembg_matte(img: Image.Image) -> Image.Image:
    from rembg import remove  # type: ignore
    return remove(img.convert("RGBA"))


def trim(img: Image.Image, pad: float) -> Image.Image:
    bbox = img.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    if not bbox:
        return img
    l, t, r, b = bbox
    pw, ph = int((r - l) * pad), int((b - t) * pad)
    l, t = max(0, l - pw), max(0, t - ph)
    r, b = min(img.width, r + pw), min(img.height, b + ph)
    cut = img.crop((l, t, r, b))
    side = max(cut.width, cut.height)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(cut, ((side - cut.width) // 2, (side - cut.height) // 2))
    return canvas.resize((1024, 1024), Image.LANCZOS)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("dst")
    ap.add_argument("--tol", type=int, default=28)
    ap.add_argument("--pad", type=float, default=0.04)
    ap.add_argument("--rembg", action="store_true")
    a = ap.parse_args()
    img = Image.open(a.src)
    out = rembg_matte(img) if a.rembg else flood_matte(img, a.tol)
    out = trim(out, a.pad)
    Path(a.dst).parent.mkdir(parents=True, exist_ok=True)
    out.save(a.dst, "PNG", optimize=True)
    alpha = out.getchannel("A")
    hist = alpha.histogram()
    print(f"{Path(a.dst).name}: {out.size} transparent={hist[0]/ (out.width*out.height):.1%} opaque={hist[255]/(out.width*out.height):.1%}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
