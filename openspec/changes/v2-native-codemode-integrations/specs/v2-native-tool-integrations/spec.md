## ADDED Requirements

### Requirement: Mandatory native durable codemode with capability parity

Every agentic-coding-v2 durable root/project orchestrator, interactive workflow and nested worker/verifier/fixer SHALL select `createCodemodeExtension` from `@earendil-works/pi-durable/codemode`, using QuickJS, native discovery, structured results, cancellation and durable nested execution/replay. All durable roles SHALL have equal capabilities; reviewer restrictions SHALL be prompt-only. Explicit standalone no-tools chat SHALL remain unchanged. The host SHALL NOT create a Pi agent session, spawn Pi, request another model for the adapter, create another agent runtime, or import/delegate to v1.

#### Scenario: Root and nested verifier use the same surface
- **WHEN** a fake-model root launches a nested verifier and each calls codemode
- **THEN** each SHALL discover and invoke its native and compatible imported tools through native nested execution in its own cwd
- **AND** no extra Pi session, Pi process, model request or agent runtime SHALL be created

#### Scenario: Standalone remains no-tools
- **WHEN** an explicit standalone no-tools chat is opened
- **THEN** no codemode/imported tools or integration owner SHALL be added

### Requirement: Public supported configuration and loading boundary

The host SHALL use only public supported APIs of explicitly approved pinned dependencies. It SHALL resolve Pi's user directory using the supported `PI_CODING_AGENT_DIR`/`~/.pi/agent` primitive and user-level configuration/loading semantics, without implicit project-local integration trust. Config and credentials SHALL remain in place and read-only; logs, cache and state SHALL be v2-owned. Missing supported APIs SHALL block the affected implementation strategy with evidence and an explicit dependency decision, not private imports, a silent upgrade, installation, duplicate credential configuration or disguised absence.

#### Scenario: Pinned API cannot meet safe loading constraints
- **WHEN** the public loader cannot exclude project extension execution or missing-package installation
- **THEN** implementation SHALL stop at the public-API gate and present the limitation and required approved API/dependency strategy
- **AND** it SHALL NOT initialize integrations to probe the gap

#### Scenario: User configuration is absent or disabled
- **WHEN** isolated user configuration is empty or integrations are disabled
- **THEN** no integration processes, network connections or extension execution SHALL occur
- **AND** native codemode SHALL still be available to durable agents

#### Scenario: Untrusted project configuration exists
- **WHEN** the actual conversation worktree contains `.pi` integration configuration without a corresponding explicit trust decision
- **THEN** it SHALL NOT be loaded, executed or connected

#### Scenario: Authentication requires mutation
- **WHEN** a configured server needs login, token refresh or an unsupported credential resolver
- **THEN** the host SHALL report a sanitized bounded auth/unsupported diagnostic
- **AND** SHALL NOT launch login, execute credential commands or write credentials implicitly

### Requirement: Direct MCP and honest headless extension compatibility

MCP tools SHALL use direct public MCP clients/transports. Compatible user extensions SHALL run as trusted executable code through an isolated headless compatibility adapter without a Pi session. UI registrations alone SHALL NOT reject otherwise compatible tools. Safety hooks and session-dependent setup SHALL be faithfully supported or their dependent tools SHALL be disabled with a visible unsupported diagnostic; the adapter SHALL NOT silently discard behavior or fabricate a session/UI/model context.

#### Scenario: Tool extension also registers rendering or commands
- **WHEN** a synthetic extension registers an independent compatible tool and UI-only rendering/command metadata
- **THEN** the tool SHALL remain available with honest headless UI limitations

#### Scenario: Extension requires unsupported safety semantics
- **WHEN** an extension registers a safety hook or depends on a session capability the adapter cannot faithfully supply
- **THEN** affected tools SHALL be unavailable with a bounded feature-class diagnostic
- **AND** unsupported behavior SHALL NOT be silently skipped or answered with fabricated success

#### Scenario: MCP server is available through local mock transport
- **WHEN** an enabled temporary MCP entry or compatible extension server registration supplies tools
- **THEN** a direct client SHALL list and invoke them without invoking Pi's session-based MCP extension

### Requirement: Real exposure, activation and collision-safe discovery

The host SHALL preserve direct, deferred, codemode, model-only and hidden exposure and supported activation semantics. Direct tools SHALL be model/script-callable; deferred tools SHALL remain natively discoverable and loadable without eager model declaration; codemode tools SHALL be script-only; model-only tools SHALL be excluded from script-callable discovery; hidden tools SHALL be neither discoverable nor callable. Native tool names SHALL win. Imported names SHALL be stable and unambiguous across source/normalization/JavaScript-identifier collisions and registration order. Native search/describe facilities SHALL return real schemas and names, not an imitation textual catalog.

#### Scenario: All five exposures
- **WHEN** fixtures register one tool of each exposure
- **THEN** model declarations, native tool search, script discovery and execution SHALL match the exposure contract
- **AND** hidden tools SHALL be unavailable through both model and nested execution

#### Scenario: Native and imported names collide
- **WHEN** native tools, two extension sources and two MCP sources normalize to colliding names
- **THEN** native tools SHALL retain their names and all accepted imported names SHALL be deterministic, unique and usable through native discovery
- **AND** reversing registration order SHALL NOT change their identities

### Requirement: Actual invocation context and bounded faithful output

Imported invocations SHALL receive their owning conversation's actual current cwd/worktree, native call identity and cancellation signal. Supported extension nested execution SHALL use `ToolExecutionApi.executeTool`, preserving native validation, hooks, ownership, replay and progress. Adapters SHALL preserve supported text, image, structured output, details and errors, with explicit bounded progress/results/traversal and truncation/unsupported diagnostics. They SHALL NOT turn structured errors, interruption or cancellation into success, including late callback completion.

#### Scenario: Concurrent worktrees and native nested call
- **WHEN** two owners invoke the same synthetic tool in different worktrees and it makes a supported nested native call
- **THEN** each invocation SHALL see its own cwd/signal and native nested result
- **AND** neither SHALL observe another owner's context or mutable adapter state

#### Scenario: Mixed results and bounded progress
- **WHEN** synthetic tools return text/images/structured success, structured errors, oversized nested content or excessive progress
- **THEN** supported values and error status SHALL be preserved within documented budgets
- **AND** traversal SHALL stop at the budget before unbounded serialization and report omissions explicitly

#### Scenario: Cancellation wins over late result
- **WHEN** cancellation reaches an extension or mock MCP call and a callback later returns success
- **THEN** the signal SHALL reach the invocation and the durable result SHALL remain aborted/error rather than successful

### Requirement: Unsafe effects stay unsafe through native replay

Imported external/uncertain operations SHALL default to replay-unsafe, including calls nested under replay-safe native codemode. Remote annotations or read-like names SHALL NOT automatically establish safety. The native VM journal and native nested-task replay policies SHALL remain authoritative. Interrupted unsafe effects SHALL NOT be resent after restart; recorded completed results SHALL remain reusable through native recovery.

#### Scenario: Crash after external issuance before result commit
- **WHEN** a mock unsafe tool is interrupted inside codemode after issuance and before durable completion
- **THEN** recovery SHALL refuse reissuing that effect and report interruption/error through native nested execution
- **AND** the mock issuance count SHALL remain one

#### Scenario: Completed nested result is replayed
- **WHEN** native VM recovery reaches an already completed keyed nested call
- **THEN** the committed result SHALL be reused without another external invocation

### Requirement: Event-driven same-conversation catalog reconciliation

Late extension/MCP registration, schema/exposure change and removal SHALL be event-driven without connection/session recreation, sleeps or polling. Updates SHALL reconcile both registry registrations and explicit conversation selections at safe boundaries. In-flight native schemas and codemode discovery snapshots SHALL remain coherent; a subsequent call in the same conversation SHALL observe the applied generation. Owners/generation fences SHALL prevent cross-conversation leaks and resurrection after disposal.

#### Scenario: Late MCP tool becomes available
- **WHEN** a mock server or synthetic extension emits a registration/list-change event after the conversation's first call
- **THEN** the next safe-boundary codemode/search call in that same conversation SHALL discover/invoke the new tool
- **AND** another owner SHALL not gain the tool and the original connection SHALL be reused

#### Scenario: Active schema is replaced or removed
- **WHEN** a schema/exposure change or removal arrives while a native call/script is active
- **THEN** that invocation SHALL retain its coherent admitted snapshot and the update SHALL apply at the next safe boundary
- **AND** subsequent declarations/discovery SHALL not retain stale removed tools

#### Scenario: Disposed owner receives a late event
- **WHEN** a connection or async extension callback publishes after owner disposal
- **THEN** no tool or owner SHALL be recreated and no stale generation SHALL be published

### Requirement: Bounded isolated ownership and complete disposal

The host SHALL bound owners, connections, accepted tools, worker capacity, nested calls, progress, result traversal and diagnostics using documented tested limits. Active owners SHALL NOT be evicted to satisfy admission. Task cancellation/completion/removal, conversation closure and host shutdown SHALL fence admissions, unsubscribe, abort and join owned work, close clients/transports, invalidate runtime and release selected registrations idempotently. Worker capacity SHALL remain reserved until actual worker exit. Trusted code ignoring abort SHALL NOT be reported as disposed while still running.

#### Scenario: Capacity is exhausted
- **WHEN** all bounded owner/connection/worker slots are occupied by active work
- **THEN** new acquisition SHALL fail visibly with a bounded capacity diagnostic and active owners SHALL remain intact

#### Scenario: Task and conversation lifecycle release resources
- **WHEN** a task completes, is cancelled/removed, its conversation closes, or the host shuts down
- **THEN** its owned integrations SHALL stop accepting work and release subscriptions/clients/transports/registrations exactly once after owned calls settle
- **AND** unrelated owners SHALL remain unaffected

### Requirement: Visible sanitized compatibility diagnostics

Unsupported, invalid, auth-required and unavailable integrations SHALL produce visible bounded failure-class diagnostics with actionable recovery hints. Diagnostics SHALL NOT expose secret values, raw config/exception payloads, credential-bearing endpoints, environment dumps or `.env` contents. Trust disclosure SHALL state that extensions run with host-user permissions and are not sandboxed by QuickJS.

#### Scenario: Sensitive upstream error
- **WHEN** a mock connection error includes a secret header, command, credential URL or oversized message
- **THEN** diagnostics SHALL expose only a bounded sanitized category/recovery hint and no sensitive payload

### Requirement: Maintenance stays integration-inert

Stopped-host `--clear-finished-tasks` SHALL never initialize integrations, connect clients, execute extension code, start codemode workers or resume agents. It SHALL preserve native history, admission fences and unrelated conversations.

#### Scenario: Cleanup with configured synthetic integrations
- **WHEN** the actual stopped-host cleanup CLI runs against isolated config/state with extension/MCP sentinels
- **THEN** cleanup SHALL complete with zero extension executions, transport connections, workers or resumed model calls

### Requirement: Source and bundled assets with isolated acceptance

Source execution and the built v2 JS distribution SHALL include/resolve supported QuickJS WASM and worker assets without v1 imports or source-tree fallback. Acceptance SHALL use only temporary isolated Pi/config/state, fake models, synthetic extensions and local mock MCP, never real integrations/services. Tests SHALL be unit-first and event/barrier driven, without deadline sleeps, polling or timeout inflation.

#### Scenario: Source and bundle run the same synthetic script
- **WHEN** the isolated fixture runs native codemode through source and through the built CLI distribution outside source resolution assumptions
- **THEN** both SHALL discover/invoke native, synthetic extension and local MCP tools and return structured results using their own WASM/worker assets

#### Scenario: Verification handoff is scoped to the feature
- **WHEN** independent verification begins or fixes change the diff
- **THEN** its coordinator SHALL establish the actual feature base/diff, provide each reviewer an explicit relevant changed-file list and diff, reject preexisting/unrelated/preference findings before fixes, and refresh assignments after fixes
- **AND** final evidence SHALL include unfiltered v2 type-check, lint and build plus full-suite measured duration and failures together
