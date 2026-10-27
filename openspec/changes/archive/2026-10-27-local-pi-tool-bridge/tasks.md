## 1. Confirm upstream integration boundary

- [x] 1.1 Verify the pinned Pi 1.4.0 public resource-loading APIs can select only user-level extension resources; use the loader path that does not discover `<cwd>/.pi/extensions`.
- [x] 1.2 Verify the pinned Pi MCP extension can load user `mcp.json`/`mcp-auth.json` with project trust disabled and without private deep imports; add a bounded compatibility diagnostic if the public API is insufficient.
- [x] 1.3 Inspect the exact pinned pi-durable 1.4.0 tool exposure, abort, progress, result and replay APIs; document native deferred discovery/tool_search support before choosing its mapping.

## 2. Implement the conversation-scoped extension bridge

- [x] 2.1 Add a bridge owner keyed by durable conversation and resolve current cwd/context at each call, including persistent-role rebinds.
- [x] 2.2 Load compatible user extensions through Pi's public loader and adapt static `registerTool` definitions; map `session_start`/`session_shutdown` to idempotent conversation lifecycle.
- [x] 2.3 Classify unsupported extension hooks/context APIs and prevent tools that depend on unsupported setup from registering; provide a bounded feature-class diagnostic.
- [x] 2.4 Adapt Pi tool parameters, errors, text/image/structured results, details, progress and `AbortSignal` to the durable native registration contract; do not inject run env, run tokens or other conversation context.
- [x] 2.5 Ensure host/conversation shutdown aborts in-flight bridge work and disposes extension and process-owned resources idempotently; keep bridge-owned mutable state conversation-local.

## 3. Integrate user-configured MCP

- [x] 3.1 Reuse Pi's supported user-level MCP configuration, stdio and streamable-HTTP transport, timeout/progress and local OAuth refresh behavior; do not load project MCP configuration or support legacy SSE implicitly.
- [x] 3.2 Report malformed configuration, unavailable server and user-interaction-required auth through bounded sanitized diagnostics; do not start a sign-in UI or persist credential values in durable state.
- [x] 3.3 Add cleanup for MCP calls/transports and stdio process groups on cancellation and host shutdown, without allowing one server failure to remove unrelated tools.

## 4. Enforce policy and durable callable semantics

- [x] 4.1 Add only machine-local bridge policy for tool-specific restricted-run allow rules and explicit replay overrides; do not duplicate Pi server/credential configuration or ship provider-specific defaults.
- [x] 4.2 Preserve authoritative agentic-coding tool registrations and use deterministic extension/MCP namespaces; reject or disable collisions with bounded diagnostics.
- [x] 4.3 Apply the current `ToolPolicy` to direct and nested tool calls; default-deny imported tools in read-only and orchestrator runs, and never rely on MCP annotations as authorization.
- [x] 4.4 Integrate eligible tools with the existing native codemode and native deferred `tool_search` catalogs; keep both catalogs on the current run's policy-filtered callable set and do not add a parallel sandbox/catalog.
- [x] 4.5 Mark uncertain external calls unsafe for durable replay by default and verify recovery returns an interrupted result without silently repeating a side effect.

## 5. Add isolated fixtures, focused tests and documentation

- [x] 5.1 Add a representative registerTool extension fixture and local mock MCP fixtures that load through the shared user-level configuration path without loading any real user extension or contacting a live server.
- [x] 5.2 Add focused tests for direct and native codemode execution; text/image/structured/error/progress/cancellation propagation; unsupported-feature diagnostics; cleanup; collision handling; restricted-run denial/explicit allow; and default non-replay.
- [x] 5.3 Add focused tests for per-conversation cwd/context and persistent-role rebinding, plus an empty temporary Pi configuration that proves no integration tool or outbound connection appears.
- [x] 5.4 Add focused tests for malformed/unavailable/auth-required MCP diagnostics and verify diagnostics omit credentials, expanded environment values, private URLs/headers, arguments and results.
- [x] 5.5 Document supported extension/MCP paths, user-level-only scope, unsupported Pi APIs, machine-local policy, auth re-login flow, replay limits and the trusted-code/non-sandbox boundary.
- [x] 5.6 Run focused changed-behavior tests and a CLI/build smoke check with temporary `HOME`, `AGENTIC_CODING_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `HERDR_WIKI_DIR` and host storage; verify tests never read live Pi/workflow stores.
- [x] 5.7 Verify idle-owner eviction, active-owner retention, the 256-tool refresh cap, cancellation-resistant shutdown draining and late-result rejection.
- [x] 5.8 Verify progress text/details, model-only and hidden exposure, nested calls restricted to the current durable callable set, and plain-text nested results.
- [x] 5.9 Verify orchestrator allow-listing, disabled/empty-config no-connection behavior, and separate sanitized invalid/unavailable/auth-required MCP diagnostics including codemode and non-text/error/structured outcomes.
- [x] 5.10 Re-run Biome, whole-project type-check, build and strict OpenSpec validation after remediation.
