# AM4 disk recovery, 2026-09-11

AM4, the capture node, was at 95 % (21 GB free on a 394 G root volume) and `capture_worker`
stops a campaign below 20 GiB free. The survey found that the pressure was not the capture
masters. Receipts for every step are in `E:\omen\steward-multi-era\am4-space-20260911\`
(`00-before.txt` … `99-after-*.txt`); offloaded files are in `E:\omen\am4-offload\`.

## What was found

| Item | Size | Fact |
|---|---|---|
| Unallocated LVM extents | 62.7 GB | The 462.7 G partition carried a 400 G logical volume (installer default). |
| `~/baseline/models/*.gguf` | 52.7 GB | Three June models on a box with no inference engine since 2026-08-20. |
| World-save copies under `runs/<attempt>/xdg/…/worlds_local/` | 47.8 GB at 09:40 UTC | Duplicates of `source/` worlds left by attempts that stopped before the supervisor's own cleanup. |
| `~/steward/publish`, `~/.cache/uv`, `~/chatgpt_parser_run/venv` | 27.4 GB | Aug-22 world-cache staging (unmounted), package cache, an old venv. |
| `~/ComfyUI/output`, `~/omen-preswap/*.tgz` | 7.4 GB | Generated images and the OMEN pre-swap backup: moved to OMEN, not deleted. |
| Docker | 16.6 GB cache, 7 unique `pre-*` images | 12 `legacy-*` tags all pointed at `:local`; 7 `pre-*` tags were distinct images. |
| Masters (eras 7, 9, 10) | 39 GB | **Left on AM4** by decision; `shuttle_masters.py` moves them later. |

## What was done (all times UTC)

| Step | Action | `df` free after |
|---|---|---|
| — | survey (09:40) | 22.0 GB, 95 % |
| 0 | before-snapshot (17:59). By then 49 GB of the world copies in the quiet campaigns had already been removed outside this plan (their `worlds_local` dirs are dated 17:59; no receipt found). | 71.4 GB, 83 % |
| 1 | `lvextend -y -l +100%FREE -r` online; ext4 grew to 462.7 G (`df` size 455 G), still clean | 134.0 GB, 72 % |
| 2 | three GGUFs hashed into `models/REMOVED-20260911.json`, then deleted | 186.7 GB, 61 % |
| 3a–c | `steward/publish` (no mount, no symlink, no open fd), `uv cache clean` (9.5 GiB), parser venv | 211.9 GB, 55 % |
| 5 | 12 `legacy-*` tags untagged, 7 `pre-*` images removed without `-f`, `docker builder prune -f` (3.6 GB); running image and 12 containers unchanged | 215.6 GB, 54 % |
| 4 | `prune_run_worlds.py` over era 7/9/10/14 quiet + era-14 smoke: 3 files, 3.29 GB (the smoke's `saves/`); the quiet campaigns reported 0, see step 0 | 218.9 GB, 54 % |
| 3d–e | `omen-preswap-20260819.tgz` (1.8 GB) then `ComfyUI/output` (4,269 PNGs, 5.6 GB) pulled to OMEN over wifi, verified by sha256 before the AM4 copy goes; unattended, hours at ~220 kB/s | +7.4 GB when done |

Untouched by design: the `era11-detail-*` campaigns (another session captured on
`era11-detail-v4-smoke-1.0` throughout), `steward-world` (the live viewer, 8 eras served
before and after), `comfy-valheim-lab`, `.config/unity3d`, `venvs/torch-xpu`, `valheim/`, every
attempt directory and log, `source/`, `staged-worlds/`, the masters.

## Left on the table

`era12-quiet` smoke xdg (0.95 GB), `terrain-cache-20260909` (0.9 GB), 16 `steward-world:*`
release images (16 GB reclaimable per `docker system df`, rollback evidence), 788 MB of
exited containers, the ext4 reserve (`tune2fs -m 1` ≈ 17 GB), and the 39 GB of masters. The
volume group now has zero free extents, so there is no room for an LVM snapshot until
something else shrinks.

## The masters, when they move

`shuttle_masters.py` with `--dest E:\omen\steward-multi-era\captures\<era>` (the journal's
`file` values already start with `images/`), `--state` from the campaign's `state.json`;
era 10 first needs its AM4 journal (994 entries) intersected with OMEN's 1,270-entry journal
so the loop never asks AM4 for a frame only OMEN has. At today's link that is 37–80 hours
of batches; on a cable it is minutes. `enp5s0` has no carrier.
