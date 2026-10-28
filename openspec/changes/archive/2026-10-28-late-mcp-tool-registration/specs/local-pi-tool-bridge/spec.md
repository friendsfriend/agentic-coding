## ADDED Requirements

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