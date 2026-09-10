#!/usr/bin/env python3
"""Deploy a built Chronicles site to FX99 as an immutable release with a symlink swap.

Caddy serves `/srv/sites/<slug>/` at `/<slug>/` with no configuration change, which makes
the deployment question "what does /srv/sites/chronicles contain right now" rather than
"which config is live". The answer here is: nothing but symlinks. Every real file lives in
`.releases/<stamp>-<sha12>/`, and publishing is re-pointing a handful of links.

That shape buys three things. A release is verified in place before anything points at it,
so a truncated transfer never becomes the live site. A rollback is the same swap run
against a directory that is still on disk, not a rebuild. And because the hashed
`chronicles.<hash>.css` / `gateway.<hash>.js` links from the previous release are kept for
one generation, a browser that fetched the old HTML a second before the swap can still
fetch the assets that HTML names.

Usage:
  python tools/chronicles/deploy.py --out <built dir>
      [--ssh-target fx99] [--remote-root /srv/sites/chronicles]
      [--dry-run | --list | --rollback <release>] [--receipt <path>]

The built directory is whatever `build.py` produced: index.html, guide/index.html, the
hashed css and js, img/**, build.json and receipt.json. receipt.json is the contract --
`{"files":[{"path","bytes","sha256"}]}` -- and every file in it is checked locally before
the transfer and again on the box after extraction.

One-time bootstrap, run by a human because /srv/sites is root-owned (see README):
  ssh fx99 sudo install -d -o derek -g derek -m 775 /srv/sites/chronicles
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import uuid

SSH = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]
SCP = ["scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]
KEEP_RELEASES = 5
RELEASE = re.compile(r"\d{8}T\d{6}Z-[0-9a-f]{12}")
# Assets whose name already carries their content hash. Two releases can hold different
# files under these names without conflict, which is what makes the one-generation
# overlap safe.
HASHED = re.compile(r"^(chronicles\.[0-9a-z]+\.css|gateway\.[0-9a-z]+\.js)$")

REMOTE = r'''
import hashlib, json, os, re, shutil, tarfile
from pathlib import Path
# Mirrors the local HASHED constant: names that carry their own content hash may overlap
# across two releases, which is what makes the one-generation hold safe.
HASHED = re.compile(r"^(chronicles\.[0-9a-z]+\.css|gateway\.[0-9a-z]+\.js)$")

root = Path(settings['root'])
releases = root / '.releases'
mode = settings['mode']
assert str(root).startswith('/srv/sites/'), 'remote root outside /srv/sites'
assert root.is_dir(), f'no such directory: {root} (run the one-time install -d bootstrap)'


def top_links():
    """Every top-level symlink and where it points, relative to the root."""
    if not root.is_dir():
        return {}
    return {p.name: os.readlink(p) for p in sorted(root.iterdir()) if p.is_symlink()}


def release_of(link):
    """The release directory a top-level link points into, or None."""
    parts = Path(link).parts
    if len(parts) >= 2 and parts[0] == '.releases':
        return parts[1]
    return None


def known_releases():
    if not releases.is_dir():
        return []
    return sorted(p.name for p in releases.iterdir() if p.is_dir())


def current_release():
    for name, link in top_links().items():
        if name == 'index.html':
            return release_of(link)
    seen = [release_of(l) for l in top_links().values()]
    seen = [s for s in seen if s]
    return seen[0] if seen else None


if mode == 'list':
    print(json.dumps({'root': str(root), 'releases': known_releases(),
                      'current': current_release(), 'links': top_links()}))
    raise SystemExit(0)

previous = current_release()

if mode == 'deploy':
    archive = Path(settings['archive'])
    assert archive.stat().st_size == settings['bytes'], 'archive size mismatch in flight'
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == settings['sha256'], 'archive digest mismatch'
    releases.mkdir(exist_ok=True)
    target = releases / settings['release']
    assert not target.exists(), f'release {settings["release"]} already exists'
    staging = releases / ('.' + settings['release'] + '.incoming')
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            resolved = (staging / member.name).resolve()
            assert member.isfile(), f'not a plain file: {member.name}'
            assert resolved.is_relative_to(staging.resolve()), f'escapes the release: {member.name}'
        tar.extractall(staging, filter='data')
    # Re-hash on the box. A transfer that arrived intact can still have been written to a
    # full disk, and this is the last moment a bad release costs nothing to discard.
    receipt = json.loads((staging / 'receipt.json').read_text())
    for record in receipt['files']:
        file = staging / record['path']
        assert file.is_file(), f'missing after extraction: {record["path"]}'
        assert file.stat().st_size == record['bytes'], f'size drift: {record["path"]}'
        assert hashlib.sha256(file.read_bytes()).hexdigest() == record['sha256'], f'digest drift: {record["path"]}'
    for path in staging.rglob('*'):
        os.chmod(path, 0o755 if path.is_dir() else 0o644)
    os.replace(staging, target)
    archive.unlink()
    verified = len(receipt['files'])
else:                                                     # rollback
    target = releases / settings['release']
    assert target.is_dir(), f'no retained release {settings["release"]}'
    verified = len(json.loads((target / 'receipt.json').read_text())['files'])

# ---- the swap ------------------------------------------------------------------
entries = sorted(p.name for p in target.iterdir())
for name in entries:
    existing = root / name
    assert not existing.exists() or existing.is_symlink(), \
        f'{name} in the site root is a real file, not a link this lane owns'
    stage = root / ('.swap-' + name + '-' + settings['release'])
    if stage.is_symlink() or stage.exists():
        stage.unlink()
    stage.symlink_to(os.path.join('.releases', settings['release'], name))
    os.replace(stage, existing)          # atomic: readers see one release or the other

# Clear links left over from earlier releases, keeping the outgoing release's hashed
# assets for exactly one generation so HTML already in a browser can still resolve them.
removed, held = [], []
for name, link in top_links().items():
    if name in entries:
        continue
    origin = release_of(link)
    if origin is None:
        continue
    if origin == previous and HASHED.match(name):
        held.append(name)
        continue
    (root / name).unlink()
    removed.append(name)

# Prune old releases, but never one something still points at.
live = {release_of(l) for l in top_links().values()} - {None}
pruned = []
for name in known_releases()[:-settings['keep']] if settings['keep'] else []:
    if name in live or name == settings['release']:
        continue
    shutil.rmtree(releases / name)
    pruned.append(name)

print(json.dumps({'release': settings['release'], 'previous': previous, 'mode': mode,
                  'filesVerified': verified, 'links': top_links(), 'heldAssets': held,
                  'unlinked': removed, 'prunedReleases': pruned,
                  'releases': known_releases()}))
'''


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            h.update(block)
    return {"bytes": Path(path).stat().st_size, "sha256": h.hexdigest()}


def remote(target, code):
    # Bytes: a text-mode pipe on Windows would send \r\n, which python3 tolerates and
    # bash does not -- send the same thing either way rather than relying on that.
    result = subprocess.run(SSH + [target, "python3 -"], input=code.encode("utf-8"),
                            capture_output=True)
    stderr = result.stderr.decode("utf-8", "replace").strip()
    if result.returncode:
        raise RuntimeError(f"Remote operation failed ({result.returncode}): {stderr}")
    if stderr:
        print(stderr, file=sys.stderr)
    return result.stdout.decode("utf-8", "replace")


def verify_local(out):
    """The built directory must be exactly what its own receipt says it is."""
    receipt_path = out / "receipt.json"
    if not receipt_path.is_file():
        raise SystemExit(f"No receipt.json in {out} -- build it before deploying it")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
    listed = {record["path"] for record in receipt["files"]}
    present = {p.relative_to(out).as_posix() for p in out.rglob("*") if p.is_file()}
    missing = sorted(listed - present)
    extra = sorted(present - listed - {"receipt.json"})
    if missing:
        raise SystemExit(f"{len(missing)} file(s) in receipt.json are not on disk, first: {missing[0]}")
    if extra:
        raise SystemExit(f"{len(extra)} file(s) on disk are not in receipt.json, first: {extra[0]}")
    for record in receipt["files"]:
        stamp = digest(out / record["path"])
        if stamp["bytes"] != record["bytes"] or stamp["sha256"] != record["sha256"]:
            raise SystemExit(f"{record['path']} does not match receipt.json")
    return receipt, sorted(listed | {"receipt.json"})


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, help="the built site directory")
    parser.add_argument("--ssh-target", default="fx99")
    parser.add_argument("--remote-root", default="/srv/sites/chronicles")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--list", action="store_true", help="show releases and what the links point at")
    parser.add_argument("--rollback", metavar="RELEASE")
    parser.add_argument("--receipt", type=Path)
    return parser.parse_args()


def main():
    args = parse_args()
    if sum(bool(x) for x in (args.dry_run, args.list, args.rollback)) > 1:
        raise SystemExit("--dry-run, --list and --rollback are three different questions")
    if not re.fullmatch(r"/srv/sites/[A-Za-z0-9_-]+", args.remote_root):
        raise SystemExit("Expected a single site root under /srv/sites/")
    if not re.fullmatch(r"[A-Za-z0-9_.@-]+", args.ssh_target):
        raise SystemExit("Invalid SSH alias")
    if args.rollback and not RELEASE.fullmatch(args.rollback):
        raise SystemExit("--rollback takes a release name like 20260910T041500Z-0123456789ab")
    if not args.out and not (args.list or args.rollback):
        raise SystemExit("--out is required to deploy")

    settings = {"root": args.remote_root, "keep": KEEP_RELEASES}

    if args.list:
        print(remote(args.ssh_target, "settings=" + repr(settings | {"mode": "list"}) + "\n" + REMOTE))
        return

    if args.rollback:
        settings |= {"mode": "rollback", "release": args.rollback}
        print(f"rollback -> {args.ssh_target}:{args.remote_root}  release {args.rollback}")
        result = json.loads(remote(args.ssh_target, "settings=" + repr(settings) + "\n" + REMOTE))
        report(args, result, [])
        return

    out = args.out.resolve()
    if not out.is_dir():
        raise SystemExit(f"No built site at {out}")
    receipt, names = verify_local(out)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    release = stamp + "-" + digest(out / "receipt.json")["sha256"][:12]
    total = sum(record["bytes"] for record in receipt["files"])
    print(f"{out}: {len(names)} files, {total/1e6:.1f} MB  ->  "
          f"{args.ssh_target}:{args.remote_root}/.releases/{release}/")

    if args.dry_run:
        for name in names[:12]:
            print("  " + name)
        if len(names) > 12:
            print(f"  ... and {len(names) - 12} more")
        print("  swap: " + ", ".join(sorted({n.split('/')[0] for n in names})))
        print("dry run: nothing sent. Remote state now:")
        try:
            print(remote(args.ssh_target, "settings=" + repr(settings | {"mode": "list"}) + "\n" + REMOTE))
        except RuntimeError as failure:
            # The commonest reason is that nobody has run the bootstrap yet. Say so rather
            # than making the operator read a traceback for it.
            print(f"  remote listing unavailable: {failure}")
            print(f"  bootstrap once, as a human: ssh {args.ssh_target} "
                  f"sudo install -d -o derek -g derek -m 775 {args.remote_root}")
        return

    with tempfile.TemporaryDirectory(prefix="chronicles-deploy-") as temporary:
        archive = Path(temporary) / "chronicles.tgz"
        with tarfile.open(archive, "w:gz") as tar:
            for name in names:
                tar.add(out / name, arcname=name, recursive=False)
        bundle = digest(archive)
        remote_archive = "/tmp/chronicles-" + release + ".tgz"
        subprocess.run(SCP + [str(archive), f"{args.ssh_target}:{remote_archive}"], check=True)
        settings |= {"mode": "deploy", "release": release, "archive": remote_archive,
                     "sha256": bundle["sha256"], "bytes": bundle["bytes"]}
        result = json.loads(remote(args.ssh_target, "settings=" + repr(settings) + "\n" + REMOTE))
        report(args, result, receipt["files"])


def report(args, result, files):
    print(json.dumps({"release": result["release"], "previous": result["previous"],
                      "files": len(files) or result["filesVerified"],
                      "remote_root": args.remote_root}, indent=2))
    for key in ("links", "heldAssets", "unlinked", "prunedReleases"):
        if result.get(key):
            print(f"{key}: {json.dumps(result[key])}", file=sys.stderr)
    if args.receipt:
        document = {"schema": "chronicles-deployment/v1",
                    "deployedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "release": result["release"], "previous": result["previous"],
                    "files": files or result["filesVerified"],
                    "remote_root": args.remote_root, "ssh_target": args.ssh_target,
                    "remote": result}
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        candidate = args.receipt.with_name(args.receipt.name + ".tmp-" + uuid.uuid4().hex[:8])
        candidate.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
        os.replace(candidate, args.receipt)
        print(f"receipt: {args.receipt}", file=sys.stderr)


if __name__ == "__main__":
    main()
