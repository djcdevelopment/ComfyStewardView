# Creator participation: what claiming is, and where it lives

A decision record, written after the fact because its absence caused a duplication.

Two claim implementations shipped eleven hours apart, on two surfaces of the same site,
with different identity models, and neither could reach anyone. Nobody had written down
that the first existed, so the second was built without knowing. This note is the thing
that should have existed first.

## What claiming is for

Two purposes, both about the community rather than the data:

1. **Buy-in.** A builder seeing their own work photographed and being able to say "that
   one is mine" is the point of publishing the archive at all.
2. **A signal about where to spend hardware.** A claim, and especially a follow-up photo
   request, says which builds someone actually cares about. That is a better input to the
   next capture campaign than any heuristic — and the measurements say build attributes
   predict nothing about photograph quality, so a human saying "this one matters" is
   genuinely the best signal available.

## What a claim asserts, and what it does not

A claim is a **self-reported intent marker**. It is not verified ownership, and it must
never become one silently.

Attribution stays derived from the world save: `creator_id` on each placed piece, grouped
by exact membership, surfaced as `contributors[]` with per-builder shares. That is
evidence. A claim is a person saying something about themselves on a public web page with
no authentication whatsoever.

So: **a claim never modifies attribution, never reorders credit, and never appears as
though it did.** Accepting claims as identity would need an authenticated path and a
reconciliation policy, and neither exists. The UI says "a self-reported marker, not
verified ownership" for that reason, and that wording is load-bearing.

## Which surface owns it

**The creators site (`/valheim/creators/`) owns claiming. The photo gallery deliberately
does not.**

The gallery had its own claim, request and vote buttons calling `/api/valheim/*`. That API
is real — `~/am4bot/bot.py:1440` on AM4, four correctly-shaped handlers on
`127.0.0.1:8200`, backed by a SQLite `signals` table, authenticated by a `X-Gallery-User`
header that AM4's Caddy stamped from basic auth. It **stopped on 2026-06-25 and stayed
stopped**, and on 2026-08-24 the gallery moved to FX99 for bandwidth — FX99 has no `/api`
route and no basic auth, so even a proxy would have 403'd every write.

The result was a page whose claim buttons could never render (gated behind a sign-in that
could never succeed) and whose stars visibly rolled themselves back on every click. Those
paths are removed. The lightbox now links to the builders page instead.

Choosing one surface is not about which is nicer. Two claim models on one site means two
things to keep honest, and the second one was built precisely because the first was
invisible.

## The identity model

**Local-first, anonymous, no sign-in, no server.**

- A volunteer handle, free text, defaulting to "Anonymous volunteer".
- State in `localStorage` under `creators-participation-v1`. Persistence is a convenience,
  not the mechanism — a private window with site data blocked must still work, which is
  why `saveState()` tolerates failure and says so.
- No account, no cookie, no credential, and `fetch` sends none.
- A "forget my participation" control, because the request form invites a Discord handle
  or e-mail and there must be a way to withdraw it.

The alternative — reviving the AM4 API — was rejected: it would resurrect a service dead
for two and a half months, on the wrong host, behind a front door with no auth, to serve
the surface that no longer owns claiming.

## How a claim reaches Derek

Today, by hand, and the UI says so.

Confirming a claim copies a payload (`steward-creator-participation-export/v1`) to the
clipboard, with a fallback box when the clipboard is unavailable or refuses. The volunteer
sends it on — Discord is where this community already is. The wording never says
"submitted"; it says the claim is recorded on this device and needs sending.

`submitPayload()` and the `creator-participation-endpoint` meta tag remain, empty. If an
endpoint is ever configured the flow submits automatically and reports `submitted` instead.
That is the seam, not a plan.

## What would have to be true to accept claims automatically

Before wiring an endpoint, all of these:

- **Somewhere to run it.** FX99 serves static files only; both deployers ship tarballs and
  flip symlinks. Nothing there could serve a dynamic route today.
- **Moderation.** A public unauthenticated POST accepting free text and contact details
  needs rate limiting, abuse handling, and a review step before anything is published.
- **A retention answer.** Contact details are personal data. How long they are kept, who
  can read them, and how someone withdraws them must be decided before they are collected
  server-side rather than in the volunteer's own browser.
- **A reconciliation policy.** What happens when two people claim one build, or when a
  claim contradicts `creator_id` evidence. Until that is written, claims stay markers.

## Related

- `participation-flow-implementation-notes.md` — how the flow is built. This note is why.
- `tools/am4-gallery/PROVENANCE.md` — the vendored AM4 gallery, and the account of how the
  API was lost. It calls itself a cautionary tale about unversioned, unsupervised things;
  the duplication documented here is the second chapter of the same story.
