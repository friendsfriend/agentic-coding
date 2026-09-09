## Context

`contracts.ts` combines workflow data types with a hand-written `Contract<T>.parse` system and throws `ContractFailure` or `WorkflowRuntimeError`. `definitions/contracts.ts` supplies step output parsers. Registry digests depend on contract IDs/versions and explicit step/manifest fields, not parser implementation. Legacy snapshots also have normalization and optional-field rules that Schema defaults must not silently change.

The migration's main value proposition is reducing the number of conventions an agent must infer. A permanent mixture of custom orchestration and Effect would defeat that goal. The [roadmap](README.md) defines full scope and subsequent owners.

## Goals / Non-Goals

**Goals:** one contract implementation, explicit operational failure types, stable wire/persisted behavior, version-matched examples agents can copy, and an inventory that prevents partial migration from becoming the end state.

**Non-goals:** migrating the runner/store in this phase, wrapping every pure function in Effect, changing the security policy, or publishing a reusable workflow framework.

## Decisions

### 1. Choose one supported version before writing examples

Resolve the supported Effect release line at implementation time, verify it with Bun 1.3.14, TypeScript 6, the installed build tooling, and a compiled-binary smoke check, then lock the selected version. Record version-matched official documentation links and the exact idioms used locally. Do not mix release-line APIs copied from unrelated tutorials. Keep `bun:test`; use Effect test facilities through it instead of introducing another test framework.

Use native Effect APIs directly. Do not create a project-specific `effect()` wrapper, service factory, or combinator DSL. Add platform integrations only with their first real consumer in the owning phase. Alternative: install the whole ecosystem now; rejected because unused packages and examples add choices rather than consistency.

### 2. Schema owns data decoding; domain invariants remain explicit

Migrate commands, snapshots, developer questions/answers, and built-in step input/output contracts to Schema. Infer corresponding data types where possible. Preserve pure cross-field checks as refinements or pure validation functions, including optional legacy fields, path normalization, array order, unknown-key handling, and absence versus explicit null. External adapter envelopes/configuration receive Schema at their migration boundary in phases 2–3.

Retain the existing contract identity descriptor where required by registry and assignment pins. If a synchronous `parse` facade is needed during transition or at a pure schema boundary, it delegates to the single Schema implementation; it is not a second validator. Runtime-facing decoding exposes expected validation failures rather than converting all exceptions into defects.

Never hash Schema ASTs, tagged-error internals, service values, or runtime metadata. Preserve `stableJson`, historical manifest/step digests, output schema IDs/versions, and serialized snapshots. Where old parser behavior is demonstrably unsafe, stop and propose a separately reviewed validation/compatibility change; do not silently normalize it differently as part of migration.

### 3. Use concrete failure categories, not a new stringly typed umbrella

Define a small discriminated union for real recovery choices: invalid input/artifact, unauthorized or stale run, stale revision with current revision, stale effect ownership, pin/store compatibility, and infrastructure failures introduced by following phases. Keep stable existing error codes at the external formatter. Do not create one class for each message or one broad catch that makes defects retryable.

Pure decisions can return the selected Effect release's synchronous typed result type or throw a known tagged domain failure at a documented boundary; they do not acquire services or run a runtime. Application operations later lift expected domain failures into their typed channel and retain unexpected defects separately. Tests assert recovery distinctions and bounded diagnostic fields, not Effect's default pretty-printer output. Secrets and raw input contents are not emitted by default.

### 4. Agent guidance is part of the implementation contract

Create `docs/workflow-effect.md`, linked from root `AGENTS.md` and workflow README. Describe one standard pattern each for sequential operations, tagged failures, service provision, resource ownership, schema decoding, test clock use, and the outer runtime boundary. Examples must import production symbols or live in a type-checked test/example module; avoid uncompiled snippets that drift.

State explicitly: outbox records and `Effect` programs are different concepts; durable retries are not generic `Effect.retry`; pure step behavior remains pure; no nested runtime execution; Promise/native I/O belongs in boundary adapters. Services are introduced only when a concrete production boundary is migrated, using Layers at composition roots rather than throughout domain code.

Record a source inventory by module group in `docs/workflow-effect-migration.md`: contracts/definitions, store/kernel/reducers/security, startup/config/profiles, runner/adapters/credentials/wiki/assets, telemetry, CLI, and workflow-facing TUI/shared clients. Each entry names its owning phase, callers, pure/native boundary exceptions, and migration-only bridges. This is a small evaluation record, not a benchmark framework. Baseline and final comparison outcomes for the two agent tasks are evaluated in a separate change; their protocol/template live in `docs/workflow-effect-baseline.md`.

## Risks / Trade-offs

- Schema defaults change behavior -> characterize valid/invalid/legacy normalization before deleting old parser code and pin digest fixtures.
- Error refactor collapses security distinctions -> test codes, redaction, stale ownership, and no-mutation rejection paths.
- Agent examples use unavailable APIs -> compile examples against the locked version and cite that release's docs.
- Temporary facades become permanent orchestration -> inventory exact symbols and phase-4 removal gates; pure contract identity adapters remain explicitly justified.

## Migration Plan

Capture compatibility cases and agent baseline first. Introduce Schema/errors and migrate contract callers in coherent groups, keeping the same external representation. Update all affected focused tests and verify build compatibility. Do not modify generated assets manually.

Rollback is a code/dependency rollback only if compatibility fixtures demonstrate the old binary can still read newly written data. There is no schema downgrade in this proposal; do not undo separately landed store migrations. Later phases remove migration-only facades.

## Open Questions

Exact supported Effect version and necessary platform package versions are resolved and recorded in task 1.1 before API selection. No storage or workflow-semantics decision is deferred to that task.
