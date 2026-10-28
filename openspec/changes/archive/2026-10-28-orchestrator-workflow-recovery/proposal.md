## Why

The home orchestrator cannot return corrective context to a blocked worker with no pending question or safely restart it. Supported, audited recovery is needed instead of manual storage edits or misusing paused-only resume.

## What Changes

- Add explicit revision-guarded orchestrator recovery inspection, preview and execution through supported server tools.
- Persist bounded recovery instructions into replacement worker input and preserve history and attribution.
- Reuse engine repair/retry and effect dispatch; enforce human gates, ownership and active-run safety server-side.
- Add isolated deterministic integration and negative tests and precise tool guidance.

## Capabilities

### New Capabilities

- `orchestrator-workflow-recovery`: Bounded authorized recovery of blocked workers and repairable workflow integrity states without human approval bypass.

### Modified Capabilities

None. The existing specs directory has no matching capability; this change adds a single end-to-end recovery capability.

## Impact

Home orchestrator tools, server authorization/operations, existing runtime recovery boundaries, focused tests and guidance. No dependency changes, live workflow repair, configuration edits or storage surgery.
