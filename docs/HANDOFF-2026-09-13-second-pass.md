# Handoff — second-pass era intake and compare-and-reshoot photography (2026-09-13)

For the next agent picking this up cold. Section 0.3 is the current state; later dated sections
are historical and must not be used as a live-status claim. Receipts are the ground truth if
this document and the lake ever disagree. The operator is Derek (pronouns unknown — use
they/them); the Steam account
`Zephar410` is shared between OMEN (their gaming PC) and AM4 (the capture host).

## 0.3 STATUS UPDATE 2026-09-16 02:05 UTC - BOUNDED CREATOR PROFILES LIVE

- **The systemic prolific-builder fix is live.** Creator release
  `e15699254951-6e8c2f02792b` serves 5,823 searchable identities, 56,237 qualifying albums
  and 16,111 photographs. The publication threshold is 20 measured saved pieces credited
  to that builder; unmeasured historical leading-contributor albums remain explicit legacy
  evidence. All 682 identities left with no qualifying albums remain searchable and show a
  truthful empty-profile message. The transition was proved by the dedicated contribution
  gate rather than an ad-hoc count comparison.
- **Large profiles now open with photographs, then guide exploration.** The global carousel
  remains first and unchanged by later filters. Era cards lead to a six-build guided mix of
  photographed highlights and substantial unphotographed work; the credited-piece matrix
  and complete 50-row ledger are opt-in. Find and Order are an adjacent compact toolbar,
  with the redundant desktop era selector removed and retained as a mobile shortcut.
  Kinship is a bounded five-card introduction whose full ledger lives on the Kinship page.
- **Ibocain is the scale fixture.** Their plain profile still exposes all 547 qualifying
  builds, 40 photographed builds and the photo carousel, but first paint renders six build
  choices and no full ledger. A direct link to Era 6 build `b90d3cdf…` focuses the exact
  record. The live smoke also verified a 2,929-build profile, a single-era profile, an empty
  profile, 390 px layout, the Kinship route and the World route.
- **Release evidence is durable.** Source release commit `e156992` was deployed from a clean
  isolated worktree; smoke-harness correction `a8ca539` makes browser evaluation failures
  explicit and aligns the bound with the intentional six-card guide. The deployment receipt
  is `E:\omen\steward-multi-era\receipts\deploy-creator-guide-e156992.json`; the passing
  live smoke is `validation\creator-guide-e156992-rerun5\receipt.json`. The data gate found
  zero changed, new or removed thread documents and identical directory data.
- **Next operational work is still the refused/reshoot round in §0.1.** Do not reopen the
  profile information architecture without observed user evidence. The current guardrails
  and follow-up questions are in `docs/plans/creator-profile-follow-up.md`; the design
  decisions are in `docs/adr/`.

## 0.2 HISTORICAL STATUS UPDATE 2026-09-15 06:56 UTC - ERA 17 WORLD LINK REPAIRED (superseded by §0.3)

- **Charon's Era 17 creator-to-World deep link is live.** The creator identity is
  `558504476a9953e58d01620fdaf9f616`; its build key is
  `a3ea156b92e9aa99d569889f64e29a3d1644ddd88a720df9880835e1057ff485`.
  The old Era 17 public cache had snapshot 107 and terrain, but no `build_membership` table,
  so the exact-build endpoint failed with HTTP 500. The archived Era 17 membership was at
  snapshot 1017. The source save SHA-256 was identical across snapshots, and all 4,359,570
  membership rows joined uniquely to the old public ZDO cache, including Charon's 4,555 pieces.
  The replacement remaps only membership snapshot 1017 to public snapshot 107; the existing
  schema-3 terrain manifest remains byte-identical. Validation rejects a wrong source snapshot,
  duplicate or incomplete membership, and an old-live-cache mismatch.
- **AM4 World release** `db83bf988120-replace-era17-8d15512a8a29` replaced only Era 17
  in a hard-link-cloned catalog. The candidate and active probes both confirmed the exact
  build and 4,555-piece scene before the swap completed; all 17 eras remain ready. The prior
  live container/release and the outgoing Era 17 files were retained. A first prepared
  release `727f76a07d47-replace-era17-cdf722d9dd59` stopped before candidate startup due a
  deployment-script variable collision; it was never live and remains for audit. The fix is
  ComfyStewardView commit `db83bf9881200486d99ba25ea958c1e7b5831368` (pushed).
- **User-facing smoke passed.** Charon's supplied Era 17 World link opened the exact selection,
  validated 3D and exported a PNG; Derek's supplied Era 15 build still opened 657 pieces,
  validated 3D and exported a PNG. The same browser smoke bootstrapped all 17 eras and checked
  their terrain/biome contracts. Package, deployment receipt, browser cases and browser smoke
  results live under `E:\omen\steward-multi-era\world-view-v3\era17-membership-20260915\`.
  The live API reports `ready`, this release, 17 ready eras, Charon 4,555 and Derek 657 pieces.
- **Next useful work remains the refused/reshoot round in §0.1.** This repair did not change
  the judged creator gallery, picker indexes, Chronicles counts, or any host masters/images.

## 0.1 HISTORICAL STATUS UPDATE 2026-09-15 05:47 UTC — FIRST-PASS JUDGED GALLERY LIVE (superseded by §0.2)

- **All eight first-pass light tables are complete.** Era 11 reshoot 33, Era 1 154, Era 2 315,
  Era 3 306, Era 5 363, Era 6 394, Era 13 230, Era 15 249: **2,044 complete human verdicts**
  and 1,026 decided pairs. Every run's `verdicts/pair-verdicts.json` was harvested with
  `--require-complete`; the cumulative evidence is
  `C:\work\baseline\docs\evidence\pair-verdicts-all.json`, commit `85385359` (pushed).
  Era 6's whole-page export suffix is `6c609cf51e89.json`, and its 394 rows were the last pass.
- **The judged import is complete for the seven new eras and Era 11 reshoot.** Each candidate
  under `campaigns/<era>/run/<root>/judged-candidate/` was built with *both* `--rank` and
  `--verdicts`: eight complete manifest judgements, zero unjudged builds, original rank
  no-survivor builds retained in the reshoot queue. The existing 18-manifest `run-manifest.json`
  was not rewritten; eight capture manifests and seven new-era picker indexes were backed up
  hash-identically under `judged-preview-20260915/live-backup/`, then promoted at their existing
  lake paths. The Era 11 picker index is a separate historical 689-frame index and was not
  replaced by the 18-frame reshoot manifest.
- **The public transition was gated before publish.** The isolated
  `judged-preview-20260915/projection/` uses the same 17 analysis receipts and 18 capture paths
  with eight judged substitutions. The strict eight-pair `diff_projection.py
  --capture-transition` gate verified exactly 1,988 changed builds and **3,756 removed photos**,
  with no unrelated public change; local creators/world browser smoke passed. The ordinary
  `gate_creators.py` no-content-change check predictably fails this intended photo transition,
  so use the manifest-pair gate for judged imports. A single full driver run,
  `runs/20260915T052855Z/run-receipt.json`, completed with 17 verified eras, 7,496 private
  builders, 16,111 captured photographs from 18 manifests, and zero stale-item removal.
  `Invoke-EraArchive.ps1 -SkipCleanup` now also skips analysis-backup pruning (commit `542bf67`).
- **Live site agrees with the judged manifests.** Creators release
  `542bf6743590-eeec135b9ba1` is live: 5,823 threads, 59,708 published albums, 16,111 public
  photographs, 17 eras. The seven new-era `/valheim/era<era>/index.json` files were atomically
  swapped after hash verification; their judged frame counts are Era 1 144, Era 2 338,
  Era 3 220, Era 5 432, Era 6 538, Era 13 174, Era 15 231. The outgoing picker indexes
  remain at `/srv/sites/valheim/.picker-releases/20260915-judged-first-pass/`. Every new
  selected photo ID was already published among the rank picks, so no derivative transfer or
  image deletion was needed. Chronicles release `20260915T054540Z-7551eb970934` is live with
  the same 5,823/16,111/17 counts; live front-door smoke passed 15/15. The search panel now
  cancels its pending debounce when Escape dismisses it, and `deploy.py --no-prune` kept *all*
  older immutable releases (commit `0b0057b`). Deployment receipts are
  `judged-preview-20260915/deploy-creators.json` and
  `judged-preview-20260915/deploy-chronicles-escape-fix.json`.
- **Next useful work is the refused/reshoot round, not another full-era light table.** Exact
  per-root lists and reason maps are the `judged-candidate/rejects-<era>.json` files. Across
  eight roots there are **563 builds**: 91 original rank no-survivors, 445 `neither`, and
  27 single-frame `reshoot` verdicts. Counts by root are Era 1 39, Era 2 82, Era 3 160,
  Era 5 70, Era 6 59, Era 13 79, Era 15 64, Era 11 reshoot 10. Replan short batches
  by era, shoot only these builds, then judge the new frames against the existing first-pass
  keeper or refusal. Keeper-master shuttling is also still pending: the eight judged
  `worklist-<era>.json` selectors match their host `state.json` source paths and SHA-256s,
  selecting 2,095 masters / 21.89 GiB and omitting 6,424 completed losers. The slow host-to-OMEN
  link makes this a separately budgeted, resumable transfer; do not start it as incidental
  cleanup. All host master images and older webp derivatives are retained;
  **nothing under `<root>/images/` was deleted**.

## 0. HISTORICAL STATUS UPDATE 2026-09-15 05:00 UTC (superseded by §0.1)

- **Era 17 is repaired and live.** The missing save was outside the canonical intake root,
  not overwritten by Era 4's different Charon identity. Hash-identical copies now live under
  `E:\omen\gallery\valheim\ComfyEra17_20260822\`; driver receipt
  `runs\20260915T012402Z\run-receipt.json` verifies all 17 eras. Creator release
  `fdfd76dc59dc-d54b59fa7e9d` and Chronicles release
  `20260915T014500Z-8b2f4aca84e7` are live. Era 17 Charon is
  `558504476a9953e58d01620fdaf9f616` (22 public albums); Era 4 Charon remains the separate
  `dfec5cb...` identity. The single-era intake exception is commit `fdfd76d`.
- **The light table now works locally.** It stores each part under a deterministic page key,
  autosaves to localStorage, exports/imports a fingerprinted JSON envelope, and harvests with
  `--require-complete`; no Artifact DB is involved. Baseline commits are `66503516` (local
  workflow), `5b76e0b7` (safe multipart cumulative append plus explicit `merge`), and
  `5d971fe9` (standards-mode sizing) and `f1edee91` (a fixed viewport dock for single-frame
  controls). Era 5 and Era 6 now use one whole-era page each rather than split parts. Both
  `light-table\light-table.html` pages were regenerated with the docked-footer fix, verified
  against the exact part-build unions, and served from the lake.
- **Human verdicts so far:** Era 11 reshoot is complete at 33/33 (5 earlier, 15 replanned,
  3 both, 10 neither). Era 1 is complete at 154/154 across two hash-bound part receipts
  (52 first survivor, 45 second survivor, 22 both, 32 neither, 3 keep-single). The merged
  receipt is `campaigns\era1\run\era1-fx99-20260913b\verdicts\pair-verdicts.json`.
  Era 13 is also complete at 230/230 (69 first survivor, 68 second survivor, 17 both,
  73 neither, 3 keep-single), with its two part hashes bound by the merged receipt under
  `campaigns\era13\run\era13-20260913b\verdicts\`.
  Era 15 is complete at 249/249 (72 first survivor, 77 second survivor, 40 both,
  56 neither, 2 keep-single, 2 reshoot-single) with all three part hashes bound by
  `campaigns\era15\run\era15-20260913b\verdicts\pair-verdicts.json`.
  Era 3 is complete at 306/306 (56 first survivor, 57 second survivor, 52 both,
  127 neither, 3 keep-single, 11 reshoot-single), with all three part hashes bound by
  `campaigns\era3\run\era3-fx99-20260913\verdicts\pair-verdicts.json`.
  Era 2 is complete at 315/315 (65 first survivor, 95 second survivor, 89 both,
  59 neither, 7 reshoot-single), with all three part hashes bound by
  `campaigns\era2\run\era2-fx99-20260913\verdicts\pair-verdicts.json`.
  Era 5 is complete at 363/363 (102 first survivor, 83 second survivor, 123 both,
  51 neither, 1 keep-single, 3 reshoot-single). Its single whole-era receipt is
  `campaigns\era5\run\era5-20260913\verdicts\pair-verdicts.json`. Cumulative evidence
  commit `93cf696d` contains 1,650 verdicts / 861 decided pairs across seven runs.
  Exports and receipts live under each `<run>\verdicts\` directory.
- **The judged transition was proved on real data without touching live state.** The isolated
  Era 11 candidate is under
  `campaigns\era11-reshoot\run\era11-reshoot-20260913\judged-candidate\`: 18 current-root
  keeper frames, 10 human-refused builds, 33 judged and zero unjudged. Against the live
  projection, `diff_projection.py --capture-transition` verified exactly 33 changed builds and
  80 photograph removals, with no unrelated public change. Its keeper shuttle dry run selected
  exactly 18 masters and omitted 136 completed losers; it transferred and deleted nothing.
- **Safety tooling is pushed.** Comfy commits `550cc61` and `8ba8579` add the manifest-pair
  transition gate, verdict-receipt hash/membership/completeness checks, rank no-survivor
  preservation, keeper-only shuttling, and receipt-first exact-path loser pruning. The full
  archive suite is 229 passed / 4 skipped. `prune_capture_losers.py` defaults to a candidate
  receipt and cannot execute until every keeper is present locally and SHA-verified by an exact
  matching relocation receipt.

Next: judge Era 6 (394 items; whole-page export suffix `6c609cf51e89.json`) at
`campaigns\era6\run\era6-20260913\light-table\light-table.html`. Harvest its single whole-era
export against `ab-pairs.json` with `--require-complete`; no part merge is needed. Complete
the first-pass verdicts before replacing any live rank-pick manifest. A judged import must pass
**both** `--rank`
and `--verdicts`, so original rank no-survivor builds remain on the reshoot list. No master
transfer, remote prune, judged manifest replacement, or judged gallery deploy has happened yet.

## 1. Where things are

| Thing | Where |
|---|---|
| Source repo (parser, lab, era-archive tools) | `C:\work\ComfyStewardView`, branch **`era-intake-second-pass`** (pushed to `origin`; commits `ad17071`, `48718b7`, plus whatever follows) |
| Photography tools (planner, judge, light table, subject gate) | `C:\work\baseline\tools\selfie-stick\`, branch **`photo-compare-and-reshoot`** (pushed) |
| Harvest pointer only | `C:\work\deepagents-shot-director`, branch `harvest-pointer` (local only — no remote configured) |
| The lake (all receipts, packages, campaigns) | `E:\omen\steward-multi-era` (not a repo; 1.2 TB free) |
| Original saves (read-only inputs) | `E:\omen\gallery\valheim\ComfyEra*\` |
| AM4 (Linux capture/terrain host, RTX 5070, 24 cores, ~190 GB free) | `ssh am4.tail8e749c.ts.net`; game `/home/derek/valheim` (**Valheim l-1.0.7**, build 25185596); work under `/home/derek/valheim-capture/` |
| World server (public 3D/terrain view) | AM4 docker `steward-world` on 7081 → https://am4.tail8e749c.ts.net/world/ |
| Creators site + photo galleries | fx99 (`/srv/sites/valheim`), deployed by `deploy_gallery.py` / `publish_captures.py` |
| Session memory for Claude | `C:\Users\derek\.claude\projects\E--omen-steward-multi-era\memory\` (read `MEMORY.md`) |
| Plan file of this pass | `C:\Users\derek\.claude\plans\e-omen-gallery-valheim-i-was-just-jazzy-wigderson.md` |
| Receipt doc of this pass | `docs/era-intake-second-pass-2026-09-13.md` (this repo) |

Run tests before and after any change:
```
cd C:\work\ComfyStewardView\tools\era-archive && python -m pytest tests -q      # 199 pass, 4 skip
cd C:\work\baseline && python -m pytest tests\test_selfie_stick.py -q           # 94 pass
```
Java (only if `viewer/` or `lab/` Java changes): `JAVA_HOME=C:\work\ComfyStewardView\.tools\jdk-17.0.19+10`,
`.tools\apache-maven-3.9.6\bin\mvn.cmd -f viewer\pom.xml package` (vendored; nothing on PATH).

## 2. What is DONE (verified, receipted)

- **All 16 eras are in the archive.** Eras 1–6 (world formats 26–28), 13, 15 arrived 2026-09-12
  and were ingested; the catalog (`E:\omen\steward-multi-era\catalog.json`) has 16 `verified`
  entries, snapshot IDs 1001–1016. `intake-report.json` shows 0 rejects. Parser jar
  `35447e3d…` is the accepted lineage (`catalog.parsers`), proven row-identical to the old jar
  on eras 7 and 16 by `archive.py parser-check`.
- **Cross-era projection rebuilt once, correctly.** `runs/20260913T042116Z/run-receipt.json`:
  7,360 builders, 597,100 builds, **14,016 photographs from 10 capture manifests** (the count the
  live creators site shows). `run-manifest.json` is the ONLY source of cross-era flags now;
  the driver `tools\era-archive\Invoke-EraArchive.ps1` reads it and fails the run if the
  projection imported fewer manifests than named. Never hand-run `community.py` without all ten.
- **Terrain for all 8 new eras**: generated on AM4 (`/home/derek/valheim-capture/terrain-20260913/`),
  imported to `E:\omen\steward-multi-era\am4-terrain-cache-20260913\<era>\`, contexts built at
  `world-view-v3\terrain-schema3-20260913-am4\<era>\`. Eras 1/2/3/5/6 are world-generator 1
  (pre-Mistlands terrain kept by the game). Era 4 loaded its caches but the client refused the
  world afterwards (see §6).
- **World view deployed**: 8 era packages under `world-view-v3\era-deltas\`, deployed at
  revision `ad17071` (`world-view-v3\receipts\<era>-ad17071dae62.json`); the server lists 17
  eras, all with terrain and scene; browser smoke passed (`world-view-v3\browser-live\eras-ad17071\`).
- **Converted-world cross-checks** for eras 7/10/12/14 (`converted-worlds\<era>\check.json`):
  the parser never under-reads the game (era 7 lost 0.107 % of pieces in the game's own
  conversion, the others ≤ 7 pieces). The old parked `Valheim.terrain-*` dirs on C: were deleted
  after harvest (18.7 GB freed).
- **Eight capture campaigns prepared** under `E:\omen\steward-multi-era\campaigns\<era>\`
  (`refine\campaign.json` is what runs on AM4; `prepare-receipt.json` per era). Plus
  `campaigns\era11-reshoot\` (the 33 builds the light table refused on 09-12, replanned).
- **The era-11 reshoot has been SHOT** (AM4 root `era11-reshoot-20260913`): 33 builds, 154 poses,
  `rank-era11.json` kept 98 frames, all 33 builds reach the light table as pairs, derivatives made.
  Nothing has been judged or published from it yet.

## 3. What is RUNNING right now (started 2026-09-13 07:47 UTC) — NOTHING as of 2026-09-14 01:15 UTC: every chain below completed; see §4.0

AM4 user unit **`steward-overnight-20260913`** runs `/home/derek/valheim-capture/overnight-20260913.sh`:
`era13-20260913b` (236 builds / 949 poses) then `era15-20260913b` (255 / 1,020). Per root:
`refine_worker.py --builds 9999` (feed mode, fan off) → `rank_frames.py --keep 3` →
`make_derivatives.py` on the keepers only. ~10 s per pose; expected complete ~13:30 UTC.
A failure stops the chain (`set -e`); nothing retries. Check:
```
ssh am4.tail8e749c.ts.net 'cat ~/valheim-capture/overnight-20260913.log; cat ~/valheim-capture/era13-20260913b/status.json; systemctl --user is-active steward-overnight-20260913'
```
"chain complete" in the log = both eras shot, ranked, derivatives encoded. If it failed, read
`<root>/worker-run.log` and the tail of `<root>/refine-journal.jsonl`; a `timeout` event names a
pose the client never finished. The earlier root `era13-20260913` (no `b`) is a stopped first
attempt (145 shots, killed after an outland build wedged the client) — keep it, don't reuse it.

**fx99 (second capture host, added 2026-09-13 ~12:00 UTC)** user unit **`steward-fx99-overnight`**
runs `/home/derek/valheim-capture/fx99-overnight.sh`: `era1-fx99-20260913b` (161 builds / 645
poses) → `era2-fx99-20260913` (331 / 1,334) → `era3-fx99-20260913` (328 / 1,298); same per-root
shape (`~/venvs/judge` CPU torch, `--threads 4`, nice 5, `HF_HUB_OFFLINE=1`). The script stops
**ollama** for the run and restores it in an EXIT trap, and does `sudo chvt 3` first (see §6).
Smoke gate passed 12:12Z: 10 builds / 50 poses, median 10.2 s, no timeouts, no swap growth,
creators site 200 throughout (`era1-fx99-20260913-smoke`, keep). Check:
```
ssh fx99.tail8e749c.ts.net '~/valheim-capture/smoke-status.sh era2-fx99-20260913 steward-fx99-overnight; cat ~/valheim-capture/fx99-overnight.log'
```
fx99's client is Steam build **25253764 = Valheim 1.0.12 (n-40)** on Derek's second account
(`durracktu`) — a third instrument beside OMEN 1.0.12 and AM4 l-1.0.7; every root's
`runtime.json` records it. Provisioning receipt + verified-launch proof:
`E:\omen\steward-multi-era\fx99-setup-20260913\{receipt.json, launch-fx99-plugins.json}`;
staged worlds `E:\omen\steward-multi-era\fx99-staging-20260913\`.

Masters (10 MB 4K PNGs) stay on the host that shot them (AM4 or fx99) under `<root>/images/<run>/`. Only `derivatives/large`
and `derivatives/thumb` webps need to travel. Do not shuttle masters until verdicts exist.

## 4. NEXT STEPS, in order (the compare-and-reshoot loop)

### 4.0 STATUS 2026-09-14 20:10 UTC — the live gallery is on RANK PICKS, pending Derek's verdicts

Every era the plan assigned has been shot, ranked and **published with the machine's picks**
(Derek's decision 2026-09-14: publish now, judge later). Steps 1 and 6 below are DONE for all
eight roots; steps 2–5 (the light table) are NOT — nothing on the live site has been judged by
the eye yet. What is live:

- Capture manifests `captures/<era>/captures-<era>.json` (+ `captures-era11-reshoot.json`) for
  eras 1, 2, 3, 5, 6, 13, 15 — built with the new `import_captures.py --rank <run>/rank-<era>.json`
  (commit `74dfa05`): every rank_frames keeper publishes best-first, each photo carries a `rank`
  block, the manifest says `"ranked": true, "judged": false`. 2,044 albums, 5,851 photographs.
- Derivatives on fx99 `/srv/sites/valheim/<era>/{large,thumb}/` (`publication-<era>.json` receipts);
  masters still on AM4 / fx99 under `<root>/images/` (~90 GB) — NOT shuttled.
- `run-manifest.json` lists 18 capture manifests; driver run `runs/20260914T193524Z/` (19,867
  photographs, 4,827 builds with photos, no failures).
- Creators projection `projections/20260914-rank-picks` (5,734 threads, 55,805 albums), smoke
  `projections/smoke-20260914-rank-picks`, deployed as release `74dfa053a3d4-c5a15ddc269d`
  (`projections/deploy-20260914-rank-picks.json`); chronicles release `20260914T195137Z-f6625418aaba`.
- The `/valheim/` picker galleries for the seven new eras: `captures/<era>/index-<era>.json` from
  the new `gallery_index_from_captures.py index --archive-root E:\omen\steward-multi-era ...`
  (legacy facets — kind of place, landmarks, 2 km areas, region — derived from the community
  analysis + package, so the Filters panel works like era 17's), viewer page + `eras.json` pushed
  to every era dir (old `eras.json` retained in `/srv/sites/valheim/.picker-releases/20260914/`).
  Re-run it for an era after any re-import (step 3 below) and push `index.json` again.
- Light tables are BUILT and chunked, not yet published: `campaigns/<era>/run/<root>/light-table-parts/`
  (22 parts of ≤120 pairs, each ≤241 files / ≤45 MB — the artifact limits are 255 files and 64 MB per
  publish); `parts.json` in each lists them. Era 11's uses `light-table-derivatives/` (old + new frames).

**What to do later (the verdict pass), in order:**
1. Publish each part as an Artifact with `capabilities: {db: {}}` (load the `artifact-capabilities`
   skill first), page `light-table.html` + its `files.json` map as supporting files. Derek judges
   part by part (~16 min per 120 pairs; ~4.5 h in total across 2,044 pairs + 42 singles).
2. Harvest per part: `read_db` collection `verdicts` (`out_dir` a folder), then
   `light_table.py harvest --pairs <part pairs file> --verdicts <folder> --out <run>/pair-verdicts.part-NN.json
   --append C:\work\baseline\docs\evidence\pair-verdicts-all.json --judged-by "Derek Ciula, <date>"`;
   merge the parts' `verdicts` lists into one `<run>/pair-verdicts.json` per era (same header).
3. Re-import with the eye's picks: `import_captures.py --root <run> --base .../valheim/<era>/
   --verdicts <run>/pair-verdicts.json --out captures/<era>/captures-<era>.json` (same path → the
   manifest flips to `judged: true`; unjudged builds publish nothing, so judge a whole era before
   re-importing it). Rebuild that era's `index-<era>.json` with `gallery_index_from_captures.py`.
4. `publish_captures.py` again for that era (only adds/removes changed derivatives), push the
   index, then ONE driver run + `gallery.py` + gate/diff (expect photo counts to FALL — that is the
   eye pruning, check `removed` is only judged builds) + smoke + `deploy_gallery.py` + chronicles.
5. Reshoot list = rank `reshoot` builds (era1 7, era2 16, era3 22, era5 16, era6 18, era13 6, era15 6)
   plus every `neither`/`reshoot` verdict → replan (next-ranked poses) → short sessions per §5 → back
   to step 1 for those builds only.
6. Shuttle keeper masters once (`shuttle_masters.py`, batches, sha-verified) after verdicts, then
   prune the losers on the hosts. Until then do not delete anything under `<root>/images/`.

(Applies to every finished root on **either host** — AM4 roots `~/valheim-capture/<era>-20260913b`, fx99 roots `~/valheim-capture/<era>-fx99-20260913[b]`; the ssh target is the only difference.)

1. **Pull results to OMEN** for each finished root (`era11-reshoot-20260913`, `era13-20260913b`,
   `era15-20260913b`): `rank-<era>.json`, `refine.json`, `state.json`, `derivatives/large/*.webp`
   → `E:\omen\steward-multi-era\campaigns\<era>\run\` (scp; use `MSYS_NO_PATHCONV=1` and
   drive-letter local paths in Git Bash).
2. **Build the light-table pairs** (`C:\work\baseline\tools\selfie-stick\light_table.py`):
   - era 11 reshoot: `light_table.py build-pairs --rank <run>/rank-era11.json --against C:\work\baseline\docs\evidence\2026-09-12-refine-loop-calibration\ab-pairs.json --run era11-reshoot-20260913 --out <run>/ab-pairs.json` (roles: earlier planned frame vs replanned).
   - era 13 / 15: `build-pairs --rank <run>/rank-<era>.json --out <run>/ab-pairs.json` (top-2 survivors as a pair; single survivors as keep/reshoot).
   - `light_table.py page --pairs <run>/ab-pairs.json --derivatives <run>/derivatives --out <run>/light-table` → `light-table.html` + `pub/` + `files.json`.
3. **Publish the page as an Artifact** with the `db` capability (load the `artifact-capabilities`
   skill first) and the `files.json` map as supporting files, so Derek's picks are stored under
   `verdicts/<build>`. Keys: ←/→ pick a side, ↑ both, ↓ neither; single frames ↑ keep / ↓ reshoot.
   Derek judges ~8 s/pair. The 77-pair round trip of this tool reproduces the committed verdicts.
4. **Harvest**: read the artifact DB (`read_db`, collection `verdicts`, `out_dir` to a folder) then
   `light_table.py harvest --pairs <run>/ab-pairs.json --verdicts <folder> --out <run>/pair-verdicts.json --append C:\work\baseline\docs\evidence\pair-verdicts-all.json --judged-by "Derek Ciula, <date>"`.
5. **Reshoot the refused**: builds judged `neither`/`reshoot` → replan (next mass / typology
   alternate — `plan_detail_shots.py` already emits five poses; feed the next-ranked ones) → a
   short refine session on AM4 → light table again. Prepare roots exactly like §5.
6. **Publish keepers**: `import_captures.py --root <run> --base https://fx99.tail8e749c.ts.net/valheim/<era>/ --verdicts <run>/pair-verdicts.json --rejects ... --worklist ... --cameras ...`
   → shuttle the keeper masters once (`shuttle_masters.py`) → `publish_captures.py` → **append the
   new `captures-<era>.json` to `run-manifest.json`** → run the driver
   (`Invoke-EraArchive.ps1 -InputRoot E:\omen\gallery\valheim -OutputRoot E:\omen\steward-multi-era`)
   → `gallery.py` projection → `gate_creators.py` → `diff_projection.py` → `browser-smoke.mjs`
   → `deploy_gallery.py` → `tools\chronicles\build.py` + `deploy.py`. Each once.
7. **Remaining eras** (1, 2, 3, 5, 6; era 4 blocked — §6): campaigns are prepared. To run one:
   see §5. Consider re-running `prepare_campaign.py` first so the outland rule applies (era 1–6
   were prepared before it existed; era 13/15 `b` roots have it).

## 5. How to run a capture root on AM4 (what worked tonight)

```
# on OMEN: push the campaign and the scripts (Git Bash; note MSYS_NO_PATHCONV and C:/ paths)
R=/home/derek/valheim-capture/<era>-<stamp>
ssh am4.tail8e749c.ts.net "mkdir -p $R"
MSYS_NO_PATHCONV=1 scp E:/omen/steward-multi-era/campaigns/<era>/refine/campaign.json E:/omen/steward-multi-era/campaigns/<era>/refine/all-shots.tsv am4.tail8e749c.ts.net:$R/
MSYS_NO_PATHCONV=1 scp C:/work/ComfyStewardView/tools/era-archive/{refine_worker,capture_worker,install_capture_worker,rank_frames,make_derivatives}.py C:/work/baseline/tools/selfie-stick/frame_judge.py am4.tail8e749c.ts.net:$R/
# on AM4
cp ~/valheim-capture/era11-requests-r5/{frame_geometry,master_detail}.py $R/
python3 $R/install_capture_worker.py --root $R --game /home/derek/valheim \
  --source-db ~/valheim-capture/staged-worlds/<era>-<sourceKey>/<worldId>.db --source-fwl .../<worldId>.fwl \
  --character-file ~/valheim-capture/era11-requests-r5/source/questyfour-seed.fch \
  --terrain-root ~/valheim-capture/terrain-20260913/<era>/caches \
  --verified-launch ~/valheim-capture/launch-1.0-plugins.json \
  --prefs ~/valheim-capture/era11-requests-r5/source/prefs
# run (Steam must be logged in interactively first — Derek does that at the keyboard)
export XDG_RUNTIME_DIR=/run/user/$(id -u); export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
systemd-run --user --unit=steward-<era>-<stamp> --setenv=DISPLAY=:0 --property=Restart=no --property=KillMode=mixed --property=TimeoutStopSec=150 \
  /home/derek/venvs/torch-xpu/bin/python $R/refine_worker.py --root $R --builds 9999 --threads 8 --idle-seconds 900
# then
python3 $R/rank_frames.py --root $R --keep 3
python3 $R/make_derivatives.py --root $R --worklist $R/derivatives-<era>-keepers.json --jobs 8
```
Staged worlds for all 16 eras are already on AM4 (`staged-worlds/<era>-<sourceKey>/`); `worldId`
is `Booty` for era 1 and `comfy` for era 2 (the catalog's `worldId`), `ComfyEraN` otherwise.
A root is single-use (`runtime.json` freezes it); make a new directory for a rerun. **Never
delete an attempt directory**; rename it with the reason (`runs/<x>-failed-<why>`).

## 6. Known problems and open items

- **Era 4 cannot be photographed** by any 1.0.x client: the game converts it and then throws
  `EndOfStreamException` in `Inventory.LoadOld` (one malformed item string in one container),
  bounces to the menu. The archive is fine (parser + payload identity check passed). Fix = find
  the container (needs the game's exact `Inventory.LoadOld` layout; the `items` strings are in
  `payloads/era4/.../zdo_payload.parquet`), blank it in a *derived* working copy, stage that
  copy under a different name for the game only. Never touch the original.
- **Both hosts are on Valheim 1.0.x** (AM4 l-1.0.7 since 09-11, OMEN 1.0.12). Every photo
  published before 09-13 was 0.221.12. Recorded per receipt (`gameBuild`, `loadCensus`); nothing
  hides it. On AM4 `-batchmode` segfaults under Vulkan — launch fullscreen 3840×2160 (the
  capture worker's way). The 1.0 client renames the original `.db/.fwl` to `_backup_*` on quit
  and writes a chunked `worlds_local/<world>/_main.1.db2` — no monolithic rewrite to cross-check.
- **Outland builds** (radius > 10.5 km) wedge the client (210 s per pose, then nothing). The
  subject gate now rejects them (`docs/evidence/2026-09-13-subject-gate-calibration/thresholds.json`
  in baseline); campaigns for eras 1–6 were prepared before that rule — re-run
  `prepare_campaign.py` for an era before dispatching it.
- **The subject gate is weak by design**: two physically stated rules (bare floor, debris) plus
  outland. The fitted-threshold attempt was rejected (it threw away single-storey houses).
  Recalibrate with `subject_gate.py calibrate` once light-table verdicts on coverage-queue
  builds exist.
- **AM4 refine worker timeouts**: one timed-out pose is now a vetoed pose; two consecutive stop
  the run (the client is wedged). If a run stops that way, `pkill -KILL -x valheim.x86_64`, then
  `systemctl --user reset-failed <unit>` before restarting anything, and clear
  `~/valheim/BepInEx/config/shotplan-feed/` (`STOP`, `*.tsv`, `*.done`).
- **fx99 specifics**: Xorg `:0` is headless (virtual DP-0, 3840×2160) on VT 3 with `-novtswitch`;
  if any other VT is in the foreground X is "switched away" and GL crawls at ~1 FPS with nothing
  presented. `fleet-dash.service` used to `chvt 2` on start (line commented out 2026-09-13,
  backup `fleet-dash.service.bak-20260913`); the chain script re-asserts `chvt 3` anyway. No
  monitor is attached or needed: Steam login goes over `ssh -L 5900:localhost:5900
  fx99.tail8e749c.ts.net` + TigerVNC to `localhost:5900` (x11vnc is localhost-only,
  `fx99-x11vnc.service`); `xdotool` is installed for moving windows into the viewer's corner.
  The Steam client must stay logged in (`~/.local/share/Steam/logs/connection_log.txt` says
  `Logged On`). ollama pins 4.7 GiB of the 8 GiB VRAM — never run a capture with it up. Roots
  are single-use here too (`runs/refine-attempt-01` is hard-coded): a second launch on the same
  root fails with `FileExistsError` — make a `b` root (`scripts/*.py` + the campaign pair +
  `install_capture_worker.py`). Judge is ~2.8 s/frame on this CPU (AM4 0.8 s).
- **Not scoped, worth doing**: prune `community-tables/` hashes not referenced by
  `analysis/read-model.json` (~1.1 GB); decide whether `omen-capture-era8` (11 GB) and
  `omen-capture-era11` (5 GB) raw OMEN masters at the lake root move under `captures/`;
  add a remote for `deepagents-shot-director` and push `harvest-pointer`.
- `deploy_world_era.py` refuses a dirty tree: commit before any world deploy (`--revision` must
  equal `HEAD`). `deploy_gallery.py` is run only on explicit request.

## 7. Decisions Derek made (don't relitigate)

- Photography instrument: **AM4 only**; OMEN stays free for gaming. (The "0.221.12 on AM4"
  premise died on 09-13 — it's 1.0.7 — but the host choice stands.)
- **Compare-and-reshoot from now on, no brute-force campaigns, no refine fan.** Evidence:
  `C:\work\baseline\docs\evidence\2026-09-12-refine-loop-calibration\` — keeping the planned
  pose beat the fan 25:18; the judge's `score()` is anti-correlated with the eye (42 %).
  `frame_judge.replay_pairs` pins 25/43 as the bar any ranker must beat.
- Shoot ~5 planned poses per build; **shutter time is not the bind — 4K volume, network and
  storage are**. Prune on AM4 (`rank_frames.py`: veto → duplicates → forecast → sky/luma; a
  pruner, not a picker), ship thumbnails only, move keeper masters once. "Go slow to go fast."
- Derek's `Neither` breakdown: ~60 % subjects not worth a photo, ~30 % framing, ~10 % blatant.
- Cleanup of parked dirs / Chrome profiles / stale duckdb / `.bak` was approved and done.

## 8. Tooling gotchas on this PC

- The Bash tool's heredocs collapse `\\` to `\`: never patch files with backslashes via an
  inline heredoc — use Edit/Write or a script file. PowerShell 5.1 rules are in the repo
  `CLAUDE.md` (no `&&`, never `2>&1` a native exe, check `$LASTEXITCODE`).
- Git Bash rewrites `/home/derek/...` in ssh/scp args: `MSYS_NO_PATHCONV=1`, and then local
  script paths must be `C:/...` not `/c/...`.
- Steam on AM4 must be logged in *interactively* (Derek at the keyboard) before a game launch;
  a second game session on the shared account evicts the first — never launch on AM4 while
  `valheim.exe` runs on OMEN (`tasklist //FI "IMAGENAME eq valheim.exe"`).
- Transient systemd units keep their name after failing: `systemctl --user reset-failed <unit>`.
- The 440 MB `analysis/community-private.json` takes ~10 s to load; don't load it twice.
