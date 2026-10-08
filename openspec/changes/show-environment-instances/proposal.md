# Proposal

## Why

Agent-owned instances, queued starts and idle timers run in the background.
Without visibility the developer cannot tell why the machine is loaded, which
workflow owns a container, or why an agent waits in a queue.

## What Changes

- An **Instances** section in the Environments feature: rows grouped by owner
  (`user`, each workflow with its title), columns app, runtime, status,
  endpoints/ports, idle time and TTL remaining.
- A **Queue** section showing queued starts with position and age.
- Actions: stop an agent-owned instance (confirmation), jump to the owning
  workflow's dashboard.
- Live updates through the existing event stream (`environment.instance.*`
  events emitted by the instance manager).

## Capabilities

### New Capabilities

- `environment-instance-view`: TUI listing of instances and queue with stop and
  navigate actions.

## Impact

- `src/tui/app/EnvironmentsFeature.tsx` and its packages under
  `packages/devenv/cli/src/tui/`, the environment keybind catalog, event
  publication in `src/server/environment/instances/`.
- Depends on `add-environment-instances`, `add-environment-instance-lifecycle`.
