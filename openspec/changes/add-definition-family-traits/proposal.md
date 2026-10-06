# Proposal

## Why

The engine decides how a repository workflow behaves by comparing its definition
id to family names: `CHANGE_FREE_IMPLEMENTATION = {no-openspec, solo, verify}`,
`CLOSE_ONLY_DEFINITIONS`, `definition.id.startsWith("openspec-fusion")`,
`definitionId === "openspec-apply"`, `"rebase"`/`"verify"` start guards, and
about 60 more such branches across `steps/`, `runtime/`, `startup.ts` and
`effect-runner.ts`. A workflow whose graph is composed at runtime has a new id
and would silently fall through every one of them.

The first step is to make those properties explicit data on the definition,
without changing any behavior or call site, so the next change
(`read-family-traits-instead-of-ids`) can switch readers one by one against a
parity-tested source of truth.

## What Changes

- `WorkflowManifestPolicy` gains `traits` for repository-target code-change
  families (`openspec`, `openspec-apply`, `openspec-propose`, `openspec-fusion`,
  `openspec-fusion-propose`, `no-openspec`, `solo`, `rebase`, `verify`):
  - `changeArtifacts`: `openspec` | `none`
  - `planning`: `none` | `single` | `fusion`
  - `changeIdentity`: `planned` | `workflow-id`
  - `delivery`: `pull-request` | `none`
  - `startRequirements`: subset of `task`, `clean-tree`, `openspec-project`,
    `openspec-change`, `base-commit`, `rebase-refs`
  - `openspecVerifier`: boolean
- Registration validates traits (enums, repository target only, structural
  consistency with the graph).
- A new **family-traits tier** (`rounds + 800`) registers every family; the
  repository code-change families carry traits; new starts resolve this tier.
- `effectiveFamilyTraits(definition)` returns declared traits or, for earlier
  tiers, the same values from a per-id fallback table — so every pinned workflow
  has traits.
- A parity test asserts declared traits equal the fallback table for every
  registered built-in. No reader changes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-definition-registry`: adds declared family traits and the tier that
  carries them.

## Impact

- `src/workflow/registry.ts` (type, validation),
  `src/workflow/definitions/manifest-policy.ts` (trait table, tier, fallback),
  `src/workflow/definitions/registerBuiltins.ts` (register the tier),
  `src/workflow/startup.ts` / `cli` start (resolve the new tier).
- Definition digest table and registry tests; `docs/workflow-architecture.md`
  (tier list).
