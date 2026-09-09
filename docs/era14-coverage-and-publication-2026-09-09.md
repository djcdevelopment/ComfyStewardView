# Era 14: coverage, publication, and a frozen client, 2026-09-09

Era 14 is the first of seven eras. The question driving today was which subjects the
default camera should spend hardware on, and the answer turned out to be much smaller
than the queue — and beside the point, because the photographs had nowhere to go.

## The queue was aimed at the wrong number

`analysis/jobs.json` holds **234,927 photography jobs**, one per attributed build, about
2,480 hours of capture. The objective those jobs encode is builder coverage, and coverage
saturates long before the queue does.

- All 5,228 builder-era pairs across the seven eras are reachable in **~2,300 subjects**.
- Era 14's own 642 builders needed **289**, out of 36,817 queued.
- When the campaign was stopped it had already covered **622 of 642 (97%)** from 496
  builds. Its remaining 182 subjects added no builder at all.

So 180 of those were retired — 720 shots, roughly two hours and 5.8 GB — keeping the 2
that still added coverage. The other 18 uncovered builders need builds that were never in
the 1,000-subject campaign: 9 subjects, 36 shots, six minutes, planned but not yet shot.

Era 14 finished at **2,148 photographs of 523 builds**.

`plan_coverage.py` now does this selection from the Parquet read model in **4 seconds for
all seven eras**: 1,933 subjects, 7,732 shots, 21.9 h. It independently reproduced the
9-subject era-14 figure that had been derived from the 367 MB private document.

| era | builders | subjects | shots | in-world |
|---|---|---|---|---|
| 7 | 827 | 383 | 1,532 | 98% |
| 8 | 827 | 342 | 1,368 | 99% |
| 9 | 701 | 296 | 1,184 | 96% |
| 10 | 836 | 319 | 1,276 | 91% |
| 11 | 724 | 301 | 1,204 | 91% |
| 12 | 671 | 283 | 1,132 | 90% |
| 14 | 642 | 9 | 36 | — |

## Selection is deliberately crude

Ranking builds by how well they photograph does not work, and this is measured rather
than assumed: across 268 builds with three or more scored frames, height correlates
−0.189 with frame quality, the ranking score −0.136, prefab variety −0.128, pieces
−0.034, footprint and portals ≈ 0. Within-build spread (0.246) is 85% of between-build
spread (0.288); `frames_whole_build=false` frames score *higher* (5.681 vs 5.582).

Two coarse rules do carry signal and are the only ones applied beyond coverage: exclude
repeated stamped builds, and prefer in-world over outland, where a subject past the
10.5 km world edge has no terrain under it — Era 17's fourteen sky platforms median 4.774
against a gallery median of 5.472.

## The photographs had no route to anyone

`community.py` wrote `"photos": []` on every modern build, and the only code that ever
appended a photograph was `import_legacy`, serving era16/17. The creators site went live
this morning with **2,430 of its 2,747 builder threads reading "0 photos"**. The same gap
blinded the planner, which decides who is covered by reading `build["photos"]`.

`import_captures.py` reads a campaign's own journal and emits a manifest keyed by real
`buildKey`; `community.py` now attaches it. Era 14 produced **523 albums, 2,089
photographs, 0 unresolved builds** — every key resolved to an album that already existed,
with exact membership and every contributor, which the legacy path cannot do.

Effect on the site: builder threads carrying photographs go from **317 to 784**.

## Derivatives, and a slow link

`make_derivatives.py` encodes on the capture host: **2,096 masters to 4,192 webp, 303 MB,
zero failures, two minutes** on AM4's 24 cores. Sizes match
`build_valheim_index.py` — 1600 px at quality 80, 512 px thumbs at 82 — so the aesthetic
bench can score these against the 4,536 frames it has already scored.

That matters because **AM4 is on a slow link**. Measured today: 83 ms average RTT to OMEN
with 226 ms spikes, 75 ms to fx99, against 3 ms OMEN→fx99, and sustained throughput of
**129 KB/s**. An 18 GB master transfer is a five-hour job; 303 MB of derivatives is forty
minutes. Masters stay on the capture host. Getting AM4 onto wired ethernet is worth doing
before six more eras produce ~60 GB.

## Both clients frozen

Valheim's update shipped today. Both hosts ran buildid `21981559` with
`AutoUpdateBehavior "0"`.

**OMEN was live**: `StateFlags 6` (installed *plus update required*), `TargetBuildID
25185596`, 3,368,616,258 bytes queued, 0 downloaded, and `ScheduledAutoUpdate` set for
**2026-09-09T16:45:31Z**. AM4 still read `StateFlags 4` and had not yet seen it.

Both are now `AutoUpdateBehavior "1"` with the schedule cleared, verified to survive a
Steam restart, with the prior manifests kept as `appmanifest_892970.acf.pre-freeze-20260909`.
An update would have failed `capture_worker.check_runtime`'s hash check on
`valheim.x86_64`, `UnityPlayer.so` and the assembly DLLs, and taken the current-client
route — the only proven route for these historical worlds — with it.

One gap remains: `Invoke-OrbitCapture.ps1:164` launches through `steam.exe -applaunch`,
which still triggers an update at launch. AM4 avoids this by running the binary directly.
The OMEN runner needs the same before it captures.

## Not done

- The 18 uncovered era-14 builders (9 subjects).
- Eras 7–12 have no observed compatibility evidence on the current client. All six are
  staged and hash-verified on AM4 at `/home/derek/valheim-capture/staged-worlds/`.
- The template fix in `community.py` is inert until analyses are recomputed:
  `analyze_era` returns cached receipts, so `jobs.json` still carries one job per stamped
  copy. `plan_coverage.py` does not depend on it — it excludes templates itself.
- LAION scoring of the new frames, deferred while OMEN's CPU is committed.
