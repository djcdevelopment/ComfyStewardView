# Era 14 current-client capture on AM4

VERIFIED on 2026-09-09 UTC (September 8 local): the original Era 14 archive loaded
in Valheim **0.221.12**, Unity **6000.0.61f1**, and produced four native
**3840 x 2160** photographs. This was a direct load of an isolated save copy,
not a synthetic reconstruction. Derek observed the physical monitor and accepted
the appearance. Historical runtime parity was not required for this test.

AM4 used its NVIDIA RTX 5070, driver 595.84, and physical display `:0` at
3840 x 2160. Steam identified the logged-in persona as Zephar410. The loader was
BepInEx 5.4.23.3; its only active plugins were:

| Plugin | Bytes | SHA-256 |
| --- | ---: | --- |
| ComfyCameraProof 0.2.0 (SelfieStick) | 87552 | `5d16c4a1e8f70ef1f49103c58976607ace2d7a98d156edacc50e3aa988adc4c9` |
| BetterServerPortals 1.7.0, supplied by Derek | 15360 | `1bc8b1369899d8dee290806c4920b0f7051c8087a2c7d391070aaf1a9b592399` |

BetterServerPortals logged activation of its cached connection coroutine and
processed 14,092 portal objects. This verifies caching, not a claim of multithreaded
portal execution. NetworkSense and the quest add-ons were not loaded.

## Capture and terrain evidence

The game read **8,016,512 ZDOs** from the version-35 save. It generated the world
minimap in **4,753 ms**, using world-generator version 2. Three 2048 x 2048 caches
were written: map (232025 bytes), height (4158932 bytes), and forest mask
(449506 bytes). Their original PNG bytes were retained.

Capture run `20260909-034419` contains four Clear/0.64 orbit views of pilot build
`33c3b4a8e6994f060b893161facbdc22f5aa00f746b2949ab8ea5a823aefaa3f`.
Its exact archive membership has 7,123 construction objects. The capture's
`pieces_near_aim=8723` is a surrounding scene count, not a membership reconciliation.
Every shot reports `occluded=false`. The first PNG is 7190497 bytes, SHA-256
`07169db5732156bbb0ebfa17bca3d799a0b2280f737571734bd650ea9288c203`.

Current catalog matching covered 6,977 of 7,123 members. The remaining 146 had
unresolved names; this is not a measured missing-runtime-asset count. Appearance
was reviewed as a capture smoke test, not an exhaustive historical-fidelity audit.
The earlier blanket historical-runtime prerequisite was too restrictive. This
receipt proves the current-client route for this Era 14 sample; it does not certify
every era, prefab, or historical terrain height. The archive publication command's
older runtime-review gate is separate and was not used for this local test.

## Isolation and recovery

Operator artifacts on OMEN: `E:\omen\steward-multi-era\am4-smoke`, including
`photos`, `terrain-caches`, `capture-output.json`, `launch.json`,
`shotplan-receipts.jsonl`, `pilot-coverage.json`, and both game logs.
The output receipt pins byte counts, SHA-256 hashes and dimensions.

AM4 session: `/home/derek/valheim-capture/era14-smoke-20260909T0336Z`.
The complete pre-existing BepInEx tree, including quest plugins, configurations and
previous captures, is preserved under `backup/BepInEx`; all **1,094 files** were
hashed before relocation and verified afterward. A fresh loader/core and the two
listed plugins occupy `/home/derek/valheim/BepInEx`.

The first launch demonstrated that this client ignored `-savedir` for its menu
world list; it refused to load the missing world. The successful launch set
`XDG_CONFIG_HOME` to the session's `xdg` directory, whose Unity data path points at
the isolated `saves` directory. That directory contains only archive copies and a
copy of the Questyfour character. The original character was rehashed unchanged.
The missing Linux dependency `libpulse-mainloop-glib0` was installed to resolve
the PlayFab native-library dialog. No server or container restart was needed.

Valheim quit after the four shots, and the auto-boot request was moved out of the
active configuration. The capture-only mod setup remains installed. With Valheim
stopped, restore the prior quest setup using:

```sh
python3 /home/derek/valheim-capture/era14-smoke-20260909T0336Z/restore_remote.py
```

That script verifies the original backup hashes, preserves the current capture
setup under `capture-BepInEx`, then restores the original mod tree. It deletes
nothing. Original archive DB/FWL hashes remain those in the
[archive intake receipt](era-archive-2026-09-08.md).
