## Why

A shared frontend is not a single application while launch, shutdown and packaging still have competing owners. The first shipping milestone needs one executable and explicit TUI-owned lifecycle while retaining both backend runtimes.

## What Changes

- Ship one executable containing unified TUI, workflow/telemetry code and embedded Go backend, with retained command aliases.
- Unify readiness, startup progress, cancellation, shutdown, signal handling and renderer cleanup.
- Verify backend ownership by spawned identity, not listener port; attach mode never stops an attached server.
- Preserve separate domain rules for action cancellation, workflow resources and externally managed containers/tmux/Herdr sessions.
- Package optional gRPC support as an internal executable mode and validate supported protocols and loopback binding.

## Capabilities

### New Capabilities

- `unified-application-distribution`: One artifact, compatible entrypoints and source-independent runtime assets.

### Modified Capabilities

- `tui-server-lifecycle`: Extend lifecycle guarantees from telemetry to the entire owned mixed-runtime stack.

## Impact

Depends on `replace-workflow-project-discovery`. Touches both build pipelines, CLI dispatch, lifecycle modules, telemetry bootstrap and embedded-server extraction. This completes the frontend-first release; porting Go and full-feature remote attachment remain deferred to the backend boundary change.
