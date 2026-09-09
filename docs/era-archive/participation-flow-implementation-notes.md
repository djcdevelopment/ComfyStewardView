# Creator participation flow: implementation notes (2026-09-09)

This note records the participation-feature work currently implemented in
`tools/era-archive/web/*` and the projection generator.

## Files changed

- `tools/era-archive/web/index.html`
  - Added participation UI shell:
    - Participation snapshot block (local counts + volunteer handle)
    - Claim modal
    - Additional photo request modal
    - Payload modal + copy actions
    - Shared toast container
    - Endpoint metadata slot (`meta name="creator-participation-endpoint"`)
- `tools/era-archive/web/creators.css`
  - Added styling for directory/thread cards, chips, modals, buttons, and status to
    support the new participation controls.
- `tools/era-archive/web/creators.js`
  - Replaced the prior single-pass render script with a stateful client flow:
    - local participation state model in `localStorage` (`creators-participation-v1`)
    - directory page: search + era filtering + paginated builders
    - thread page: per-era collapsible build sections
    - build actions:
      - "I built this" claim flow
      - "Request additional photographs" (enabled after claim)
      - request presets + free-form note + urgency + contact
    - per-builder participation chips on directory cards
    - optional remote submit attempt using endpoint from `<meta>`
    - local queue semantics when endpoint is unavailable (`queued` status)
    - payload copy for manual or automatic handoff
- `tools/era-archive/gallery.py`
  - Added optional projection export of a sanitized `participation.json` snapshot
    from `analysis/participation.json` when present.
  - Kept existing API compatibility by making `analysis_root` optional.

## Why this design

The participation goal is community buy-in, so the flow is intentionally staged:

- Claim first lowers effort and provides intent before heavier requests.
- Local-first persistence allows users to continue if backend submission is unavailable.
- Additional photo requests are gated on claims to reduce ungrounded operator workload.
- Payload copy makes participation review possible even without a live backend endpoint.

## Validation performed

- `node --check tools/era-archive/web/creators.js` -- syntax check passed.
- `python -m unittest discover -s tools/era-archive/tests -v` -- all tests passed (25/25).

## Assumptions / notes

- Endpoint is optional and empty by default in the template.
- Claim/request records are currently user-intent markers, not globally verified ownership.
- Duplicate handling and identity reconciliation are limited to local storage scope.
- Existing public directory/thread schema is preserved; no private attribution fields were added.

## Operational follow-up

- Set `meta[name="creator-participation-endpoint"]` to a real ingestion endpoint.
- Optional: add server-side aggregation/reporting of `queued` vs `submitted`.
- Optional: add backend request validation/moderation before acceptance.
