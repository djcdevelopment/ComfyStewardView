# Islet Control Plane & Steward Integration Specification

This specification defines the boundary and contract between **Islet** (the operational control plane) and **Steward** (`ComfyStewardView` - world intelligence & read model).

## Domain Separation

```text
+-------------------------------------------------------------------------------+
| ISLET (Control Plane & Operational Pipeline)                                 |
|                                                                               |
|  1. Discovers nightly/triggered backups (AM4 production / P7 cloud)           |
|  2. Verifies save file SHA-256 integrity                                      |
|  3. Invokes Steward Ingest API with local file path + provenance payload      |
|  4. Records execution receipts and pipeline status                            |
|  5. Displays "World History" status card with launcher link to Steward        |
+-------------------------------------------------------------------------------+
                                       |
                                       | POST /api/v1/db/snapshots/ingest
                                       v
+-------------------------------------------------------------------------------+
| STEWARD (World Intelligence & Read Model)                                     |
|                                                                               |
|  1. Parses save file via WorldParser                                          |
|  2. Appends ZDOs, container items & provenance to DuckDB analytics cache      |
|  3. Pre-calculates snapshot deltas (+ZDOs, -ZDOs, item changes) vs prior save  |
|  4. Renders static map tile overlays                                          |
|  5. Returns execution receipt JSON to Islet                                   |
|  6. Serves the 4-tab UI: World | Changes | History | Explore                    |
+-------------------------------------------------------------------------------+
```

---

## 0. Where the work runs

Processing and serving are split across hosts. OMEN parses saves and builds artifacts; AM4 only
serves them.

```text
OMEN (processing)                                  AM4 (serving)
  comfy-valheim-lab server  --+
  worlds_local/*.db           |
                              +--> tools/Publish-Steward.ps1
  AM4 world (pulled frozen) --+       |
                                      |  parse + DuckDB cache + rendered layers
                                      |  (~53 s, ~1.2 GB per world)
                                      |
                                      +--> scp artifacts --> steward-data volume
                                                             touch /data/.cache-complete
                                                             restart container
                                                                    |
                                                                    v
                                                             serve mode only
                                                             https://am4.../steward/
```

**Why the marker matters.** `entrypoint.sh` gates its batch build on `/data/.cache-complete`.
Publishing prebuilt artifacts and touching that marker makes the container skip the build and go
straight to serve mode, so moving processing to OMEN needed no application change at all.

**AM4 still needs a world file.** Around twenty endpoints read the in-memory `ZdoFlatStore`, not
DuckDB, so the container parses a `.db` at every start (seconds, not minutes). The frozen world
copy stays on AM4; only the expensive batch build moved.

**One world, several copies.** Every save in this lab is a copy of the same ComfyEra16 world with
slight testing drift — AM4's, OMEN's, and the frozen `erasave` copy alike. They therefore share a
single `world_id` and are distinguished by `source` (`am4`, `omen`) and `backup_id`, not by
separate world ids. Splitting them would scatter one world's history across parallel timelines
and make the Changes view unable to diff them, which is the only interesting question to ask of
two copies. The AM4 copy is snapshotted there with an mtime-stable copy and pulled; OMEN's is read
from a rotated `*_backup_auto-*.db`, immutable once written and so needing no torn-copy protection.

Measured between two such copies: 43 objects added, 43 removed, 2,366 ownership changes, no net
item change — wandering fauna and little else. That is what "slight drift" looks like, and it is
the shape a healthy delta should have here.

**The consistency gate.** `Publish-Steward.ps1` refuses to publish unless the `file_hash` recorded
in the am4-sourced snapshot equals the SHA-256 of the world file AM4 will actually serve. Otherwise
the DuckDB view and the in-memory view would describe different saves. It also fails closed if any
snapshot has zero ZDO rows or no prefab dictionary recorded.

**Retention splits by host (updated 2026-08-09).** The Parquet archive on OMEN
(`%LOCALAPPDATA%\steward-publish\archive\`) is the history of record and accumulates forever.
The live cache is disposable: every publish rebuilds it fresh from the archive's latest-6
window plus that run's new worlds (unindexed bulk loads, indexes built once at the end), so
AM4's volume stays bounded at ~7 GB and indexed appends never happen in the publish lane. A
continuity gate fails the publish if any previously shipped snapshot is missing from the new
cache. AM4's ingest endpoint is disabled (`STEWARD_DISABLE_INGEST=1`) — publish owns that
history; ingest remains the lane for lab instances. See `SAVES.md` for the location registry.

**Archiving is always on and lossless.** A snapshot costs ~1,196 MB as live DuckDB but
**113.7 MB as Parquet + zstd — 10.5x smaller with every column of every row retained**, written in
about three seconds. Files land in `<ArchiveDir>/snapshot-<id>-<source>/{zdo,container_item,
world_snapshot}.parquet`.

Archived does not mean unreadable. DuckDB queries Parquet in place, so an archive is still a
first-class dataset with no import step:

```sql
SELECT category, COUNT(*) FROM '<archive>/snapshot-*/zdo.parquet' GROUP BY 1;
```

Verified round-trip on a real snapshot: 9,155,594 ZDO rows and 406,511 container items readable
through that glob, provenance intact, category counts identical to the live cache.

At 113.7 MB a snapshot, storage stops being a planning constraint — 15 GB is roughly 130 snapshots.
Where the Parquet goes afterwards (cold storage, cloud drive) is outside this tool's remit; it
writes locally and stops there.

Run it dry first — it builds and verifies locally, touching nothing on AM4 beyond the read-only
world pull:

```bash
powershell -ExecutionPolicy Bypass -File .\tools\Publish-Steward.ps1
```

Then publish with `-Push`. `-SkipAm4World` builds the omen-sourced copy only, for when AM4 is
unreachable. `-Archive` additionally writes each snapshot out as Parquet.

`Deploy-Steward.ps1` remains the lane for shipping *code* to AM4 (image build + compose up).
`Publish-Steward.ps1` ships *data*. Deploy when the jar changes; publish when the world changes.

---

## 1. Steward Ingest API Boundary

### `POST /api/v1/db/snapshots/ingest`

Because Valheim `.db` save files frequently exceed 1GB, save files are **not** streamed across HTTP. Steward processes local save file paths accessible on the host machine (e.g., AM4 or OMEN server).

#### Request Headers
`Content-Type: application/json`

#### Request Payload
```json
{
  "filePath": "C:\\work\\comfy\\erasave\\ComfyEra16.db",
  "worldId": "ComfyEra16",
  "worldName": "ComfyEra16",
  "source": "am4",
  "backupId": "bak_20260807_020000",
  "saveTimestamp": "2026-08-07T02:00:00Z",
  "fileHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

#### Response (Success Receipt - HTTP 200)
```json
{
  "status": "success",
  "snapshotId": 184,
  "worldId": "ComfyEra16",
  "worldName": "ComfyEra16",
  "source": "am4",
  "backupId": "bak_20260807_020000",
  "fileHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "fileSize": 1152938472,
  "parsedZdos": 9155594,
  "storedZdos": 885213,
  "worldVersion": 37,
  "prefabDictionaryVersion": "0.221.12",
  "prefabCoveragePct": 99.46,
  "durationMs": 742000,
  "ingestedAt": "2026-08-07T19:30:00Z",
  "delta": {
    "prevSnapshotId": 183,
    "zdosAdded": 1384,
    "zdosRemoved": 27,
    "zdosModified": 0,
    "containerItemsDelta": 412,
    "newPortals": 2,
    "newTombstones": 14,
    "dictionaryMismatch": false
  }
}
```

`parsedZdos` is every ZDO in the save. `storedZdos` is the smaller "interesting" subset held in
memory (roughly a tenth) — do not alert on the difference.

`prefabCoveragePct` is the share of ZDOs that resolved to a real prefab name. A sharp drop means
the dictionary has gone stale against a new game build; see
[PREFAB_DICTIONARY.md](PREFAB_DICTIONARY.md).

#### Timeouts and cost — measured, not estimated

**An ingest of a 1.27 GB / 9.16M-ZDO save into an existing cache takes 12–13 minutes.** Raw
parsing is only ~4 s; the wall-clock is writing 9.16M ZDO rows and ~400k container-item rows.
Islet must set its HTTP timeout to **at least 20 minutes** and treat ingest as a long-running job,
not a request/response call.

**The same work against a fresh cache takes 53 seconds** — 260,000 ZDO/s versus 12,400 ZDO/s, a
21× difference. The cause is indexing: `AnalyticsCache.finish()` calls `createIndexes()`, so every
subsequent append writes through the indexes it built, and the DuckDB Appender fast path loses
most of its advantage. Two consequences:

- Batch builds that start from nothing (`--rebuild-cache`, what `Publish-Steward.ps1` does) are
  cheap. Budget a minute, not a quarter of an hour.
- Growing a long history by repeated ingest gets progressively more expensive. As of 2026-08-09
  the ingest path drops indexes before its bulk append and rebuilds them at finish, and the
  publish lane avoids indexed appends entirely (fresh cache from the Parquet archive each run),
  so both lanes stay linear per snapshot.

**Storage, measured:** a single-snapshot cache is ~1.2 GB; a two-snapshot cache is ~3.2 GB, so the
appended snapshot costs closer to 2 GB. A 42-snapshot window is therefore tens of GB, on a host
whose compose file caps memory at 8 GB but does not bound disk. Islet owns retention. DuckDB does
not release file space on `DELETE` without a checkpoint, so pruning needs a maintenance step.

Ingest is single-writer. Do not issue concurrent ingests against one cache file.

---

## 2. Islet "World History" Status Card UI Contract

Islet renders a summary card on its `Operate -> World History Pipeline` dashboard with operational details and receipts.

### Status Card Fields:
- **Last backup:** `02:00`
- **Last Steward ingest:** `Success` (Receipt #184)
- **Snapshots retained:** `42`
- **Latest delta:** `+1,384 / -27 ZDOs`
- **Link:** `Open Steward ->` (`http://am4.tail8e749c.ts.net/steward/`)

---

## 3. Querying History & Snapshot Diffs from Steward

### List Retained Snapshots
`GET /api/v1/db/snapshots?worldId=ComfyEra16`

### Query Snapshot Delta Summary
`GET /api/v1/db/snapshots/delta?snapshotId=184`

### Compare Any Two Snapshots (Detailed Prefab Diff)
`GET /api/v1/db/snapshots/compare?from=183&to=184`

#### What a delta actually means

**Object identity is prefab hash plus position, not `zdo_index`.** `zdo_index` is the parser's
loop counter — a ZDO's ordinal slot in the save file — and the parser never reads a ZDOID, so the
cache holds no persistent per-object key. Comparing slots between two saves compares array
positions rather than objects, which degenerates to the row-count difference with the prefab
breakdown taken from whatever sits at the tail of the larger file. Positions are used instead,
quantised to 1 cm.

Consequences Islet should encode in its status card:

- **Mobile categories churn.** Creatures, dropped items and ships move, so they appear as removed
  in one place and added in another between any two saves. Read `addedByCategory` /
  `removedByCategory` and drive "build activity" from `BUILDING`, `CONTAINER`, `PORTAL`, `SIGN`,
  `ITEM_STAND` — not from the headline totals.
- **`reconciles` is a self-check.** `added - removed` must equal `zdoCountTo - zdoCountFrom`. When
  it is false, objects sharing one exact position changed in number, which a presence-based
  comparison cannot see; the counts are then a lower bound and `reconcileWarning` explains it.
- **`dictionaryMismatch` invalidates prefab breakdowns.** Snapshots named by different prefab
  dictionaries are not comparable at prefab level — a rename reads as a demolition plus a build.
  Re-ingest both sides with the same dictionary before trusting the diff.
- **`zdosModified`** counts objects present in both snapshots at the same position whose
  `creator_id` or `owner_id` changed. Finer per-field change detection would require
  `--cache-fields`, which is off by default.

---

## 4. Operational Receipt Logging Sequence

Islet logs structured receipts for each pipeline run:
```text
02:00 [ISLET]   Nightly backup created: bak_20260807_020000
02:01 [ISLET]   SHA-256 verified: e3b0c44298fc...
02:02 [STEWARD] Ingest API invoked via POST /api/v1/db/snapshots/ingest
02:14 [STEWARD] Snapshot #184 committed to DuckDB (9,155,594 ZDOs, 12m18s)
02:14 [STEWARD] Delta vs Snapshot #183: +1,384 / -27 ZDOs (reconciles=true, dict 0.221.12)
02:14 [ISLET]   Pipeline completed with 0 errors (Receipt #184 saved)
```

Note the twelve-minute gap between invocation and commit. An earlier draft of this sequence
showed two minutes; that was the parse time, not the ingest time.
