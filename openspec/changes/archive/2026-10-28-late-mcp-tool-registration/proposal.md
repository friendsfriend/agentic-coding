## Why

A durable Pi conversation snapshots its owner’s MCP tools before slower MCP servers finish starting, leaving those later-registered tools unavailable to that conversation’s model and native codemode. This change makes supported late catalog changes usable without restarting or recreating a conversation while preserving safe turn and lifecycle boundaries.

## What Changes

- Keep MCP startup bounded and promptly expose tools from ready servers while propagating later supported registrations and catalog changes to their owning durable conversation.
- Define safe refresh behavior across turn admission, active execution, cancellation, disposal, eviction, and shutdown; keep catalog selection, policy, and isolation guarantees intact.
- Add deterministic fake-server regression coverage for delayed, unavailable, and post-disposal registration paths, including native codemode in one durable conversation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-pi-tool-bridge`: require late MCP registrations and supported catalog changes to reach the owning durable conversation's authorized model, deferred-discovery, and native codemode surfaces without restarting or manually refreshing the bridge.

## Impact

- `agentic-coding/src/agent-host/pi-tool-bridge.ts` and `host.ts`: bridge owner catalog propagation, current run policy selection, and safe conversation tool-selection refresh.
- `agentic-coding/test/agent-host-pi-tool-bridge.test.ts`: deterministic fake delayed/unavailable MCP-server regression and lifecycle/policy coverage, using isolated test configuration.
- `agentic-coding/docs/settings-inventory.md` and the `local-pi-tool-bridge` OpenSpec delta: distinguish late MCP catalog propagation from still-unsupported dynamic Pi extension registration and document the safe availability boundary. Inspect current pinned Pi public hooks before implementation chooses a mechanism. No dependency upgrade or Azure-specific fixture is in scope.
