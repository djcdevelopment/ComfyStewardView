#!/usr/bin/env python3
"""Turn 4K capture masters into the webp derivatives the gallery serves.

Runs on the capture host, deliberately: the masters are ~8 MB each and the derivatives
about 3% of that, so encoding here and moving only the webp turns an 18 GB transfer into
roughly 1 GB. `capture_worker.py` stays free of image decoding and publication by design;
this is the separate step that does it, after a campaign is finished.

Sizes match `baseline/tools/selfie-stick/build_valheim_index.py` -- 1600 px at quality 80
for `large/`, 512 px at 82 for `thumb/` -- because the aesthetic bench scores the 1600 px
derivative. Deriving at some other size would make these frames incomparable with the
4,536 already scored.

Standard library plus ffmpeg. Resumable: an existing non-empty output is left alone, so a
re-run after an interruption costs only what is missing.

Usage:
  python3 make_derivatives.py --root <campaign root> --worklist derivatives-<era>.json
                              [--dest <dir>] [--jobs 12] [--verify]
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

LARGE_PX, LARGE_QUALITY = 1600, 80
THUMB_PX, THUMB_QUALITY = 512, 82
COMPRESSION_LEVEL = 4          # ffmpeg's libwebp knob for Pillow's method=4


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def parse_args():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--root", type=Path, required=True, help="campaign root the sources sit under")
    p.add_argument("--worklist", type=Path, required=True)
    p.add_argument("--dest", type=Path, default=None, help="default <root>/derivatives")
    p.add_argument("--jobs", type=int, default=12)
    p.add_argument("--verify", action="store_true",
                   help="re-hash each master against the worklist before encoding. The "
                        "campaign journal already verified them at harvest, so this is "
                        "off by default -- it costs a full read of every 8 MB file")
    p.add_argument("--ffmpeg", default="ffmpeg")
    return p.parse_args()


def encode(ffmpeg, source, dest, px, quality):
    """Longest side to px, preserving aspect; -2 keeps the other side even."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    temporary = dest.with_suffix(".webp.tmp")
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
               "-vf", f"scale='min({px},iw)':-2:flags=lanczos",
               "-c:v", "libwebp", "-quality", str(quality),
               "-compression_level", str(COMPRESSION_LEVEL), "-preset", "picture",
               "-f", "webp", str(temporary)]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0 or not temporary.exists() or not temporary.stat().st_size:
        temporary.unlink(missing_ok=True)
        return None, (result.stderr or "empty output").strip()[:200]
    os.replace(temporary, dest)
    return dest.stat().st_size, None


def one(args, dest_root, item):
    source = (args.root / item["source"]).resolve()
    if not source.is_relative_to(args.root.resolve()):
        return item["id"], 0, 0, "source escapes the campaign root"
    if not source.exists():
        return item["id"], 0, 0, "master is gone"
    if args.verify:
        h = hashlib.sha256()
        with source.open("rb") as stream:
            for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
                h.update(block)
        if h.hexdigest() != item["sha256"]:
            return item["id"], 0, 0, "master does not match the journal"
    sizes = []
    for folder, px, quality in (("large", LARGE_PX, LARGE_QUALITY),
                                ("thumb", THUMB_PX, THUMB_QUALITY)):
        out = dest_root / folder / (item["id"] + ".webp")
        if out.exists() and out.stat().st_size:
            sizes.append(out.stat().st_size)
            continue
        size, error = encode(args.ffmpeg, source, out, px, quality)
        if error:
            return item["id"], 0, 0, error
        sizes.append(size)
    return item["id"], sizes[0], sizes[1], None


def main():
    args = parse_args()
    root = args.root.resolve()
    dest_root = (args.dest or root / "derivatives").resolve()
    work = read(args.worklist)
    items = work["items"]
    print(f"{len(items):,} masters -> {dest_root} with {args.jobs} workers", flush=True)

    started = time.monotonic()
    large_bytes = thumb_bytes = done = 0
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = [pool.submit(one, args, dest_root, item) for item in items]
        for future in concurrent.futures.as_completed(futures):
            identifier, large, thumb, error = future.result()
            done += 1
            if error:
                failures.append({"id": identifier, "error": error})
            else:
                large_bytes += large
                thumb_bytes += thumb
            if done % 250 == 0:
                rate = done / max(time.monotonic() - started, 1e-9)
                print(f"  {done:,}/{len(items):,}  {rate:.1f}/s  "
                      f"{(len(items)-done)/max(rate,1e-9)/60:.1f} min left", flush=True)

    elapsed = time.monotonic() - started
    receipt = {
        "schema": "steward-derivatives/v1",
        "era": work["era"], "base": work["base"],
        "masters": len(items), "encoded": len(items) - len(failures),
        "failures": failures[:50], "failureCount": len(failures),
        "largeBytes": large_bytes, "thumbBytes": thumb_bytes,
        "totalBytes": large_bytes + thumb_bytes,
        "large": {"px": LARGE_PX, "quality": LARGE_QUALITY},
        "thumb": {"px": THUMB_PX, "quality": THUMB_QUALITY},
        "seconds": round(elapsed, 1),
    }
    write(dest_root / "receipt.json", receipt)
    print(f"\n{receipt['encoded']:,} encoded, {len(failures):,} failed, "
          f"{(large_bytes + thumb_bytes)/1e9:.2f} GB in {elapsed/60:.1f} min")
    for failure in failures[:5]:
        print(f"  {failure['id']}: {failure['error']}")
    print(dest_root / "receipt.json")


if __name__ == "__main__":
    main()
