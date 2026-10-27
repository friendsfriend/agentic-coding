# home-orchestrator Specification

## Purpose
TBD - created by archiving change attribute-orchestrator-actions. Update Purpose after archive.
## Requirements
### Requirement: Orchestrator starts and actions are attributed

A workflow started through the orchestrator principal SHALL pin
`startedBy = "orchestrator"` for its lifetime, and a workflow started by the
operator SHALL pin `startedBy = "developer"`; a workflow without the field SHALL
read as `developer`. A developer action accepted from the orchestrator principal
SHALL be recorded with its event actor carrying `principal: "orchestrator"`,
while operator actions SHALL keep their existing actor. Attribution SHALL be
decided by the server from the authenticated principal and SHALL NOT be
expressible in a request.

#### Scenario: Orchestrator-started workflow

- **WHEN** the orchestrator starts a workflow
- **THEN** its view and overview SHALL report `startedBy` as `orchestrator`
- **AND** the workspace sidebar SHALL mark its row

#### Scenario: Orchestrator resumes a workflow

- **WHEN** the orchestrator sends `resume`
- **THEN** the recorded event actor SHALL carry `principal: "orchestrator"`

#### Scenario: Request tries to claim attribution

- **WHEN** a start request includes a `startedBy` field
- **THEN** the server SHALL reject the request as malformed

### Requirement: Orchestrated workflow monitoring

The shell SHALL consume the typed workflow event catalog the server derives from
the workflows the orchestrator started while it runs and
`[agents.orchestrator] monitor` is not `off`, and SHALL NOT read workflow views
or derive transitions itself. The first observation of a workflow SHALL only
establish its baseline and SHALL NOT produce an event. The events the shell
delivers by default SHALL be the ones it delivers today: a human review step
entered (`review.waiting`), a pending developer question (`question.pending`), a
developer question routed to the orchestrator (`question.routed`), the workflow
becoming `attention-required` (`attention.raised`/`workflow.failed`), a newly
failed effect (`effect.failed`) and completion (`workflow.completed`).

#### Scenario: First observation is silent

- **WHEN** the monitor first learns of a workflow already waiting at plan
  approval
- **THEN** no note and no notification SHALL be produced for it

#### Scenario: Review step entered

- **WHEN** an observed orchestrator-started workflow moves into developer review
- **THEN** exactly one `review.waiting` event SHALL be delivered

#### Scenario: The shell reads no views

- **WHEN** the monitor is running
- **THEN** it SHALL consume catalog events from the server's stream and SHALL
  perform no workflow view read of its own

### Requirement: Developer is told about waiting reviews

The shell SHALL raise one notification for every human-needed catalog event that
belongs to a workflow the orchestrator started — `review.waiting` and
`question.pending` — naming the workflow and its current step, in both `wake`
and `notify` modes, whatever subscriptions exist. No other event SHALL raise a
shell notification.

#### Scenario: Plan waiting on the developer

- **WHEN** an orchestrator-started workflow enters plan approval
- **THEN** the shell SHALL raise one notification naming that workflow and step

#### Scenario: No subscription changes this

- **WHEN** the orchestrator has unsubscribed from everything and a review is
  waiting on the developer
- **THEN** the shell SHALL still raise the notification

### Requirement: Orchestrator session wake-ups

In `wake` mode the shell SHALL deliver subscribed catalog events to the active
orchestrator session as follow-up input, using each subscription's mode and
cadence: events within one coalescing window become a single note, the session
receives at most one note per minute per session, and overflow is merged into the
next note. A `digest` subscription SHALL batch its events to its own interval and
a `silent` subscription SHALL be recorded without delivering. With no explicit
subscription the implicit `default` subscription SHALL deliver the events this
requirement listed before this change. In `notify` mode no note SHALL be
delivered and in `off` mode nothing SHALL be observed.

#### Scenario: Burst of transitions

- **WHEN** three orchestrator-started workflows change state within the
  coalescing window
- **THEN** the session SHALL receive one note listing all three

#### Scenario: Notify mode

- **WHEN** `monitor` is `notify` and a workflow becomes attention-required
- **THEN** the session SHALL receive no input

#### Scenario: No subscriptions

- **WHEN** the orchestrator has created no subscription and a subscribed-by-
  default event occurs
- **THEN** the session SHALL receive the note the default subscription produces

### Requirement: Orchestrator can shape workflows with blueprints

The orchestrator principal SHALL be allowed to read the blueprint step catalog,
validate blueprints, and start blueprint workflows. Blueprint starts from the
orchestrator SHALL keep the human-review gate pin. The orchestrator session SHALL
be offered tools for these operations and SHALL never submit a manifest
directly.

#### Scenario: Orchestrator validates then starts

- **WHEN** the orchestrator validates a blueprint and then starts it
- **THEN** the started workflow SHALL pin the validated digest
- **AND** its plan, developer and wiki gates SHALL be pinned `always`

#### Scenario: Review-free blueprint

- **WHEN** the orchestrator starts a blueprint that bypasses developer review
- **THEN** the server SHALL refuse it with the compiler's diagnostic

### Requirement: Developer questions from orchestrator-started workflows

A developer question created by a run of an orchestrator-started workflow SHALL be routed to the orchestrator session first: the record SHALL carry an orchestrator routing marker, SHALL appear in the orchestrator's workflow observation as an orchestrator question, and SHALL NOT open the developer's question modal while it is unanswered. The orchestrator SHALL be able to answer it or forward it to the developer; forwarding SHALL clear the marker and give the developer a full wait window. While an orchestrator-routed question is pending, the developer SHALL also be able to answer it directly, which clears the marker, so an orchestrator session that is off or idle cannot strand the workflow. A pending orchestrator-routed question SHALL remain visible in the workflow's pending question view so the parked workflow shows what it waits for.

#### Scenario: Question routes to the orchestrator first

- **WHEN** a run of an orchestrator-started workflow creates a developer question
- **THEN** the record SHALL carry the orchestrator routing marker and appear as an orchestrator question
- **AND** the record SHALL NOT appear in the developer's pending developer questions before it is forwarded

#### Scenario: Orchestrator forwards to the developer

- **WHEN** the orchestrator forwards a pending orchestrator-routed question it cannot answer
- **THEN** the marker SHALL be cleared and the wait window reset
- **AND** the question SHALL appear in the developer's pending developer questions

#### Scenario: Developer unblocks an idle orchestrator

- **WHEN** the developer answers a pending orchestrator-routed question while the orchestrator has not answered or forwarded it
- **THEN** the engine SHALL accept the answer, clear the routing marker, and record the developer's answer
- **AND** the asking run SHALL resume under the same rule as a developer-routed question

#### Scenario: Orchestrator question cannot be answered by the wrong actor

- **WHEN** the orchestrator attempts to answer a question that is not routed to it
- **THEN** the engine SHALL reject the answer without changing the question

### Requirement: Home Orchestrator destination and persistent session

The full application's Home SHALL offer an Orchestrator destination that opens
one persistent `pi-durable` conversation hosted by a dedicated agent host in
orchestrator mode. Reopening the page SHALL resume the same conversation, and a
`/new` command SHALL start a new conversation that becomes the active one.

#### Scenario: Opening the Orchestrator resumes the session

- **WHEN** the developer opens Home → Orchestrator after a previous session
- **THEN** the page SHALL show that session's transcript
- **AND** no second conversation SHALL be created

#### Scenario: Starting a new session

- **WHEN** the developer submits `/new`
- **THEN** a new conversation SHALL be created and persisted as the active session

### Requirement: Configurable orchestrator model

The orchestrator session's model and thinking level SHALL be read from
`[agents.orchestrator]` (`model`, `thinking`) in the user configuration, edited
in Settings → Agent Presets, and applied every time the page opens. Absent
fields SHALL use the durable host defaults; unknown keys SHALL be rejected.

#### Scenario: Selected model applies on open

- **WHEN** the developer saves a model and thinking level and reopens the page
- **THEN** the session SHALL run with that model and thinking level

### Requirement: Orchestrator capability and route policy

The unified server SHALL accept an orchestrator capability derived from the
instance token and authenticate it as the `orchestrator` principal. Requests
from that principal SHALL be limited to health, observations, workflow view,
start, action and execute, agents configuration reads, classifier status and
the event stream; any other route SHALL be refused with 403 before any
operation runs. The orchestrator host process SHALL NOT inherit the instance
token.

#### Scenario: Forbidden route

- **WHEN** the orchestrator calls a configuration write, a developer-question
  answer, a review save, a repair or a delete
- **THEN** the server SHALL answer 403 `orchestrator-forbidden`
- **AND** the operation SHALL NOT be invoked

### Requirement: Human reviews stay with the developer

The server SHALL refuse every approval, rejection and review-comment action from
the orchestrator principal. While a workflow's current step is a plan approval,
developer review, findings review or wiki approval, only resume, failed-effect
retry and preset switch SHALL be accepted from the orchestrator. Workflows the
orchestrator starts SHALL pin the plan approval, developer review and wiki gates
to `always`; this SHALL be decided by the server from the principal and SHALL
NOT be expressible in the start request.

#### Scenario: Approval refused at a review step

- **WHEN** the orchestrator sends `approve-plan` while the workflow is at plan
  approval
- **THEN** the server SHALL answer 403 and the workflow SHALL be unchanged

#### Scenario: Orchestrator start keeps reviews

- **WHEN** the orchestrator starts a workflow whose preset sets the developer
  review gate to `auto`
- **THEN** the started workflow SHALL pin the developer review gate as `always`

### Requirement: Orchestrator tool surface

The orchestrator session SHALL be offered the coding tools, orchestrator
workflow tools, and operational tools. It SHALL also receive native codemode
when enabled in the user's global Pi settings, including access to compatible
codemode-only imported tools when the local Pi bridge is enabled. The workflow
tools SHALL call the unified server only with the orchestrator capability from
the session's run environment.

#### Scenario: Codemode is available to the orchestrator

- **WHEN** global Pi settings enable codemode for an orchestrator session
- **THEN** the session SHALL offer native codemode
- **AND** it SHALL allow nested execution of the session's authorized callable tools

### Requirement: Orchestrator event subscription tools

The orchestrator tool surface SHALL include `subscribe_events`,
`unsubscribe_events`, `list_subscriptions` and `read_events`, each with a
compact description. `read_events` SHALL pull recorded events since a cursor with
filters and a bounded page size, so the orchestrator can poll instead of being
woken, and SHALL answer a stale cursor explicitly instead of returning a gap.
The routes behind them SHALL be part of the orchestrator capability's allowlist,
and every other route refusal SHALL be unchanged.

#### Scenario: Subscribing then pulling

- **WHEN** the orchestrator subscribes to `effect.failed` and later calls
  `read_events` since its last cursor
- **THEN** it SHALL receive the recorded matching events up to the page bound

#### Scenario: Unlisted route

- **WHEN** the orchestrator calls a route outside the allowlist
- **THEN** the server SHALL refuse it with `403 orchestrator-forbidden`

### Requirement: Event monitor master switch

`[agents.orchestrator] monitor` SHALL remain the master switch: `off` SHALL
observe nothing (no derivation, no log, no delivery) and SHALL refuse every
subscription tool with a clear error naming the setting; `notify` SHALL accept
subscriptions, raise the developer notifications and deliver no note; `wake`
SHALL deliver notes. The stall threshold SHALL be configurable as
`[agents.orchestrator] stall_minutes` with a default of 30 minutes.

#### Scenario: Off refuses a subscription

- **WHEN** `monitor` is `off` and the orchestrator calls `subscribe_events`
- **THEN** the tool SHALL fail with an error naming `[agents.orchestrator]
  monitor` and no subscription SHALL be stored

#### Scenario: Notify accepts but does not deliver

- **WHEN** `monitor` is `notify` and a subscription is active
- **THEN** `list_subscriptions` SHALL show it, the developer notification SHALL
  be raised and no note SHALL be delivered

#### Scenario: Configurable stall threshold

- **WHEN** `[agents.orchestrator] stall_minutes` is set
- **THEN** the server SHALL use it as the stalled-run threshold instead of the
  default

### Requirement: Orchestrator page accepts pointer input

The Orchestrator page SHALL accept the pointer: the wheel SHALL scroll its
transcript, a tap on the prompt area SHALL focus the prompt input, a tap on a
transcript block row SHALL keep toggling that block, and the page's model or
thinking picker SHALL select on a tap and activate on a tap of the selected row.
Pointer input SHALL NOT change the page's key handling, its session lifecycle,
its monitoring behavior or the transcript's selection copy, and SHALL add no
per-move handler.

#### Scenario: Scrolling the orchestrator transcript

- **WHEN** the developer moves the wheel over the transcript
- **THEN** the transcript SHALL scroll
- **AND** the session, its subscription state and the prompt SHALL remain unchanged

#### Scenario: Focusing the orchestrator prompt

- **WHEN** the developer taps the prompt area
- **THEN** the prompt input SHALL take text focus
- **AND** no send SHALL happen without the send key or the send control

#### Scenario: Orchestrator picker row

- **WHEN** the developer taps a row in the model or thinking picker
- **THEN** the row SHALL be selected
- **AND** tapping the selected row SHALL apply it as `Enter` does

#### Scenario: Keyboard page behavior is unchanged

- **WHEN** the developer sends, scrolls, toggles, opens a picker and leaves the page with the keyboard
- **THEN** every Orchestrator key SHALL behave as before

### Requirement: Orchestrator starts a workflow from a task reference

`start_workflow` SHALL accept a task reference as an alternative to inline `task`
text, and SHALL refuse a call that carries both or neither, naming both
parameters. A reference SHALL be either an OpenSpec change of the target
repository (a change id, or a path inside that repository's
`openspec/changes`) or the session's previous developer message. The server SHALL
resolve a change reference to that change's `proposal.md` and `tasks.md` content
as the task, and SHALL echo the resolved change id and the resolved task length
in the start answer. The host SHALL resolve the previous-message reference to the
developer's own last message of the session — never a monitor note or an abort
marker — and SHALL name that source and its length in the answer. A reference
SHALL be refused, in one bounded message that names the candidates, when it does
not resolve, when it matches more than one change, or when it names an archived
change. Inline `task` SHALL keep working unchanged, and a reference SHALL pass
the same start guard, the same preset and branch rules and the same human reviews
as inline text.

#### Scenario: A change reference starts the workflow and echoes its resolution

- **WHEN** the orchestrator calls `start_workflow` with `taskRef: { change:
  "add-stage-oauth2-auth" }` for a repository whose active changes include that
  id
- **THEN** the started workflow's task SHALL be the text assembled from that
  change's `proposal.md` and `tasks.md`
- **AND** the answer SHALL name the resolved change id and the resolved task
  length

#### Scenario: An unresolved reference names the candidates

- **WHEN** the reference matches no active change of the repository
- **THEN** the call SHALL be refused without a workflow being started
- **AND** the refusal SHALL name the closest existing change ids, bounded, and
  say how many more exist

#### Scenario: An ambiguous reference is refused rather than guessed

- **WHEN** the reference is a prefix of two or more active changes
- **THEN** the call SHALL be refused without a workflow being started
- **AND** the refusal SHALL name the matches

#### Scenario: The previous message is used as the task

- **WHEN** the orchestrator calls `start_workflow` with `taskRef: {
  previousMessage: true }` after the developer sent a message in the session
- **THEN** the workflow's task SHALL be that developer message verbatim
- **AND** the answer SHALL name the previous message as the task source and its
  length

#### Scenario: No previous developer message is available

- **WHEN** the session carries no developer message yet
- **THEN** the call SHALL be refused without a workflow being started
- **AND** the refusal SHALL name `task` and `taskRef.change` as the alternatives

#### Scenario: Inline task text is unchanged

- **WHEN** the orchestrator calls `start_workflow` with `task` text and no
  `taskRef`
- **THEN** the start SHALL behave exactly as before this change, including its
  answer

### Requirement: Orchestrator lists a repository's OpenSpec changes

The orchestrator tool surface SHALL include one listing tool for a repository's
OpenSpec changes that answers compact rows — change id, title, task progress and
the change's repository-relative path — and SHALL mark a change that a
non-closed workflow of that repository is already implementing. The listing SHALL
read only the repository's `openspec/changes` directory, SHALL exclude archived
changes, SHALL be bounded in the number of rows and in the length of each title,
and SHALL answer an empty list for a repository without that directory. The
existing change-id observation the dashboard reads SHALL keep its shape.

#### Scenario: Changes are listed as compact rows

- **WHEN** the orchestrator lists the changes of a repository holding active
  changes
- **THEN** each row SHALL carry the change id, its title, its checked/total task
  count and its `openspec/changes/<id>` path
- **AND** no row SHALL carry file contents

#### Scenario: A change already being implemented is marked

- **WHEN** a non-closed workflow of that repository implements one of the listed
  changes
- **THEN** that row SHALL name the workflow id and its status

#### Scenario: A repository without OpenSpec changes

- **WHEN** the repository has no `openspec/changes` directory
- **THEN** the listing SHALL answer an empty list rather than fail

### Requirement: One workflow identifier across the list and the status poll

`workflow_status` SHALL accept the `workflowId` that `list_workflows` returns
without also being given the repository: when `repo` is omitted the tool SHALL
resolve the repository from the same workflow board `list_workflows` reads, and
SHALL answer one row per repository when that id exists in more than one. An
unknown id SHALL be answered, not failed, with the closest existing ids bounded
and a note when more exist. `workflow_status` SHALL accept several ids in one
call, each with its own `sinceRevision`, and SHALL answer one compact entry per
id in the requested order. A call that names a single id SHALL answer exactly the
shape it answers today, and no row SHALL gain a field.

#### Scenario: A poll without a repository resolves it from the board

- **WHEN** the orchestrator polls the `workflowId` it read from `list_workflows`
  and omits `repo`
- **THEN** the poll SHALL answer that workflow's compact row, including its
  `target`

#### Scenario: An unknown id answers with the closest ids

- **WHEN** the orchestrator polls an id that no workflow on the board has
- **THEN** the answer SHALL name the closest existing ids, bounded
- **AND** the call SHALL NOT fail

#### Scenario: Several ids are polled in one call

- **WHEN** the orchestrator polls three ids, one of them with the revision of its
  own last answer
- **THEN** the answer SHALL carry three compact entries in the requested order
- **AND** the unchanged one SHALL answer in a few bytes, naming its
  `workflowId`, revision, status and step

#### Scenario: A single-id answer is unchanged

- **WHEN** the orchestrator polls one id with `sinceRevision` equal to its
  current revision
- **THEN** the answer SHALL be the few-byte `unchanged` answer it answers today

### Requirement: A refused start names what stopped it

`start_workflow` SHALL name what stopped a refused start: a refusal because the
target repository's working tree is not clean SHALL carry the number of dirty
paths and a bounded list of them, without file contents, and `start_workflow`
SHALL return that refusal verbatim. The
clean-tree requirement itself SHALL be unchanged: a reference start is refused
exactly like an inline-text start.

#### Scenario: A dirty tree refusal lists the paths

- **WHEN** `start_workflow` is called for a repository with dirty paths
- **THEN** the call SHALL be refused with the dirty-path count and a bounded list
  of the paths
- **AND** no file content SHALL appear in the refusal

