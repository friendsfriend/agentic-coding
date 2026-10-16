# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
