#!/usr/bin/env python3
"""Push one viewer page to every published era directory, atomically and reversibly.

`Publish-Gallery.ps1` ships a whole era -- index.json, the derivatives, the page. That is
the right shape when the data changed and the wrong shape when only the page did: eight
directories under /srv/sites/valheim hold byte-identical copies of gallery/index.html, and
re-publishing eight eras to change a stylesheet moves gigabytes to deliver 40 kB.

So this moves the page and nothing else. Each target keeps its own index.json, thumb/ and
large/ untouched; the new page lands as a dot-file beside the old one and is renamed onto
it, which is atomic on one filesystem, so no reader ever sees a half-written page.

The copy being replaced is retained first, under `<remote-root>/.viewer-releases/<sha12>.html`.
That directory name is deliberate: `Publish-Gallery.ps1` clears a gallery with
`rm -rf ./thumb ./large ./img` and `rm -f ./index.html ./index.json ./depth.json ./judge.json
./eras.json`, so anything else in the root survives a full era publish and the rollback
target is still there afterwards.

Usage:
  python tools/selfie-stick/push_viewer.py --viewer tools/selfie-stick/gallery/index.html
      [--ssh-target fx99] [--remote-root /srv/sites/valheim] [--dirs era16,era7]
      [--dry-run | --verify | --rollback <sha12>] [--receipt <path>]

  --dry-run   read-only: list the targets, their current page shas, and what is retained
  --verify    read-only: fail if any target's page differs from the local file
  --rollback  put a retained page back; <sha12> comes from a receipt or from --dry-run
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import uuid

SSH = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]
SCP = ["scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]

# One script, four modes. Everything that touches the filesystem quotes its paths, and the
# only writes are inside a target directory or the retention directory beside it.
REMOTE = r'''
set -eu
mode="$1"; root="$2"; incoming="$3"; want="$4"; only="$5"; rel="$6"

case "$root" in
  /srv/sites/*) ;;
  *) echo "refusing a remote root outside /srv/sites: $root" >&2; exit 2 ;;
esac
[ -d "$root" ] || { echo "no such directory: $root" >&2; exit 2; }
releases="$root/.viewer-releases"

sha_of() { if [ -f "$1" ]; then sha256sum "$1" | cut -d' ' -f1; else echo "-"; fi; }

# A target is the gallery root itself plus every immediate era*/ holding an index.json.
# index.json is the test rather than index.html so a directory half-way through its first
# publish is never handed a page for data that is not there yet.
targets() {
  if [ -f "$root/index.json" ]; then echo "$root"; fi
  for dir in "$root"/era*/; do
    [ -d "$dir" ] || continue
    [ -f "$dir/index.json" ] || continue
    echo "${dir%/}"
  done
}

wanted() {
  if [ -z "$only" ]; then return 0; fi
  name="$(basename "$1")"
  if [ "$1" = "$root" ]; then name="."; fi
  case ",$only," in *",$name,"*) return 0 ;; esac
  return 1
}

if [ -d "$releases" ]; then
  for kept in "$releases"/*.html; do
    [ -f "$kept" ] || continue
    printf 'R\t%s\t%s\n' "$(basename "$kept" .html)" "$(wc -c < "$kept" | tr -d ' ')"
  done
fi

targets | while IFS= read -r dir; do
  wanted "$dir" || continue
  previous="$(sha_of "$dir/index.html")"
  short="-"
  if [ "$previous" != "-" ]; then short="$(printf '%s' "$previous" | cut -c1-12)"; fi

  if [ "$mode" = "list" ]; then
    printf 'T\t%s\t%s\t%s\t-\n' "$dir" "$short" "$previous"
    continue
  fi

  source="$incoming"
  if [ "$mode" = "rollback" ]; then
    source="$releases/$want.html"
    [ -f "$source" ] || { echo "no retained page $want.html under $releases" >&2; exit 3; }
  fi

  # Retain what is about to be overwritten, once per distinct page.
  if [ "$previous" != "-" ]; then
    mkdir -p "$releases"
    [ -f "$releases/$short.html" ] || cp -p "$dir/index.html" "$releases/$short.html"
  fi

  staged="$dir/.index.html.$rel"
  cp "$source" "$staged"
  chmod 644 "$staged"
  mv -f "$staged" "$dir/index.html"          # same filesystem: readers see one page or the other

  after="$(sha_of "$dir/index.html")"
  expected="$want"
  if [ "$mode" = "rollback" ]; then expected="$(sha_of "$source")"; fi
  ok=false
  if [ "$after" = "$expected" ]; then ok=true; fi
  printf 'T\t%s\t%s\t%s\t%s\n' "$dir" "$short" "$after" "$ok"
done

if [ "$mode" = "push" ] && [ -f "$incoming" ]; then rm -f "$incoming"; fi
'''


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def remote(target, argv):
    # ssh joins its command words with spaces and the remote login shell parses the
    # result, so an empty argument would simply disappear on the way over. Quote the
    # whole command here and hand ssh one word.
    command = " ".join(shlex.quote(word) for word in ["bash", "-s", "--"] + argv)
    # Bytes, not text: a text-mode pipe on Windows rewrites every \n as \r\n, and bash
    # answers a script full of carriage returns with "$'\r': command not found".
    result = subprocess.run(SSH + [target, command],
                            input=REMOTE.encode("utf-8"), capture_output=True)
    stderr = result.stderr.decode("utf-8", "replace").strip()
    if stderr:
        print(stderr, file=sys.stderr)
    if result.returncode:
        raise RuntimeError(f"Remote operation failed ({result.returncode})")
    return result.stdout.decode("utf-8", "replace")


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--viewer", type=Path,
                        default=Path(__file__).resolve().parent / "gallery" / "index.html")
    parser.add_argument("--ssh-target", default="fx99")
    parser.add_argument("--remote-root", default="/srv/sites/valheim")
    parser.add_argument("--dirs", default="", help="comma list of era directories, '.' for the root")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--rollback", metavar="SHA12")
    parser.add_argument("--receipt", type=Path)
    return parser.parse_args()


def main():
    args = parse_args()
    if sum(bool(x) for x in (args.dry_run, args.verify, args.rollback)) > 1:
        raise SystemExit("--dry-run, --verify and --rollback are three different questions")
    if not re.fullmatch(r"/srv/sites/[A-Za-z0-9_-]+", args.remote_root):
        raise SystemExit("Expected a single site root under /srv/sites/")
    if not re.fullmatch(r"[A-Za-z0-9_.@-]+", args.ssh_target):
        raise SystemExit("Invalid SSH alias")
    only = args.dirs.strip()
    if only and not re.fullmatch(r"[A-Za-z0-9_.,-]+", only):
        raise SystemExit("Unsafe --dirs list")
    if args.rollback and not re.fullmatch(r"[0-9a-f]{12}", args.rollback):
        raise SystemExit("--rollback takes the 12-character sha from a receipt")

    viewer = args.viewer.resolve()
    if not viewer.is_file():
        raise SystemExit(f"No viewer page at {viewer}")
    local = digest(viewer)
    mode = "list" if (args.dry_run or args.verify) else ("rollback" if args.rollback else "push")
    release = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6]
    incoming = "/tmp/.viewer-" + release + ".html"

    print(f"{viewer.name} {viewer.stat().st_size:,} B  sha256 {local[:12]}")
    print(f"{mode} -> {args.ssh_target}:{args.remote_root}" + (f"  dirs={only}" if only else ""))

    if mode == "push":
        subprocess.run(SCP + [str(viewer), f"{args.ssh_target}:{incoming}"], check=True)

    argv = [mode, args.remote_root, incoming, args.rollback or local, only, release]
    output = remote(args.ssh_target, argv)

    kept, dirs = [], []
    for line in output.splitlines():
        parts = line.split("\t")
        if parts[0] == "R" and len(parts) == 3:
            kept.append({"sha12": parts[1], "bytes": int(parts[2])})
        elif parts[0] == "T" and len(parts) == 5:
            directory, previous, current, ok = parts[1:]
            dirs.append({"dir": directory, "previous_sha12": previous,
                         "new_sha12": current[:12] if current != "-" else "-",
                         "ok": ok == "true" if mode != "list" else current == local})

    receipt = {"schema": "steward-viewer-push/v1",
               "pushedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
               "mode": mode, "remote_root": args.remote_root, "ssh_target": args.ssh_target,
               "pushed_sha": args.rollback or local, "local_sha": local,
               "viewer": str(viewer), "retained": kept, "dirs": dirs}
    print(json.dumps({"pushed_sha": receipt["pushed_sha"],
                      "dirs": [{k: d[k] for k in ("dir", "previous_sha12", "new_sha12", "ok")}
                               for d in dirs]}, indent=2))
    if kept:
        print(f"retained pages: {', '.join(k['sha12'] for k in kept)}", file=sys.stderr)
    if args.receipt:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        candidate = args.receipt.with_name(args.receipt.name + ".tmp-" + uuid.uuid4().hex[:8])
        candidate.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
        os.replace(candidate, args.receipt)
        print(f"receipt: {args.receipt}", file=sys.stderr)

    if not dirs:
        raise SystemExit(f"No target directories found under {args.remote_root}")
    stale = [d["dir"] for d in dirs if not d["ok"]]
    if args.verify and stale:
        raise SystemExit(f"{len(stale)} of {len(dirs)} directories do not carry this page: "
                         + ", ".join(stale))
    if mode in ("push", "rollback") and stale:
        raise SystemExit(f"Write did not take in: {', '.join(stale)}")
    if args.dry_run:
        # In a listing, `ok` answers "does this directory already carry the local page?".
        print(f"dry run: {len(dirs)} target(s), {len(dirs) - len(stale)} already on this page, "
              f"nothing written", file=sys.stderr)


if __name__ == "__main__":
    main()
