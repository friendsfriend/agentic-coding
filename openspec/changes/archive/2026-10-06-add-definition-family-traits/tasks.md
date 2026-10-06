# Tasks

## 1. Traits

- [x] 1.1 Inventory every repository-family id comparison outside `src/workflow/definitions/` (file, function, property it decides) and record it in `design.md`. Verify: the list covers every hit of the family-id grep.
- [x] 1.2 Add the `traits` type to `WorkflowManifestPolicy` and its registration validation (enums, repository target only, structural consistency). Verify registry tests for each rejection.
- [x] 1.3 Add the per-id trait table and `effectiveFamilyTraits`. Verify it returns traits for every repository family at every registered tier and `undefined` for wiki/research/wiki-comments.

## 2. Tier

- [x] 2.1 Register the family-traits tier (`rounds + 800`) for every family and make new starts resolve it. Verify that earlier tiers keep their digests (digest table test) and a new start pins the new tier.
- [x] 2.2 Add the parity test: declared traits equal the fallback table for every built-in at the new tier.
- [x] 2.3 Update the tier list in `docs/workflow-architecture.md`; run `bun run lint`, `bun run type-check`, `bun run build` and the workflow registry/digest suites.
