# Steward synthetic history corpus

This is the controlled validation lane for Steward's snapshot, delta, and raster pipeline.
It is intentionally separate from the AM4 publish lane.

The first corpus is six cumulative snapshots: the current save as snapshot 00, followed by five
seeded mutation intervals. Six is the current raster retention boundary; all 15 pair rasters remain
available without changing production policy.

The in-world mutation side belongs to ComfyQuestLab's marked ZDO builder/destructor and its bounded
batch mailbox. Selfie Stick remains the unattended local-world lifecycle adapter. Steward ingests
the resulting frozen saves through `/api/v1/db/snapshots/ingest` so each interval gets a real
snapshot receipt and `snapshot_delta` row.

## Contract

- [schema-v1.json](schema-v1.json) is the machine-readable corpus contract.
- [scenario-v1.json](scenario-v1.json) is the first bounded scenario sequence.
- Every event writes a JSONL identity ledger. Durable identity is `prefab_hash + XYZ rounded to
  1 cm`; runtime ZDOIDs are evidence only.
- Requested counts and applied counts are separate. Applied counts are authoritative.
- Full saves, DuckDB caches, rendered PNGs, and coordinate-bearing ledgers belong under an ignored
  run directory; commit only schemas and hash-indexed summaries.

## Safe execution shape

1. Freeze the current `.db`/`.fwl` pair and hash it.
2. Mutate only the explicitly selected R&D world or a disposable working copy.
3. Apply one step, force a world save, stop the server, and copy an mtime-stable snapshot.
4. Ingest snapshots serially into a fresh local cache.
5. Capture compare responses, delta manifests, PNG hashes, and observation receipts.
6. Restore the original local world and verify its hashes.

The first live run must not use `Publish-Steward.ps1 -Push` or the production AM4 volume.

## Unattended Docker replay

`Invoke-DockerReplay.ps1` drives the existing QuestLab mailbox against the OMEN Docker lab. It
installs the already-built QuestLab plugin, starts and stops only the Valheim service inside the
named container, applies each cumulative `history_step`, waits for its receipt, and captures the
save after the runner's explicit save barrier. No player client or manual login is required.

The replay deliberately leaves the lab server running on the final synthetic state. Its durable
evidence is `receipts/docker-replay.json`, five ground-truth receipts, five JSONL ledgers, and six
hash-distinct frozen saves. Pass explicit paths when replaying outside the reference OMEN layout.

    .\Invoke-DockerReplay.ps1 `
      -Container 'comfy-valheim-lab-valheim-server-1' `
      -RunRoot 'D:\steward-synthetic-history-v1'

By default the replay reuses snapshot 00 and the plans already in that run root. For a fresh run
root, pass `-SourceCorpus` pointing to a previously planned corpus containing those inputs.

## Coordinator

`Invoke-SyntheticHistory.ps1` creates corpus metadata and deterministic step plans, backs up the
baseline, records frozen saves, and submits snapshots to a local Steward instance. Its `ApplyStep`
action writes only the bounded QuestLab mailbox request; it does not drive the server lifecycle.
Use `Invoke-DockerReplay.ps1` when the Docker lab should run the complete mutation/capture loop.

Typical local sequence:

    .\Invoke-SyntheticHistory.ps1 -Action Plan -WorldDirectory 'D:\Valheim\worlds_local'
    .\Invoke-SyntheticHistory.ps1 -Action Prepare -WorldDirectory 'D:\Valheim\worlds_local'
    # Apply QuestLab steps 1..5 cumulatively; the QuestLab runner forces each save.
    .\Invoke-SyntheticHistory.ps1 -Action RecordSnapshot -SnapshotIndex 0 -WorldDirectory 'D:\Valheim\worlds_local'
    .\Invoke-SyntheticHistory.ps1 -Action Ingest
    .\Test-SyntheticHistory.ps1 -CorpusRoot '..\..\artifacts\synthetic-history\steward-synthetic-history-v1'

`Restore` restores only the baseline backup created by `Prepare` and requires the world process to
be stopped. Generated saves, ledgers, PNGs, and receipts stay under `artifacts/` (or the explicit
run root) and are not source-controlled.

## Reference-run acceptance

The first six-snapshot corpus is considered complete when:

- all six `.db` and `.fwl` hashes match `corpus.json` and all database hashes are distinct;
- Steward reports six snapshots and all 15 canonical pairs available;
- every pair manifest advertises 16 aligned layers (two layer families at four resolutions, with
  independent added and removed channels);
- channel raw totals are invariant across resolutions and every advertised PNG has a valid PNG
  signature; and
- `validation/sequence-summary.json` records exact ground truth versus observed counts, including
  expected net-state cancellations rather than treating them as silent success.

The reference run intentionally demonstrates two current representation boundaries: an object
created and removed inside the same interval is invisible to snapshot identity comparison, and a
destroy/rebuild at the same prefab and centimeter position is under-counted. It also demonstrates
that wood pieces missing a BUILDING dictionary classification appear in `all-zdos`, not
`build-activity`. These are validation findings, not generator failures.
