# AM4 capture resume and historical world staging

VERIFIED on 2026-09-09 UTC (September 8 local): Era 14 capture resumed after
Zephar410 became available again. Derek identified the earlier interruption as
the shared Steam account being used for gaming on OMEN. The retained first failed
launch ended during login; the next launch recorded Steamworks initialization
errors and was deliberately stopped. This was not evidence of a world-save or
historical runtime incompatibility.

Steam logged on successfully at 05:09:43 UTC. The resumed game identified
Zephar410 and loaded the same isolated Era 14 source using the current client.
BetterServerPortals activated and processed 14,092 portals. Capture run
`20260909-051400` began with 396 unfinished shots in the first batch. At
05:20:07 UTC, the journal contained 40 completed campaign photographs, including
the four retained from the earlier verification.
The new photographs passed the worker's 3840 x 2160 file checks; pixel review,
ranking and publication remain deferred.

The supervisor now counts failed attempts separately from launch directory
numbers. Operator pauses and disk-limit stops do not consume its two-failure
budget. Unrecorded/crashed attempts still count as failures. No attempt counters
or completed-shot records were reset. Steam must be running before launch.

## Deployed capture worker

- Source revision: `2b0635e8f5ecf0b8475029ad08edb39af601f7fb`.
- Worker: 16383 bytes, SHA-256
  `b6142a14febbb827ea7df4239d1c60fbd8bc9c6af37bf9dbbf69998682bdb736`.
- Unit: `steward-era14-capture.service`, invocation
  `ed887e2edf544e02865d3cd191b63765`.
- Campaign: `/home/derek/valheim-capture/era14-quiet-20260909`.
- Prior state, worker, deployment and stop request:
  `resume-20260909T0511Z/` beneath the campaign directory.
- New PNGs: `images/20260909-051400/` beneath the campaign directory.

The exact two-plugin capture configuration passed its runtime checks. The quest
mod backup remains at the location documented in the
[original capture receipt](era14-am4-current-client-capture-2026-09-08.md).
The game and worker run on AM4 independently of the SSH connection. Network use
was reauthorized, but the capture worker itself still performs no network work.

## Staging workflow

The separate transfer tool is pinned to pushed revision
`b6aeb9505d2308633e6a1c32bdfbee5b02988c92`. It compresses original DB/FWL pairs,
verifies transport SHA-256, then verifies decompressed byte counts and SHA-256
against the original archive catalog. A completed pair becomes a directory under
`/home/derek/valheim-capture/staged-worlds/<era>-<sourceKey>/`, with read-only source
files and a `receipt.json`. Game working saves are separate. Reruns verify and
skip existing pairs; unexpected archive members and mismatched data fail before
the pair is published as ready.

Operator evidence lives in `E:\omen\steward-multi-era\am4-resume-20260909`:
`worker-artifact.json`, `capture-validation.json`, and `transfers/` containing
progress, transport hashes and per-era receipts. This is a staging operation;
it does not switch the running world or certify another era's runtime assets.

VERIFIED staging checkpoint at 05:20 UTC: Era 7 (991526652 original bytes) and
Era 8 (1000337100 original bytes) were ready with both file hashes checked on AM4.
Era 9 was transferring; Eras 10, 11 and 12 remained queued. The transfer was left
running in the background (Windows Python worker PID 38736, launcher PID 38352),
with progress in `transfers/status.json`. Completion of all six transfers was
still pending at this checkpoint. The 4,000-photo campaign also remained running.

VERIFIED completion update: all six original DB/FWL pairs finished staging at
05:25:36 UTC, totaling 5545801854 bytes. Each pair has a verified receipt under
`/home/derek/valheim-capture/staged-worlds`. The subsequent
[spatial publication receipt](era-archive-spatial-publication-2026-09-08.md) records
their use in the viewer while photography continues.

Validation: all 17 archive, campaign and staging tests passed. The regression
checks cover deliberate pauses, crash accounting, original-pair preservation,
corrupt transport/source rejection, archive traversal rejection, and repeat
staging. `git diff --check` passed. Operational commands are in the
[capture runbook](../tools/era-archive/QUIET-CAPTURE.md).
