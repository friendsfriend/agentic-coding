## Why

Recurring stuck agents expose a systemic gap between durable workflow intent and process-local host authority. Obsolete launch effects can also remain retryable after their runs retire, blocking validated workflow actions.

## What Changes

- Separate authenticated ordinary host dispatch from privileged parked-task recovery without interrupting busy hosts.
- Centralize effect eligibility and retirement across exposure and atomic command validation.
- Add bounded, previewed, audited reconciliation for stuck launch records, preserving leases, outcomes, human gates and evidence.
- Distinguish queued, claimed, admitted, working, failed and recovery-blocked states.

## Capabilities

### New Capabilities
- `durable-agent-launch-lifecycle`: Safe cross-process admission, effect fencing, supported recovery and truthful lifecycle visibility.

### Modified Capabilities

- `orchestrator-workflow-recovery`: Reconcile expired launch claims and demonstrably unstarted pending runs through reviewed bounded recovery; retain authenticated developer cross-step Repair while restricting orchestrator recovery to the current step.

## Impact

Host client/authority boundary, workflow outbox and command validation, recovery APIs and status projections; deterministic isolated tests and correction of stale recovery documentation. One primary change, no independent follow-ups: authority, retirement and reconciliation must compose to resolve the reported state safely. Preserve main's ab82223 multi-target Repair and f0e6965 nested-codemode outcome handling, squash delivery and every human gate. No live recovery, deployment, scheduler redesign, speculative preset migration or store schema migration is authorized.
