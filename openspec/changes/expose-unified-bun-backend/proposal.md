## Why

Workflow execution and telemetry still live beside the renderer, while environment operations use Go HTTP/SSE. A stable Bun server boundary enables later runtime replacement without another frontend rewrite and prevents terminal suspension from blocking backend work.

## What Changes

- Move workflow application, observations, telemetry collection and persistence ownership into one Bun server process.
- Make the TUI a typed HTTP/SSE client and retain a private Go compatibility backend for unported environment routes.
- Add authenticated, bounded request/response and credential-prompt routing with preserved workflow revisions and run capabilities.
- Define event ordering, bounded buffering, reconnect resynchronization and owned cancellation.
- **BREAKING** architectural constraint: replace the former mandatory in-process dashboard/engine coupling with a typed server boundary; existing public workflow command semantics remain.

## Capabilities

### New Capabilities

- `unified-backend-api`: Authenticated Bun API, event and interaction boundary with temporary Go delegation.

### Modified Capabilities

- `agentic-coding-consolidation`: Update target surface map and migration invariant from in-process dashboard engine access to one server API.
- `dashboard-engine-integration`: Replace direct engine/Herdr imports and dashboard-owned execution scopes with authenticated client operations and server-owned execution, preserving cancellation and command authority.

## Impact

Depends on `unify-application-lifecycle-and-binary`. Touches workflow application/operations, dashboard observation bridge, telemetry modules, clients, CLI caller authentication and architecture checks. No workflow domain rewrite or Go service port in this change.
