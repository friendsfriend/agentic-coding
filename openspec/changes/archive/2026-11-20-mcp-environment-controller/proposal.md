## Why

Environment management should be usable from OpenCode and other MCP clients without maintaining another coding-agent application. Its ownership, exact-plan approval and conservative recovery guarantees must survive the move out of the Pi-native task host.

## What Changes

- Introduce an MCP-first environment controller boundary, independent of client presentation and model execution.
- Begin with a separate read-only stdio entrypoint for configured environment discovery/catalog inspection, reusing the v2 environment rules without opening a native harness or reading provider credentials.
- Incrementally extract storage, execution scopes, approvals and runtime orchestration from the native host before exposing mutating MCP tools.
- Keep human approval on a separate operator interface, never a model-callable approval tool. Preserve immutable plans, request identity, live-handle ownership, quarantine and bounded/redacted diagnostics.
- Ultimately support one local authenticated controller shared by clients, with optional stdio bridges. Independent read-only catalog processes in the first slice have no resource authority.
- Defer OpenCode plugins, custom tool renderers and UI wrappers. Future developer review should retain v1 diff/comment behavior, with a transcript file list if public APIs allow; environment UI stays separate from the transcript.

## Capabilities

### New Capabilities

- `mcp-environment-controller`: Portable environment tools, controller-owned execution scopes and operator-only approval, introduced through a read-only catalog milestone.

### Modified Capabilities

None. Existing native-host behavior is not replaced in the first milestone.

## Impact

Initially adds `agentic-coding-v2/src/mcp/`, a separate package script, official MCP SDK/schema dependencies, focused tests and documentation. Later stages touch environment persistence and runtime adapters through explicit seams; they must not rewrite concurrent review/runtime work or import existing live resources. No real engines, providers, credentials, running application hosts or MCP accounts are used during verification.
