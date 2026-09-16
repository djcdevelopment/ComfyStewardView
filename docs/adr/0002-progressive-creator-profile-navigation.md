# ADR 0002: Progressive creator-profile navigation

- Status: Accepted
- Date: 2026-09-15

## Context

The original profile worked for a few photographed albums but did not scale to builders
active across many eras. Ibocain's retained profile has 547 qualifying albums and 259
qualifying co-builders. Rendering the entire unphotographed ledger and relationship table
turned the page into a database dump. A first heatmap reduced the list but displaced the
strongest part of the page—the photograph carousel—and duplicated era selection in a large
Browse panel. Relationship links also briefly opened a path without the carousel.

Cold visitors need a narrative before controls: who this is, what the photographs mean,
how work changes by era, and only then how to find an exact record. At the same time,
researchers still need complete, deterministic access to every qualifying album.

## Decision

- The builder hero and global photograph carousel are the opening. Era, piece-band,
  search and kinship filters never mutate or remove that tour.
- Era cards are the primary orientation and desktop era control. Mobile also exposes an
  era select as a compact shortcut.
- The default build explorer is a maximum six-card guided mix: up to half photographed
  highlights and half substantial unphotographed work, filled deterministically when one
  lane is short. Explicit sort choices are strict rather than guided.
- The credited-piece matrix starts folded. It filters by era and the builder's own piece
  band when opened; its printed counts remain authoritative.
- Find and Order sit beside the explorer as a compact toolbar. The matching count and
  removable filter chips explain the current view. The complete ledger is opt-in, paged at
  50 rows, and retains exact build-key search and `?build=` deep links.
- A profile shows at most five leading co-builder cards. The complete searchable ledger,
  era facets, pair details and tagging workflow live on the Kinship route. `?kin=` links
  preserve the carousel and offer a clear relationship destination.
- Browser smoke must cover a prolific profile, Ibocain's 547-album regression fixture, a
  single-era profile, an empty retained profile, direct links and a 390 px viewport.

## Consequences

First paint is bounded by presentation choices rather than archive size, while every
album remains reachable through filtering or the ledger. The carousel and build explorer
have deliberately different scopes; copy on the page makes that distinction explicit.
Mobile carries one controlled duplication—the era select—because the alternative is
crossing a long grid of era buttons.

The guided mix is a curatorial algorithm and therefore a tested policy, not incidental
DOM order. New profile features must fit this progression or move to a dedicated route.
Future changes need observed user evidence and must preserve the smoke invariants rather
than re-expanding the opening page.
