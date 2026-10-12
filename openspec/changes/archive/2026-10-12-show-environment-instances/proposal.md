# Proposal

## Why

With one run per app, workflows wait for each other and for the developer. A
toast says that something waits, but the developer needs one place to see who
holds which app, who waits and for how long, and to unblock a waiter by force
releasing the holder.

## What Changes

- A **Slots** section in the Environments feature. One row per app that is
  held or waited for, with: holder (`you` or the workflow title), runtime,
  status, endpoints, held-since and idle time (TTL remaining for agent
  holders), and the waiting workflows in queue order with their wait time.
- Actions:
  - **Force release** (with confirmation): stops the holder's run and grants
    the next waiter (route from `make-app-runs-exclusive`).
  - **Open owning workflow**: jumps to the holder's or a waiter's dashboard.
- Live updates from `environment.slot.*` events, with a re-snapshot from
  `GET /api/v1/environment/apps/slots` on a sequence gap.
- The app list marks apps held by an agent, so a refused human start explains
  itself.

## Capabilities

### New Capabilities

- `environment-instance-view`: TUI listing of app slots, holders and waiters,
  with force-release and navigation actions.

## Impact

- `src/tui/app/EnvironmentsFeature.tsx` and its packages under
  `packages/devenv/cli/src/tui/`, the environment keybind catalog.
- Depends on `make-app-runs-exclusive` and `add-environment-instance-lifecycle`.
