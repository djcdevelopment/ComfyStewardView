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

## 1. Steward Ingest API Boundary

### `POST /api/v1/db/snapshots/ingest`

Because Valheim `.db` save files frequently exceed 1GB, save files are **not** streamed across HTTP. Steward processes local save file paths accessible on the host machine (e.g., AM4 or OMEN server).

#### Request Headers
`Content-Type: application/json`

#### Request Payload
```json
{
  "filePath": "C:\\work\\comfy\\erasave\\ComfyEra16.db",
  "worldId": "am4-prod",
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
  "worldId": "am4-prod",
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

**An ingest of a 1.27 GB / 9.16M-ZDO save takes 12–13 minutes, not seconds.** Parsing is ~4 s;
essentially all the wall-clock is writing 9.16M ZDO rows and ~400k container-item rows into
DuckDB. Islet must set its HTTP timeout to **at least 20 minutes** and treat ingest as a
long-running job rather than a request/response call.

**Each snapshot costs roughly 1.5 GB of DuckDB storage.** A 42-snapshot retention window is
therefore ~60 GB, on a host where the compose file caps memory at 8 GB but does not bound disk.
Islet owns retention: decide how many snapshots to keep and prune deliberately. DuckDB does not
release file space on `DELETE` without a checkpoint, so pruning needs a maintenance step.

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
`GET /api/v1/db/snapshots?worldId=am4-prod`

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
