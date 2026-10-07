# Proposal

## Why

A workflow pins `definition: { id, version, digest }` and every command resolves
it from an in-memory registry built from code (`registerBuiltins`). A workflow
graph composed at runtime would exist only in the process that composed it: after
a restart, its pin resolves to nothing and the workflow is stranded. Custom
graphs need durable storage and a resolver that re-validates them every time
they are loaded.

## What Changes

- Store schema version 5 adds `workflow_definitions` (content-addressed by
  digest) in each workflow target store; the migration is additive.
- A **definition resolver** replaces direct `registry.definition(...)` calls:
  built-in registry first, then the target store; a stored manifest is
  re-validated against the current step catalog on every load and cached per
  process.
- Custom definitions use the reserved `custom.` id namespace, version 1, and an
  id derived from the digest; built-ins may not use the namespace.
- A custom definition must satisfy the newest built-in tier's invariants: exact
  step references, manifest policy with family traits (repository code-change
  target only), a routing step before every classifiable step, and a gate before
  every gated stage.
- A stored definition that no longer validates (a step version was removed)
  blocks its workflows like a pin mismatch, with a diagnostic naming the step.
- Operator CLI: `workflow define --repo PATH --file manifest.json` validates and
  stores a definition and prints its id and digest; `workflow start --type
  <custom id>` starts it.

## Capabilities

### New Capabilities

- `custom-workflow-definitions`: storage, validation, resolution and start of
  custom workflow definitions.

### Modified Capabilities

None (store versioning rules already cover additive migrations).

## Impact

- `src/workflow/runtime/store.ts` (v5 DDL, migration, shape classification),
  a new `runtime/definitions.ts` (resolver), the 16 `registry.definition(...)`
  call sites (`runtime/engine.ts`, `view.ts`, `store.ts`, `migration.ts`,
  `effect-runner.ts`, `startup.ts`).
- `src/workflow/registry.ts` (validate without registering; `custom.` namespace).
- `src/workflow/cli/commands/` (`define`), `cli/schema.ts`, `cli/run.ts`.
- Depends on `read-family-traits-instead-of-ids` (a custom repository definition
  behaves by its traits).
