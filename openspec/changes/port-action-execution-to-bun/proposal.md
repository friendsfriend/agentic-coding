## Why

Environment execution cannot be replaced safely by generic workflow-engine actions: its immutable definitions, command trees, readiness and dependency leases have distinct semantics. Port its execution core explicitly before moving runtime adapters.

## What Changes

- Port environment action registry, stable labels, versioned snapshots and definition compilation.
- Port command/run history, deduplicated execution, typed scoped values, dependency coordination, readiness and cancellation.
- Port shell/PowerShell/script configuration, metadata, execution, output and tmux recovery.
- Keep non-ported container/Kubernetes operations behind narrow private Go adapters; Bun alone owns run state and command accounting for migrated runs.
- Preserve distinction between environment action execution and workflow durable outbox semantics.

## Capabilities

### New Capabilities

- `bun-environment-action-engine`: Compatible Bun action registry, executor and script/process lifecycle.

### Modified Capabilities

None; workflow registry, step behavior and outbox contracts are unchanged.

## Impact

Depends on `port-git-providers-and-ai-to-bun`. Ports imported `pkg/actionregistry`, `pkg/actionrun`, `pkg/actionexec`, scripts and related handlers. Requires quiescent ownership cutover and historical fixture coverage; no live-run reparenting is promised.
