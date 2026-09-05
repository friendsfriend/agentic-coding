## 1. Prepare behavior oracles

- [ ] 1.1 Confirm evidence separation and behavior-pin resolution prerequisites are implemented; record existing state/event/run/effect outputs and pins for supported workflows.
- [ ] 1.2 Add verification characterization cases for all parallel completion orders, critical findings, clean rounds, one-time test-verifier execution, retry, and loop exhaustion.
- [ ] 1.3 Add equivalent fusion survivor/counting, planning/consolidation validation, and delivery chaining cases before moving their decisions.

## 2. Move completion ownership

- [ ] 2.1 Extend the existing step behavior contract with a constrained completion result using validated facts; audit StepDefinition.reduce callers before consolidating redundant built-in plumbing.
- [ ] 2.2 Implement generic runtime application of local updates, legal transitions, authorized run requests, and allowlisted effects inside the existing transaction.
- [ ] 2.3 Move verification completion into its registered behavior and run its characterization suite unchanged.
- [ ] 2.4 Move fusion completion into its registered behavior and verify surviving results, handoff orders, and retry behavior unchanged.
- [ ] 2.5 Move planning/consolidation completion and effect-gated validation into registered behavior with unchanged primary-change validation.
- [ ] 2.6 Move delivery chaining into registered behavior while leaving cross-cutting cleanup and ownership enforcement in the runtime.
- [ ] 2.7 Remove duplicate generic step-ID completion branches and redundant built-in decision paths after confirming every caller uses the pinned behavior resolver.

## 3. Preserve safety and compatibility

- [ ] 3.1 Test invalid capabilities/evidence/leases reject before hook execution and forbidden hook output rolls back without consuming capabilities or launching effects.
- [ ] 3.2 Test persistence failure after behavior evaluation and verify state, events, effects, and parallel results remain atomic.
- [ ] 3.3 Confirm definitions, semantic pins, actions, context carry-over, run/effect identities, and supported output ordering remain equivalent to baseline.

## 4. Validate and document

- [ ] 4.1 Run affected workflow-steps, workflow-registry, workflow-runtime, workflow-effects, workflow-plan-fusion, workflow-plan-primary-change, and workflow-e2e tests.
- [ ] 4.2 Update workflow architecture docs with completion ownership, constrained result fields, security boundary, and remaining intentional step-identity checks.
- [ ] 4.3 From agentic-coding/, run bun run type-check, bun run lint with zero diagnostics, and bun run build.
- [ ] 4.4 Run openspec validate centralize-step-completion-behavior --strict; defer discovered behavior fixes rather than altering move-only baselines.
