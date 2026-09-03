# Architecture decision records

ADRs describe decisions that define the live public world view. They are append-only: supersede an
accepted decision with a new ADR rather than rewriting its history.

| ADR | Status | Decision |
|---|---|---|
| [0001](0001-server-enforced-public-profile.md) | Accepted | Enforce the published snapshot and lens on the server and in a derived cache. |
| [0002](0002-snapshot-matched-terrain-package.md) | Accepted | Build terrain and biome context offline as a checksummed snapshot package. |
| [0003](0003-terrain-first-progressive-map.md) | Accepted | Make terrain the neutral canvas and analysis tools reversible questions. |
| [0004](0004-isolated-world-deployment.md) | Accepted | Deploy `/world/` independently from the existing Steward service. |
| [0005](0005-anonymous-first-feedback.md) | Accepted | Keep feedback anonymous by default with optional ephemeral Discord identity. |
| [0006](0006-exact-selection-webgpu-scene.md) | Accepted | Rebuild bounded selections as exact, sanitized, selection-local WebGPU scenes. |
