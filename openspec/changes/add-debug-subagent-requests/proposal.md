# Proposal

## Why

Implementation agents and verifiers should be able to hand a focused
"reproduce / check this in the running app" task to the debug role and keep
working, instead of spending their own context on browser sessions. The
developer must be able to see what was asked and found, without being asked to
approve it.

## What Changes

- Tools for every durable run except debug runs themselves:
  - `debug_request({goal, context?, apps?})` → request id; starts a `debug`
    role run asynchronously in the **caller's worktree** with the caller
    workflow's owner (shared instances);
  - `debug_result(id)` → status and report when done;
  - `debug_wait(id, timeoutSec?)` → blocks until done or timeout (≤ 30 min);
  - `debug_cancel(id)`.
- On completion the engine **injects** the report into the caller's
  conversation as a follow-up message (`AgentHost.submit(..., "followUp")`). If
  the caller run has ended, the report stays available as an artifact.
- Limits: one open request per caller run, two per workflow; recursion
  forbidden.
- **Handoff guard:** a caller cannot hand off while it has open requests unless
  it cancels them.
- Shared-worktree convention in both prompts; the result lists files the debug
  run touched with their diff.
- Read-only TUI view: dashboard "Debug requests" list (caller role, goal,
  status, duration) opening the report and the request's evidence. No actions.

## Capabilities

### New Capabilities

- `debug-subagent-requests`: request lifecycle, async delivery, limits, handoff
  guard, touched-file reporting, read-only view.

## Impact

- Workflow store table `debug_requests` (migration), CLI
  `agentic-coding workflow debug-request|debug-result|debug-wait|debug-cancel`,
  effects `debug.request.run` / `debug.request.deliver`, handoff guard in
  `src/workflow/cli/commands/`, `src/agent-host/tools.ts` (four tools),
  `AgentHost.submit` use, dashboard section + `debug-requests` observation.
- Depends on `add-debug-workflow` (role).
