## Why

Workflow work currently requires agents to learn custom parsers, thrown-error conventions, dependency wiring, and asynchronous lifecycle patterns. The main migration goal is a consistent, documented Effect programming model that makes agent-authored changes easier to implement and verify; productivity gains must be observed rather than assumed.

## What Changes

- Establish the first of four ordered changes for a full workflow-layer migration; see [migration roadmap](README.md).
- Select and lock a supported Effect release compatible with the repository's Bun, TypeScript, and compiled binary; use version-matched official APIs.
- Replace workflow command, snapshot, question, and step input/output parser implementations with Effect Schema while preserving accepted data, normalization, contract identities, and definition digests.
- Introduce concrete tagged operational failures and one mapping to existing external diagnostics; distinguish expected failures, defects, and interruption.
- Publish agent-facing conventions with checked examples, migration inventory, and a small before/after task protocol.
- **BREAKING:** Internal contract/error APIs migrate toward Schema and typed failures. Temporary caller bridges are explicit and removed by the final proposal; external CLI/JSON and persisted formats remain compatible.

## Capabilities

### New Capabilities

- `workflow-effect-conventions`: Version-matched Effect idioms, typed failure boundaries, Schema ownership, and discoverable agent guidance.

### Modified Capabilities

- `workflow-state-runtime`: Schema migration compatibility for persisted and external workflow contracts.

## Impact

- Code: `agentic-coding/package.json`, lockfile, `src/workflow/contracts.ts`, `definitions/contracts.ts`, registry contract integration, and directly affected callers/tests.
- Guidance: `AGENTS.md`, `agentic-coding/src/workflow/README.md`, and new `agentic-coding/docs/workflow-effect.md` and `workflow-effect-migration.md`.
- Add `effect`; add platform packages only when a following phase implements an actual platform service. Keep Bun tests and Biome.
- No implementation prerequisite among the new proposals. Coordinate contract changes with in-flight store migration work; later phases have explicit architecture prerequisites.

## Non-goals

No durable-engine replacement, database migration, new workflow semantics, generic service framework, agent instruction asset rewrite, or claim of guaranteed agent productivity. This phase does not finish execution or caller migration.
