## Context

The implementation is based on the `fe144d5` baseline. Agentic-coding pins `@earendil-works/pi-coding-agent`, `pi-durable`, `pi-ai` and `pi-codemode` to 1.4.0; the installed Pi CLI is also 1.4.0. The durable host currently uses pi-durable's `defineExtension`/`defineTool` registry and native durable codemode, with per-conversation IDs and run-specific `ToolPolicy`. It does not host Pi's complete extension session runtime. The implementation verified the pinned public API declarations and exercises only temporary user-level fixtures; no live user extension, MCP server, or credential was accessed.

The installed Pi extension API is substantially broader than tool registration. `ExtensionToolContext` carries cwd, mode/UI, a read-only Pi `SessionManager`, `ModelRegistry`, an abort signal, active/callable tools and nested `executeTool`; tool definitions also carry TypeBox parameters, output schema, exposure, annotations, custom renderers and progress callbacks. Pi extensions can register session, agent, turn, message, context-transform, provider, input, tool-call/result and MCP lifecycle hooks, commands, shortcuts, UI, providers and persistent entries. A Pi tool's result can contain text/image content, details, structured output and an error; cancellation and nested-call progress are part of its contract.

The Pi MCP APIs support stdio and streamable HTTP (not legacy SSE), configurable exposure, request timeout/progress, OAuth refresh and a machine-local credential store. The installed Pi docs and APIs include `createMcpExtension`, `McpClient`, `StreamableHttpTransport`, and a public `loadExtensions` loader. Pi's convenience `discoverAndLoadExtensions()` unconditionally searches `<cwd>/.pi/extensions` as well as global paths; Pi only loads project extensions and `<cwd>/.pi/mcp.json` after project trust. Durable Pi has no equivalent user trust prompt. The selected scope is therefore user/global Pi configuration only, not project-local resources.



## Goals / Non-Goals

**Goals:**

- Give durable Pi access to generic user-level Pi extension tools and user-configured MCP tools through one supported configuration path.
- Keep each bridge runtime and its mutable state scoped to its durable conversation; rebind cwd/run identity through the host's current context lookup and do not pass workflow run environments or capability tokens into extension context.
- Preserve supported tool parameters, errors, text/image/structured output, progress and cancellation; dispose session-scoped extensions and transports cleanly.
- Apply the durable host's direct/callable tool semantics, run-specific tool policies, native codemode and any supported native deferred-discovery path without widening permissions.
- Fail closed with bounded, sanitized diagnostics when configuration, authentication, upstream compatibility, collision or policy checks fail.

**Non-Goals:**

- Full Pi ExtensionAPI/session-runtime parity, a second Pi agent loop, project-local `.pi` resources, new OAuth UI, a plugin sandbox, provider-specific integrations/defaults, checked-in endpoints or secrets, broad telemetry, or loading/executing the developer's live extensions in tests.
- Treating MCP annotations or user extension claims as authorization, read-only proof, or replay-safety proof.

## Decisions

### Use Pi's user-level configuration and public loaders; exclude project resources

Resolve the global agent directory from the host's configured Pi agent directory and initialize Pi's public `DefaultResourceLoader` against that directory with project trust disabled. Filter its loaded resources before binding; do not call `discoverAndLoadExtensions()` with a workflow cwd because that helper searches project-local paths. Use Pi's built-in `createMcpExtension` / standard MCP configuration path with project trust disabled so it reads only the existing user `mcp.json` and user auth store. Do not create a parallel file format for server endpoints, credentials, extension paths or package installation.

The existing agentic-coding user configuration may add only bridge policy (enablement, restricted-run allow rules and explicit replay overrides), not duplicate Pi server definitions or credentials. Defaults contain no provider/vendor-specific tools. The bridge does not install/update packages automatically; it only loads already configured/resolved resources. If pinned public Pi APIs cannot provide user-only resource discovery or auth without reaching into unstable private modules, stop and surface a bounded compatibility diagnostic rather than silently loading project config or building a second config parser/auth store.

### Bridge a defined tool subset, not the whole Pi runtime

Use Pi's extension loader to load user extension modules and collect their registrations; use a per-durable-conversation bridge runtime to adapt eligible `registerTool` definitions into pi-durable registrations. Support static tool metadata/schema and execution, per-call `cwd` and `AbortSignal`, progress, text/image output, structured output, ordinary tool errors and explicitly marked error results. Bound imported tool registrations to 256 per owner, result content to 256 items and 64 KiB, progress-content inspection to 256 items, and structured JSON traversal by depth, node and container-entry budgets. Nested durable calls preserve bounded ordinary text and error diagnostics when structured output is absent. `ctx.executeTool` may call only tools that the current durable conversation is authorized to call, through the host's native execution API; it receives no unfiltered host registry.

Map Pi's `session_start`/`session_shutdown` only to the bridge conversation's creation/disposal lifecycle. Do not pretend Pi's context transform, provider, user-input, session replacement/tree/compaction, command/shortcut, persistent-entry, custom UI or rendering hooks have durable equivalents. A user extension that registers unsupported hooks or APIs is reported as unsupported and its affected tools are not exposed; runtime use of a UI/session/model capability that cannot be established at load time returns a clear unsupported-context error. The bridge declares `hasUI: false`; it never simulates user confirmation or silently accepts a UI-dependent tool. Pi extension code runs with the host process's user permissions and is trusted code, not sandboxed.

The `createMcpExtension` implementation is the upstream lifecycle/transport/auth path for configured MCP servers, with its normal stdio and streamable-HTTP transports and user-local OAuth credential store. Its default exposure and server overrides are retained only where they fit durable policy. When a server needs user interaction that durable Pi cannot provide, do not open a browser or collect credentials from a model call; return a bounded `sign-in required` diagnostic directing the user to Pi's normal login surface. Never copy `mcp-auth.json`, environment values, OAuth tokens or headers into agentic-coding configuration, durable conversation state, tool details or logs.

### Scope every bridge session and tool call to the current durable conversation

Create one bridge owner per durable conversation, not one mutable shared extension context for all runs. The current conversation-to-run context lookup supplies the current cwd and identity for each invocation, including persistent roles that are rebound on later runs. Tool factories and mutable MCP client state belong to that bridge owner. The owner table is capped at 32 entries: before creating another owner, evict the least-recently-used owner with no active calls; never evict a live invocation, and fail closed if all owners are active. Closing an owner aborts active calls and awaits their completion before emitting idempotent `session_shutdown`, disposing the Pi session and releasing registrations no longer used by another owner. Host shutdown uses the same drain boundary. A trusted callback that ignores its signal can therefore delay shutdown indefinitely; the in-process bridge cannot safely force-terminate arbitrary extension code. If an extension module deliberately uses process-global state, the bridge cannot sandbox or prevent that trusted code from sharing it; do not place bridge-owned run context or mutable data in a process-global extension registry.

Never pass `DurableRunContext.env`, `HERDR_RUN_TOKEN`, other run capabilities, classifier bindings, or another conversation's paths/context into Pi's `ExtensionContext`. The code is still trusted local code and can inspect the host process/OS under the same-user permission boundary; document that explicitly rather than claiming isolation from malicious extensions.

### Preserve authoritative names and durable exposure semantics

Keep all agentic-coding built-in and workflow tools authoritative. Name imported user extension tools with a deterministic extension namespace; preserve Pi's documented `mcp__<server>__<tool>` namespace for MCP. Resolve collisions before registration: an external tool must never replace a built-in/workflow tool, and duplicate imported names are disabled with a deterministic, bounded diagnostic rather than last-registration-wins behavior. Keep origins/namespaces for policy decisions and diagnostics without exposing local endpoint or credential values.

Translate Pi tool exposure only into durable-native registrations that have equivalent semantics: direct declarations are model-callable; codemode-only tools remain callable only through the durable agent's native codemode; hidden tools are omitted; and `model-only` tools are not offered to nested callers. Map deferred tools to native `deferred: true` registrations with model/tool callers, and install pi-durable's native `tool_search` extension only when the bridge is enabled. Its search/activation uses the current conversation's selected tool set, which is already filtered by the current `ToolPolicy`; no parallel catalog or permission bypass is introduced.

Normal writable durable runs may use configured, enabled integrations subject to Pi exposure and durable registration. Read-only and orchestrator runs expose no imported tools by default. A machine-local, explicit tool-specific policy may allow a named external tool for a restricted policy; absence of that rule means denied. MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) and extension descriptions are untrusted hints, never authorization or proof of read-only/safe-to-replay behavior. Native codemode's run-scoped callable set is the same boundary as direct model exposure; nested calls must be rechecked by the host rather than trusting a script's catalog.

### Treat uncertain external calls as non-replayable

External extension and MCP invocations are `unsafe` for durable replay by default. A crash or uncertain completion must return an interrupted result to the model rather than silently reissue the external operation. An explicit machine-local replay policy can opt a specifically named integration tool into native safe replay only when its operator accepts duplicate-side-effect risk; Pi annotations alone cannot grant this. Preserve the existing native codemode nested-call journal and host shutdown behavior; do not implement a second retry/replay engine or promise exactly-once effects.

### Diagnostics and validation are local and bounded

Provide one bounded diagnostic per relevant failure class: malformed/unsupported config, extension load/factory error, unsupported extension API/hook, MCP unavailable/timeout, auth interaction required, duplicate/reserved collision, restricted-policy denial, result conversion failure, cancellation and disposal failure. Startup diagnostics include a static recovery hint for user-level Pi settings or Pi login, as applicable. Diagnostics identify the extension/server by a local safe label and the failure class, but omit credentials, resolved environment values, request/response payloads, private URLs/headers, full tool arguments/results and run capability data. Diagnostics are operational, not a second telemetry stream.

Focused tests use a temporary HOME, `AGENTIC_CODING_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `HERDR_WIKI_DIR` and temporary host storage. A representative custom tool extension and local mock stdio/HTTP MCP fixtures are loaded through the shared configuration path, without executing any real user extension or contacting live systems. A second empty machine/config fixture proves no integration tools are registered and no outbound connection is opened.

## Risks / Trade-offs

- **[Pi extensions expect hooks, UI or session state that durable Pi cannot provide]** → The supported contract is explicitly tool-oriented; unsupported registrations disable affected tools and produce bounded diagnostics. Document trusted-code/API limits and add fixtures for both a compatible tool and a rejected dependency on unsupported context.
- **[Pi's public resource discovery includes project paths by default]** → Use a user-only public loader path; test that project extension/MCP fixtures are not loaded. If user-only discovery/auth cannot be done on public APIs, stop rather than fall back to project discovery or an independent secret parser.
- **[OAuth sign-in requires interactive Pi UI]** → Reuse existing user-local auth and upstream refresh only; report sign-in-required when it cannot proceed, and never initiate login in the durable host.
- **[Arbitrary local integrations can mutate state or repeat side effects]** → Deny them in restricted runs unless explicitly allow-listed in machine-local policy; mark calls non-replayable by default; document same-user trusted-code and uncertain-side-effect boundaries.
- **[Durable host serves multiple conversation owners while Pi modules can cache process state]** → Keep registrations, cwd and bridge clients per conversation; cap owners at 32 and evict only idle owners. Verify concurrent isolation, persistent-role rebinding and cleanup of an evicted owner. Module code can intentionally share process globals; this is part of the disclosed trusted-code boundary, not a sandbox guarantee.
- **[A local callback ignores cancellation]** → Do not claim that shutdown terminated the in-process callback. Await its completion before reporting shutdown complete; the trusted-code boundary means an uncooperative callback can delay host shutdown.
- **[Large catalogs or upstream deferred semantics drift]** → Recheck the pinned pi-durable 1.4.0 declarations and run-level callable catalog; use only native discovery if available, otherwise fail closed and keep tests explicit.

## Migration Plan

1. Add the user-level bridge and machine-local policy as opt-in durable-host behavior with no changes to the Pi user's existing config or MCP files.
2. Add focused isolated extension/MCP fixtures and policy/cancellation/recovery tests before enabling it in the default durable host path.
3. Document supported tool registration, user-only source scope, unsupported APIs, authentication handoff, safe-replay defaults and same-user trusted-code boundary.
4. Roll back by disabling/removing the bridge registration and policy section; existing durable tools, host storage and Pi configuration remain readable and unchanged. No data migration is required.

## Pinned API findings

- Pinned pi-durable 1.4.0 provides `createToolSearchExtension()` and native deferred-tool loading through `control.addTools`. The host installs that native extension only when the bridge is enabled; its `api.agent(context).deferred` catalog is scoped to the current conversation's already policy-filtered tool selection. Eligible Pi `deferred` tools therefore use native search; tools that require unsupported dynamic `prepareLoadout` or `reachesTools` APIs remain omitted.
- The bridge uses Pi's public `DefaultResourceLoader`, `createAgentSession`, `createMcpExtension` and `ExtensionRunner` APIs, with project trust disabled and temporary fixtures proving project `.pi` integrations are excluded.
