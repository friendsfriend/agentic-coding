# Proposal

## Why

Everything the orchestrator does reaches the engine as an ordinary developer
command: its starts and actions are recorded with a `developer` actor, and the
workflow carries no trace of who started it. The developer cannot tell which
workflows the orchestrator launched, the event history cannot distinguish its
actions from theirs, and the follow-up changes (monitoring, launch limits) have
nothing to scope by.

## What Changes

- Workflows started by the orchestrator principal pin `metadata.startedBy =
  "orchestrator"` at start; operator starts pin `"developer"`. Older snapshots
  without the field read as `"developer"`.
- Developer actions dispatched by the orchestrator principal are recorded with
  actor `{ kind: "developer", principal: "orchestrator" }`; operator actions keep
  today's actor shape unchanged.
- The workflow view and overview expose `startedBy`; the workspace sidebar marks
  orchestrator-started rows; `list_workflows` / `workflow_status` return it.
- The principal travels from the server to the engine as a server-decided
  option, never as a wire field.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `home-orchestrator`: adds attribution of orchestrator starts and actions.

## Impact

- `src/contracts/workflow.ts` (`WorkflowMetadata.startedBy`, view/overview field,
  snapshot schema with an optional field — no store migration).
- `src/server/app.ts`, `src/server/handlers.ts` (principal into start/action).
- `src/workflow/startup.ts`, `src/workflow/runtime/engine.ts`,
  `runtime/reducers/developer-action.ts` (event actor).
- `src/workflow/runtime/view.ts`, `src/server/operations/observations.ts`
  (projection), `src/tui/otel/components/WorkspaceSidebar.tsx`,
  `src/agent-host/orchestrator.ts` (tool output).
