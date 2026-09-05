## Why

Effect leases expire after 30 seconds while a claimed batch executes sequentially without renewal. Architecture review reproduced a 31-second handler executing 20 times, exceeding the stored four-attempt limit, with no completion recorded.

## What Changes

- Claim effects only when execution capacity is available.
- Renew ownership during long-running work and reject expired ownership consistently.
- Bound subprocess execution and stop initiating external work after ownership loss.
- Apply attempt exhaustion to expired-lease recovery, not only handler errors.
- Add deterministic long-operation, crash-recovery, and competing-runner checks.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-state-runtime`: Renewable effect ownership and bounded expired-lease recovery.

## Impact

- Priority: high; architecture finding 1. No prerequisite changes.
- Code: `agentic-coding/src/workflow/effect-runner.ts`, `runtime/engine.ts`, `runtime/store.ts`, `runtime/reducers/effect-result.ts`, and subprocess calls used by effect handlers.
- Tests: workflow effects, runtime, adapters, and credentials.
- Existing outbox schema and idempotency keys should be reused. No queue service or new dependency.

## Non-goals

No runner daemon, parallel execution framework, workflow graph change, or redesign of credentials UI.
