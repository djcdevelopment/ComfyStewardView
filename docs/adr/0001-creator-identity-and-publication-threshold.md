# ADR 0001: Creator identity and publication threshold

- Status: Accepted
- Date: 2026-09-15

## Context

The archive spans worlds whose character names are neither unique nor permanent. Two
people can use the same name, one person can appear under several names, and a name can
be absent from one save. The Charon report made the risk concrete: Era 4 and Era 17 both
contained a visible `Charon`, while the Era 17 creator page was missing. Treating the name
as a key would have made overwrite a plausible explanation and a dangerous repair. The
actual cause was an absent Era 17 intake source; the two recorded identities were already
distinct.

Publishing every one-piece or incidental contribution also made prolific profiles
unusable. A profile could contain hundreds of low-participation albums and suggest that
proximity or a token contribution meant authorship. Removing those albums entirely,
however, risked removing searchable identities and making archive-wide photograph counts
appear to change.

## Decision

- `builderKey` is the public identity key. Display names and aliases are searchable
  observations only. Equal names never merge identities, and gallery or capture labels
  never create identity joins.
- A measured album qualifies for a creator profile when both the build and that creator's
  saved-piece credit contain at least 20 pieces. The default minimum share remains zero;
  the piece threshold is the substantial-participation rule.
- A contributor with no measured piece count qualifies only when the evidence is exactly
  `legacy-leading-contributor`. The archive retains the unmeasured state rather than
  inventing a number.
- A threshold transition retains every identity from the previous projection with
  `--retain-empty-from`. A creator with no qualifying albums receives a searchable empty
  page with an explicit explanation.
- Photography totals remain archive-wide facts. Omitting a low-credit occurrence from a
  creator profile does not delete its images or reduce the global photograph count.
- A dedicated semantic gate proves the transition: identities are retained, every kept
  album satisfies the rule, every removed measured album fails it, and unrelated thread
  data does not move.

## Consequences

Duplicate names remain honest and independently addressable. Missing-era investigations
must trace intake and identity evidence instead of repairing by name. Creator pages better
represent meaningful construction participation, while small contributions remain in the
private analysis and global archive counts.

Some searchable profiles contain no public albums. This is intentional and more truthful
than either erasing a recorded person or publishing hundreds of incidental credits. The
20-piece value is now an explicit publication policy; changing it requires a new gated
transition and a superseding decision.
