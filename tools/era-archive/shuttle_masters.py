#!/usr/bin/env python3
"""Move finished capture masters off the capture host a batch at a time.

The capture host's link is slow -- measured 130-290 KB/s, with 83 ms RTT to OMEN and
75 ms to the web host -- so an 18 GB master set is a multi-hour transfer that cannot be
done in one window. But the host also needs free space for the next era, and `disk_stop`
halts a campaign when free space falls below `minFreeBytes`. So: move a batch, verify it,
delete that batch, repeat. Every batch that lands is space the running campaign can spend.

Verification is the campaign's own journal. `state.json` already records a sha256 for
every harvested photograph, so a file leaves the host only after the copy on this side
hashes to what the journal says it should. Nothing is trusted to the transfer.

Note the consequence: once masters are moved, re-running the capture worker against that
campaign root fails its startup integrity check, because `Worker.__init__` re-verifies
every completed photograph. That is correct -- the files really did move -- so a marker
is left on the host saying so, and relocation is for finished campaigns only.

Usage:
  MSYS_NO_PATHCONV=1 python shuttle_masters.py --state <state.json> --dest <dir>
      --remote-root <path> [--ssh-target homebase] [--batch 50] [--stop-after N]
      [--dry-run]
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import tarfile
import time

HEREDOC = "STEWARD_EOF"
RM = "xargs -d '\\n' rm -f --"
FREE = "df --output=avail -B1 /home | tail -1"

# Left on the capture host so its worker can explain a missing master instead of dying on
# a raw FileNotFoundError that reads like a failed capture.
MARKER_FILE = ".masters-relocated.json"
MARKER = ("cat > " + MARKER_FILE + " <<'STEWARD_MARKER'\n"
          + json.dumps({
              "schema": "steward-masters-relocated/v1",
              "note": ("masters were moved off this host; the copies and their sha256s are "
                       "in relocation.json at the destination. A relocated campaign cannot "
                       "be resumed, only re-planned.")})
          + "\nSTEWARD_MARKER")

# Git for Windows rewrites POSIX-looking arguments into Windows paths before a native
# binary parses them, so "-C /home/derek/..." reached the remote tar as
# "C:/Program Files/Git/home/...". These switches are a belt; the braces are that every
# remote command travels on stdin rather than in argv. Callers still need
# MSYS_NO_PATHCONV=1 so --remote-root survives the shell that launches python.
ENV = {**os.environ, "MSYS2_ARG_CONV_EXCL": "*", "MSYS_NO_PATHCONV": "1"}


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def sha256(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def parse_args():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--state", type=Path, required=True,
                   help="a local copy of the campaign's state.json -- the manifest")
    p.add_argument("--dest", type=Path, required=True)
    p.add_argument("--remote-root", required=True, help="campaign root on the capture host")
    p.add_argument("--ssh-target", default="homebase")
    p.add_argument("--batch", type=int, default=50)
    p.add_argument("--stop-after", type=int, default=0,
                   help="stop after this many batches (0 = until everything has moved)")
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args()


def pending(entries, dest):
    """Files not yet sitting locally at the right size. Hashing everything on every pass
    would cost more than the transfer does; the per-batch check below is the real gate."""
    return [(name, entry) for name, entry in entries
            if not ((dest / name).exists()
                    and (dest / name).stat().st_size == entry["metadata"]["bytes"])]


def script_with_list(root, command, names, tail=""):
    """A shell script whose file list arrives as a heredoc, not as arguments."""
    lines = ["set -e", "cd " + shlex.quote(root), command + " <<'" + HEREDOC + "'"]
    lines.extend(names)
    lines.append(HEREDOC)
    if tail:
        lines.append(tail)
    return "\n".join(lines) + "\n"


def remote_script(target, script, sink=None):
    """Run a script on the capture host with nothing but 'bash -s' in argv."""
    command = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", target, "bash -s"]
    process = subprocess.Popen(command, stdin=subprocess.PIPE,
                               stdout=(sink or subprocess.PIPE),
                               stderr=subprocess.PIPE, env=ENV)
    out, errors = process.communicate(script.encode())
    return process.returncode, out, errors.decode(errors="replace")


def release(target, root, names):
    """Delete masters on the host and report the free space that bought."""
    code, out, errors = remote_script(target, script_with_list(
        root, RM, names, tail=MARKER + "\n" + FREE))
    if code:
        return None, errors.strip()[:200]
    return int(out.decode(errors="replace").strip().splitlines()[-1]), None


def fetch(target, remote_root, names, dest):
    """One tar stream per batch: a per-file scp would pay the 83 ms handshake 50 times.

    Unpacked with Python's tarfile rather than the tar binary, for the same reason the
    command travels on stdin -- no path is ever handed to an external program.
    """
    bundle = dest / ".incoming.tar"
    try:
        with bundle.open("wb") as sink:
            code, _, errors = remote_script(
                target, script_with_list(remote_root, "tar -cf - -T -", names), sink=sink)
        if code:
            print("  remote tar failed: " + errors.strip()[:200])
            return False
        with tarfile.open(bundle) as tar:
            for member in tar.getmembers():
                if (not member.isfile() or member.name.startswith("/")
                        or ".." in Path(member.name).parts):
                    print("  refusing unsafe member: " + member.name)
                    return False
            # filter="data" strips ownership and permission metadata and refuses anything
            # outside the destination; this becomes the default in Python 3.14.
            tar.extractall(dest, filter="data")
        return True
    finally:
        bundle.unlink(missing_ok=True)


def record(receipt, receipt_path, verified):
    size = sum(e["metadata"]["bytes"] for _, e in verified)
    receipt["moved"].extend({"file": n, "sha256": e["sha256"],
                             "bytes": e["metadata"]["bytes"]} for n, e in verified)
    receipt["bytes"] += size
    receipt["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    write(receipt_path, receipt)
    return size


def main():
    args = parse_args()
    dest = args.dest.resolve()
    dest.mkdir(parents=True, exist_ok=True)
    state = read(args.state)
    entries = sorted(((v["file"], v) for v in state["completed"].values()), key=lambda x: x[0])
    print(f"{len(entries):,} masters in the journal", flush=True)

    receipt_path = dest / "relocation.json"
    receipt = read(receipt_path) if receipt_path.exists() else {
        "schema": "steward-master-relocation/v1", "sourceKey": state["sourceKey"],
        "remoteRoot": args.remote_root, "moved": [], "bytes": 0}
    moved = {m["file"] for m in receipt["moved"]}
    todo = [e for e in pending(entries, dest) if e[0] not in moved]
    already = [e for e in entries if e[0] not in moved and e not in todo]
    print(f"{len(todo):,} still to fetch, {len(already):,} already here from an earlier "
          f"transfer", flush=True)
    if args.dry_run:
        print(f"dry run: would free {len(already):,} without transferring, "
              f"then move {len(todo):,}")
        return

    # A file some earlier attempt copied is space the host is still paying for, and the
    # size check above skips it forever: never fetched, so never deleted. Verify the local
    # copy against the journal and release the remote one -- no bytes move.
    if already:
        freed = [(n, e) for n, e in already
                 if (dest / n).exists() and sha256(dest / n) == e["sha256"]]
        if freed:
            free, error = release(args.ssh_target, args.remote_root, [n for n, _ in freed])
            if error:
                print("  reconcile delete failed: " + error)
            else:
                size = record(receipt, receipt_path, freed)
                print(f"  reconciled {len(freed):,} already-copied master(s), freed "
                      f"{size/1e9:.2f} GB without transferring; host free {free/1e9:.1f} GB",
                      flush=True)

    batches = 0
    while todo:
        if args.stop_after and batches >= args.stop_after:
            print(f"stopping after {batches} batch(es) as asked")
            break
        chunk = todo[: args.batch]
        started = time.monotonic()
        if not fetch(args.ssh_target, args.remote_root, [n for n, _ in chunk], dest):
            print("transfer failed; the host is untouched")
            break

        verified, failed = [], []
        for name, entry in chunk:
            local = dest / name
            if not local.exists():
                failed.append(name)
            elif sha256(local) != entry["sha256"]:
                failed.append(name)
                local.unlink(missing_ok=True)
            else:
                verified.append((name, entry))
        if failed:
            print(f"  {len(failed)} file(s) failed verification, kept on the host; "
                  f"first {failed[0]}")
        if not verified:
            print("nothing verified in this batch; stopping rather than looping")
            break

        free, error = release(args.ssh_target, args.remote_root, [n for n, _ in verified])
        if error:
            print("  remote delete failed: " + error)
            break
        size = record(receipt, receipt_path, verified)

        batches += 1
        elapsed = time.monotonic() - started
        todo = todo[len(chunk):]
        print(f"  batch {batches}: {len(verified)} moved, {size/1e6:.0f} MB in "
              f"{elapsed:.0f}s ({size/elapsed/1e3:.0f} KB/s); "
              f"host free {free/1e9:.1f} GB; {len(todo):,} left", flush=True)

    print(f"relocated {len(receipt['moved']):,} masters, {receipt['bytes']/1e9:.2f} GB total")
    print(receipt_path)


if __name__ == "__main__":
    main()
