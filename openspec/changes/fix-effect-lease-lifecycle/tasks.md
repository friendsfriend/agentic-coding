## 1. Reproduce and define ownership

- [ ] 1.1 Add a fake-clock regression using the real engine/outbox and a handler exceeding 30 seconds; assert it cannot execute beyond the stored automatic attempt budget.
- [ ] 1.2 Add tests for a slow first effect, competing claimers, expired renewal, and stale completion without wall-clock sleeps.

## 2. Correct claiming and renewal

- [ ] 2.1 Make the serial runner claim one effect when it can begin execution, preserving the bounded drain budget.
- [ ] 2.2 Centralize lease validity using the injected engine clock; include expiry in effectIsLive and implement token-bound, unexpired CAS renewal.
- [ ] 2.3 Add renewal lifecycle around active observation/execution and dispose renewal on completion, failure, cancellation, or ownership loss.
- [ ] 2.4 Enforce exhausted expired leases transactionally with failed status, attention, and audit event; define bounded explicit operator retry without resetting effect identity.

## 3. Handle slow work and ownership loss

- [ ] 3.1 Inventory all blocking subprocesses reachable during a claimed effect; convert potentially long calls to bounded asynchronous execution so renewal is not starved.
- [ ] 3.2 Connect ownership loss to subprocess cancellation and prevent further external actions; restrict cleanup to resources still owned by that execution.
- [ ] 3.3 Test crash-after-success observation, repair during execution, credential waits exceeding the original lease, cancellation cleanup, and a successor adopting existing resources.

## 4. Validate and document

- [ ] 4.1 Run affected workflow-runtime, workflow-effects, workflow-adapters, and workflow-credentials tests; verify long work completes once and expired recovery stops at its budget.
- [ ] 4.2 Update workflow architecture/recovery docs with claim capacity, renewal, exhaustion, and mixed-version runner restrictions.
- [ ] 4.3 From agentic-coding/, run bun run type-check, bun run lint with zero diagnostics, and bun run build.
- [ ] 4.4 Run openspec validate fix-effect-lease-lifecycle --strict and review the diff for unrelated workflow changes.
