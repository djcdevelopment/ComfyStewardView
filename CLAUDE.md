# ComfyStewardView — working notes for agents

## Disk discipline (read before you copy anything)

Every artifact in this project is enormous and there are already ~37 copies of the same world
save across this machine totalling ~47 GB. On 2026-08-08 three abandoned agent scratchpads held
28.3 GB and drove `C:` to 1.1 GB free — low enough that the nightly publish, which pulls a 1.24 GB
world into `%LOCALAPPDATA%\steward-publish`, was about to fail on space rather than on anything
real.

Reference sizes:

| Thing | Size |
|---|---|
| `ComfyEra16.db` (any copy) | 1.27 GB |
| Analytics cache for one snapshot | ~1.2 GB |
| Live publish cache (`steward-publish\out`) | ~10 GB |
| Shaded jar | 89 MB |
| Parquet archive, per snapshot | ~113 MB |

Rules:

- **Never copy a world save to work on it.** Point the tool at the original with `--cache`
  somewhere scratch. The parser opens the `.db` read-only.
- **Build scratch caches on `D:`, not `C:`.** `C:` carries the publish workdir and the fieldlab
  server installs; `D:` is where corpus work belongs.
- **Delete a scratch cache the moment you are done with it.** Nothing prunes agent scratchpads,
  so anything left behind is left behind permanently.
- **Prefer the Parquet archive over the live cache.** `%LOCALAPPDATA%\steward-publish\archive` is
  the history of record — ~113 MB per snapshot, lossless, and queryable in place. The 10 GB live
  cache is *rebuilt from it* on every publish, so it is regenerable, not precious.
- Run `tools\Clear-StewardScratch.ps1` (dry run) to see what has accumulated; `-Delete` to prune.
  It reports large caches outside the scratch root but never deletes those.

There is a small `Era16.db` (0.3 MB) at
`C:\work\baseline\fieldlab\autonomous\state\server\config\worlds_local\Era16.db`. Use it as the
boot world for anything that does not need real data — `Main` parses the world synchronously
before the HTTP port opens, so a 1.3 GB boot world costs minutes on every restart.

## Iterating on the UI

`viewer/src/main/resources/static/index.html` is the entire frontend: one file, no build step,
Alpine + Leaflet + Tailwind from CDN.

It is served from `--static-dir` when that points at a real directory, falling back to the copy
baked into the jar. So:

- **Locally**: `.\Start-Viewer.ps1 -SkipBuild` serves it straight from the working copy against the
  real publish cache. Edit, refresh, done — no rebuild, no restart.
- **On AM4**: `.\tools\Push-StewardUi.ps1` ships it in ~2 seconds and verifies by hashing what the
  server actually returns. No image rebuild, no container restart, no world re-parse.
- Only run `.\tools\Deploy-Steward.ps1` when **Java** changed. That one rebuilds the image on AM4
  and restarts the container, which re-parses the 1.3 GB world before the port reopens.

Do not "fix" a failed UI push by restarting the container — avoiding the restart is the entire
point of that path.

## Build

No Java or Maven on PATH. Both are vendored:

- JDK: `.tools\jdk-17.0.19+10`
- Maven: `.tools\apache-maven-3.9.6\bin\mvn.cmd`

Set `JAVA_HOME` to the vendored JDK before invoking Maven.

`viewer/target` is gitignored. It used to be tracked, which meant every branch that compiled
conflicted with every other one in `.class` files and three 89 MB jars — that, and nothing else,
is what blocked PR #3.

## PowerShell 5.1

- Never `2>&1` a native executable. Windows PowerShell wraps its stderr in ErrorRecords, so
  `$ErrorActionPreference = 'Stop'` kills the run on the first warning even when the process exits
  0. `Invoke-Batch` in `Publish-Steward.ps1` shows the right shape: call it bare, check
  `$LASTEXITCODE`.
- No `&&`, no `||`, no ternary, no `?.`.

## Snapshot semantics

- Categories are frozen into `zdo.category` **at parse time**. A classifier change does nothing to
  already-ingested snapshots; re-ingest is the only lever. `world_snapshot.parser_version`
  (currently 1.1.0) is how a mixed-classification cache is detected.
- Delta rasters are rendered for the **full matrix** of the latest 6 snapshots per world — 15
  pairs, 4 layers, 4 cell sizes, added and removed channels.
- The delta manifest says `"encoding":"gray8"`, but the renderer writes `TYPE_INT_ARGB` and the
  files are RGBA8. R=G=B=value and **alpha is the presence mask** — gate on alpha, not on value.
- Snapshot `all-zdos` bounds run past `x=+75000` on a handful of outlier ZDOs, well outside the
  ±26500 world box. Never `fitBounds` to them.
- `/api/v1/points`, `/api/v1/structures`, `/api/v1/portals` and `/api/v1/sectors` answer from the
  **boot parse**, not from a snapshot. On AM4 the boot world is ComfyEra16, so drawing them over
  another world's data shows the wrong world. Use `/api/v1/db/zdo/query?snapshot=…` instead.
