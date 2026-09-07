## Context

Generic reducers currently know verification role aggregation, test-verifier sequencing, fusion fan-out completion, planning OpenSpec validation, and delivery commit/push chaining. Existing step behavior owns entry/arrival but the built-in reduce callback is largely an unchanged-snapshot adapter.

## Goals / Non-Goals

**Goals:** one owner for completion semantics and a generic engine that enforces safety independently of step identity.

**Non-goals:** changing verification limits, routing, graph topology, context precedence, capability policy, or external plugin discovery.

## Decisions

### Extend one existing behavior contract

Use the existing registered step behavior to accept authenticated agent completion and completed effect facts. It returns only the changes the current implementations require: local step-state updates, a legal transition outcome/context, requested runs, and allowlisted effects. Avoid a second reducer registry or arbitrary engine callback in hook context.

Reuse/consolidate StepDefinition.reduce where practical; built-ins must not keep two competing completion decision paths. Preserve its public contract until callers and extension-seam tests have been audited. Hooks use the pinned step resolver introduced by `version-workflow-behavior-pins`.

### Runtime owns authorization and atomicity

The engine verifies exact run identity, generation, capability, evidence schema/digest, action revision, and effect lease before invoking behavior. It validates returned fields, routes, effect kinds, and legal graph outcomes, then applies run bookkeeping, capability consumption, state, event, and outbox writes in the existing transaction. Hooks receive no Database, filesystem, subprocess, clock function, or network port.

Runtime-internal persistence reducers may remain SQL-aware; pure domain completion hooks do not. Cross-cutting closure, repair, and security/capability shaping are not moved merely because their code mentions a step ID.

### Move one decision family at a time

Characterize and extract verification first: parallel result preservation, critical findings, loop limits, and the one-time test-verifier follow-up. Then extract fusion counting and survivor reuse, planning/consolidation validation requests, and delivery chaining. Keep global effect cleanup and ownership expiration in the engine.

Each move must preserve state, events, run/effect identities and ordering where contractual, actions, and graph/semantic pins. If a behavior bug is discovered, document it separately rather than slipping it into a relocation diff.

## Risks / Trade-offs

- Hook outputs could become an unrestricted engine scripting API → use the smallest closed result shape needed by existing steps and validate every request.
- Aggregation moves can lose parallel results → test multiple handoff orders and retries against the pre-move behavior.
- A new hook could obscure transaction ownership → keep SQL changes visible in the runtime and test rollback after hook evaluation.

## Migration Plan

Land evidence separation and exact-version lookup first. Add hooks with equivalent behavior and migrate one family per focused green test run. Remove redundant built-in decisions only after all callers route through registered behavior. This is behavior-preserving and needs no new semantic version solely for moving functions; any observable difference requires a separate compatibility decision.
