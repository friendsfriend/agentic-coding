## ADDED Requirements

### Requirement: Shared persistent WHAT and WHEN
The server SHALL persist reusable revisioned jobs, schedules referencing jobs, and occurrence history independently of views and conversations. Jobs MUST carry name, target, self-contained task/original instruction/context references, project/repository as appropriate, model/preset references, execution/worktree/branch settings, permission/review policy and reporting destination. Both management surfaces MUST use the same validated authenticated service. Concrete identities/settings MUST be resolved and snapshotted at occurrence admission without storing secrets.

#### Scenario: Shared job edit
- **WHEN** a reusable job is edited after an occurrence is admitted
- **THEN** future occurrences use the new revision, the confirmation lists affected schedules and the admitted occurrence keeps its previous immutable settings and identities

#### Scenario: Reopen and unsupported store
- **WHEN** the server reopens persisted schedules or encounters an unreadable/newer store
- **THEN** valid schedules/history survive, and an unsupported store fails closed without replacement or silent empty initialization

### Requirement: Explicit once and recurring timing
The service SHALL accept absolute instants, relative delays resolved once to instants, anchored elapsed intervals of at least one minute, and calendar schedules with selected ISO weekdays, hour/minute and explicit valid IANA timezone. Calendar schedules MUST preserve local wall time across DST, skip nonexistent times and execute only the earlier ambiguous instant once per local date. Local once input MUST reject nonexistent times and require explicit ambiguity resolution. No timezone SHALL be guessed. Create/edit/manual preview SHALL expose resolved timezone, offsets, next execution and next five previews before confirmation.

#### Scenario: Delay and interval
- **WHEN** a one-hour delay and a six-hour interval are created at a fixed clock instant
- **THEN** the once instant is fixed at creation plus one hour and interval slots remain six elapsed hours apart regardless of DST or completion time

#### Scenario: Calendar daylight saving
- **WHEN** daily 02:30 Europe/Berlin crosses spring and autumn transitions
- **THEN** the spring missing local slot is skipped and the autumn repeated local slot executes only at its earlier instant

#### Scenario: Missing timezone
- **WHEN** a calendar request omits timezone or supplies an invalid zone
- **THEN** both UI and tools receive authoritative validation failure rather than an assistant-selected timezone

### Requirement: Durable idempotent admission and recovery
Occurrence identities SHALL be stable and unique per schedule/nominal due or manual request key. Transactional fenced claims, durable target reservations and idempotent activation/query MUST prevent duplicate launches across concurrent dispatchers, restart, lease expiry and acknowledgement loss. Unknown outcomes MUST retain occupancy and reconcile the same identity. Enqueued/admitted/processing/completed MUST be distinct. The system MUST NOT claim exactly-once arbitrary external effects.

#### Scenario: Crash after target admission
- **WHEN** target admission succeeds and the scheduler crashes before recording acknowledgement
- **THEN** recovery queries the same target receipt and reattaches to the same execution without starting a second one

#### Scenario: Claim contention
- **WHEN** two dispatchers claim the same due slot and a lease subsequently expires
- **THEN** unique identity and fenced activation permit only one runnable target, with no release of occupancy for ambiguous work

### Requirement: No overlap and bounded downtime
The service SHALL enforce job-level no-overlap across referencing schedules, including pending, queued, executing, unknown outcome and human-review waits. Overlapping due slots MUST be recorded skipped, not queued without bound. At most one wake-up per job SHALL be outstanding and at most one scheduled wake-up per destination SHALL process at a time. Recurring downtime SHALL skip missed slots using bounded range summaries and advance to the first future slot, without replaying backlog; normal polling lateness up to five seconds SHALL remain eligible. One-time wake-ups SHALL default to run-late; other once jobs MUST explicitly select run-late or expire-after grace. Forward/backward clock changes SHALL not repeat prior slots.

#### Scenario: Review wait
- **WHEN** a workflow occurrence waits for developer review and another schedule referencing its job becomes due
- **THEN** the new occurrence is skipped-overlap with a link to the outstanding execution and the review is not auto-approved

#### Scenario: Service resume
- **WHEN** service resumes after many recurring slots and an overdue one-time wake-up
- **THEN** recurring missed slots are summarized without replay and the once wake-up remains pending marked late

#### Scenario: Explicit expiry
- **WHEN** a one-time standalone job exceeds its configured expiry grace
- **THEN** it becomes expired with a visible reason and no run is launched

### Requirement: Atomic schedule management
Management SHALL support job and schedule create/read/list/update, preview, postpone/reschedule, pause/resume, run-now, cancel/delete and paginated occurrence history/results. Mutations MUST carry idempotency request keys and revision preconditions for edits. Same-key changed bodies and stale revisions MUST conflict. Pause/cancel/delete SHALL fence unadmitted work; already-admitted work SHALL remain linked and not be implicitly killed. Run-now MUST honor policy, paused/cancelled state and no-overlap; recurring cadence SHALL remain unchanged, while a once run-now SHALL consume the once trigger. Postpone SHALL override only the next recurring due time. Deletion MUST preserve active identity/history and refuse deletion of a job referenced by live schedules.

#### Scenario: Cancel versus activation
- **WHEN** cancellation races with durable target activation
- **THEN** a cancellation that wins prevents activation, while an admission that wins is returned explicitly with its target link and is not killed or forgotten

#### Scenario: Retry manual request
- **WHEN** a run-now response is lost and the identical request is retried
- **THEN** it returns the same occurrence and cannot produce another run

#### Scenario: Pause edit resume
- **WHEN** a paused schedule is edited and resumed after downtime
- **THEN** no work was admitted during pause, revision conflicts were enforced, and the next due follows the edited timing and visible late policy

### Requirement: Conversation-bound safe wake-up
A wake-up SHALL be a durable follow-up to its originating orchestrator host/conversation/run association, never an independent agent or steer/interruption. Its persisted envelope MUST include the original instruction, what/why to recheck, references, due/late information and reporting identity independent of compaction. Busy targets SHALL retain pending delivery and admit only at a safe turn boundary. Missing/rebound destinations MUST raise visible destination-unavailable attention without silent redirection. Explicit cancellation/postponement SHALL be supported. A recheck MUST grant no remediation/deployment authority.

#### Scenario: Busy compacted conversation
- **WHEN** a wake-up becomes due during an in-flight tool call, compaction occurs and the service restarts
- **THEN** the original tool call is not interrupted and the same self-contained wake-up is admitted once at a safe boundary, with queued, processing and terminal states separately recorded

#### Scenario: New conversation
- **WHEN** the developer starts a new orchestrator conversation before a scheduled wake-up is due
- **THEN** delivery remains pinned to the original identity or reports it unavailable, never reroutes to the new active conversation

### Requirement: Isolated standalone execution
Each standalone occurrence SHALL have its own tracked isolated execution, policy, output/evidence and results link, reusing existing configured host/runtime/model and safe execution modes. It MUST NOT inject its prompt into the interactive orchestrator. Read-only SHALL be the default; broader requested policy MUST follow ordinary authorization and review rules.

#### Scenario: Standalone report
- **WHEN** a recurring report job becomes due
- **THEN** a new isolated occurrence execution is tracked with its own results link and policy, without creating an interactive orchestrator input

### Requirement: Validated workflow launch
Scheduled workflow launches SHALL use existing supported workflow types and the normal validated start/admission path, preserving required task/project/app/stage/branch/worktree settings, environment leases and human plan/developer/findings/wiki gates. Stable occurrence ownership SHALL be verified before an existing workflow id is reused.

#### Scenario: Invalid start settings
- **WHEN** a scheduled workflow requires an app/stage/branch setting that is missing or no longer valid
- **THEN** admission fails visibly before a workflow runs, without substituting defaults or bypassing start validation

#### Scenario: Human gate
- **WHEN** a scheduled coding workflow reaches a human gate
- **THEN** it waits for the developer, retains no-overlap occupancy and never auto-approves or auto-merges

### Requirement: Tool management and guidance
Orchestrator scheduling tools SHALL expose the shared management operations with compact paginated results and confirmations naming target, timing/timezone, next run, effective execution/review/late/no-overlap policies and reporting destination. Guidance SHALL offer scheduling for later checks and use a durable wake-up for explicit reminders, while asking about ambiguous recurrence/timezone/authority instead of silently creating recurring work. Existing imported-tool access without allow-lists and native codemode MUST remain intact.

#### Scenario: Explicit reminder
- **WHEN** the developer explicitly asks the orchestrator to remind itself to recheck a subject in an hour
- **THEN** it creates a once wake-up with resolved instant and self-contained context and confirms destination/policy, rather than relying on conversation memory

### Requirement: Complete manual Schedules surface
The shell SHALL provide Schedules list/detail/editor/history with job reuse and all three target types and all agreed timing types. It MUST expose name, target, project, timing/timezone, enabled/paused state, next run, last result, active occurrence and service availability; offer run-now/pause/resume/cancel/delete/reschedule/postpone; and navigate to agent/workflow/exact-conversation output/evidence. Server preview/confirmation and inline validation SHALL be shared with tools. Keyboard actions MUST use the per-surface catalog, shared footer and full help contract.

#### Scenario: Manual creation and inspection
- **WHEN** a user creates each target with once, interval or calendar timing through the manual editor
- **THEN** required target fields and server preview are available, successful saves appear in the shared list and history opens the correct linked output/evidence

#### Scenario: Help and unavailable backend
- **WHEN** the user opens Schedules with an unavailable server and then opens help
- **THEN** availability is reported honestly, no false durable save succeeds, the footer lists special actions and help lists every catalog key including standard navigation

### Requirement: Bounded history, failures and lifecycle
The server lifecycle SHALL own reconciliation independent of views and operate only while running/awake. Documentation/status MUST explain shell-owned versus headless service availability and no OS wake guarantee. History SHALL distinguish launch failure, execution failure, skipped/missed/expired/cancelled, queued and waiting-review outcomes; preserve target links; and emit bounded completion/failure/attention notifications through existing surfaces. Infrastructure admission retries SHALL be bounded to five with the same identity, never replay partially executed work. Terminal detail SHALL be retained at most 90 days/1000 per schedule with explicit retention boundaries and compact summaries; active/unknown records and necessary deduplication identities MUST NOT be pruned. Jobs/schedules SHALL each be bounded to 1000 and pages to 100.

#### Scenario: Failure and pruning
- **WHEN** admission retries exhaust, an agent fails, and old terminal history is pruned
- **THEN** launch-failed and execution-failed remain distinguishable, active/unknown runs retain identity, lists expose retention boundaries and no old slot is recreated

#### Scenario: View closure
- **WHEN** the Schedules view closes while its owning server remains active
- **THEN** scheduling continues and survives server restart, but stopping the server or sleeping the machine does not promise timely execution

### Requirement: Isolated deterministic verification
Verification SHALL use isolated HOME, AGENTIC_CODING_CONFIG_DIR, PI_CODING_AGENT_DIR, HERDR_WIKI_DIR and temporary stores, with fake clocks/fault injection and local fixture executions of all targets. It MUST NOT use paid models/live services, real schedules or developer stores, build/restart the running developer instance, expose secrets or depend on unmerged bridge code.

#### Scenario: Local release evidence
- **WHEN** scheduling is verified
- **THEN** focused recurrence/DST/race/recovery/admission/tool/UI tests and actual local fixture target executions provide evidence without touching live state
