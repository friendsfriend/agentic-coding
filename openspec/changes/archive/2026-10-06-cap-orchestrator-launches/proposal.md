# Proposal

## Why

The orchestrator can start any number of workflows. Each one launches agents,
spends model budget and holds a worktree. A misread request, a retry loop in the
model, or a wake-up (`add-orchestrator-workflow-monitoring`) that the model
answers with "start another one" can fan out without bound. The developer needs
a hard ceiling that the server enforces regardless of what the session decides.

## What Changes

- `[agents.orchestrator] limits = { max_active, max_starts_per_day }` with
  defaults `3` and `20`.
- The server refuses an orchestrator start with 409 `orchestrator-limit` when the
  number of active (not `completed`/`closed`) orchestrator-started workflows
  across all workflow targets has reached `max_active`, or when the number of
  orchestrator starts in the trailing 24 hours has reached `max_starts_per_day`.
  The refusal names the limit, the current count, and the workflows counted.
- Operator starts are never limited or counted.
- Limits are file-only configuration, shown read-only in Settings.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `home-orchestrator`: adds server-enforced launch limits.

## Impact

- `src/server/orchestrator-policy.ts` (pure limit decision),
  `src/server/app.ts` (enforcement before `operations.start`).
- A bounded count over the workflow target registry
  (`src/workflow/runtime/target-registry.ts`) and the stores' `startedBy` and
  `created_at`.
- `src/workflow/profiles.ts` (parse/validate `limits`), Settings inventory
  (read-only entry), `docs/orchestrator.md`.
- Depends on `attribute-orchestrator-actions` (`startedBy`).
