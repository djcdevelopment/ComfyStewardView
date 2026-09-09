# Era 14 capture: retiring the stamped lots, 2026-09-09

Derek, watching the run, said the last dozen-plus photographs were all near-identical
square platforms floating in sky with a black marble roof, and guessed they were "sky
farms" — plots handed to every player away from the main world. He was right, and the
repetition was larger than it looked from the screen.

## What was in the queue

Campaign subjects **655 through 700 and beyond were an unbroken run of one footprint**:
46 × 29 m, 20.6 m tall, and 1,629 pieces — the same piece count for 238 of the 239
members of that cohort. Every sampled member returned the same prefab histogram. They
are one stamped lot copy-pasted across the outland at 18–26 km radius; beyond the
10.5 km world edge Valheim generates no terrain, which is why each reads as a platform
in open sky. At four orbit angles apiece that cohort alone was 952 photographs of the
same walls, and the longest unbroken stretch still ahead was 70 subjects.

Footprint alone could not have made the call. Era 14's 88 × 88 cohort shares a lot size
and holds **25 different buildings**, as do 93 × 94, 151 × 106, 74 × 73, 146 × 74 and
89 × 88. Those stayed in the queue. Identity here is the multiset of prefabs a build is
made of: two builds with the same histogram are the same building.

| copies | pieces | photographs if kept | first subject |
|---|---|---|---|
| 238 | 1,629 | 952 | #491 |
| 18 | 2,459 | 72 | #750 |
| 10 | 1,723 | 40 | #938 |
| 10 | 1,992 | 40 | #134 |
| 8 | 562 | 32 | #962 |
| 6 | 1,688 | 24 | #424 |
| 6 | 2,714 | 24 | #430 |

## Why the queue was full of them

`community.py` ranks photography by greedy builder-era coverage: every player earns a
first photograph before anyone earns a second. Each stamped lot has a different owner,
so each copy scored a fresh coverage point and floated to the top of `jobs.json`. The
template class was never modelled, so 238 copies of one building entered as 238 subjects.

## A second problem the measurement turned up

At the measured 379 shots/h and 8.11 MB/shot the campaign **could not have finished**.
It held 8.7 GB of headroom before `minFreeBytes` (20 GiB) and needed 10.6 GB, so it
would have stopped itself on `disk-reserve` around subject ~940. Cutting the templates
resolves this as a side effect rather than by raising a limit.

## What was done

| | before | after |
|---|---|---|
| `targetShots` | 4,000 | 2,816 |
| `completedShots` | 2,778 | 1,960 |
| still to photograph | 1,305 | 856 |
| `freeBytes` | 29.63 GB | 33.73 GB |
| `campaign.json` sha256 | `985dc353…` | `16ff64b7…` |

- **12:33:49Z** — `STOP` honoured at 2,778 shots, `reason: operator-stop`, game exited.
  `failed_attempts` does not charge an operator stop against the retry budget.
- **12:36:10Z** — 296 subjects retired across the seven families: 1,184 planned
  photographs removed, of which 314 were unshot and **818 already captured and deleted**,
  freeing 5,202,093,556 bytes. 52 captured photographs were kept — the six smaller
  families keep an exemplar; the 238-copy family keeps none, by decision.
- **12:37:12Z** — supervisor restarted. `batch-0007` came up with a target of **180
  shots instead of 400**, the rest of that chunk having been retired.

A build is retired by **emptying its `shots` array, never by removing its entry**.
Batches are index chunks of `plan['builds']` and `attempt()` creates
`runs/<batch>-attempt-NN` with `exist_ok=False`, so dropping entries would slide a batch
name onto a different build set while `state['attempts']` and the existing attempt
directories still describe the old one, and the next launch would collide on `mkdir`.
Emptying keeps every position, and `unfinished()` drops the build anyway.

## Verification

- Newest dispatch: 45 builds / 180 shots, **0 retired buildKeys present**.
- Images on disk **1,960** — exactly equal to journal entries, so no orphan files and no
  journal row pointing at a deleted photograph.
- `campaign.json` still holds all 1,000 entries, 704 of them with shots, and records 296
  `retiredBuildKeys`.
- `retired.json`: 296 builds and 818 photograph records, each retaining its sha256 and
  capture receipt, so what was photographed stays provable after the file is gone.
- The supervisor started at all, which is what proves the `runtime.json` re-stamp and the
  journal integrity loop over the reduced `completed` set both pass.
- Projected: 856 shots ≈ 2.3 h, needing ~6.9 GB against ~12.2 GB of headroom.

## Code

- `tools/era-archive/find_template_builds.py` — derives the families from a frozen
  campaign and the verified Parquet; writes a retire list, changes nothing.
- `tools/era-archive/retire_builds.py` — applies one on the capture host. Standard
  library only, refuses a running campaign, a mismatched `runtime.json`, or a list from
  another snapshot; journals before it deletes and re-stamps the digest last.
- `tools/era-archive/community.py` — builds now carry `templateKey` and `templateCopies`,
  and the greedy loop emits a photography job for the first copy only, marking the rest
  `duplicateOfBuildKey`. The check sits **before** `covered.add`, so a skipped owner stays
  uncovered and a distinct build of theirs is still worth queueing.

`templateKey` is keyed on `prefab_hash`, not the resolved name: an era with a dictionary
gap reports several distinct prefabs under one null name, and grouping on that would
merge genuinely different buildings into a single identity. The retirement applied here
was first derived name-keyed; re-deriving it hash-keyed returned the identical 296
subjects and the identical 238-member deletion set, so the applied cut holds under the
stricter predicate. The copy of `retire_builds.py` on AM4 was resynced with the repository
after the run; the difference was the `fcntl` import site and a lock refactor for
testability, with no behavioural change.

Tests: `tests/test_retire_builds.py` (7 cases) and one case in `tests/test_archive.py`.
Full suite 33 passed.

## Left open

- The six same-footprint, different-building families — 67 remaining subjects — stay in
  the queue on the evidence. They are still outland and will still float against sky.
  Four sample frames from an already-captured 88 × 88 subject would settle whether they
  are worth the film; that needs the no-downloads-while-gaming rule lifted
  (`QUIET-CAPTURE.md`).
- No backfill was taken. The campaign now delivers 704 subjects rather than 1,000. The
  eligible unqueued pool holds 386 in-world builds of ≥400 pieces, the largest 7,123
  pieces, if a follow-on campaign is wanted.
