# Steward save & cache locations — canonical registry

Each era is a distinct `world_id`; snapshots within an era form its history. This is the
authoritative map of where active and historical copies live and which lane touches them.

| Location | Host | Owner / purpose |
|---|---|---|
| `/home/derek/comfy-valheim-lab/server-state/config/worlds_local/ComfyEra16.db` | AM4 | **Live game world.** Source for am4-sourced snapshots. Never edited by tooling. |
| `/home/derek/steward/world/ComfyEra16.db` | AM4 | **Publish-owned serve copy.** Re-snapshotted (mtime-stable) from the live world by every `Publish-Steward` run; Deploy-Steward only seeds it on first deploy. Not frozen — it tracks the last publish. |
| `/home/derek/steward/world/ComfyEra17.db` | AM4 | **Completed-era serve copy.** Uploaded only from an explicit release artifact, SHA-256 verified, and selected through `/home/derek/steward/.env`. |
| `steward_steward-data` volume → `/data/{world-cache.duckdb, rendered/, .cache-complete}` | AM4 | **Published artifacts.** Replaced atomically by each publish. The API ingest endpoint is disabled here (`STEWARD_DISABLE_INGEST=1`) — publish owns this history. |
| `C:\work\baseline\fieldlab\autonomous\state\server\config\worlds_local\` | OMEN | **Lab game world + rotated backups.** Newest `*_backup_auto-*.db` is the omen-sourced snapshot each publish. Also the seed world for synthetic-history replays. |
| `%LOCALAPPDATA%\steward-publish\out\` | OMEN | **Publish workdir.** `world-cache.duckdb` is disposable (rebuilt every run); `rendered\` persists across runs (only missing rasters render). |
| `%LOCALAPPDATA%\steward-publish\archive\` | OMEN | **History of record.** Parquet per snapshot (`snapshot-<id>-<source>/`), accumulates forever, never pruned by tooling. Each publish rebuilds the live cache from its latest-6 window. Backed up = history backed up. |
| `artifacts\synthetic-history\<corpusId>\` and `D:\steward-synthetic-history-v1\` | OMEN | **Synthetic validation corpora.** Own caches, own world ids; never feed the AM4 publish lane. |
| `C:\work\comfy\erasave\ComfyEra16.db` | OMEN | **Historical.** Referenced only by old planning docs; no script reads it. Safe to delete. |

Notes:
- `p7` appears only in Islet-spec prose (cloud backup ambitions); no code or config
  references it.
- The live AM4 cache carries at most the **latest 6 snapshots** (the delta-matrix
  window). Older history exists only in the Parquet archive; DuckDB queries it in place
  (`SELECT * FROM 'archive/snapshot-*/zdo.parquet'`).
- Lanes and their write targets: `Publish-Steward.ps1` (archive + workdir + AM4 volume +
  AM4 serve copy), `Deploy-Steward.ps1` (AM4 image; `-RefreshWorld` wipes the volume),
  ingest API (lab instances only), synthetic-history tools (corpus dirs only).
- A machine-local nightly configuration may pin an immutable completed-era artifact;
  unchanged releases are a no-op and executable defaults do not encode its drive path.
