# local-pi-tool-bridge Specification

## Purpose
TBD - created by archiving change local-pi-tool-bridge. Update Purpose after archive.
## Requirements
### Requirement: User-level Pi configuration is the bridge source
The durable host SHALL discover configured user-level Pi extension and MCP tools through Pi's supported configuration/resource-loading path. It SHALL use `PI_CODING_AGENT_DIR` when set and otherwise Pi's normal user agent directory. It SHALL NOT load project-local `.pi` extensions or `.pi/mcp.json` in durable runs without an equivalent explicit project-trust decision. Integration endpoints, credentials and enablement SHALL remain machine-local and SHALL NOT be copied into checked-in files, workflow state or agentic-coding configuration. A machine without configured integrations SHALL NOT gain integration-specific tools or make an integration connection.

#### Scenario: Configured user-level extensions and MCP tools are discovered
- **WHEN** a user-level Pi configuration contains an enabled compatible extension or MCP server
- **THEN** the durable host SHALL discover it through the same Pi user-level configuration/resource path used for normal Pi integrations
- **AND** SHALL NOT require a second server endpoint or credential configuration stack

#### Scenario: Empty machine has no integration connections
- **WHEN** the user's Pi agent directory contains no extension or MCP integration
- **THEN** the durable host SHALL expose no integration-specific tool
- **AND** SHALL make no outbound integration connection

#### Scenario: Project configuration is not trusted implicitly
- **WHEN** the durable run's cwd contains project `.pi` extension or MCP configuration but no explicit durable project-trust decision exists
- **THEN** the bridge SHALL NOT load, execute or connect to anything declared by that project configuration

#### Scenario: Integration secrets remain machine-local
- **WHEN** the bridge loads a user-level server configuration or authentication state
- **THEN** endpoint credentials, expanded environment values, OAuth tokens and headers SHALL remain in the existing machine-local Pi configuration/auth storage
- **AND** SHALL NOT be copied into workflow files, durable transcripts, tool details or checked-in configuration

### Requirement: Compatible Pi extension tools have an explicit support boundary
The bridge SHALL adapt generic Pi extensions that register durable-compatible tools, preserving their parameter schema and model-facing description. It SHALL map only the supported `session_start` and `session_shutdown` lifecycle hooks to creation and idempotent disposal of the per-conversation bridge. It SHALL explicitly diagnose unsupported hooks and APIs, including provider, prompt/context transformation, user-input, session replacement/tree/compaction, command/shortcut, persistent Pi entry, custom UI, rendering or dynamic tool-registration behavior. An extension whose tools depend on unsupported setup SHALL have those tools disabled rather than silently presented as fully compatible. The bridge SHALL disclose that extension code executes as trusted local code with the host process's user permissions, not in a sandbox.

#### Scenario: Tool-only extension registers a compatible tool
- **WHEN** a user-level extension registers a static model-callable tool using the supported Pi tool contract
- **THEN** the durable host SHALL register the compatible tool with its parameter schema and description
- **AND** SHALL apply the current conversation's policy and result/cancellation adapter before exposing it

#### Scenario: Extension registers an unsupported lifecycle or UI dependency
- **WHEN** an extension registers an unsupported hook or requires a Pi UI/session capability the bridge cannot provide
- **THEN** the bridge SHALL produce a bounded unsupported-feature diagnostic naming the feature class
- **AND** SHALL NOT expose tools whose required setup would be skipped

#### Scenario: Extension code is not represented as sandboxed
- **WHEN** a user enables an extension for durable Pi
- **THEN** documentation and diagnostics SHALL state that its code runs with the host process's local user permissions
- **AND** SHALL NOT claim that the bridge isolates untrusted or malicious extension code

### Requirement: Extension context and lifecycle are conversation-scoped
Each durable conversation SHALL have a distinct bridge owner and tool execution context. For each invocation, the bridge SHALL use the cwd and run identity currently bound to that conversation, including after persistent-role rebinding. It SHALL NOT inject `DurableRunContext.env`, run capability tokens, classifier bindings, hidden workflow capabilities or another conversation's context into a Pi extension context. The bridge SHALL propagate the durable call's cancellation signal and SHALL drain and dispose all conversation-owned extension/MCP resources idempotently at conversation/host shutdown.

#### Scenario: Concurrent conversations use their own cwd and tool context
- **WHEN** two durable conversations execute the same imported extension tool with different cwd and run bindings
- **THEN** each invocation SHALL receive only its owning conversation's current cwd and supported context
- **AND** no bridge-owned mutable state or context from one conversation SHALL be visible to the other

#### Scenario: Persistent role is rebound to a later run
- **WHEN** a durable conversation is reused by a later run with a different current cwd or run identity
- **THEN** subsequent imported tool calls SHALL use the later binding rather than the context captured by the first run

#### Scenario: Conversation owners remain bounded
- **WHEN** the durable host opens more than 32 Pi-backed conversations
- **THEN** it SHALL evict the least-recently-used idle owner before creating another
- **AND** it SHALL NOT evict an owner with an active call
- **AND** it SHALL refuse a new owner with a bounded diagnostic if all owners are active

#### Scenario: Host shutdown cancels and disposes resources
- **WHEN** the durable host shuts down while an imported tool or MCP request is active
- **THEN** the abort signal SHALL reach the invocation
- **AND** host shutdown SHALL await the active call before emitting `session_shutdown` and disposing its owner
- **AND** a trusted callback that ignores cancellation MAY delay shutdown; shutdown SHALL NOT report completion while that bridge-owned call remains live

### Requirement: Tool results, progress and cancellation are preserved
The bridge SHALL preserve supported Pi tool outcomes when adapting them to pi-durable, including text and image content, structured output, tool details, error outcomes and progress updates. It SHALL preserve a structured error as an error rather than a successful text result. The bridge SHALL forward cancellation to extension tool callbacks and MCP requests; a cancelled or interrupted call SHALL NOT be reported as successful.

#### Scenario: Direct tool returns text and structured output
- **WHEN** an imported tool returns text content and valid structured content for its declared output schema
- **THEN** the durable model call SHALL receive the text and native codemode SHALL receive the structured value

#### Scenario: Tool returns an image or an error
- **WHEN** an imported tool returns image content or an error result with structured details
- **THEN** the durable result SHALL preserve the supported image or error outcome and its structured details without converting an error into success

#### Scenario: Nested durable tool has ordinary text or diagnostics
- **WHEN** an imported tool calls an authorized durable tool that has no structured output
- **THEN** the Pi extension's nested result SHALL include bounded model-facing text or error diagnostics when available
- **AND** it SHALL use a bounded generic error only when no safe text or diagnostic is available

#### Scenario: Tool content traversal reaches its bound
- **WHEN** progress content, result content or structured details exceed the bridge's item, byte, depth or node budget
- **THEN** traversal SHALL stop at the documented bound
- **AND** the durable result SHALL fail closed or report a bounded truncation diagnostic without scanning an unbounded collection

#### Scenario: Tool reports progress and is cancelled
- **WHEN** an imported tool or MCP request emits progress and its durable call is then cancelled
- **THEN** progress SHALL be forwarded through the durable tool update path
- **AND** cancellation SHALL reach the underlying invocation and the final outcome SHALL be cancelled/interrupted, not successful

### Requirement: Configured MCP servers use Pi's supported transports and machine-local auth
The bridge SHALL support user-configured Pi MCP servers over stdio and streamable HTTP using Pi's supported MCP configuration, transport and authentication behavior. It SHALL preserve configured request timeouts, supported progress, content/error results, and existing user-local authentication/refresh behavior where the upstream public API supports them. It SHALL NOT support legacy SSE by silently treating it as HTTP. When fresh user interaction is required, durable Pi SHALL NOT open a login flow or collect credentials; it SHALL return a bounded sign-in-required diagnostic directing the user to Pi's normal login surface. Server unavailability, malformed configuration and auth failure SHALL NOT prevent unrelated durable tools from working.

#### Scenario: Stdio and streamable HTTP servers are configured
- **WHEN** the user-level `mcp.json` contains enabled stdio or streamable-HTTP MCP servers
- **THEN** the bridge SHALL connect through Pi's supported transport/configuration path and register tools under a deterministic server namespace
- **AND** SHALL not copy server definitions or credentials to workflow state

#### Scenario: Existing OAuth state is available
- **WHEN** a configured HTTP MCP server can authenticate using the existing user-local Pi OAuth state
- **THEN** the bridge SHALL use the upstream supported token/refresh behavior without exposing token values

#### Scenario: MCP requires interactive sign-in
- **WHEN** an MCP server requires sign-in that cannot complete without a user interaction
- **THEN** the bridge SHALL report a sanitized sign-in-required diagnostic
- **AND** SHALL NOT start a browser, accept a model-supplied credential or store a new token

#### Scenario: Invalid MCP configuration
- **WHEN** a user-level MCP entry is malformed or declares an unsupported transport
- **THEN** the bridge SHALL report a bounded configuration failure class and a user-level settings recovery hint
- **AND** other valid servers and durable tools SHALL remain usable

#### Scenario: Unavailable MCP server
- **WHEN** a configured MCP server is unavailable or times out
- **THEN** the bridge SHALL report a bounded availability failure class
- **AND** other valid servers and durable tools SHALL remain usable

#### Scenario: Auth-required MCP server
- **WHEN** a configured MCP server requires fresh user interaction
- **THEN** the bridge SHALL report a bounded sign-in-required diagnostic directing the user to Pi's normal login surface
- **AND** it SHALL NOT expose the server's private endpoint, credentials or response body

### Requirement: Run policy, collision and exposure rules are fail-closed
Every imported tool SHALL be checked against the owning run's `ToolPolicy` and native callable/model exposure semantics before registration and again before nested execution. Orchestrator runs SHALL receive all compatible imported tools without a machine-local allow-list, subject to native exposure and collision rules. Read-only runs SHALL receive no imported tools by default; a machine-local, tool-specific policy MAY explicitly allow a named external tool for a read-only policy. MCP annotations and extension claims SHALL NOT by themselves establish read-only permission, authorization or safe replay. Imported tools SHALL NOT replace or shadow an authoritative agentic-coding tool. A tool whose exposure cannot be represented without widening visibility or callable access SHALL remain unavailable with a diagnostic.

#### Scenario: Restricted run denies an imported tool by default
- **WHEN** a read-only run is created with no machine-local allow rule for an imported tool
- **THEN** the tool SHALL be absent from both model-visible and native codemode-callable catalogs
- **AND** a nested invocation SHALL be refused without executing the external tool

#### Scenario: Orchestrator needs no imported-tool allow-list
- **WHEN** the local Pi bridge is enabled for an orchestrator run without any imported-tool allow-list
- **THEN** all compatible imported tools SHALL be available according to their native exposure rules
- **AND** their execution SHALL NOT require a tool-specific allow rule
- **AND** authoritative tool collision protections SHALL remain enforced

#### Scenario: Explicit restricted-run policy allows one named tool
- **WHEN** a machine-local policy explicitly allows a named imported tool for the current restricted `ToolPolicy`
- **THEN** only that named tool SHALL be exposed at the configured Pi/native exposure level
- **AND** its MCP annotations SHALL NOT expand that permission to another tool

#### Scenario: Annotation does not make an MCP tool read-only
- **WHEN** an MCP server claims `readOnlyHint` or `idempotentHint` for a tool without a matching machine-local restricted-run policy
- **THEN** the bridge SHALL continue to deny that tool in the restricted run

#### Scenario: Imported name collides with an authoritative tool
- **WHEN** an extension or MCP tool name collides with an agentic-coding built-in/workflow tool or another imported tool
- **THEN** the authoritative tool SHALL retain its registration
- **AND** the colliding imported tool SHALL be disabled or deterministically namespaced with a bounded diagnostic

### Requirement: Native codemode and deferred discovery use the authorized tool catalog
Compatible imported tools SHALL participate in durable Pi's native codemode only according to the current run's authorized callable set. The host SHALL retain direct durable tools and SHALL recheck each nested call against the same run-specific policy. The implementation SHALL evaluate the pinned pi-durable runtime's native deferred discovery/tool-search support; it SHALL use such discovery only when the upstream native API preserves visibility and permission rules. It SHALL NOT add a parallel sandbox, catalog or tool-search path that can expose hidden or restricted tools.

#### Scenario: Authorized imported tool is called through native codemode
- **WHEN** a writable run's native codemode script discovers and calls an authorized imported tool
- **THEN** the tool SHALL execute through the durable native nested-call API and its result/progress/error SHALL be recorded through that API

#### Scenario: Restricted or hidden tool cannot be called through codemode
- **WHEN** a codemode script names a hidden, denied or otherwise non-callable imported tool
- **THEN** the native host SHALL refuse the call before invoking the extension or MCP server
- **AND** SHALL not reveal a different run's tool catalog

#### Scenario: Model-only tools are direct-only
- **WHEN** an imported tool declares `model-only` exposure
- **THEN** it MAY be visible to the model's direct tool caller
- **AND** it SHALL be absent from native codemode's callable set
- **AND** a hidden tool SHALL be absent from both surfaces

#### Scenario: Deferred discovery uses the native policy-filtered surface
- **WHEN** a compatible imported tool declares deferred exposure and the pinned pi-durable runtime provides its native tool-search surface
- **THEN** the host SHALL use native `tool_search` to load only deferred tools already authorized in the current conversation's selected tool set
- **AND** SHALL NOT implement a second catalog or search/activation bypass

### Requirement: External calls are unsafe to replay by default
Imported extension and MCP calls SHALL be treated as non-replayable when completion is uncertain. After a durable interruption, the host SHALL report an interrupted result instead of silently reissuing an external call. A machine-local policy MAY explicitly opt a named tool into the native safe-replay contract, but annotations alone SHALL NOT make that choice. The host SHALL preserve pi-durable's existing nested-call journal and SHALL NOT promise exactly-once external side effects.

#### Scenario: Crash occurs during an uncertain external call
- **WHEN** the host is interrupted while an imported tool call may have performed an external side effect
- **THEN** recovery SHALL return an interrupted result and SHALL NOT automatically repeat the external call

#### Scenario: Explicit replay policy is configured
- **WHEN** a machine-local operator explicitly marks a named imported tool safe for native replay
- **THEN** the host MAY apply the native safe-replay setting to that tool
- **AND** SHALL document the operator's duplicate-side-effect responsibility without claiming exactly-once behavior

### Requirement: Diagnostics are bounded and sanitized
Configuration, loading, unsupported-feature, collision, policy, timeout, authentication, result-conversion, cancellation and disposal failures SHALL produce bounded diagnostics that identify a safe local integration label and failure class. Diagnostics SHALL omit credential values, expanded environment values, OAuth tokens, private URLs/headers, full tool arguments/results, prompts, other-run context and run capability data. Failure in one integration SHALL NOT erase diagnostics for unrelated integrations or make the core durable tool surface unavailable.

#### Scenario: Diagnostic contains sensitive input
- **WHEN** an integration failure contains a credential, private endpoint/header, argument, prompt or result in its error text
- **THEN** the surfaced diagnostic SHALL redact or omit those values and remain within its documented length bound

#### Scenario: One integration fails to load
- **WHEN** one configured extension or MCP server fails during load or connection
- **THEN** the durable host SHALL report its bounded failure class while keeping unrelated compatible integrations and authoritative tools usable

#### Scenario: Pi owner startup fails
- **WHEN** a conversation's Pi loader, session creation, extension binding or tool-catalog refresh fails
- **THEN** the bridge SHALL report a bounded startup failure class and a safe next step such as checking user-level Pi settings or signing in through Pi
- **AND** it SHALL NOT log the underlying exception, resolved paths or credential-bearing configuration

### Requirement: Late MCP catalog changes reach their owning durable conversation safely

The durable host SHALL make supported late MCP tool registrations and supported MCP catalog changes available to the owning durable conversation without process restart, conversation recreation, or manual bridge refresh. It SHALL reconcile the owner's explicit selected tool set using supported Pi and pi-durable APIs and serialized owner admission. Additive updates MAY commit while busy, preserving every prior selected name, prepared request, active definition and deferred/model-tool state; later requests, including queued follow-ups, SHALL see authorized additions. Non-additive changes SHALL wait for an atomic full-idle boundary and SHALL NOT invalidate an active imported call. Registration and catalog refresh SHALL remain bounded and SHALL NOT use unbounded background polling.

#### Scenario: Fast tools remain usable while another MCP server connects slowly
- **WHEN** a fast MCP server registers tools before another configured server finishes connecting
- **THEN** the fast server's tools SHALL remain promptly usable
- **AND** the durable host SHALL NOT wait indefinitely for the slower server

#### Scenario: Late MCP registration reaches the same durable conversation
- **WHEN** another MCP server registers a compatible tool after the initial owner snapshot and the conversation's initial tool selection
- **THEN** the tool SHALL become available to that same durable conversation at its next safe turn admission without restarting the process or recreating the conversation
- **AND** an operator SHALL NOT need to manually trigger a bridge refresh

#### Scenario: Late direct and deferred tools retain their native exposure
- **WHEN** supported late MCP registrations include direct and deferred tools
- **THEN** direct tools SHALL be offered on their authorized direct surface
- **AND** deferred tools SHALL be discoverable only through the pinned native deferred-discovery surface and callable only when authorized
- **AND** refresh SHALL NOT create a parallel discovery or activation path

#### Scenario: Late tool is actually called through native codemode
- **WHEN** codemode is enabled and an authorized compatible MCP tool registers after the initial selection for an orchestrator conversation with no imported-tool allow-list
- **THEN** native codemode SHALL discover and execute that tool through the same durable conversation's authorized native nested-call API
- **AND** the call's result, declared structured-output identity, progress, error, and cancellation behavior SHALL remain governed by the existing bridge adapters

#### Scenario: Supported MCP catalog update is applied at a safe boundary
- **WHEN** a configured MCP server reports a supported tool-catalog addition, removal, or definition change
- **THEN** additions SHALL reach later prepared requests and non-additive changes SHALL reach the owning conversation at an atomic full-idle boundary
- **AND** a running turn and any active imported call SHALL retain the definitions and execution state with which they started

#### Scenario: Catalog change arrives during active execution
- **WHEN** a registration or supported catalog change arrives while the conversation is executing a model turn, direct imported call, or codemode nested call
- **THEN** the host SHALL coalesce additions into a preserved selection for later requests and retain non-additive changes until an atomic full-idle boundary
- **AND** the active turn and call SHALL complete or cancel according to their existing contract without refresh-induced invalidation

#### Scenario: Unavailable server does not block ready tools or shutdown
- **WHEN** a configured MCP server never becomes ready while another server or native tools are usable
- **THEN** startup and cancellation SHALL remain bounded, ready tools SHALL remain usable, and the unavailable server SHALL NOT prevent unrelated tools from working
- **AND** the host SHALL NOT poll indefinitely waiting for the server

#### Scenario: Update arrives after owner disposal or eviction
- **WHEN** a late registration notification or refresh completion arrives after its conversation owner begins disposal, eviction, or host shutdown
- **THEN** it SHALL NOT recreate that owner, republish an owner-specific selected catalog, or affect another conversation
- **AND** owner-scoped listeners and background work SHALL be detached, cancelled, or awaited as part of disposal

### Requirement: Late imported tools preserve current policy and owner isolation

A late or changed MCP tool SHALL pass the same current run `ToolPolicy`, native visibility/callability, authoritative collision, schema/result, and owner-isolation checks as a tool present at initial startup. Registry-wide presence SHALL NOT grant another conversation access to the tool.

#### Scenario: Late tool remains denied to a restricted run
- **WHEN** a compatible MCP tool registers late for a read-only conversation with no explicit machine-local allow rule
- **THEN** it SHALL remain absent from model-visible, deferred-discovery, and native codemode-callable surfaces
- **AND** a nested invocation SHALL be refused without executing the server tool

#### Scenario: Late tool is visible only to its authorized owner
- **WHEN** a shared bridge registry receives a late MCP registration for one conversation but another conversation has not registered or selected that tool
- **THEN** only the owning conversation's policy-filtered selection SHALL expose and execute it
- **AND** the other conversation SHALL NOT discover or execute it through direct, deferred, or codemode surfaces

#### Scenario: Late authoritative name collision does not replace a native tool
- **WHEN** a late MCP registration collides with an authoritative agentic-coding tool or an existing imported tool
- **THEN** the authoritative registration SHALL retain precedence and the collision SHALL follow the existing bounded-disable/namespace behavior
- **AND** the late update SHALL NOT widen access or replace the authoritative tool

