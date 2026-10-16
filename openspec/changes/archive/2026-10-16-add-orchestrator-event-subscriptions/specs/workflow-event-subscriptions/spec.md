# Spec Delta

## ADDED Requirements

### Requirement: Orchestrator-controlled event subscriptions

Subscriptions SHALL be created and managed by the orchestrator session through
`subscribe_events`, `unsubscribe_events`, `list_subscriptions` and
`read_events`. A subscription SHALL carry a filter (workflow ids, "all started
by me", repositories, event ids or categories, and optional conditions on
attention-required reasons, run roles and minimum severity), a delivery mode
(`wake`, `digest` or `silent`), an expiry or an until-condition, a label and a
reason. Filters SHALL be validated: an unknown workflow id, a filter beyond the
documented bounds, or a subscription beyond the store's cap SHALL be refused
with a clear error naming the limit.

#### Scenario: Subscribing to one workflow's attention events

- **WHEN** the orchestrator subscribes to `attention.raised` for one workflow
  with mode `wake` and an expiry
- **THEN** the server SHALL store the subscription and `list_subscriptions`
  SHALL return it with its label, filter, mode and expiry

#### Scenario: Unknown workflow is refused

- **WHEN** the orchestrator subscribes to a workflow id no observation returns
- **THEN** the tool SHALL fail with an error naming that id and no subscription
  SHALL be stored

#### Scenario: Subscription cap

- **WHEN** the store already holds the maximum number of subscriptions and
  another is requested
- **THEN** the request SHALL be refused with an error naming the cap

### Requirement: Durable, session-owned subscriptions

Subscriptions SHALL be persisted in a small JSON file next to the orchestrator
conversation state under the configuration root, written atomically, and SHALL
be readable after a TUI restart while the orchestrator conversation persists.
They SHALL NOT be written to any workflow store, and no store schema or
`STORE_SCHEMA_VERSION` SHALL change. Each record SHALL name the orchestrator
session that created it, and a record whose session is not the active session
SHALL be pruned.

#### Scenario: Subscriptions survive a restart

- **WHEN** a subscription exists and the shell restarts with the same
  orchestrator session
- **THEN** `list_subscriptions` SHALL still return it

#### Scenario: A new session starts

- **WHEN** the developer starts a new orchestrator session
- **THEN** the previous session's subscriptions SHALL be pruned and SHALL NOT be
  delivered

### Requirement: Default subscription preserves current behaviour

While a session holds no explicit subscription, the server SHALL treat one
implicit `default` subscription as active: the events the current monitor
delivers (`review.waiting`, `question.pending`, `question.routed`,
`attention.raised`, `workflow.failed`, `effect.failed`, `workflow.completed`)
for the workflows the orchestrator started, in `wake` mode with the current
cadence. `list_subscriptions` SHALL show it, and any explicit subscription SHALL
replace it. A filter that names no `scope` reads as `scope: "mine"`.

#### Scenario: No subscriptions, today's behaviour

- **WHEN** the orchestrator has created no subscription and one of its workflows
  enters a review step
- **THEN** the session SHALL receive one note naming that workflow, exactly as
  before this change

#### Scenario: The default is visible and replaceable

- **WHEN** the orchestrator lists its subscriptions before subscribing
- **THEN** the listing SHALL name the implicit `default` subscription, and after
  one explicit subscription exists the listing SHALL NOT include it

### Requirement: Delivery modes and anti-storm guarantees

Delivery SHALL reuse the monitor's guarantees per subscription: events inside a
coalescing window become one note; `wake` mode SHALL deliver at most one note
per minute per session with overflow merged forward; `digest` mode SHALL
accumulate events and deliver at most once per `digestMinutes` (default 5);
`silent` mode SHALL record the matched events and deliver no note. The system
SHALL bound a note to 20 event lines, bound the pending backlog to 200 events
(dropping and counting the oldest), and refuse to exceed 20 notes per trailing
hour per session, keeping the rest queued.

#### Scenario: Burst of transitions

- **WHEN** three subscribed workflows change state inside the coalescing window
- **THEN** the session SHALL receive one note listing all three

#### Scenario: Digest cadence

- **WHEN** a `digest` subscription matches events at different times inside one
  digest interval
- **THEN** the session SHALL receive one note for that interval

#### Scenario: Silent records without delivering

- **WHEN** a `silent` subscription matches an event
- **THEN** the event SHALL be readable with `read_events` and the session SHALL
  receive no note

#### Scenario: Bounded note

- **WHEN** one note would list more events than the line bound
- **THEN** the note SHALL elide the rest with a count

### Requirement: De-duplicated, labelled notes

An event matched by more than one subscription SHALL appear as exactly one line,
and the note SHALL name every contributing subscription by label. The note SHALL
keep the `[workflow-monitor]` prefix, one line per event, in event-sequence and
catalog order. The orchestrator system prompt SHALL explain the prefix, the
subscription labels and how to subscribe or pull with the event tools.

#### Scenario: One event, two subscriptions

- **WHEN** one event matches two subscriptions with different labels
- **THEN** the note SHALL contain one line for that event and SHALL list both
  labels

#### Scenario: Prompt explains the note

- **WHEN** the orchestrator system prompt is read
- **THEN** it SHALL describe the note prefix, the subscription labels and the
  subscribe/read tools

### Requirement: Subscription cleanup

A subscription SHALL be pruned when its expiry passes, when the workflow it
names as an until-condition is `closed` or `completed`, when its remaining-event
count reaches zero, when its session is no longer active, and when it is removed
with `unsubscribe_events`.

#### Scenario: Expiry

- **WHEN** a subscription's expiry passes
- **THEN** it SHALL be pruned and SHALL NOT match further events

#### Scenario: Until-condition reached

- **WHEN** a subscription's until-workflow reaches `completed`
- **THEN** it SHALL be pruned

#### Scenario: Removal is idempotent

- **WHEN** `unsubscribe_events` names a subscription twice
- **THEN** the second call SHALL succeed and change nothing

### Requirement: Subscription visibility is bounded to what the orchestrator may see

A subscription SHALL NOT widen the orchestrator's visibility: it observes the
workflows the observation surface already returns, payloads stay bounded and
secret-free, and records carry no raw task text beyond a bounded summary.

#### Scenario: Visibility is unchanged

- **WHEN** the orchestrator subscribes to "all started by me"
- **THEN** the events it receives SHALL describe exactly the workflows
  `list_workflows` already reports for it

### Requirement: Developer visibility and removal

The Orchestrator view SHALL list the active subscriptions compactly — label,
filter, mode, expiry and last delivery — and SHALL let the developer remove one,
without a keybind or a new surface.

#### Scenario: Listing subscriptions

- **WHEN** the developer runs `/subscriptions` on the Orchestrator page
- **THEN** the page SHALL list each active subscription with its label, filter,
  mode, expiry and last delivery

#### Scenario: Removing a subscription

- **WHEN** the developer removes a subscription from that list
- **THEN** it SHALL be pruned and the list SHALL no longer show it
