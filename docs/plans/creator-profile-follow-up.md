# Creator-profile follow-up plan

- Status: Active observation; implementation complete
- Updated: 2026-09-15
- Live release: `e15699254951-6e8c2f02792b`
- Source release commit: `e156992`

## Outcome already delivered

The creator archive now keeps identities independent from names, publishes substantial
profile credits without deleting small contributions from the archive, retains searchable
empty profiles, and bounds large pages through progressive disclosure. The live projection
contains 5,823 profiles, 56,237 qualifying albums and 16,111 photographs. Ibocain's 547
albums and the largest 2,929-album profile are the scale fixtures.

The profile order is:

1. identity and orientation;
2. global photograph carousel;
3. era guide, with the piece-range matrix folded;
4. compact Find and Order controls;
5. six-build guided shortlist, with a 50-row complete ledger on request;
6. five leading co-builder cards and a path into Kinship;
7. notes and onward paths.

The carousel remains global when an era, piece band, query, build deep link or historical
kinship link is active.

## Release invariants

Do not ship a creator-profile change unless all of these remain true:

- every previous `builderKey` remains searchable, including zero-album profiles;
- equal display names do not merge threads;
- qualifying-album counts equal the sum of the era inventory cells;
- the photo carousel renders on plain, `?build=` and `?kin=` profile URLs when photographs
  exist;
- initial build cards are at most six and the full ledger has no rows until requested;
- the complete ledger pages at 50 rows and exact build-key search finds older eras;
- the embedded co-builder introduction is bounded and full relationship work opens Kinship;
- a 390 px viewport has no horizontal overflow;
- presentation-only projections have identical thread and directory data to live;
- a changed threshold, era intake or capture set uses its dedicated semantic gate.

## Next observations

No immediate redesign is planned. Use real questions and the existing access logs to decide
whether another change earns its complexity.

- Watch whether visitors start from the carousel, era guide, Find, or Kinship and whether
  they can return to the photo tour without explanation from an operator.
- Collect reports for builders with many eras, one era, no qualifying albums, no
  photographs, and ambiguous names. Record the exact URL and viewport with each report.
- Check whether “your pieces” and “whole-build photographs” are understood. Change copy
  before adding another visualization.
- Review whether the mobile era select is used. It is the only intentional duplicate era
  control and can be removed if evidence shows the button grid is enough.
- Treat a request for another large table as a candidate for a dedicated route or download,
  not automatic expansion of the profile.

## Separate operational work

The refused/reshoot photography round in
[`HANDOFF-2026-09-13-second-pass.md`](../HANDOFF-2026-09-13-second-pass.md) remains the
next archive operation. It is independent of profile UX. Do not combine reshoot manifests,
keeper transfer, creator presentation and World deployment into one release.

## Release procedure

Use the real projection as the smoke fixture; do not construct a synthetic matrix before a
useful profile renders.

```powershell
python -m unittest discover -s tools/era-archive/tests -q
node --test tools/era-archive/tests/*.test.js

python tools/era-archive/gallery.py `
  --output-root E:\omen\steward-multi-era `
  --destination <new-immutable-projection> `
  --world-url https://am4.tail8e749c.ts.net/world/ `
  --min-build-pieces 20 --min-builder-pieces 20 `
  --portrait-library <portraits-manifest> `
  --retain-empty-from <current-projection>

python tools/era-archive/gate_creators.py --projection <new-immutable-projection>
node tools/era-archive/profile-ux-smoke.mjs <new-immutable-projection> <local-receipt-dir>

python tools/era-archive/deploy_gallery.py `
  --projection <new-immutable-projection> --revision <full-commit> `
  --receipt <deployment-receipt>

node tools/era-archive/browser-smoke.mjs `
  https://fx99.tail8e749c.ts.net/valheim/creators/ `
  https://am4.tail8e749c.ts.net/world/ <live-receipt-dir>
```

Commit from a clean isolated worktree before deployment. The live smoke receipt is the
terminal artifact; a screenshot or a successful atomic switch is not sufficient by itself.
