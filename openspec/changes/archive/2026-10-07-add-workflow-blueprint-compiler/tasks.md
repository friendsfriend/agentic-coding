# Tasks

## 1. Blueprint model

- [x] 1.1 Add the blueprint Effect Schema and the blueprint step catalog (allowed logical steps with id, label, actor, outcomes, description). Verify decode tests and that every catalog entry is a registered step and no internal step is listed.
- [x] 1.2 Add the human-review validator over the logical graph. Verify one passing and one failing fixture per rule, including a loop that returns to implementation after review.

## 2. Compiler

- [x] 2.1 Implement `compileBlueprint`: reject internal steps, insert triage routing, gates and per-step routing via the built-in transforms, pin exact step refs, derive policy from traits, dry-compile, enforce bounds. Verify diagnostics for each rejection.
- [x] 2.2 Verify equivalence: blueprints for `openspec`, `no-openspec` and `solo` compile to the same steps and edges as the newest-tier built-ins; the same blueprint compiles to the same digest twice.
- [x] 2.3 Verify the compiled manifest passes the custom-definition invariants check from `persist-custom-workflow-definitions`.
- [x] 2.4 Document blueprints in `docs/workflow-architecture.md`; run `bun run lint`, `bun run type-check` and the domain-layer purity tests.
