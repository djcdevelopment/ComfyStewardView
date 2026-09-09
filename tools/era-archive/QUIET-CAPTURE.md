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
`TimeoutStopSec=150`. The persistent state prevents completed shots from being
repeated. Exhausted retries require investigation, not automatic reset.

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
