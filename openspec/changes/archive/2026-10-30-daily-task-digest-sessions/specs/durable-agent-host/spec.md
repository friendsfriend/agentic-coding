## ADDED Requirements

### Requirement: Named workflowless durable sessions
The system SHALL support multiple named workflowless pi-durable sessions with stable identities, retained native history and independently selectable workspace sidebar entries. They SHALL NOT impersonate Home or workflow agents or inherit workflow remediation authority. Creation SHALL be explicit and retry-safe; continuation SHALL recover only the exact existing conversation. Existing single-session metadata SHALL migrate non-destructively through supported versioned migration.

#### Scenario: Select and reopen independent sessions
- **WHEN** a developer creates two named sessions, sends messages, switches between them and restarts the UI/host
- **THEN** each sidebar entry SHALL reopen its own retained history and the prior selection SHALL remain independent of background report delivery
- **AND** Home and workflow-agent navigation SHALL remain unchanged

#### Scenario: Legacy or malformed state
- **WHEN** legacy single-session metadata is migrated or malformed/future metadata is encountered
- **THEN** supported migration SHALL preserve the existing conversation and history without duplicate allocation
- **AND** unsupported or corrupt state SHALL produce diagnostics rather than silently select another conversation

### Requirement: Exact-session scheduled read-only delivery
The existing scheduler SHALL support explicit persistent workflowless-session collection destinations with pinned repository, baseBranch, configured model, permission and review policies, authenticated custody and native host/conversation identity. Existing wake-up, workflow and per-occurrence standalone targets SHALL retain their behavior. Collection SHALL require no writable per-occurrence approval and SHALL NOT bypass normal reviews or busy-host barriers.

#### Scenario: Background digest survives restart
- **WHEN** a bound digest occurrence executes after a restart while Home or a different session is selected
- **THEN** its native report SHALL enter only the bound session and remain visible when that sidebar entry opens
- **AND** delivery SHALL NOT change focus or selected session

#### Scenario: Lost acknowledgement and stale retry
- **WHEN** a crash or retry occurs across reservation, admission, native submission, answer commit or result association
- **THEN** reconciliation SHALL use the same occurrence/native request identity and exact answer entry, producing one report association and no duplicate report
- **AND** stale generation or fence requests SHALL NOT activate or publish

#### Scenario: Missing destination or revoked custody
- **WHEN** a session is deleted, its store is replaced, access is revoked or foreign custody is presented
- **THEN** admission/recovery SHALL deny delivery with visible nonsecret diagnostics and history
- **AND** SHALL NOT recreate, retarget or select the current conversation

#### Scenario: Busy and cancelled occurrence
- **WHEN** the pinned host is busy or an occurrence is cancelled before admission
- **THEN** the scheduler SHALL preserve busy-host barriers, existing no-overlap/late-policy controls and cancellation semantics without aborting unrelated work
- **AND** cancelled-before-admission work SHALL NOT submit a report

### Requirement: Enforced least-authority collection profile
Workflowless scheduled collection SHALL expose only authorized read-only provider and constrained local discovery operations. Read-only enforcement SHALL apply through codemode discovery/execution and nested MCP dispatch, not only prompts. It SHALL NOT expose arbitrary writable shell, source mutation, merge, approval, deploy, workflow remediation or credential management authority. Existing native bridge and review/login controls SHALL remain intact.

#### Scenario: Nested tool attempts mutation
- **WHEN** a collection session or external tool description attempts a write or authority escalation through direct or nested codemode execution
- **THEN** execution SHALL be denied without changing permissions or source records
- **AND** secrets SHALL remain unavailable to report text and diagnostics
