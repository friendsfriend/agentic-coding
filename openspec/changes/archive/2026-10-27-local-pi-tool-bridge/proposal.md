## Why

Users already configure Pi extensions and MCP integrations for their normal local Pi agent, but agentic-coding's durable Pi host does not yet bridge those machine-local capabilities. This change adds a generic, opt-in bridge that makes compatible local tools available directly and through native durable codemode without importing provider-specific defaults or moving credentials into repository/workflow state.

## What Changes

- Reuse the installed/pinned Pi 1.4.0 user-level extension and MCP configuration path; keep project-local `.pi` configuration out of scope until durable Pi has an equivalent project-trust boundary.
- Bridge generic Pi `registerTool` integrations and user-configured stdio/streamable-HTTP MCP tools into pi-durable, with per-conversation cwd/context, supported cancellation/progress and text/image/structured results, and explicit lifecycle/disposal.
- Treat Pi's wider extension runtime as a compatibility boundary: diagnose unsupported hooks, session/context transforms, UI/commands, provider registration and other APIs; never expose a tool whose required setup is unsupported or pretend full `ExtensionAPI` parity.
- Reuse existing machine-local MCP authentication where the upstream public API supports it; do not initiate an interactive sign-in from durable Pi, and report bounded sanitized diagnostics when user action is required.
- Apply fail-closed run-specific exposure, reserved-tool collision handling and conservative nested-call replay to local integrations; integrate with native codemode and evaluate deferred discovery without bypassing authorization.
- Add isolated custom-extension/mock-MCP fixtures, focused tests and configuration/diagnostic documentation. Do not check in machine-specific endpoints, integration defaults or secrets, or run live services for tests.

## Capabilities

### New Capabilities

- `local-pi-tool-bridge`: Machine-local user Pi extension tools and MCP servers bridged into durable Pi under compatibility, lifecycle and exposure policies.

### Modified Capabilities


## Impact

Expected impact is localized to `agentic-coding/src/agent-host/`, the durable host's Pi configuration/runtime integration, focused tests and user-facing documentation. The installed Pi API is version 1.4.0 and exposes a broader extension runtime than pi-durable's existing ToolRegistration API; the supported target is a tool bridge, not full Pi extension runtime parity. The checked-out host is at the requested `fe144d5` baseline. User configuration was inspected structurally only: global Pi settings, an extension directory and a conventional `mcp.json` exist; no values or extension code were exposed or loaded, and no server was connected or configuration modified.
