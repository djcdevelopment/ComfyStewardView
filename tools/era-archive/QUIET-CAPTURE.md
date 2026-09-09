# Quiet capture on AM4

Prepare shot lists before gaming on OMEN. During the campaign, AM4 owns game
execution, PNG storage, receipts, recovery and status. The worker has no network
operations, image decoding, scoring, thumbnail generation or publication. Do not
download photographs, terrain caches or full logs until Derek explicitly finishes
gaming. Optional remote observation reads only `status.json`, at most hourly.

`campaign.py` selects 1,000 eligible, unphotographed builds from the existing
coverage queue. It checks source/snapshot membership, excludes investigation
candidates and completed four-view pilots, and computes four Clear/0.64 exterior
views from each build's exact XYZ membership. Local dispatch IDs are campaign-scoped;
the manifest retains source, snapshot, build and membership identities.

The initial campaign is Era 14 only, using the current-client route verified in the
[AM4 capture receipt](../../docs/era14-am4-current-client-capture-2026-09-08.md).
This local capture queue does not use the publication command's older historical
runtime gate. Other eras need their own observed compatibility evidence.

`install_capture_worker.py` accepts explicit paths to already-local original world
backups, the character, terrain caches and the verified launch receipt. It freezes
copies with byte/SHA-256 verification. No world transfer or package installation is
needed on AM4. `capture_worker.py` requires only Python's standard library and Linux.

Each 100-build batch starts with fresh local world and character copies beneath an
isolated `XDG_CONFIG_HOME`. The installed game client ignores `-savedir` for menu
selection, so the worker uses the verified XDG arrangement. Plugins and engine files
are checked against the installation receipt before every launch. Only SelfieStick
and BetterServerPortals are admitted. The operator's previous quest-mod tree stays
in its verified backup outside the active loader tree.

Each completed PNG is checked locally for its PNG boundaries and 3840 x 2160
dimensions, copied and hash-checked into the campaign's `images` directory, and
journaled before the duplicate is removed from the temporary capture location.
Partial final receipt lines and incomplete images do not count. A restart recovers
completed writes and schedules only unfinished angles, preserving dispatch IDs.
Visual quality and attribution review remain deferred.

The supervisor allows two failed launches per batch. Operator pauses and disk
limit stops do not consume that budget; attempt directory numbers always increase
so prior evidence remains intact. A missing result counts as failure. Steam must
be running before launch, and its account must remain available throughout capture.
Fifteen minutes without a new
completed photograph triggers a controlled stop of its own game process; the game
gets 120 seconds to exit before that specific child is killed. Repeated failure
stops the campaign. Reaching 32 GiB of PNG output or falling below 20 GiB free space
also stops it. No captures are deleted to make room. Successful runs retain PNGs,
receipts and logs; only their disposable save copies are removed.

## The installed Era 14 campaign

Root: `/home/derek/valheim-capture/era14-quiet-20260909`.
The `source` directory contains verified original copies recovered locally from
the successful smoke session's `.old` files. The full queue is 1,000 builds and
4,000 photographs; the additional one-build verification counts toward this queue.

Local state: `state.json`; small remote-readable summary: `status.json`;
one-build verification: `smoke-result.json`; raw photographs: `images/<run>/`;
dispatch and runtime receipts: `runs/<batch-attempt>/`. Nothing under this root is
a public web directory.

Service commands on AM4:

```sh
# Stop cleanly; completed photographs remain available for resume.
systemctl --user stop steward-era14-capture.service

# A persistent local stop request is also supported.
touch /home/derek/valheim-capture/era14-quiet-20260909/STOP

# Read only this small summary while OMEN is being used for gaming.
cat /home/derek/valheim-capture/era14-quiet-20260909/status.json
```

To resume after deliberately clearing a stop request, launch the same worker and
root using a new user systemd unit with `Restart=no`, `KillMode=mixed`, and
`TimeoutStopSec=150`. The unit is transient, so it no longer exists once it has
stopped and `systemctl --user start` returns exit 5; re-issue `systemd-run`. Over a
non-interactive SSH the user manager also needs its socket named explicitly.

**Set `DISPLAY` explicitly on every unit.** A transient unit inherits nothing from
your shell, and Valheim, Steam and openbox all need an X display. This is invisible
until the machine reboots: before a reboot these units are usually started from a
session that already exports `DISPLAY`, so they work; afterwards they do not, and
the failure does not name the cause. Steam logs `Unable to open X11 display,
exiting` and is gone about two seconds later, openbox dies the same way (leaving a
black screen with a cursor, which looks like a broken desktop-sharing session), and
the capture worker then reports the misleading `Steam must be running before
capture starts`. X itself is fine throughout -- check with `pgrep -a -f Xorg` and
`DISPLAY=:0 xdpyinfo`, which needs no `XAUTHORITY` on this host.

```sh
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus

# Support services first, in this order, each with DISPLAY.
systemd-run --user --unit=steward-capture-openbox --setenv=DISPLAY=:0 \
  --property=Restart=no /usr/bin/openbox
systemd-run --user --unit=steward-capture-steam --setenv=DISPLAY=:0 \
  --property=Restart=no /usr/games/steam

# Then the worker, once Steam is not merely running but LOGGED IN (see below).
systemd-run --user --unit=steward-era14-capture --setenv=DISPLAY=:0 \
  --property=Restart=no \
  --property=KillMode=mixed --property=TimeoutStopSec=150 \
  /usr/bin/python3 /home/derek/valheim-capture/era14-quiet-20260909/capture_worker.py \
  --root /home/derek/valheim-capture/era14-quiet-20260909
```

**Wait for Steam to finish logging in, not just to appear in `pgrep`.** The worker's
precondition only checks that the process exists, so starting it too early launches
Valheim into `[S_API FAIL] SteamAPI_Init() failed; connect to global user failed`.
The game stays up and the campaign reports `capturing` while capturing nothing.
Confirm the login landed before starting the worker:

```sh
tail -3 /home/derek/.local/share/Steam/logs/connection_log.txt   # want "Logged On"
```

`SteamAPI_Init(): ... OK` with no following `[S_API FAIL]` in the attempt's
`stdout.log` is the positive signal that the race was avoided.

The persistent state prevents completed shots from being
repeated. Exhausted retries require investigation, not automatic reset.

**Never delete an attempt directory to clear a failure.** `state.json` records
`activeAttempt`, and on restart the worker reads that attempt's `dispatch.json` to
recover the last completed writes; removing the directory turns a recoverable stop
into `FileNotFoundError: .../dispatch.json` on every subsequent start. If a
campaign that has captured nothing must be reset, clear the bookkeeping instead,
and refuse to do it once any shot is completed:

```sh
python3 - <<'PY'
import json, pathlib
p = pathlib.Path('state.json'); s = json.loads(p.read_text(encoding='utf-8-sig'))
assert not s.get('completed'), 'refusing to reset a campaign that has captured shots'
s['activeAttempt'] = None; s['attempts'] = {}
p.write_text(json.dumps(s, indent=2), encoding='utf-8')
PY
```

After stopping the service and confirming Valheim is closed, restore the prior
quest setup with the preserved script:

```sh
python3 /home/derek/valheim-capture/era14-smoke-20260909T0336Z/restore_remote.py
```

The restoration script keeps the capture-only loader setup as well. Campaign
photographs remain outside the mod tree. Do not restore mods while the supervisor
is running.

Validation: the archive test suite exercises queue order and exclusions,
source/snapshot isolation, four-view completion, unfinished-angle recovery,
truncated PNGs, local durable harvesting, retry limits, disk boundaries and stalls.
The installed service must pass a one-build four-PNG metadata check before the
remaining batches are launched.

VERIFIED deployment on 2026-09-09 UTC: the one-build service passed at 04:16:41
with four matching 3840 x 2160 PNGs stored on AM4 and the game stopped. The full
`steward-era14-capture.service` was then started independently of SSH. Its first
100-build batch resumes with the verification build already complete. No images,
terrain caches or detailed logs were downloaded during this verification.
The initial compressed plan/worker transfer was 344214 bytes, followed by a
15522-byte worker update. Deployed worker SHA-256:
`67d17346cc4bd66bb626ccfb4930444f93acd23708f32ca97ef127d6b07c69d9`,
from pushed revision `cdd6b218bb5452f99bf09ed35dbc548d7146f628`.
This proves installation and startup, not completion of the 4,000-shot campaign.

## Retiring subjects from a running campaign

A world that hands every player an identical plot produces hundreds of copies of one
building under hundreds of different owners, and coverage ranking puts each of them near
the front of the queue. `find_template_builds.py` groups a frozen campaign's subjects by
the SHA-256 of their `(prefab_hash, count)` histogram and writes a retire list;
`retire_builds.py` applies it on AM4. Footprint is not enough to judge by — Era 14's
88 x 88 cohort shares a lot size and holds 25 different buildings.

Stop the campaign first and wait for `state: stopped`; the tool refuses a running one, a
`campaign.json` that no longer matches `runtime.json`, and a list from another snapshot.
A retired build keeps its entry with an empty `shots` array, so batch names stay aligned
with the attempt directories already on disk. Journal rows for deleted photographs move
to `retired.json` with sha256 and receipt intact before any file is unlinked, and
`runtime.json` is re-stamped last. `prune-receipt.json` records the whole operation.

```sh
python3 retire_builds.py --root <campaign root> --retire-file retire-<era>.json \
    --reason '...' --delete-captured --dry-run
```

The 2026-09-09 Era 14 application is recorded in
[the template retirement receipt](../../docs/era14-template-retirement-2026-09-09.md).

## Stage additional worlds when network use is authorized

`stage_worlds.py` takes an explicit catalog, era list, SSH target, remote root,
local output directory and pushed tool revision. It compresses each original pair,
checks the transport hash, then checks both decompressed files against the archive
catalog on AM4. Only a verified pair becomes a ready directory; source files are
read-only. A rerun verifies and skips existing pairs. Game saves and capture control
files are never transfer targets. The transfer runs independently of the capture
worker and writes progress and per-era receipts in the local output directory.

```powershell
python tools/era-archive/stage_worlds.py `
  --catalog <archive-root>/catalog.json --eras era7 era8 era9 era10 era11 era12 `
  --ssh-target <am4-ssh-alias> `
  --remote-root /home/derek/valheim-capture/staged-worlds `
  --output <transfer-receipt-directory> --revision <pushed-40-character-commit>
```

Staging does not switch the running world or establish compatibility for another
era. Its first capture still needs to be observed before starting that era's queue.

The [September 8 resume receipt](../../docs/am4-capture-resume-2026-09-08.md)
records the subsequent Steam-session recovery, updated worker, new 4K captures
and historical-world transfer checkpoint.
