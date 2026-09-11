## Context

This is change 1 of the migration. Both repositories use Bun 1.3.14, OpenTUI 0.4.2, Solid 1.9 and TypeScript 6. agentic-coding has a single TS package with workflow architecture checks; devenv has cli/core/types/ui workspaces and a Go 1.26.4 server. The operator wants all features retained, a devenv-led component migration, manual project reconciliation and eventual Bun-only backend.

## Goals / Non-Goals

**Goals:** Reproducible import, one dependency graph, runnable legacy surfaces and a durable parity inventory.

**Non-Goals:** Changing UI behavior, porting Go, relocating user repositories/databases, replacing Herdr or renaming the product.

## Decisions

1. Import a recorded source revision into root `server/` and `agentic-coding/packages/devenv/{cli,core,types,ui}`; copy relevant tests, guides and build assets. Keep existing `agentic-coding/src/workflow` paths stable. This avoids a simultaneous engine reorganization. Do not use an absolute dependency on `~/devenv`, a submodule, or a second runtime checkout.
2. Use `agentic-coding/package.json` as the Bun workspace root, retaining temporary `@devenv/*` names. One lockfile and one OpenTUI/Solid resolution are required. Preserve the Go module/import identity until its retirement; no publishing infrastructure is needed.
3. Record source commit, import manifest, license notices and any intentionally excluded generated/cache/user files in `agentic-coding/docs/devenv-import.md`. Import committed source, not local credentials, databases, node_modules or dist. The source package metadata and license file must be reconciled before redistribution rather than guessing licensing intent.
4. Create `agentic-coding/docs/devenv-merge-parity.md`: each user-visible feature, HTTP route, action kind, CLI mode, data/config location and supported platform has an old owner, intended owner, tests and migration status. Include feature-specific subviews and optional integrations, not only top-level tabs. This is the no-feature-loss gate used by every later change.
5. Apply Biome to imported TypeScript and keep existing workflow layer checks active. Move shared pure diff helpers out of an API-client package if necessary to avoid making UI primitives depend on backend clients. Fix dependencies rather than broadly relaxing architecture tests.

## Risks / Trade-offs

- Import drift → pin source revision and re-review changes made after this analysis; do not overwrite concurrent edits.
- Formatting noise → separate import/formatting from behavior commits and verify tests before/after.
- Compiled paths assume the old layout → update path resolution and test both source and compiled entrypoints.
- Platform claims exceed tested support → record supported, fixture-only and unavailable-platform coverage separately.

## Migration Plan

Capture both baselines, import source, align workspace/tooling, then restore both old launch paths against imported code. `bun run lint`, type-check, both Bun suites and Go tests/vet must pass; record pre-existing failures and resolve release blockers rather than declaring them successes. Only host-target builds are required for local iteration. Do not execute real environment actions while establishing baseline. Rollback is a source/build revert: no user data/schema migration occurs.

## Open Questions

No product decision blocks source import. Redistribution remains gated on resolving any license metadata discrepancy. Exact source revision is captured at implementation time, not assumed from this proposal's date.
