# Archive architecture decision records

These ADRs govern the public multi-era creator archive. They complement the Spatial
Lab ADRs under `lab/docs/adr/`: the Lab records decisions about `/world/`, while this
index records identity, publication and navigation decisions for `/valheim/creators/`.

Accepted ADRs are append-only. A later change should add a superseding ADR rather than
quietly changing the reason an existing public record or URL behaves as it does.

| ADR | Status | Decision |
|---|---|---|
| [0001](0001-creator-identity-and-publication-threshold.md) | Accepted | Keep identity keyed independently from display names, require substantial measured credit for albums, and retain searchable empty profiles. |
| [0002](0002-progressive-creator-profile-navigation.md) | Accepted | Keep the photo tour global and expose large build and kinship inventories through bounded progressive disclosure. |
