#!/usr/bin/env python3
"""Publish an era's capture derivatives beside the existing galleries.

`deploy_gallery.py` ships the creators projection -- JSON, JS, CSS. It has never had to
carry photographs, because until now no modern era had any: the only images on the site
came from the era16/17 legacy galleries. This puts an era's `thumb/` and `large/` webp
where a capture manifest's `base` URL says they are, using the same directory shape those
galleries already use.

Masters stay on the capture host. Only derivatives travel -- 4K PNGs are ~8 MB each and
the webp about 3% of that, which is the difference between an 18 GB transfer and 300 MB
over a link that has been measured at 129 KB/s.

Usage:
  python publish_captures.py --derivatives <dir> --manifest captures-<era>.json
                             [--ssh-target fx99] [--remote-root /srv/sites/valheim]
                             --receipt <path> [--dry-run]
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

from archive import digest, load, now, save


def remote(target, code):
    result = subprocess.run(["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                             target, "python3", "-"],
                            input=code, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"Remote operation failed ({result.returncode}): {result.stderr.strip()}")
    return result.stdout


def parse_args():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--derivatives", type=Path, required=True, help="dir holding thumb/ and large/")
    p.add_argument("--manifest", type=Path, required=True, help="captures-<era>.json")
    p.add_argument("--ssh-target", default="fx99")
    p.add_argument("--remote-root", default="/srv/sites/valheim")
    p.add_argument("--receipt", type=Path, required=True)
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args()


def main():
    args = parse_args()
    if not re.fullmatch(r"/srv/sites/[A-Za-z0-9_-]+", args.remote_root):
        raise ValueError("Expected a single gallery site root")
    if not re.fullmatch(r"[A-Za-z0-9_.@-]+", args.ssh_target):
        raise ValueError("Invalid SSH alias")
    manifest = load(args.manifest)
    if manifest.get("schema") != "steward-capture-gallery/v1":
        raise ValueError("Not a capture gallery manifest")
    era = manifest["era"]
    if not re.fullmatch(r"[A-Za-z0-9_-]+", era):
        raise ValueError("Unsafe era slug")

    # The manifest's URLs are the contract. Publish exactly where they point, and refuse
    # if the derivatives on disk are not the files those URLs name.
    expected = set()
    for photos in manifest["builds"].values():
        for photo in photos:
            for folder, url in (("thumb", photo["thumb"]), ("large", photo["large"])):
                if not url.startswith(manifest["base"] + folder + "/"):
                    raise ValueError(f"Photo URL leaves the era base: {url}")
                expected.add(folder + "/" + photo["id"] + ".webp")
    root = args.derivatives.resolve()
    actual = {p.relative_to(root).as_posix() for p in root.rglob("*.webp")}
    missing = sorted(expected - actual)
    if missing:
        raise ValueError(f"{len(missing)} derivative(s) missing, first: {missing[0]}")
    extra = sorted(actual - expected)

    total = sum((root / name).stat().st_size for name in expected)
    print(f"{era}: {len(expected):,} files, {total/1e6:.0f} MB -> "
          f"{args.ssh_target}:{args.remote_root}/{era}/")
    if extra:
        print(f"  {len(extra):,} derivative(s) not referenced by the manifest are not published")
    if args.dry_run:
        print("dry run: nothing sent")
        return

    with tempfile.TemporaryDirectory(prefix="steward-captures-") as temporary:
        bundle = Path(temporary) / f"{era}.tgz"
        with tarfile.open(bundle, "w:gz") as tar:
            for name in sorted(expected):
                tar.add(root / name, arcname=name, recursive=False)
        stamp = digest(bundle)
        release = era + "-" + stamp["sha256"][:12]
        remote_archive = "/tmp/steward-captures-" + release + ".tgz"
        remote(args.ssh_target, "from pathlib import Path\np=Path(" + repr(args.remote_root) +
               ")\nassert p.is_dir()\n")
        subprocess.run(["scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                        str(bundle), args.ssh_target + ":" + remote_archive], check=True)
        settings = {"root": args.remote_root, "era": era, "archive": remote_archive,
                    "release": release, "sha256": stamp["sha256"], "bytes": stamp["bytes"],
                    "files": len(expected)}
        result = json.loads(remote(args.ssh_target, "settings=" + repr(settings) + "\n" + REMOTE))
        save(args.receipt, {"schema": "steward-capture-publication/v1", "publishedAt": now(),
                            "era": era, "base": manifest["base"], "archive": stamp,
                            "manifest": digest(args.manifest), "remote": result})
        print(json.dumps(result))


REMOTE = r'''
import hashlib,json,os,shutil,tarfile
from pathlib import Path
root=Path(settings['root']);archive=Path(settings['archive'])
assert archive.stat().st_size==settings['bytes']
assert hashlib.sha256(archive.read_bytes()).hexdigest()==settings['sha256']
staging=root/('.'+settings['release']+'.incoming')
if staging.exists():shutil.rmtree(staging)
staging.mkdir()
with tarfile.open(archive) as tar:
    for member in tar.getmembers():
        name=member.name
        assert member.isfile() and not name.startswith('/') and '..' not in Path(name).parts
        assert name.split('/')[0] in ('thumb','large') and name.endswith('.webp')
    tar.extractall(staging)
written=sorted(p.relative_to(staging).as_posix() for p in staging.rglob('*.webp'))
assert len(written)==settings['files']
# Publish into place folder by folder; a viewer never sees a half-written directory.
dest=root/settings['era'];dest.mkdir(exist_ok=True)
moved=0
for folder in ('thumb','large'):
    source=staging/folder
    if not source.is_dir():continue
    target=dest/folder;target.mkdir(exist_ok=True)
    for path in source.iterdir():
        os.replace(path,target/path.name);moved+=1
shutil.rmtree(staging);archive.unlink()
for path in dest.rglob('*.webp'):os.chmod(path,0o644)
print(json.dumps({'era':settings['era'],'directory':str(dest),'published':moved,
                  'thumb':len(list((dest/'thumb').glob('*.webp'))),
                  'large':len(list((dest/'large').glob('*.webp')))}))
'''


if __name__ == "__main__":
    main()
