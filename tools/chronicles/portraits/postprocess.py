r"""Turn raw 1024x1024 portrait renders into the committed 512x512 library + manifest.

    python tools/chronicles/portraits/postprocess.py --raw E:\omen\chronicles-portraits\raw
        [--jobs E:\omen\chronicles-portraits\jobs.json] [--out tools/chronicles/assets/portraits]
        [--contact-sheet E:\omen\chronicles-portraits\contact.png] [--reject p07,p23]

Raw files are named <id>.<seed>.png. Auto-reject: not 1024 square, or the four 64px
corner patches are not a dark, desaturated ground (the prompt asks for flat dark slate).
Everything else is a human call on the contact sheet. Rejected ids are listed in the
manifest under "rejected" so generate.py --reseed can pick them up.
"""
from __future__ import annotations
import argparse, hashlib, json, sys
from datetime import datetime, timezone
from pathlib import Path
from PIL import Image, ImageDraw, ImageStat

sys.path.insert(0, str(Path(__file__).parent))
from prompts import tiles, TAIL  # noqa: E402


def corner_stats(img: Image.Image, size: int = 64):
    w, h = img.size
    boxes = [(0, 0, size, size), (w - size, 0, w, size), (0, h - size, size, h), (w - size, h - size, w, h)]
    lum, sat = [], []
    for b in boxes:
        patch = img.crop(b)
        lum.append(ImageStat.Stat(patch.convert("L")).mean[0])
        hsv = patch.convert("HSV")
        sat.append(ImageStat.Stat(hsv.getchannel("S")).mean[0] / 255.0)
    return sum(lum) / 4, sum(sat) / 4


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", type=Path, required=True)
    ap.add_argument("--jobs", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=Path("tools/chronicles/assets/portraits"))
    ap.add_argument("--contact-sheet", type=Path, default=None)
    ap.add_argument("--reject", default="", help="comma-separated ids rejected by eye")
    ap.add_argument("--max-lum", type=float, default=70.0)
    ap.add_argument("--max-sat", type=float, default=0.25)
    a = ap.parse_args()
    jobs = json.loads(a.jobs.read_text(encoding="utf-8")) if a.jobs and a.jobs.exists() else {}
    manual = {x.strip() for x in a.reject.split(",") if x.strip()}
    a.out.mkdir(parents=True, exist_ok=True)
    out_tiles, rejected, missing = [], [], []
    sheet_cells = []
    for t in tiles():
        candidates = sorted(a.raw.glob(f"{t['id']}.*.png"), key=lambda p: p.stat().st_mtime)
        if not candidates:
            missing.append(t["id"]); continue
        src = candidates[-1]  # newest attempt wins
        seed = int(src.stem.split(".")[1])
        img = Image.open(src).convert("RGB")
        lum, sat = corner_stats(img)
        why = None
        if img.size != (1024, 1024): why = f"size {img.size}"
        elif lum > a.max_lum: why = f"ground too bright ({lum:.0f})"
        elif sat > a.max_sat: why = f"ground too coloured ({sat:.2f})"
        elif t["id"] in manual: why = "rejected by eye"
        sheet_cells.append((t["id"], img, why))
        if why:
            rejected.append({"id": t["id"], "seed": seed, "why": why}); continue
        tile = img.resize((512, 512), Image.LANCZOS)
        dst = a.out / f"{t['id']}.webp"
        tile.save(dst, "WEBP", quality=88, method=6)
        job = jobs.get(t["id"], {})
        out_tiles.append({
            "id": t["id"], "seed": seed, "attempt": job.get("attempt", 1), "tags": t["tags"],
            "jobId": job.get("job_id"), "sourceSha256": hashlib.sha256(src.read_bytes()).hexdigest(),
            "cornerLuminance": round(lum, 1), "cornerSaturation": round(sat, 3),
        })
    manifest = {
        "schema": "chronicles-portraits/v1", "count": len(out_tiles), "workflow": "z-image-turbo",
        "size": 1024, "steps": 8, "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "palette": "muted slate blue and charcoal, one ember amber accent", "tail": TAIL,
        "tiles": out_tiles, "rejected": rejected, "missing": missing,
    }
    (a.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    if a.contact_sheet and sheet_cells:
        cell, cols = 192, 8
        rows = (len(sheet_cells) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * cell, rows * (cell + 22)), (9, 15, 22))
        d = ImageDraw.Draw(sheet)
        for i, (tid, img, why) in enumerate(sheet_cells):
            x, y = (i % cols) * cell, (i // cols) * (cell + 22)
            sheet.paste(img.resize((cell, cell)), (x, y))
            d.text((x + 4, y + cell + 4), f"{tid}" + (f"  X {why}" if why else ""), fill=(255, 193, 116) if not why else (255, 120, 120))
        a.contact_sheet.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(a.contact_sheet)
    print(f"tiles: {len(out_tiles)}  rejected: {len(rejected)}  missing: {len(missing)}")
    for r in rejected: print("  reject", r["id"], r["why"])
    if missing: print("  missing", ",".join(missing))
    return 0 if not rejected and not missing else 1


if __name__ == "__main__":
    sys.exit(main())
