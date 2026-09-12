## Why

The two applications share Bun, Solid and OpenTUI versions but live in separate repositories and build graphs. A reproducible import and feature baseline are prerequisites for a component-by-component merge without losing either application's behavior.

## What Changes

- Import a pinned devenv revision into this repository without changing its backend semantics.
- Establish one Bun workspace/dependency graph, Biome coverage and a combined verification entrypoint while retaining the Go module.
- Record a feature, route, command, configuration, platform and persistence parity inventory, including current test failures and source provenance.
- Keep current entrypoints working during migration; do not revive removed phase-specific workflow verbs.
- Document manual project-location reconciliation as a prerequisite to project-discovery cutover.

## Capabilities

### New Capabilities

- `merged-repository-foundation`: Reproducible source import, shared tooling and feature-preservation baseline.

### Modified Capabilities

None.

## Impact

Touches root workspace configuration, imported devenv TUI packages and Go server, build/test scripts, licensing/provenance records and migration documentation. Depends on no other migration change. Runtime porting, repository relocation and UI replacement are out of scope.
