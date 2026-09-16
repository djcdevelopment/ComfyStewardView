# Retrospective: restoring identity, then making creator profiles scale

- Date: 2026-09-15
- Scope: multi-era creator archive, creator-to-World links and prolific-profile UX
- Live creator release: `e15699254951-6e8c2f02792b`

## Outcome

We restored Charon's missing Era 17 record without merging it with the different Era 4
Charon, repaired the Era 17 creator-to-World selection, published the judged multi-era
photography corpus, and redesigned creator profiles so hundreds or thousands of builds
remain explorable without dominating first paint.

The live archive now exposes 5,823 searchable identities, 56,237 qualifying albums and
16,111 photographs across 17 eras. A 20-piece saved-credit threshold removes incidental
profile occurrences while retaining 682 searchable identities with no qualifying albums.
Ibocain's page retains all 547 qualifying builds and 40 photographed builds; it initially
shows the global carousel and six guided build choices rather than 28 pages of records.

## What actually happened

The first report sounded like a classic last-write-wins bug: a player named Charon was
visible in Era 4 but absent from Era 17. The tempting theory was that the later projection
had overwritten a duplicate name. Source evidence disproved it. Identity was already keyed
independently from display names; the canonical intake simply lacked the Era 17 save. We
restored that source and re-ran the archive rather than joining records by name.

The restored profile then exposed a second fault. Its World link reached an Era 17 public
cache with terrain but no exact build membership. The archived membership belonged to a
different analysis snapshot even though the source save was byte-identical. We proved all
4,359,570 membership rows joined uniquely to the public cache, remapped membership only,
and replaced only Era 17 in the immutable World catalog. Charon's selection then opened
4,555 exact pieces while Derek's Era 15 regression link still opened 657.

Human light-table review and the judged capture import made 16,111 photographs public. At
that point the archive's scale became visible in a way the original page had never faced.
Ibocain had 547 qualifying albums and 259 qualifying co-builders. A carousel followed by
hundreds of rows and a very tall relationship diagram was complete but not approachable.

We iterated through a thresholded explorer, an era atlas, a bounded kinship summary, a
restored carousel, a compact matrix and finally a cold-visitor sequence. The final page
keeps the photograph tour global, introduces eras before filters, defaults to a six-card
guided mix, folds the two-dimensional matrix, keeps the full ledger opt-in, and sends
detailed relationship work to Kinship. The large Browse box survived one iteration too
long; the last release folded its useful Find and Order controls directly into the explorer
and removed the redundant desktop era selector.

## What worked

- **Evidence beat the plausible duplicate-name story.** Following source receipts and
  stable keys prevented an incorrect identity merge.
- **The real profiles were the smoke tests.** Charon caught the intake and World-link
  failures. Ibocain caught the 547-album UX failure. The largest current profile verifies
  2,929 albums without pinning that count as a product limit.
- **Data and presentation were gated separately.** The contribution-threshold gate proved
  the intentional semantic transition. Later UI projections passed `gate_creators.py` with
  zero thread additions, removals or content changes and identical directory data.
- **Immutable, lane-specific deployment contained risk.** Creator releases switched only
  `/valheim/creators`; the World repair replaced only Era 17; both retained their prior
  release for rollback.
- **The carousel became an explicit invariant.** Plain, build-linked and kin-linked profiles
  now share the same photograph opening, and smoke tests assert it.
- **Derek's rapid feedback found information-architecture problems tests could not name.**
  “Still way too large,” “the kinship section is confusing,” and “we deleted the carousel”
  each identified a real discontinuity between technically bounded output and usable flow.

## What did not work well

- **We converged through too many public-shaped iterations.** Era atlas, explorer, kinship,
  carousel restoration, compact matrix and final guide became five source releases in a few
  hours. Local preview existed, but the design question should have been framed earlier as
  one top-to-bottom journey rather than a sequence of isolated component fixes.
- **Bounding rows was mistaken for solving navigation.** Reducing 547 rows to pages and a
  matrix made the DOM finite but still asked a cold visitor to understand archive mechanics
  before seeing a path through the work.
- **The best section briefly lost its guaranteed place.** A relationship-link path could
  omit or displace the carousel. The fix was not another special case; it was declaring the
  photo tour global and making all later controls independent from it.
- **The duplicate Browse panel remained after its job moved elsewhere.** Era cards already
  selected the era, yet the separate box repeated that decision. We removed the desktop
  duplicate only after reviewing the final page in sequence. Mobile keeps it deliberately.
- **The post-deploy smoke initially reported harness failures.** Its old five-card assertion
  rejected the intentional six-card guide, and a missing parenthesis in a new matrix-count
  expression surfaced as an unhelpful `undefined` read because browser evaluation exceptions
  were not propagated. The live page itself was healthy, but the release was not complete
  until the harness was repaired and rerun. `a8ca539` now throws the actual browser exception
  and waits for navigation-specific page state.

## Decisions that should survive this project

1. Names are observations; stable archive keys are identities.
2. A publication cutoff may hide a relationship occurrence, never erase the person or
   rewrite archive-wide facts.
3. Photographs are the public story; inventories and relationship ledgers are research
   tools reached progressively.
4. A bound is not a UX. Every bound needs a clear route to the complete record.
5. Deep links must add focus without replacing the page's primary context.
6. A presentation release needs both a no-data-change gate and a live browser receipt.
7. When a real scale fixture exists, keep it in the smoke instead of inventing a toy one.

## Verification and receipts

- Threshold release: commit `d58eaf2`; deployment receipt
  `E:\omen\steward-multi-era\receipts\deploy-creator-explorer-d58eaf2.json`.
- Final creator source release: commit `e156992`; deployment receipt
  `E:\omen\steward-multi-era\receipts\deploy-creator-guide-e156992.json`.
- Final live browser receipt:
  `E:\omen\steward-multi-era\validation\creator-guide-e156992-rerun5\receipt.json`.
- The final receipt reports creator and spatial status `passed`, a six-build initial
  shortlist, no initial full-ledger rows, Ibocain inventory 547, a 390/390 px mobile fit and
  a working direct link into an older Era 6 build.

## Follow-up

The page should now sit long enough to produce observed questions. The next operational
work is the refused/reshoot photography round, not another information-architecture pass.
Any future profile change starts from the invariants and evidence in
[`creator-profile-follow-up.md`](../plans/creator-profile-follow-up.md).
